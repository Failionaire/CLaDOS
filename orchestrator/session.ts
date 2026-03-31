import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import writeFileAtomic from 'write-file-atomic';
import type {
  SessionState,
  PhaseCheckpoint,
  SessionConfig,
  ConductorDecision,
  ConductorReasoning,
  ArtifactRecord,
  AgentTokenRecord,
} from './types.js';

const STATE_FILE = '00-session-state.json';

export class SessionManager {
  // Per-projectDir promise chain used as a lightweight mutex.
  // All state-mutating operations acquire this lock to prevent
  // read-modify-write races when parallel agents are running.
  private locks = new Map<string, Promise<unknown>>();

  private claDosDir(projectDir: string): string {
    return path.join(projectDir, '.clados');
  }

  private statePath(projectDir: string): string {
    return path.join(this.claDosDir(projectDir), STATE_FILE);
  }

  /**
   * Create a fresh session state file for a new project.
   */
  async init(projectDir: string, projectName: string, config: SessionConfig): Promise<SessionState> {
    const claDosDir = this.claDosDir(projectDir);

    await fs.promises.mkdir(path.join(claDosDir, 'wip'), { recursive: true });
    await fs.promises.mkdir(path.join(claDosDir, 'history'), { recursive: true });

    const now = new Date().toISOString();
    const state: SessionState = {
      project_id: uuidv4(),
      project_name: projectName,
      created_at: now,
      updated_at: now,
      pipeline_status: 'idle',
      config,
      spec_version: 1,
      current_phase: 0,
      phase_checkpoint: null,
      phases_completed: [],
      agent_tokens_used: {},
      total_cost_usd: 0,
      conductor_decisions: [],
      conductor_reasoning: [],
      dependency_divergences: [],
      validator_tier: 'sonnet',
      token_counting_approximate: false,
      context_compression_log: [],
      artifacts: {},
    };

    await this.write(projectDir, state);
    return state;
  }

  /**
   * Read the current session state from disk.
   */
  async read(projectDir: string): Promise<SessionState> {
    const statePath = this.statePath(projectDir);
    const raw = await fs.promises.readFile(statePath, 'utf-8');
    try {
      return JSON.parse(raw) as SessionState;
    } catch (err) {
      throw new Error(`Session state corrupted at ${statePath}: ${(err as Error).message}`);
    }
  }

  /**
   * Atomically update session state.
   * Accepts a partial patch — shallow-merges top-level keys.
   * Acquires the per-project write lock to prevent concurrent read-modify-write races.
   */
  async update(projectDir: string, patch: Partial<SessionState>): Promise<SessionState> {
    return this.mutateState(projectDir, (state) => ({ ...state, ...patch }));
  }

  /**
   * Update the phase checkpoint atomically.
   */
  async updateCheckpoint(
    projectDir: string,
    patch: Partial<PhaseCheckpoint>,
  ): Promise<SessionState> {
    return this.mutateState(projectDir, (state) => {
      const checkpoint: PhaseCheckpoint = {
        ...(state.phase_checkpoint ?? {
          phase: state.current_phase,
          completed_agents: [],
          in_progress_agent: null,
          in_progress_artifact_partial: null,
          spec_version_at_start: state.spec_version,
          gate_revision_count: 0,
          unresolved_streak: 0,
        }),
        ...patch,
      };
      return { ...state, phase_checkpoint: checkpoint };
    });
  }

  /**
   * Record token usage for an agent and update running cost total.
   * Accumulates tokens if the same role is re-dispatched (revision cycles, retries).
   * This ensures the total spend reflects all API calls, not just the last one.
   */
  async recordTokens(
    projectDir: string,
    phase: number,
    role: string,
    tokens: AgentTokenRecord,
  ): Promise<void> {
    await this.mutateState(projectDir, (state) => {
      const phaseKey = String(phase);
      const existing = state.agent_tokens_used[phaseKey]?.[role];
      const accumulated: AgentTokenRecord = existing
        ? {
            input: existing.input + tokens.input,
            output: existing.output + tokens.output,
            cost_usd: existing.cost_usd + tokens.cost_usd,
          }
        : tokens;
      const phaseTokens = { ...(state.agent_tokens_used[phaseKey] ?? {}), [role]: accumulated };
      const updatedTokens = { ...state.agent_tokens_used, [phaseKey]: phaseTokens };
      // Round to 6 decimal places (microdollar precision) to prevent floating-point
      // accumulation error from causing the displayed total to diverge from per-agent sums.
      const totalCost =
        Math.round(
          Object.values(updatedTokens)
            .flatMap((p) => Object.values(p))
            .reduce((sum, t) => sum + t.cost_usd, 0) * 1_000_000,
        ) / 1_000_000;
      return { ...state, agent_tokens_used: updatedTokens, total_cost_usd: totalCost };
    });
  }

