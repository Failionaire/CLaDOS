import fs from 'fs';
import path from 'path';
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
const STATE_TMP = '00-session-state.tmp.json';

export class SessionManager {
  private claDosDir(projectDir: string): string {
    return path.join(projectDir, '.clados');
  }

  private statePath(projectDir: string): string {
    return path.join(this.claDosDir(projectDir), STATE_FILE);
  }

  private tmpPath(projectDir: string): string {
    return path.join(this.claDosDir(projectDir), STATE_TMP);
  }

  /**
   * Create a fresh session state file for a new project.
   */
  async init(projectDir: string, projectName: string, config: SessionConfig): Promise<SessionState> {
    const { v4: uuidv4 } = await import('uuid');
    const claDosDir = this.claDosDir(projectDir);

    await fs.promises.mkdir(path.join(claDosDir, 'wip'), { recursive: true });
    await fs.promises.mkdir(path.join(claDosDir, 'history'), { recursive: true });

    const state: SessionState = {
      project_id: uuidv4(),
      project_name: projectName,
      created_at: new Date().toISOString(),
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
      artifacts: {},
    };

    await this.write(projectDir, state);
    return state;
  }

  /**
   * Read the current session state from disk.
   * On startup, discards any leftover .tmp file (write died mid-rename).
   */
  async read(projectDir: string): Promise<SessionState> {
    const tmpPath = this.tmpPath(projectDir);
    const statePath = this.statePath(projectDir);

    // Discard orphaned tmp file (incomplete atomic write on prior run)
    if (fs.existsSync(tmpPath) && fs.existsSync(statePath)) {
      try {
        await fs.promises.unlink(tmpPath);
      } catch { /* best-effort */ }
    }

    const raw = await fs.promises.readFile(statePath, 'utf-8');
    return JSON.parse(raw) as SessionState;
  }

  /**
   * Atomically update session state using write-file-atomic.
   * Accepts a partial patch — deep merges top-level keys.
   */
  async update(projectDir: string, patch: Partial<SessionState>): Promise<SessionState> {
    const current = await this.read(projectDir);
    const next: SessionState = { ...current, ...patch };
    await this.write(projectDir, next);
    return next;
  }

  /**
   * Update the phase checkpoint atomically.
   */
  async updateCheckpoint(
    projectDir: string,
    patch: Partial<PhaseCheckpoint>,
  ): Promise<SessionState> {
    const current = await this.read(projectDir);
    const checkpoint: PhaseCheckpoint = {
      ...(current.phase_checkpoint ?? {
        phase: current.current_phase,
        completed_agents: [],
        in_progress_agent: null,
        in_progress_artifact_partial: null,
        spec_version_at_start: current.spec_version,
        gate_revision_count: 0,
        unresolved_streak: 0,
      }),
      ...patch,
    };
    return this.update(projectDir, { phase_checkpoint: checkpoint });
  }

  /**
   * Record token usage for an agent and update running cost total.
   */
  async recordTokens(
    projectDir: string,
    phase: number,
    role: string,
    tokens: AgentTokenRecord,
  ): Promise<void> {
    const current = await this.read(projectDir);
    const phaseKey = String(phase);
    // Build updated record without mutating current state, so the cost sum is correct
    // even on re-dispatch of the same role (replaces the old entry rather than doubling it)
    const phaseTokens = { ...(current.agent_tokens_used[phaseKey] ?? {}), [role]: tokens };
    const updatedTokens = { ...current.agent_tokens_used, [phaseKey]: phaseTokens };
    const totalCost = Object.values(updatedTokens)
      .flatMap((p) => Object.values(p))
      .reduce((sum, t) => sum + t.cost_usd, 0);

    await this.update(projectDir, {
      agent_tokens_used: updatedTokens,
      total_cost_usd: totalCost,
    });
  }

  /**
   * Register a written artifact and store its token count.
   */
  async registerArtifact(
    projectDir: string,
    key: string,
    record: ArtifactRecord,
  ): Promise<void> {
    const current = await this.read(projectDir);
    await this.update(projectDir, {
      artifacts: { ...current.artifacts, [key]: record },
    });
  }

  /**
   * Append a conductor decision to the log.
   */
  async appendDecision(projectDir: string, decision: ConductorDecision): Promise<void> {
    const current = await this.read(projectDir);
    await this.update(projectDir, {
      conductor_decisions: [...current.conductor_decisions, decision],
    });
  }

  /**
   * Append a conductor reasoning record.
   */
  async appendReasoning(projectDir: string, reasoning: ConductorReasoning): Promise<void> {
    const current = await this.read(projectDir);
    await this.update(projectDir, {
      conductor_reasoning: [...current.conductor_reasoning, reasoning],
    });
  }

  /**
   * Bump the spec version (called when api spec is updated post-build).
   */
  async bumpSpecVersion(projectDir: string): Promise<number> {
    const current = await this.read(projectDir);
    const next = current.spec_version + 1;
    await this.update(projectDir, { spec_version: next });
    return next;
  }

  /**
   * Archive the current artifact version to .clados/history/ before overwrite.
   */
  async archiveArtifact(projectDir: string, artifactRelPath: string): Promise<void> {
    const claDosDir = this.claDosDir(projectDir);
    const srcPath = path.join(claDosDir, artifactRelPath);
    if (!fs.existsSync(srcPath)) return;

    const current = await this.read(projectDir);
    const key = artifactRelPath;
    const version = (current.artifacts[key]?.version ?? 1);
    const ext = path.extname(artifactRelPath);
    const base = path.basename(artifactRelPath, ext);
    const dir = path.dirname(artifactRelPath);
    const archiveName = `${base}_v${version}${ext}`;
    const archivePath = path.join(claDosDir, 'history', dir, archiveName);

    await fs.promises.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.promises.copyFile(srcPath, archivePath);
  }

  private async write(projectDir: string, state: SessionState): Promise<void> {
    const statePath = this.statePath(projectDir);
    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
    await writeFileAtomic(statePath, JSON.stringify(state, null, 2), { encoding: 'utf8' });
  }
}