  /**
   * Register a written artifact and store its token count.
   * Increments the version if this artifact key already exists (revision cycle overwrite).
   *
   * IMPORTANT: Call archiveArtifact() before registerArtifact() when overwriting an existing
   * artifact. archiveArtifact() reads the current version to name the archive file;
   * registerArtifact() then writes the incremented version. Calling in the wrong order
   * will mislabel the archive.
   */
  async registerArtifact(
    projectDir: string,
    key: string,
    record: ArtifactRecord,
  ): Promise<void> {
    // Normalize to forward slashes so keys are consistent across platforms
    const normalizedKey = key.replace(/\\/g, '/');
    await this.mutateState(projectDir, (state) => {
      const existingVersion = state.artifacts[normalizedKey]?.version ?? 0;
      const versioned: ArtifactRecord = { ...record, version: existingVersion + 1 };
      return { ...state, artifacts: { ...state.artifacts, [normalizedKey]: versioned } };
    });
  }

  /**
   * Append a conductor decision to the log.
   */
  async appendDecision(projectDir: string, decision: ConductorDecision): Promise<void> {
    await this.mutateState(projectDir, (state) => ({
      ...state,
      conductor_decisions: [...state.conductor_decisions, decision],
    }));
  }

  /**
   * Append a conductor reasoning record.
   */
  async appendReasoning(projectDir: string, reasoning: ConductorReasoning): Promise<void> {
    await this.mutateState(projectDir, (state) => ({
      ...state,
      conductor_reasoning: [...state.conductor_reasoning, reasoning],
    }));
  }

  /**
   * Bump the spec version (called when api spec is updated post-build).
   */
  async bumpSpecVersion(projectDir: string): Promise<number> {
    const state = await this.mutateState(projectDir, (current) => ({
      ...current,
      spec_version: current.spec_version + 1,
    }));
    return state.spec_version;
  }

  /**
   * Archive the current artifact version to .clados/history/ before overwrite.
   * Call this before registerArtifact() — see registerArtifact() for ordering requirements.
   */
  async archiveArtifact(projectDir: string, artifactRelPath: string): Promise<void> {
    const claDosDir = this.claDosDir(projectDir);
    const srcPath = path.join(claDosDir, artifactRelPath);

    const state = await this.read(projectDir);
    // Normalize the key before lookup so it matches the forward-slash keys stored by registerArtifact
    const normalizedKey = artifactRelPath.replace(/\\/g, '/');
    const version = state.artifacts[normalizedKey]?.version ?? 1;
    const ext = path.extname(artifactRelPath);
    const base = path.basename(artifactRelPath, ext);
    const dir = path.dirname(artifactRelPath);
    const archiveName = `${base}_v${version}${ext}`;
    const archivePath = path.join(claDosDir, 'history', dir, archiveName);

    await fs.promises.mkdir(path.dirname(archivePath), { recursive: true });
    try {
      await fs.promises.copyFile(srcPath, archivePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  /**
   * Acquire the per-project write lock and execute fn exclusively.
   * Uses promise chaining — all mutations for a given projectDir are serialized.
   * A failed mutation swallows its rejection from the lock chain so subsequent
   * operations are not permanently blocked.
   */
  private withLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectDir) ?? Promise.resolve();
    const next = prev.then(() => fn());
    this.locks.set(projectDir, next.catch(() => {}));
    return next;
  }

  /**
   * Read current state, apply fn synchronously, write the result — all under the write lock.
   * This is the single point through which all state mutations must flow.
   */
  private async mutateState(
    projectDir: string,
    fn: (state: SessionState) => SessionState,
  ): Promise<SessionState> {
    return this.withLock(projectDir, async () => {
      const current = await this.read(projectDir);
      const next = { ...fn(current), updated_at: new Date().toISOString() };
      await this.write(projectDir, next);
      return next;
    });
  }

  private async write(projectDir: string, state: SessionState): Promise<void> {
    const statePath = this.statePath(projectDir);
    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
    await writeFileAtomic(statePath, JSON.stringify(state, null, 2), { encoding: 'utf8' });
  }
}
