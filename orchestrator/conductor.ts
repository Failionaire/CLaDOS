/**
 * Conductor — deterministic TypeScript orchestrator driving the 5-phase pipeline.
 *
 * Does NOT contain LLM prompts or agent identity — those live in agents/*.md.
 * All phase transitions are expressed in plain TypeScript.
 */

import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentRegistry,
  AgentRegistryEntry,
  AgentDispatchConfig,
  AgentResult,
  AgentRole,
  ContextArtifact,
  Finding,
  GateResponse,
  PhaseCheckpoint,
  SessionState,
  WsServerEvent,
} from './types.js';
import { SessionManager } from './session.js';
import { Logger } from './logger.js';
import { Semaphore, RollingTpmTracker } from './parallel.js';
import { BudgetManager, BudgetGate, calculateCostUsd, initModelPrices } from './budget.js';
import {
  resolveContextArtifacts,
  injectVariables,
  validateSystemPromptSections,
  passesStructuralMarkerTest,
  estimateTokens,
  initContextModels,
} from './context.js';
import {
  resolveModel,
  isAgentEnabled,
  isSkippable,
} from './escalation.js';
import writeFileAtomic from 'write-file-atomic';

const CLADOS_ROOT = path.join(__dirname, '..', '..');
const REGISTRY_PATH = path.join(CLADOS_ROOT, 'agent-registry.json');
const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];
const MAX_RETRIES = 3;
const UNRESOLVED_STREAK_REASON_THRESHOLD = 3;

// ─── JSON sanitizer ───────────────────────────────────────────────────────────

function sanitizeJson(raw: string): unknown {
  let s = raw.trim();
  // Strip markdown fences
  s = s.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  // Slice to outermost { or [
  const objIdx = s.indexOf('{');
  const arrIdx = s.indexOf('[');
  if (objIdx === -1 && arrIdx === -1) throw new Error('No JSON object or array found');
  const start = objIdx !== -1 && (arrIdx === -1 || objIdx < arrIdx) ? objIdx : arrIdx;
  // Slice to the last matching closing bracket to strip trailing prose after the JSON value
  const closingChar = s.charAt(start) === '{' ? '}' : ']';
  const end = s.lastIndexOf(closingChar);
  if (end <= start) throw new Error('No closing bracket found for JSON value');
  s = s.slice(start, end + 1);
  return JSON.parse(s);
}

// ─── WIP path helpers ────────────────────────────────────────────────────────

/** Derive the correct partial-file extension from the agent's expected output type. */
function wipExtForRole(role: string): string {
  // security writes security-report.md, not JSON — keep it out of jsonRoles
  const jsonRoles = new Set(['validator', 'qa', 'wrecker']);
  return jsonRoles.has(role) ? '.partial.json' : '.partial.md';
}

// ─── Conductor ────────────────────────────────────────────────────────────────

export class Conductor {
  private anthropic: Anthropic;
  private registry!: AgentRegistry;
  private semaphore: Semaphore;
  private tpmTracker: RollingTpmTracker;
  private budgetManager: BudgetManager;
  private broadcast: (event: WsServerEvent) => void;

  /** Pending gate: set when waiting for human, resolved by handleGateResponse() */
  private gateResolve: ((response: GateResponse) => void) | null = null;
  private currentGateEvent: WsServerEvent | null = null;

  /** Resolved by handleBudgetUpdate() (true = continue) or handleBudgetAbort() (false = stop) */
  private budgetGateResolve: ((shouldContinue: boolean) => void) | null = null;
  private currentBudgetGateEvent: WsServerEvent | null = null;

  /**
   * Per-agent error resolution: keyed by role.
   * Using a Map instead of a single field prevents a race condition where two
   * parallel agents (e.g. QA + Security in Phase 2 Stage B) both exhaust retries
   * and the second assignment would silently overwrite the first promise resolver.
   */
  private agentErrorResolves = new Map<string, (action: 'retry' | 'skip') => void>();

  /**
   * Per-agent crash recovery context: populated when a partial WIP artifact passes
   * the structural marker test. Consumed (once) by the first dispatchWithRetry call
   * for that agent after a crash restart.
   */
  private crashRecoveryPrefix: Map<string, string> = new Map();

  constructor(
    apiKey: string,
    public readonly session: SessionManager,
    public readonly logger: Logger,
    broadcast: (event: WsServerEvent) => void,
  ) {
    this.anthropic = new Anthropic({ apiKey });
    this.semaphore = new Semaphore(3);
    this.tpmTracker = new RollingTpmTracker();
    this.budgetManager = new BudgetManager(session);
    this.broadcast = broadcast;
  }

  setBroadcast(fn: (event: WsServerEvent) => void): void {
    this.broadcast = fn;
  }

  /** Called by server.ts on new connections to push active gate events that aren't in SessionState */
  resendPendingEventsTo(ws: import('ws').WebSocket): void {
    if (this.currentGateEvent && ws.readyState === 1) {
      ws.send(JSON.stringify(this.currentGateEvent));
    }
    if (this.currentBudgetGateEvent && ws.readyState === 1) {
      ws.send(JSON.stringify(this.currentBudgetGateEvent));
    }
  }

  async init(): Promise<void> {
    const raw = await fs.promises.readFile(REGISTRY_PATH, 'utf-8');
    this.registry = JSON.parse(raw) as AgentRegistry;

    // Pre-compute system_prompt_tokens for each agent
    for (const entry of this.registry.agents) {
      const promptPath = path.join(CLADOS_ROOT, entry.system_prompt);
      if (!fs.existsSync(promptPath)) {
        throw new Error(`Agent system prompt missing: ${entry.system_prompt}`);
      }
      const promptText = await fs.promises.readFile(promptPath, 'utf-8');
      const missing = validateSystemPromptSections(promptText);
      if (missing.length > 0) {
        throw new Error(
          `Agent "${entry.role}" system prompt missing sections: ${missing.join(', ')}`,
        );
      }
      try {
        const count = await this.anthropic.beta.messages.countTokens({
          model: entry.default_model,
          messages: [{ role: 'user', content: 'x' }],
          system: promptText,
        });
        entry.system_prompt_tokens = count.input_tokens;
      } catch {
        entry.system_prompt_tokens = Math.ceil(promptText.length / 3.5);
      }
    }

    // Initialise utility modules with model names and prices from the registry.
    // This is the single place where model strings are read from agent-registry.json.
    initContextModels(
      this.registry.utility_models.token_counter,
      this.registry.utility_models.summarizer,
    );
    initModelPrices(this.registry.model_prices);
  }

  // ─── Gate handling ──────────────────────────────────────────────────────────

  handleGateResponse(response: GateResponse): void {
    if (this.gateResolve) {
      this.currentGateEvent = null;
      this.gateResolve(response);
      this.gateResolve = null;
    }
  }

  /** Called by server.ts POST /budget/update — resumes the pipeline with the new cap. */
  handleBudgetUpdate(): void {
    if (this.budgetGateResolve) {
      this.currentBudgetGateEvent = null;
      this.budgetGateResolve(true);
      this.budgetGateResolve = null;
    }
  }

  /** Called by server.ts POST /budget/abort — abandons the pipeline at a budget gate. */
  handleBudgetAbort(): void {
    if (this.budgetGateResolve) {
      this.currentBudgetGateEvent = null;
      this.budgetGateResolve(false);
      this.budgetGateResolve = null;
    }
  }

  /** Called by server.ts POST /agent/retry — resolves the waiting error promise for the given role key. */
  handleAgentRetry(role: string): void {
    const resolve = this.agentErrorResolves.get(role);
    if (resolve) { resolve('retry'); this.agentErrorResolves.delete(role); }
  }

  /** Called by server.ts POST /agent/skip — resolves the waiting error promise for the given role key. */
  handleAgentSkip(role: string): void {
    const resolve = this.agentErrorResolves.get(role);
    if (resolve) { resolve('skip'); this.agentErrorResolves.delete(role); }
  }

  private async waitForGate(projectDir: string): Promise<GateResponse> {
    return new Promise((resolve) => {
      this.gateResolve = resolve;
    });
  }

  // ─── Phase runner ───────────────────────────────────────────────────────────

  async runPipeline(projectDir: string): Promise<void> {
    const state = await this.session.read(projectDir);

    // Crash recovery: if we were mid-agent, handle it before proceeding
    if (state.pipeline_status === 'agent_running') {
      const partialContent = await this.crashRecover(projectDir);
      if (partialContent) {
        const freshState = await this.session.read(projectDir);
        const inProgressAgent = freshState.phase_checkpoint?.in_progress_agent;
        if (inProgressAgent) {
          this.crashRecoveryPrefix.set(
            inProgressAgent,
            `[CRASH RECOVERY — you were mid-way through writing this artifact when the process was interrupted. Continue from where you left off.]\n\nPARTIAL OUTPUT SO FAR:\n\n${partialContent}`,
          );
        }
      }
    }

    // M-11: Remove orphaned WIP partial files from previous crashed runs.
    // Keep only the file matching the current in_progress_artifact_partial (if any).
    const wipDir = path.join(projectDir, '.clados', 'wip');
    if (fs.existsSync(wipDir)) {
      const activePartial = state.phase_checkpoint?.in_progress_artifact_partial;
      const activeBasename = activePartial ? path.basename(activePartial) : null;
      for (const file of await fs.promises.readdir(wipDir)) {
        if ((file.endsWith('.partial.md') || file.endsWith('.partial.json')) && file !== activeBasename) {
          await fs.promises.unlink(path.join(wipDir, file)).catch(() => { /* ignore */ });
        }
      }
    }

    for (let phase = state.current_phase; phase <= 4; phase++) {
      // Skip already-completed phases
      if (state.phases_completed.includes(phase)) continue;

      this.logger.setContext(phase, null);
      this.logger.info('phase.start', `Starting Phase ${phase}`);

      switch (phase) {
        case 0: await this.runPhase0(projectDir); break;
        case 1: await this.runPhase1(projectDir); break;
        case 2: await this.runPhase2(projectDir); break;
        case 3: await this.runPhase3(projectDir); break;
        case 4: await this.runPhase4(projectDir); break;
      }
    }

    await this.session.update(projectDir, { pipeline_status: 'complete' });
    this.logger.info('pipeline.complete', 'Pipeline completed successfully');
  }

  // ─── Phase 0 — Concept ─────────────────────────────────────────────────────

  private async runPhase0(projectDir: string): Promise<void> {
    const state = await this.session.read(projectDir);

    // On crash recovery, preserve completed_agents, gate_revision_count, and
    // unresolved_streak so agents that finished aren't re-run and the escape
    // hatch streak counter isn't reset mid-revision-cycle.
    const isSamePhaseRecovery = state.phase_checkpoint?.phase === 0;
    const priorCompleted = isSamePhaseRecovery
      ? new Set(state.phase_checkpoint!.completed_agents)
      : new Set<string>();
    const priorRevisionCount = isSamePhaseRecovery ? state.phase_checkpoint!.gate_revision_count : 0;
    const priorUnresolvedStreak = isSamePhaseRecovery ? state.phase_checkpoint!.unresolved_streak : 0;

    await this.session.update(projectDir, {
      current_phase: 0,
      phase_checkpoint: {
        phase: 0,
        completed_agents: [...priorCompleted],
        in_progress_agent: null,
        in_progress_artifact_partial: null,
        spec_version_at_start: state.spec_version,
        gate_revision_count: priorRevisionCount,
        unresolved_streak: priorUnresolvedStreak,
      },
    });

    // PM: concept document
    if (!priorCompleted.has('pm')) {
      await this.dispatchAgent({
        role: 'pm',
        phase: 0,
        projectDir,
        contextArtifacts: [],
        contextPrefix: `The user's project idea:\n\n${state.config.idea}\n\nProject type: ${state.config.project_type}\n\nWrite the one-page concept document (00-concept.md) for this project.`,
      });
    }

    // Validator: review concept
    if (!priorCompleted.has('validator')) {
      await this.dispatchAgent({
        role: 'validator',
        phase: 0,
        projectDir,
        contextArtifacts: [{ artifact: '00-concept.md', type: 'required' }],
        contextPrefix: 'Review the concept for feasibility and obvious gaps. Write your findings to 00-validator.json.',
      });
    }

    await this.openGate(projectDir, 0, 1, ['00-concept.md', '00-validator.json']);
  }

  // ─── Phase 1 — Architecture ─────────────────────────────────────────────────

  private async runPhase1(projectDir: string): Promise<void> {
    const state = await this.session.read(projectDir);

    // On crash recovery, preserve completed_agents, gate_revision_count, and
    // unresolved_streak so agents that finished aren't re-run and the escape
    // hatch streak counter isn't reset mid-revision-cycle.
    const isSamePhaseRecovery = state.phase_checkpoint?.phase === 1;
    const priorCompleted = isSamePhaseRecovery
      ? new Set(state.phase_checkpoint!.completed_agents)
      : new Set<string>();
    const priorRevisionCount = isSamePhaseRecovery ? state.phase_checkpoint!.gate_revision_count : 0;
    const priorUnresolvedStreak = isSamePhaseRecovery ? state.phase_checkpoint!.unresolved_streak : 0;

    await this.session.update(projectDir, {
      current_phase: 1,
      phase_checkpoint: {
        phase: 1,
        completed_agents: [...priorCompleted],
        in_progress_agent: null,
        in_progress_artifact_partial: null,
        spec_version_at_start: state.spec_version,
        gate_revision_count: priorRevisionCount,
        unresolved_streak: priorUnresolvedStreak,
      },
    });

    // PM: full PRD
    if (!priorCompleted.has('pm')) {
      await this.dispatchAgent({
        role: 'pm',
        phase: 1,
        projectDir,
        contextArtifacts: [
          { artifact: '00-concept.md', type: 'required' },
          { artifact: '00-validator.json', type: 'reference' },
        ],
        contextPrefix: 'Expand the approved concept into a full PRD with user stories, acceptance criteria, and non-functional requirements. Write to 01-prd.md.',
      });
    }

    // Architect: project skeleton
    if (!priorCompleted.has('architect')) {
      await this.dispatchAgent({
        role: 'architect',
        phase: 1,
        projectDir,
        contextArtifacts: [
          { artifact: '01-prd.md', type: 'required' },
          { artifact: '00-concept.md', type: 'reference' },
        ],
        contextPrefix: 'Define the project skeleton, tech stack, dependency list, database schema, and OpenAPI spec. Write to 01-architecture.md, 01-api-spec.yaml, and 01-schema.yaml.',
      });
    }

    // Engineer: scaffold
    if (!priorCompleted.has('engineer')) {
      await this.dispatchAgent({
        role: 'engineer',
        phase: 1,
        projectDir,
        contextArtifacts: [
          { artifact: '01-prd.md', type: 'required' },
          { artifact: '01-architecture.md', type: 'required' },
          { artifact: '01-api-spec.yaml', type: 'required' },
          { artifact: '01-schema.yaml', type: 'required' },
        ],
        contextPrefix: 'Scaffold database models and the core server skeleton into src/. Generate infra/docker-compose.test.yml and .env.test. This is real code, not pseudocode.',
      });
    }

    // Validator
    if (!priorCompleted.has('validator')) {
      await this.dispatchAgent({
        role: 'validator',
        phase: 1,
        projectDir,
        contextArtifacts: [
          { artifact: '01-prd.md', type: 'required' },
          { artifact: '01-architecture.md', type: 'required' },
          { artifact: '01-api-spec.yaml', type: 'reference' },
          { artifact: '01-schema.yaml', type: 'reference' },
        ],
        contextPrefix: 'Validate the architecture artifacts and scaffold. Write findings to 01-validator.json.',
      });
    }

    await this.openGate(projectDir, 1, 2, [
      '01-prd.md', '01-architecture.md', '01-api-spec.yaml', '01-schema.yaml', '01-validator.json',
    ]);
  }

  // ─── Phase 2 — Build ────────────────────────────────────────────────────────

  private async runPhase2(projectDir: string): Promise<void> {
    const state = await this.session.read(projectDir);
    const claDosDir = path.join(projectDir, '.clados');

    // On crash recovery, preserve completed_agents, gate_revision_count, and
    // unresolved_streak so agents that finished aren't re-run and the escape
    // hatch streak counter isn't reset mid-revision-cycle.
    const isSamePhaseRecovery = state.phase_checkpoint?.phase === 2;
    const priorCompleted = isSamePhaseRecovery
      ? new Set(state.phase_checkpoint!.completed_agents)
      : new Set<string>();
    const priorRevisionCount = isSamePhaseRecovery ? state.phase_checkpoint!.gate_revision_count : 0;
    const priorUnresolvedStreak = isSamePhaseRecovery ? state.phase_checkpoint!.unresolved_streak : 0;

    await this.session.update(projectDir, {
      current_phase: 2,
      phase_checkpoint: {
        phase: 2,
        completed_agents: [...priorCompleted],
        in_progress_agent: null,
        in_progress_artifact_partial: null,
        spec_version_at_start: state.spec_version,
        gate_revision_count: priorRevisionCount,
        unresolved_streak: priorUnresolvedStreak,
      },
    });

    const isFullStack = state.config.project_type === 'full-stack';

    // Stage A — Implementation
    if (isFullStack) {
      // Backend and frontend engineers run in parallel; skip any already completed
      const needsBackend = !priorCompleted.has('engineer-backend');
      const needsFrontend = !priorCompleted.has('engineer-frontend');
      if (needsBackend || needsFrontend) {
        await Promise.all([
          needsBackend ? this.dispatchAgent({
            role: 'engineer',
            phase: 2,
            projectDir,
            contextArtifacts: [
              { artifact: '01-prd.md', type: 'required' },
              { artifact: '01-architecture.md', type: 'required' },
              { artifact: '01-api-spec.yaml', type: 'required' },
              { artifact: '01-schema.yaml', type: 'required' },
            ],
            contextPrefix: 'You are building the BACKEND. Pass 1: emit 02-build/backend-engineer-manifest.json. Pass 2: implement in batches. Pass 3: emit 02-build/test-context.json.',
            variables: { project_type: state.config.project_type, engineer_role: 'backend' },
            errorKey: 'engineer-backend',
          }) : Promise.resolve(),
          needsFrontend ? this.dispatchAgent({
            role: 'engineer',
            phase: 2,
            projectDir,
            contextArtifacts: [
              { artifact: '01-prd.md', type: 'required' },
              { artifact: '01-architecture.md', type: 'required' },
              { artifact: '01-api-spec.yaml', type: 'required' },
            ],
            contextPrefix: 'You are building the FRONTEND. Pass 1: emit 02-build/frontend-engineer-manifest.json. Pass 2: implement in batches using the OpenAPI spec as the backend contract.',
            variables: { project_type: state.config.project_type, engineer_role: 'frontend' },
            errorKey: 'engineer-frontend',
          }) : Promise.resolve(),
        ]);
      }
    } else {
      if (!priorCompleted.has('engineer')) {
        await this.dispatchAgent({
          role: 'engineer',
          phase: 2,
          projectDir,
          contextArtifacts: [
            { artifact: '01-prd.md', type: 'required' },
            { artifact: '01-architecture.md', type: 'required' },
            { artifact: '01-api-spec.yaml', type: 'required' },
            { artifact: '01-schema.yaml', type: 'required' },
          ],
          contextPrefix: 'Pass 1: emit 02-build/backend-engineer-manifest.json. Pass 2: implement in batches. Pass 3: emit 02-build/test-context.json.',
          variables: { project_type: state.config.project_type },
        });
      }
    }

    // L-3: Check for spec_version drift during the engineer run.
    // If the API spec was bumped (either engineer modified it), log and note that
    // the contract validator re-run in Stage B is warranted.
    // L-3: Check for spec_version drift during the parallel engineer run.
    // For full-stack projects: the frontend engineer ran concurrently with the backend and
    // may have built against a stale API spec. Re-run it now with the updated spec so Stage B
    // contract validation reflects both engineers' full intent.
    // For single-engineer projects: a spec bump is unusual but possible (e.g. from read→revise
    // loops); log it and let the always-running contract validator catch any mismatches.
    const stateAfterEngineers = await this.session.read(projectDir);
    if (stateAfterEngineers.spec_version !== state.spec_version) {
      if (isFullStack) {
        this.logger.warn(
          'spec_version.diverged',
          `API spec changed during parallel engineer run (${state.spec_version} → ${stateAfterEngineers.spec_version}) — re-running frontend engineer against updated spec`,
        );
        await this.dispatchAgent({
          role: 'engineer',
          phase: 2,
          projectDir,
          contextArtifacts: [
            { artifact: '01-prd.md', type: 'required' },
            { artifact: '01-architecture.md', type: 'required' },
            { artifact: '01-api-spec.yaml', type: 'required' },
          ],
          contextPrefix: 'The backend engineer updated 01-api-spec.yaml while you were running in parallel. Re-read the updated spec and revise your frontend implementation: update API call sites, request/response type definitions, and any endpoints that changed or were added. Do not change existing working code unrelated to the spec change.',
          variables: { project_type: state.config.project_type, engineer_role: 'frontend' },
          errorKey: 'engineer-frontend',
        });
      } else {
        this.logger.info(
          'spec_version.diverged',
          `API spec version changed during Phase 2 engineer run (${state.spec_version} → ${stateAfterEngineers.spec_version}) — contract validator re-run in Stage B is warranted`,
        );
      }
    }

    // Verify test-context.json exists before dispatching QA
    const testContextPath = path.join(claDosDir, '02-build', 'test-context.json');
    if (!fs.existsSync(testContextPath)) {
      throw new Error('Engineer did not produce test-context.json — cannot dispatch QA');
    }

    // Stage B — Run Contract Validator, QA→TestRunner, Security in parallel
    const { runContractValidator } = await import('../agents/_subagents/contract-validator.js');
    const { runTestRunner } = await import('../agents/_subagents/test-runner.js');

    const entryFile = path.join(projectDir, 'src', 'index.ts');
    const specPath = path.join(claDosDir, '01-api-spec.yaml');

    // Use registry entries to evaluate enabled_when — not hardcoded strings (#16)
    const securityEntry = this.getRegistryEntry('security');
    const wreckerEntry = this.getRegistryEntry('wrecker');
    const securityEnabled = isAgentEnabled(securityEntry.enabled_when, state.config);
    const wreckerEnabled = isAgentEnabled(wreckerEntry.enabled_when, state.config);

    await Promise.all([
      // Contract Validator (automated — not guarded by semaphore; always re-run, deterministic)
      runContractValidator(projectDir, specPath, entryFile),

      // QA → TestRunner (sequential pair; skip QA dispatch if already completed)
      priorCompleted.has('qa')
        ? runTestRunner(projectDir)
        : this.dispatchAgent({
            role: 'qa',
            phase: 2,
            projectDir,
            // QA: asymmetric context — NO src/, NO schema
            contextArtifacts: [
              { artifact: '01-prd.md', type: 'required' },
              { artifact: '01-api-spec.yaml', type: 'required' },
              { artifact: '02-build/test-context.json', type: 'required' },
            ],
            contextPrefix: 'Write the test suite as specified. Do NOT read src/ or 01-schema.yaml. You have no access to the implementation.',
            variables: { project_type: state.config.project_type },
            deniedPrefixes: ['src', '.clados/01-schema.yaml'],
          }).then(async () => {
            return runTestRunner(projectDir);
          }),

      // Security (if enabled) — runs parallel to QA
      securityEnabled && !priorCompleted.has('security')
        ? this.dispatchAgent({
            role: 'security',
            phase: 2,
            projectDir,
            contextArtifacts: [
              { artifact: '01-architecture.md', type: 'reference' },
              { artifact: '01-api-spec.yaml', type: 'reference' },
            ],
            contextPrefix: 'Run threat model and dependency audit. Read src/ as needed. Write to 02-build/security-report.md.',
          })
        : Promise.resolve(null),
    ]);

    // Stage C — Wrecker (if enabled), then Validator
    if (wreckerEnabled && !priorCompleted.has('wrecker')) {
      await this.dispatchAgent({
        role: 'wrecker',
        phase: 2,
        projectDir,
        contextArtifacts: [
          { artifact: '01-prd.md', type: 'reference' },
          { artifact: '01-api-spec.yaml', type: 'reference' },
          { artifact: '02-build/test-runner.json', type: 'required' },
        ],
        contextPrefix: 'Write adversarial edge-case tests to tests/adversarial/. Target the failure gaps in the test results.',
      });
      await runTestRunner(projectDir, undefined, true);
    }

    // Build validator artifact list
    const validatorArtifacts: ContextArtifact[] = [
      { artifact: '01-prd.md', type: 'reference' },
      { artifact: '02-build/contract-validator.json', type: 'required' },
      { artifact: '02-build/test-runner.json', type: 'required' },
    ];
    if (securityEnabled) {
      validatorArtifacts.push({ artifact: '02-build/security-report.md', type: 'reference' });
    }
    if (wreckerEnabled) {
      validatorArtifacts.push({ artifact: '02-build/wrecker.json', type: 'reference' });
    }

    if (!priorCompleted.has('validator')) {
      await this.dispatchAgent({
        role: 'validator',
        phase: 2,
        projectDir,
        contextArtifacts: validatorArtifacts,
        contextPrefix: 'Review all build artifacts, test results, and contract findings. Write your findings to 02-build/validator.json.',
      });
    }

    const gateArtifacts = [
      '02-build/backend-engineer-manifest.json',
      ...(isFullStack ? ['02-build/frontend-engineer-manifest.json'] : []),
      '02-build/contract-validator.json',
      '02-build/test-runner.json',
      // Include optional agent reports so the human can review them at the gate
      ...(securityEnabled ? ['02-build/security-report.md'] : []),
      ...(wreckerEnabled ? ['02-build/wrecker.json'] : []),
      '02-build/validator.json',
    ];
    await this.openGate(projectDir, 2, 3, gateArtifacts);
  }

  // ─── Phase 3 — Document ──────────────────────────────────────────────────────

  private async runPhase3(projectDir: string): Promise<void> {
    const state = await this.session.read(projectDir);

    // On crash recovery, preserve completed_agents, gate_revision_count, and
    // unresolved_streak so agents that finished aren't re-run and the escape
    // hatch streak counter isn't reset mid-revision-cycle.
    const isSamePhaseRecovery = state.phase_checkpoint?.phase === 3;
    const priorCompleted = isSamePhaseRecovery
      ? new Set(state.phase_checkpoint!.completed_agents)
      : new Set<string>();
    const priorRevisionCount = isSamePhaseRecovery ? state.phase_checkpoint!.gate_revision_count : 0;
    const priorUnresolvedStreak = isSamePhaseRecovery ? state.phase_checkpoint!.unresolved_streak : 0;

    await this.session.update(projectDir, {
      current_phase: 3,
      phase_checkpoint: {
        phase: 3,
        completed_agents: [...priorCompleted],
        in_progress_agent: null,
        in_progress_artifact_partial: null,
        spec_version_at_start: state.spec_version,
        gate_revision_count: priorRevisionCount,
        unresolved_streak: priorUnresolvedStreak,
      },
    });

    // Docs agent
    if (!priorCompleted.has('docs')) {
      await this.dispatchAgent({
        role: 'docs',
        phase: 3,
        projectDir,
        contextArtifacts: [
          { artifact: '01-prd.md', type: 'reference' },
          { artifact: '01-api-spec.yaml', type: 'reference' },
          { artifact: '02-build/test-runner.json', type: 'reference' },
        ],
        contextPrefix: 'Write README, changelog, and runbook based on the actual functioning codebase. Read src/ and tests/ via read_file as needed. Write to docs/.',
        variables: { project_type: state.config.project_type },
      });
    }

    // PM: final PRD and canonical API spec.
    // Bug 2 fix: 03-api-spec-draft.yaml never exists; PM derives the final spec by reading src/.
    if (!priorCompleted.has('pm')) {
      await this.dispatchAgent({
        role: 'pm',
        phase: 3,
        projectDir,
        contextArtifacts: [
          { artifact: '01-prd.md', type: 'required' },
          { artifact: '01-api-spec.yaml', type: 'required' },
          { artifact: '02-build/test-runner.json', type: 'reference' },
        ],
        contextPrefix: 'Write the final PRD (03-prd.md). Then produce 03-api-spec.yaml as the canonical record of the API as actually built — use read_file to inspect src/ routes and verify each endpoint against the original 01-api-spec.yaml. Preserve 01-api-spec.yaml unchanged.',
      });
    }

    // Validator
    if (!priorCompleted.has('validator')) {
      await this.dispatchAgent({
        role: 'validator',
        phase: 3,
        projectDir,
        contextArtifacts: [
          { artifact: '03-prd.md', type: 'required' },
          { artifact: '03-api-spec.yaml', type: 'required' },
        ],
        contextPrefix: 'Review documentation for accuracy against the code. Write findings to 03-validator.json.',
      });
    }

    await this.openGate(projectDir, 3, 4, ['03-prd.md', '03-api-spec.yaml', '03-validator.json']);
  }

  // ─── Phase 4 — Ship ─────────────────────────────────────────────────────────

  private async runPhase4(projectDir: string): Promise<void> {
    const state = await this.session.read(projectDir);

    // On crash recovery, preserve completed_agents, gate_revision_count, and
    // unresolved_streak so agents that finished aren't re-run and the escape
    // hatch streak counter isn't reset mid-revision-cycle.
    const isSamePhaseRecovery = state.phase_checkpoint?.phase === 4;
    const priorCompleted = isSamePhaseRecovery
      ? new Set(state.phase_checkpoint!.completed_agents)
      : new Set<string>();
    const priorRevisionCount = isSamePhaseRecovery ? state.phase_checkpoint!.gate_revision_count : 0;
    const priorUnresolvedStreak = isSamePhaseRecovery ? state.phase_checkpoint!.unresolved_streak : 0;

    await this.session.update(projectDir, {
      current_phase: 4,
      phase_checkpoint: {
        phase: 4,
        completed_agents: [...priorCompleted],
        in_progress_agent: null,
        in_progress_artifact_partial: null,
        spec_version_at_start: state.spec_version,
        gate_revision_count: priorRevisionCount,
        unresolved_streak: priorUnresolvedStreak,
      },
    });

    if (!priorCompleted.has('devops')) {
      await this.dispatchAgent({
        role: 'devops',
        phase: 4,
        projectDir,
        contextArtifacts: [
          { artifact: '01-architecture.md', type: 'reference' },
          { artifact: '03-prd.md', type: 'reference' },
          { artifact: '03-api-spec.yaml', type: 'reference' },
        ],
        contextPrefix: 'Generate Dockerfiles, CI/CD configuration, environment config, and deployment runbook. Write to infra/ and docs/runbook.md.',
        variables: { project_type: state.config.project_type },
      });
    }

    if (!priorCompleted.has('validator')) {
      await this.dispatchAgent({
        role: 'validator',
        phase: 4,
        projectDir,
        contextArtifacts: [
          { artifact: '01-architecture.md', type: 'reference' },
        ],
        contextPrefix: 'Review the deployment configuration for security and completeness. ' +
          'Read infra/ and docs/runbook.md via read_file to inspect the generated Dockerfiles, ' +
          'CI/CD config, and runbook. Write findings to 04-validator.json.',
      });
    }

    await this.openGate(projectDir, 4, 5, [
      '04-validator.json',
      'infra/docker-compose.yml',
      'infra/Dockerfile',
    ]);
  }

  // ─── Gate logic ─────────────────────────────────────────────────────────────

  /** Compute the cost estimate string for the next phase. Shared by openGate and openGateTerminal. */
  private estimateNextPhaseCost(phase: number, state: SessionState, revisionCount: number): string {
    const nextPhaseAgents = this.getPhaseAgents(phase + 1, state.config);
    return BudgetManager.estimateNextPhase(
      nextPhaseAgents,
      Object.fromEntries(nextPhaseAgents.map((a) => [a.role, resolveModel(a.default_model, a.escalation_model, revisionCount, state.config.is_high_complexity)])),
      // M-15: use stored artifact token counts instead of hardcoded 2000
      Object.fromEntries(nextPhaseAgents.map((a) => {
        const totalTokens = (a.context_artifacts ?? []).reduce((sum, art) => {
          const record = state.artifacts?.[art.artifact];
          return sum + (record?.token_count ?? 500);
        }, 0);
        return [a.role, totalTokens || 2000];
      })),
    );
  }

  private async openGate(
    projectDir: string,
    phase: number,
    gateNumber: number,
    artifactKeys: string[],
  ): Promise<void> {
    const state = await this.session.read(projectDir);
    const claDosDir = path.join(projectDir, '.clados');
    const checkpoint = state.phase_checkpoint!;

    // Load findings from the Validator output for this phase
    const findings = await this.loadValidatorFindings(claDosDir, phase);

    const nextPhaseCostEstimate = this.estimateNextPhaseCost(phase, state, checkpoint.gate_revision_count);

    await this.session.update(projectDir, { pipeline_status: 'gate_pending' });

    this.currentGateEvent = {
      type: 'gate:open',
      phase,
      gate_number: gateNumber,
      artifacts: artifactKeys,
      findings,
      revision_count: checkpoint.gate_revision_count,
      next_phase_cost_estimate: nextPhaseCostEstimate,
    };
    this.broadcast(this.currentGateEvent);

    this.logger.info('gate.open', `Gate ${gateNumber} open — waiting for human decision`);

    // Wait for human — loop until the gate is definitively resolved.
    // A blocked approve (unoverridden must_fix findings) re-broadcasts the gate
    // and re-waits rather than silently advancing the pipeline.
    for (;;) {
      const response = await this.waitForGate(projectDir);

      switch (response.action) {
        case 'approve': {
          const approved = await this.handleGateApprove(projectDir, phase, response);
          if (approved) return;
          // Blocked — re-broadcast so the client knows the gate is still open
          this.currentGateEvent = {
            type: 'gate:open',
            phase,
            gate_number: gateNumber,
            artifacts: artifactKeys,
            findings,
            revision_count: checkpoint.gate_revision_count,
            next_phase_cost_estimate: nextPhaseCostEstimate,
          };
          this.broadcast(this.currentGateEvent);
          break;
        }

        case 'revise':
          await this.handleGateRevise(projectDir, phase, gateNumber, artifactKeys, response);
          return;

        case 'abort':
          await this.session.update(projectDir, { pipeline_status: 'abandoned' });
          this.logger.info('gate.abandoned', 'Project abandoned at gate');
          throw new Error('PIPELINE_ABANDONED');

        case 'goto':
          await this.handleGateGoto(projectDir, phase, response.goto_gate);
          throw new Error(`GOTO_PHASE_${response.goto_gate}`);
      }
    }
  }

  private async handleGateApprove(
    projectDir: string,
    phase: number,
    response: Extract<GateResponse, { action: 'approve' }>,
  ): Promise<boolean> {
    const state = await this.session.read(projectDir);
    const claDosDir = path.join(projectDir, '.clados');

    // Server-side enforcement: cannot approve with unoverridden must_fix findings
    const findings = await this.loadValidatorFindings(claDosDir, phase);
    const mustFix = findings.filter((f) => f.severity === 'must_fix' && f.status !== 'resolved');
    const overridden = new Set(response.override_findings ?? []);
    const unaddressed = mustFix.filter((f) => !overridden.has(f.id));
    if (unaddressed.length > 0) {
      this.logger.warn(
        'gate.approve_blocked',
        `Approve rejected: ${unaddressed.length} must_fix finding(s) not overridden at phase ${phase}`,
      );
      // Re-open the gate rather than silently advancing
      await this.session.update(projectDir, { pipeline_status: 'gate_pending' });
      return false;
    }

    // Handle overridden findings
    if (response.override_findings && response.override_findings.length > 0) {
      await this.session.appendDecision(projectDir, {
        phase,
        agent: 'human',
        trigger: 'gate_approve_with_overrides',
        decision: `Human overrode findings: ${response.override_findings.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
    }

    await this.session.update(projectDir, {
      pipeline_status: 'agent_running',
      phases_completed: [...state.phases_completed, phase],
      phase_checkpoint: {
        ...state.phase_checkpoint!,
        gate_revision_count: 0,
        unresolved_streak: 0,
      },
    });
    return true;
  }

  private async handleGateRevise(
    projectDir: string,
    phase: number,
    gateNumber: number,
    artifactKeys: string[],
    response: Extract<GateResponse, { action: 'revise' }>,
  ): Promise<void> {
    const state = await this.session.read(projectDir);
    const checkpoint = state.phase_checkpoint!;
    const newRevisionCount = checkpoint.gate_revision_count + 1;

    await this.session.updateCheckpoint(projectDir, {
      gate_revision_count: newRevisionCount,
    });

    if (checkpoint.unresolved_streak > UNRESOLVED_STREAK_REASON_THRESHOLD) {
      // Escape hatch already fired and the guided re-run still didn't resolve it.
      // Force a terminal human-decision gate. The escape hatch does not repeat.
      await this.openGateTerminal(projectDir, phase, gateNumber, artifactKeys, newRevisionCount);
      return;
    }

    let conductorGuidance = '';
    if (checkpoint.unresolved_streak === UNRESOLVED_STREAK_REASON_THRESHOLD) {
      // First time hitting the threshold: call conductor.reason() to log guidance.
      // If the API fails, log and proceed with the revision anyway.
      const reasoned = await this.conductorReason(projectDir, phase, checkpoint, response.revision_text)
        .catch((err) => {
          this.logger.warn('conductor.reason_failed', String(err));
          return false;
        });
      if (reasoned) {
        const freshState = await this.session.read(projectDir);
        const lastReasoning = freshState.conductor_reasoning?.at(-1);
        if (lastReasoning) {
          conductorGuidance = `\n\nCONDUCTOR STRATEGIC GUIDANCE:\n${lastReasoning.response}`;
        }
      }
    }

    // Re-run the phase
    await this.session.update(projectDir, { pipeline_status: 'agent_running' });
    await this.runPhaseRevision(projectDir, phase, response.revision_text, conductorGuidance);

    // Re-open gate after revision
    await this.openGate(projectDir, phase, gateNumber, artifactKeys);
  }

  /**
   * Open a terminal gate when the escape hatch has fired and the guided re-run
   * still left must_fix findings unresolved.
   * Unlike openGate, this gate waits for human decision inline rather than returning
   * to the phase runner, so the pipeline cannot silently continue past it.
   */
  private async openGateTerminal(
    projectDir: string,
    phase: number,
    gateNumber: number,
    artifactKeys: string[],
    revisionCount: number,
  ): Promise<void> {
    const claDosDir = path.join(projectDir, '.clados');
    const findings = await this.loadValidatorFindings(claDosDir, phase);
    const state = await this.session.read(projectDir);
    const nextPhaseCostEstimate = this.estimateNextPhaseCost(phase, state, revisionCount);

    await this.session.update(projectDir, { pipeline_status: 'gate_pending' });
    this.broadcast({
      type: 'gate:open',
      phase,
      gate_number: gateNumber,
      artifacts: artifactKeys,
      findings,
      revision_count: revisionCount,
      next_phase_cost_estimate: nextPhaseCostEstimate,
    });

    this.logger.warn(
      'conductor.escape_hatch_terminal',
      `Three guided revisions have not resolved must-fix findings at Phase ${phase}. Human decision required.`,
    );

    for (;;) {
      const humanResponse = await this.waitForGate(projectDir);

      switch (humanResponse.action) {
        case 'approve': {
          const approved = await this.handleGateApprove(projectDir, phase, humanResponse);
          if (approved) return;
          this.broadcast({
            type: 'gate:open',
            phase,
            gate_number: gateNumber,
            artifacts: artifactKeys,
            findings,
            revision_count: revisionCount,
            next_phase_cost_estimate: nextPhaseCostEstimate,
          });
          break;
        }
        case 'revise':
          await this.session.update(projectDir, { pipeline_status: 'agent_running' });
          await this.runPhaseRevision(projectDir, phase, humanResponse.revision_text, '');
          await this.openGate(projectDir, phase, gateNumber, artifactKeys);
          return;
        case 'abort':
          await this.session.update(projectDir, { pipeline_status: 'abandoned' });
          throw new Error('PIPELINE_ABANDONED');
        case 'goto':
          await this.handleGateGoto(projectDir, phase, humanResponse.goto_gate);
          throw new Error(`GOTO_PHASE_${humanResponse.goto_gate}`);
      }
    }
  }

  private async handleGateGoto(
    projectDir: string,
    _fromPhase: number,
    targetGate: number,
  ): Promise<void> {
    const targetPhase = targetGate - 1;
    const claDosDir = path.join(projectDir, '.clados');
    const historyDir = path.join(claDosDir, 'history', `rollback-${Date.now()}`);
    await fs.promises.mkdir(historyDir, { recursive: true });

    // Always archive source directories so rolled-back work is preserved
    for (const dir of ['src', 'tests', 'infra', 'docs']) {
      const src = path.join(projectDir, dir);
      if (fs.existsSync(src)) {
        await fs.promises.cp(src, path.join(historyDir, dir), { recursive: true });
        // Remove so re-run from scaffold doesn't pick up stale phase code
        await fs.promises.rm(src, { recursive: true, force: true });
      }
    }

    // Archive .clados/ phase artifacts for phases >= targetPhase so the
    // re-run cannot accidentally read stale outputs from the discarded run.
    const phaseArtifactPrefixes: Record<number, string[]> = {
      0: ['00-'],
      1: ['01-'],
      2: ['02-build'],
      3: ['03-'],
      4: ['04-'],
    };
    const cladosArchiveDir = path.join(historyDir, '.clados');
    await fs.promises.mkdir(cladosArchiveDir, { recursive: true });
    for (let p = targetPhase; p <= 4; p++) {
      const prefixes = phaseArtifactPrefixes[p] ?? [];
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(claDosDir, { withFileTypes: true });
      } catch {
        break;
      }
      for (const dirent of entries) {
        if (prefixes.some((pfx) => dirent.name.startsWith(pfx))) {
          const src = path.join(claDosDir, dirent.name);
          const dest = path.join(cladosArchiveDir, dirent.name);
          await fs.promises.cp(src, dest, { recursive: true });
          await fs.promises.rm(src, { recursive: true, force: true });
        }
      }
    }

    // Reset phase state
    const state = await this.session.read(projectDir);
    const newPhasesCompleted = state.phases_completed.filter((p) => p < targetPhase);
    await this.session.update(projectDir, {
      current_phase: targetPhase,
      phases_completed: newPhasesCompleted,
      phase_checkpoint: null,
      pipeline_status: 'agent_running',
    });

    // Clear WIP directory so stale partial files don't confuse crash recovery on the re-run
    const wipDir = path.join(projectDir, '.clados', 'wip');
    if (fs.existsSync(wipDir)) {
      await fs.promises.rm(wipDir, { recursive: true, force: true });
      await fs.promises.mkdir(wipDir);
    }
  }

  // ─── conductor.reason() escape hatch ────────────────────────────────────────

  private async conductorReason(
    projectDir: string,
    phase: number,
    checkpoint: PhaseCheckpoint,
    revisionText: string,
  ): Promise<boolean> {
    const claDosDir = path.join(projectDir, '.clados');
    const findings = await this.loadValidatorFindings(claDosDir, phase);
    const mustFix = findings.filter(
      (f) => f.severity === 'must_fix' && (f.status === 'unresolved' || f.status === 'new'),
    );

    const question = `Phase ${phase} has had ${checkpoint.unresolved_streak} consecutive revision cycles. These must_fix findings remain unresolved:\n\n${JSON.stringify(mustFix, null, 2)}\n\nHuman revision request: "${revisionText}"\n\nHow should the Conductor proceed? Be specific about which aspects of the implementation need to change to resolve these findings.`;

    this.logger.info('conductor.reason', `Invoking reasoning escape hatch for phase ${phase}`);

    try {
      const msg = await this.anthropic.messages.create({
        model: this.registry.utility_models.conductor,
        max_tokens: 1500,
        messages: [{ role: 'user', content: question }],
      });
      const textBlock = msg.content.find((b) => b.type === 'text');
      const response = textBlock?.type === 'text' ? textBlock.text : '';

      await this.session.appendReasoning(projectDir, {
        phase,
        context_summary: `Gate revision ${checkpoint.gate_revision_count}, unresolved streak ${checkpoint.unresolved_streak}`,
        question,
        response,
        timestamp: new Date().toISOString(),
      });

      return true;
    } catch (err) {
      this.logger.error('conductor.reason_failed', `Reasoning call failed: ${String(err)}`);
      return false;
    }
  }

  // ─── Phase revision dispatch ─────────────────────────────────────────────────

  private async runPhaseRevision(
    projectDir: string,
    phase: number,
    revisionText: string,
    conductorGuidance = '',
  ): Promise<void> {
    const state = await this.session.read(projectDir);
    const claDosDir = path.join(projectDir, '.clados');
    const findings = await this.loadValidatorFindings(claDosDir, phase);
    const mustFixFindings = findings.filter((f) => f.severity === 'must_fix');

    // Re-dispatch only agents that own flagged files
    const flaggedFiles = [...new Set(mustFixFindings.map((f) => f.file).filter(Boolean))];

    const revisedContextPrefix =
      `REVISION REQUEST: ${revisionText}\n\n` +
      `MUST-FIX FINDINGS:\n${JSON.stringify(mustFixFindings, null, 2)}\n\n` +
      `FLAGGED FILES (focus your changes here):\n${flaggedFiles.join('\n')}` +
      conductorGuidance;

    switch (phase) {
      case 0:
        await this.session.archiveArtifact(projectDir, '00-concept.md');  // H-7
        await this.dispatchAgent({
          role: 'pm', phase: 0, projectDir,
          contextArtifacts: [{ artifact: '00-concept.md', type: 'required' }],
          contextPrefix: revisedContextPrefix,
        });
        await this.session.archiveArtifact(projectDir, '00-validator.json');  // H-7
        await this.dispatchAgent({
          role: 'validator', phase: 0, projectDir,
          contextArtifacts: [
            { artifact: '00-concept.md', type: 'required' },
            { artifact: '00-validator.json', type: 'required' },
          ],
          contextPrefix: 'Classify each prior finding as resolved/unresolved/new_discovery. Update 00-validator.json.',
        });
        break;

      case 1: {
        // Determine which agents own the flagged files and re-dispatch only those
        const pmFiles = ['01-prd.md'];
        const archFiles = ['01-architecture.md', '01-api-spec.yaml', '01-schema.yaml'];
        const srcFiles = ['src/'];

        const needsPm = mustFixFindings.some(
          (f) => !f.file || pmFiles.some((pf) => f.file?.includes(pf)),
        );
        const needsArchitect =
          mustFixFindings.some((f) => !f.file || archFiles.some((af) => f.file?.includes(af)));
        const needsEngineer = mustFixFindings.some((f) => srcFiles.some((sf) => f.file?.includes(sf)));

        if (needsPm) {
          await this.session.archiveArtifact(projectDir, '01-prd.md');  // H-7
          await this.dispatchAgent({
            role: 'pm', phase: 1, projectDir,
            contextArtifacts: [
              { artifact: '00-concept.md', type: 'required' },
              { artifact: '01-validator.json', type: 'required' },
            ],
            contextPrefix: revisedContextPrefix,
          });
        }
        if (needsArchitect) {
          await this.session.archiveArtifact(projectDir, '01-architecture.md');  // H-7
          await this.dispatchAgent({
            role: 'architect', phase: 1, projectDir,
            contextArtifacts: [
              { artifact: '01-prd.md', type: 'required' },
              { artifact: '00-concept.md', type: 'reference' },
              { artifact: '01-validator.json', type: 'required' },
            ],
            contextPrefix: revisedContextPrefix,
          });
        }
        // Always re-scaffold: architecture may have changed
        if (needsEngineer || needsArchitect) {
          await this.dispatchAgent({
            role: 'engineer', phase: 1, projectDir,
            contextArtifacts: [
              { artifact: '01-architecture.md', type: 'required' },
              { artifact: '01-api-spec.yaml', type: 'required' },
              { artifact: '01-schema.yaml', type: 'required' },
              { artifact: '01-validator.json', type: 'required' },
            ],
            contextPrefix: revisedContextPrefix,
          });
        }
        await this.session.archiveArtifact(projectDir, '01-validator.json');  // H-7
        await this.dispatchAgent({
          role: 'validator', phase: 1, projectDir,
          contextArtifacts: [
            { artifact: '01-prd.md', type: 'required' },
            { artifact: '01-architecture.md', type: 'required' },
            { artifact: '01-validator.json', type: 'required' },
          ],
          contextPrefix: 'Classify each prior finding as resolved/unresolved/new_discovery. Update 01-validator.json.',
        });
        break;
      }

      case 2: {
        const isFullStack = state.config.project_type === 'full-stack';
        const specVersionBefore = state.spec_version;
        // Targeted fix: only re-send flagged files
        await this.session.archiveArtifact(projectDir, '02-build/backend-engineer-manifest.json');  // H-7
        await this.dispatchAgent({
          role: 'engineer', phase: 2, projectDir,
          errorKey: 'engineer-backend',
          contextArtifacts: [
            { artifact: '01-api-spec.yaml', type: 'required' },
            { artifact: '02-build/backend-engineer-manifest.json', type: 'required' },
            { artifact: '02-build/validator.json', type: 'required' },
          ],
          contextPrefix: revisedContextPrefix,
          variables: { project_type: state.config.project_type, engineer_role: 'backend' },
        });
        // For full-stack projects, re-run the frontend Engineer only when findings
        // could plausibly affect frontend files. Skip if ALL findings are clearly
        // attributable to backend-only paths (routes, models, controllers, db, etc.).
        if (isFullStack) {
          const backendOnlyPaths = ['src/routes', 'src/models', 'src/controllers', 'src/db', 'src/middleware', 'src/services'];
          const needsFrontendRerun = mustFixFindings.length === 0 || mustFixFindings.some(
            (f) => !f.file || !backendOnlyPaths.some((p) => f.file!.includes(p)),
          );
          if (needsFrontendRerun) {
            await this.dispatchAgent({
              role: 'engineer', phase: 2, projectDir,
              errorKey: 'engineer-frontend',
              contextArtifacts: [
                { artifact: '01-api-spec.yaml', type: 'required' },
                { artifact: '02-build/frontend-engineer-manifest.json', type: 'required' },
                { artifact: '02-build/validator.json', type: 'required' },
              ],
              contextPrefix: revisedContextPrefix,
              variables: { project_type: state.config.project_type, engineer_role: 'frontend' },
            });
          }
        }
        // Re-run contract validator since route registrations may have changed.
        // Also log if the API spec version diverged during this revision cycle.
        {
          const stateAfterEngineers = await this.session.read(projectDir);
          if (stateAfterEngineers.spec_version !== specVersionBefore) {
            this.logger.info(
              'spec_version.diverged',
              `API spec version changed during revision (${specVersionBefore} → ${stateAfterEngineers.spec_version}) — contract validator re-run triggered`,
            );
          }
          const { runContractValidator } = await import('../agents/_subagents/contract-validator.js');
          const specPath = path.join(projectDir, '.clados', '01-api-spec.yaml');
          const entryFile = path.join(projectDir, 'src', 'index.ts');
          await runContractValidator(projectDir, specPath, entryFile);
        }
        await this.runTestRunner(projectDir);
        await this.session.archiveArtifact(projectDir, '02-build/validator.json');  // H-7
        await this.dispatchAgent({
          role: 'validator', phase: 2, projectDir,
          contextArtifacts: [
            { artifact: '02-build/contract-validator.json', type: 'required' },
            { artifact: '02-build/test-runner.json', type: 'required' },
            { artifact: '02-build/validator.json', type: 'required' },
          ],
          contextPrefix: 'Classify each prior finding. Update 02-build/validator.json.',
        });
        break;
      }

      case 3: {
        const pmFiles = ['03-prd.md', '03-api-spec.yaml'];
        const needsPm = mustFixFindings.some(
          (f) => !f.file || pmFiles.some((pf) => f.file?.includes(pf)),
        );
        if (needsPm) {
          await this.session.archiveArtifact(projectDir, '03-prd.md');  // H-7
          await this.dispatchAgent({
            role: 'pm', phase: 3, projectDir,
            // Bug 2 fix: provide the original design spec as required context;
            // PM derives the canonical spec by reading src/ via read_file.
            contextArtifacts: [
              { artifact: '01-prd.md', type: 'reference' },
              { artifact: '01-api-spec.yaml', type: 'required' },
              { artifact: '03-validator.json', type: 'required' },
            ],
            contextPrefix: revisedContextPrefix,
          });
        }
        // Only re-run docs if findings could plausibly affect documentation files.
        // Any unattributed finding is treated conservatively as potentially docs-related.
        const docsTargets = ['docs/', 'README', 'CHANGELOG', 'runbook'];
        const needsDocs = mustFixFindings.some(
          (f) => !f.file || docsTargets.some((d) => f.file?.includes(d)),
        );
        if (needsDocs) {
          await this.dispatchAgent({
            role: 'docs', phase: 3, projectDir,
            contextArtifacts: [
              { artifact: '03-validator.json', type: 'required' },
            ],
            contextPrefix: revisedContextPrefix,
          });
        }
        await this.session.archiveArtifact(projectDir, '03-validator.json');  // H-7
        await this.dispatchAgent({
          role: 'validator', phase: 3, projectDir,
          contextArtifacts: [
            { artifact: '03-prd.md', type: 'required' },
            { artifact: '03-api-spec.yaml', type: 'required' },
            { artifact: '03-validator.json', type: 'required' },
          ],
          contextPrefix: 'Classify each prior finding. Update 03-validator.json.',
        });
        break;
      }

      case 4:
        await this.dispatchAgent({
          role: 'devops', phase: 4, projectDir,
          contextArtifacts: [
            { artifact: '04-validator.json', type: 'required' },
          ],
          contextPrefix: revisedContextPrefix,
        });
        await this.session.archiveArtifact(projectDir, '04-validator.json');  // H-7
        await this.dispatchAgent({
          role: 'validator', phase: 4, projectDir,
          contextArtifacts: [
            { artifact: '01-architecture.md', type: 'reference' },
            { artifact: '04-validator.json', type: 'required' },
          ],
          contextPrefix: 'Classify each prior finding. Read infra/ and docs/runbook.md via read_file. Update 04-validator.json.',
        });
        break;
    }

    // Update unresolved streak counter
    await this.updateUnresolvedStreak(projectDir, phase);
  }

  private async updateUnresolvedStreak(projectDir: string, phase: number): Promise<void> {
    const claDosDir = path.join(projectDir, '.clados');
    const findings = await this.loadValidatorFindings(claDosDir, phase);
    const hasUnresolved = findings.some(
      (f) => f.severity === 'must_fix' && (f.status === 'unresolved' || f.status === 'new'),
    );

    const state = await this.session.read(projectDir);
    const checkpoint = state.phase_checkpoint!;
    const newStreak = hasUnresolved ? checkpoint.unresolved_streak + 1 : 0;
    await this.session.updateCheckpoint(projectDir, { unresolved_streak: newStreak });
  }

  // ─── Agent dispatch ──────────────────────────────────────────────────────────

  async dispatchAgent(config: AgentDispatchConfig): Promise<AgentResult> {
    const { role, phase, projectDir, variables, contextArtifacts, contextPrefix, modelOverride, errorKey } = config;
    const mapKey = errorKey ?? role;
    const entry = this.getRegistryEntry(role);

    // Throttle TPM before acquiring the semaphore
    const tpm = this.tpmTracker.currentTpm();
    if (tpm > this.registry.rate_limit_tpm * 0.8) {
      this.semaphore.setSlots(1);
    } else {
      this.semaphore.setSlots(3);
    }

    const release = await this.semaphore.acquire();

    try {
      // Outer loop: allows user-initiated retry after full API-retry exhaustion
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Read state inside the semaphore so parallel dispatches (e.g., Phase 2
        // concurrent engineers) each see the latest completed_agents / spec_version.
        const state = await this.session.read(projectDir);
        const checkpoint = state.phase_checkpoint;
        try {
          return await this.dispatchWithRetry(config, entry, state, checkpoint);
        } catch (err) {
          // ── Budget gate ───────────────────────────────────────────────────
          if (err instanceof BudgetGate) {
            this.currentBudgetGateEvent = {
              type: 'budget:gate',
              current_spend_usd: err.currentSpendUsd,
              remaining_budget_usd: err.remainingBudgetUsd,
              blocked_agent: err.blockedAgent,
              projected_cost_usd: err.projectedCostUsd,
            };
            this.broadcast(this.currentBudgetGateEvent);
            // Wait for the user to raise the cap or stop the pipeline
            const shouldContinue = await new Promise<boolean>((resolve) => { this.budgetGateResolve = resolve; });
            this.currentBudgetGateEvent = null;
            if (!shouldContinue) {
              await this.session.update(projectDir, { pipeline_status: 'abandoned' });
              throw new Error('PIPELINE_ABANDONED');
            }
            // Continue outer loop — it will re-read state (with updated spend cap)
            // via the session.read() at the top of the loop before calling dispatchWithRetry.
            continue;
          }

          // ── API retries exhausted ─────────────────────────────────────────
          // Wait for user to click Retry or Skip on the agent card.
          // Store in the per-agent Map so parallel agents each have their own resolver.
          const decision = await new Promise<'retry' | 'skip'>((resolve) => {
            this.agentErrorResolves.set(mapKey, resolve);
          });
          this.agentErrorResolves.delete(mapKey);

          if (decision === 'skip') {
            if (!isSkippable(role)) {
              // Safety: non-skippable agents cannot be skipped; keep waiting
              continue;
            }
            this.logger.warn('agent.skipped', `${role} skipped by user`);
            this.broadcast({ type: 'agent:skipped', phase, agent: errorKey ?? role });
            return {
              role,
              phase,
              artifact_path: '',
              final_text: '',
              tokens_input: 0,
              tokens_output: 0,
              cost_usd: 0,
            };
          }
          // decision === 'retry' — the outer while loop reruns dispatchWithRetry
          this.logger.info('agent.user_retry', `User triggered retry for ${role}`);
        }
      }
    } finally {
      release();
    }
  }

  private async dispatchWithRetry(
    config: AgentDispatchConfig,
    entry: AgentRegistryEntry,
    state: SessionState,
    checkpoint: SessionState['phase_checkpoint'],
  ): Promise<AgentResult> {
    const { role, phase, projectDir, variables, contextArtifacts, contextPrefix, modelOverride, errorKey, deniedPrefixes } = config;
    const claDosDir = path.join(projectDir, '.clados');

    // Resolve model
    const model = modelOverride ?? resolveModel(
      entry.default_model,
      entry.escalation_model,
      checkpoint?.gate_revision_count ?? 0,
      state.config.is_high_complexity,
    );

    // Load system prompt
    const rawPrompt = await fs.promises.readFile(
      path.join(CLADOS_ROOT, entry.system_prompt), 'utf-8',
    );
    const systemPrompt = injectVariables(rawPrompt, {
      project_type: state.config.project_type,
      ...variables,
    });

    this.logger.debug('agent.dispatch_start', `${role} phase ${phase}: loading context`);

    // Assemble context artifacts
    const artifacts = contextArtifacts ?? entry.context_artifacts;

    // Build summarizer budget check: enforce the 5% cap on Haiku summarization cost.
    // Track cumulative cost locally across all summarizer calls within this dispatch.
    let cumulativeSummarizerCost = 0;
    const summarizerBudgetCheck = (projectedCost: number): boolean =>
      this.budgetManager.checkSummarizerBudget(projectedCost, cumulativeSummarizerCost, state);
    const onSummarizerCost = (cost: number): void => { cumulativeSummarizerCost += cost; };

    const { resolved, compressionNeeded, fullFetchPaths } = await resolveContextArtifacts(
      claDosDir,
      artifacts,
      this.anthropic,
      this.logger,
      summarizerBudgetCheck,
      onSummarizerCost,
    );

    // Record summarizer cost to session state so per-phase cost breakdown is accurate
    if (cumulativeSummarizerCost > 0) {
      await this.session.recordTokens(projectDir, phase, 'summarizer', {
        input: 0,
        output: 0,
        cost_usd: cumulativeSummarizerCost,
      });
    }

    // Build context message
    let userContent =
      resolved.map((a) => `### ${a.key}\n\n${a.content}`).join('\n\n---\n\n');
    if (contextPrefix) userContent = contextPrefix + '\n\n' + userContent;

    // Inject crash recovery context for a restarted agent (consumed once).
    // Use mapKey (errorKey ?? role) to match how phase_checkpoint stores in_progress_agent,
    // so full-stack engineer recovery prefixes ('engineer-backend' / 'engineer-frontend') are found.
    const mapKey = config.errorKey ?? config.role;
    const recoveryPrefix = this.crashRecoveryPrefix.get(mapKey);
    if (recoveryPrefix) {
      userContent = recoveryPrefix + '\n\n' + userContent;
      this.crashRecoveryPrefix.delete(mapKey);
    }
    if (fullFetchPaths.length > 0) {
      const prefixed = fullFetchPaths.map((p) => `.clados/${p}`);
      userContent += `\n\n[NOTE: The following artifacts were compressed. Use read_file to access them in full: ${prefixed.join(', ')}]`;
    }

    // Count context tokens separately from the system prompt (H-14).
    // system_prompt_tokens is pre-computed at startup; counting them again here
    // would double-count relative to estimateNextPhase projections.
    const systemTokens = entry.system_prompt_tokens ?? Math.ceil(systemPrompt.length / 3.5);
    this.logger.debug('agent.token_count', `${role} phase ${phase}: estimating context tokens`);
    const contextTokens = await estimateTokens(userContent, this.anthropic, this.logger);
    this.logger.debug('agent.token_count', `${role} phase ${phase}: context ~${contextTokens} tokens, checking budget`);
    const totalInputTokens = systemTokens + contextTokens;

    // Budget pre-check
    await this.budgetManager.checkPreDispatch(projectDir, entry, model, totalInputTokens);

    // Set up WIP artifact path (extension reflects output type; engineer role suffix avoids
    // collision when backend + frontend engineers run concurrently in full-stack mode)
    const engineerSuffix = variables?.engineer_role ? `-${variables.engineer_role}` : '';
    const wipPath = path.join(claDosDir, 'wip', `${phase}-${role}${engineerSuffix}${wipExtForRole(role)}`);
    await fs.promises.mkdir(path.dirname(wipPath), { recursive: true });

    // Update checkpoint: in_progress
    await this.session.updateCheckpoint(projectDir, {
      in_progress_agent: errorKey ?? role,  // use errorKey for composite identity (e.g. 'engineer-backend')
      in_progress_artifact_partial: path.relative(projectDir, wipPath),
    });
    await this.session.update(projectDir, { pipeline_status: 'agent_running' });

    this.logger.setContext(phase, role);
    this.logger.info('agent.dispatch', `Dispatching ${role} (${model}) — context ${contextTokens} tokens + system ${systemTokens} tokens`);
    this.broadcast({ type: 'agent:start', phase, agent: errorKey ?? role, model });

    // Retry loop
    let lastError: Error | null = null;
    let contextCompressed = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? 30_000;
        await new Promise((res) => setTimeout(res, delay));
        this.logger.warn('agent.retry', `Retry attempt ${attempt} for ${role}`);
      }

      try {
        const result = await this.streamingDispatch(
          role, phase, projectDir, claDosDir, wipPath, model,
          systemPrompt, userContent, entry, state, compressionNeeded, deniedPrefixes, errorKey,
        );
        return result;
      } catch (err) {
        lastError = err as Error;
        const errMsg = String(err);
        const isContextLength = errMsg.includes('context_length') || errMsg.includes('too_large');

        if (isContextLength && !contextCompressed) {
          // Downgrade all to summaries and retry once more.
          // Re-prepend contextPrefix so the agent still receives its task instructions.
          contextCompressed = true;
          this.logger.warn('agent.context_length', `Context too large for ${role} — downgrading all artifacts`);
          const compressedArtifacts = resolved
            .map((a) => `### ${a.key}\n\n${a.content.slice(0, 500)}...[compressed]`)
            .join('\n\n---\n\n');
          userContent = contextPrefix ? contextPrefix + '\n\n' + compressedArtifacts : compressedArtifacts;
          continue;
        }

        if (isContextLength) {
          // Already compressed and still too large — don't waste remaining retry slots.
          this.logger.warn('agent.context_overflow', `${role} context too large even after compression — exhausted`);
          break;
        }

        const errorType = this.classifyError(errMsg);
        const retryCount = attempt + 1;

        this.broadcast({
          type: 'agent:error',
          phase,
          agent: errorKey ?? role,
          error_type: errorType,
          message: errMsg.slice(0, 200),
          retry_count: retryCount,
          is_skippable: isSkippable(role),
          error_key: errorKey,
        });

        if (attempt >= MAX_RETRIES - 1) break;
      }
    }

    // All retries exhausted — write error artifact
    const errorArtifact = {
      error_type: this.classifyError(String(lastError)),
      message: String(lastError),
      retry_count: MAX_RETRIES,
      agent: role,
      phase,
    };
    await writeFileAtomic(
      path.join(claDosDir, 'wip', `${role}-error.json`),
      JSON.stringify(errorArtifact, null, 2),
      { encoding: 'utf8' },
    );

    throw lastError ?? new Error(`Agent ${role} failed after ${MAX_RETRIES} retries`);
  }

  private async streamingDispatch(
    role: AgentRole,
    phase: number,
    projectDir: string,
    claDosDir: string,
    wipPath: string,
    model: string,
    systemPrompt: string,
    userContent: string,
    entry: AgentRegistryEntry,
    state: SessionState,
    compressionNeeded: boolean,
    deniedPrefixes?: string[],
    errorKey?: string,
  ): Promise<AgentResult> {
    const tools: Anthropic.Tool[] = this.buildToolDefinitions(entry.tools);
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];

    let wipHandle: fs.WriteStream | null = null;
    let currentSection = '';
    let lineBuffer = '';  // accumulates streaming text to detect headings split across token deltas
    let finalText = '';
    let totalInput = 0;
    let totalOutput = 0;
    const writtenPaths: string[] = [];  // M-14: collect all write_file paths

    // Clean WIP file at start of each attempt
    await writeFileAtomic(wipPath, '', { encoding: 'utf8' });
    wipHandle = fs.createWriteStream(wipPath, { flags: 'a', encoding: 'utf8' });

    try {
      // Streaming dispatch loop with tool use
      while (true) {
        const stream = this.anthropic.messages.stream({
          model,
          max_tokens: 8192,
          system: systemPrompt,
          tools,
          messages,
        });

        let assistantText = '';

        for await (const event of stream) {
          if (event.type === 'content_block_start' && event.content_block.type === 'text') {
            // Text stream starting
          } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const text = event.delta.text;
            assistantText += text;
            wipHandle?.write(text);

            // Emit section heading events — buffer across token boundaries so headings
            // split across multiple small deltas are still detected.
            lineBuffer += text;
            const newlineIdx = lineBuffer.lastIndexOf('\n');
            if (newlineIdx >= 0) {
              const completedLines = lineBuffer.slice(0, newlineIdx);
              lineBuffer = lineBuffer.slice(newlineIdx + 1);
              const headingMatch = completedLines.match(/^## (.+)$/m);
              if (headingMatch && headingMatch[1] !== currentSection) {
                currentSection = headingMatch[1]!;
                this.broadcast({ type: 'agent:stream', phase, agent: errorKey ?? role, section: currentSection });
              }
            }
          }
        }

        const finalMessage = await stream.finalMessage();
        totalInput += finalMessage.usage.input_tokens;
        totalOutput += finalMessage.usage.output_tokens;
        this.tpmTracker.record(finalMessage.usage.input_tokens + finalMessage.usage.output_tokens);

        if (finalMessage.stop_reason === 'end_turn' || finalMessage.stop_reason === 'max_tokens') {
          finalText = assistantText;
          if (finalMessage.stop_reason === 'max_tokens') {
            this.logger.warn('agent.max_tokens', `${role} hit max_tokens limit — output may be truncated`);
          }
          break;
        }

        if (finalMessage.stop_reason === 'tool_use') {
          // Process tool calls
          const toolResults = await this.processToolCalls(
            finalMessage.content, projectDir, deniedPrefixes,
          );
          messages.push({ role: 'assistant', content: finalMessage.content });
          messages.push({ role: 'user', content: toolResults });

          // Collect all write_file paths and update WIP from actual artifact content
          for (const block of finalMessage.content) {
            if (block.type === 'tool_use' && block.name === 'write_file') {
              const writtenPath = (block.input as { path: string; content: string }).path;
              const writtenContent = (block.input as { path: string; content: string }).content;
              if (writtenPath && !writtenPaths.includes(writtenPath)) writtenPaths.push(writtenPath);
              // Write WIP from actual artifact content, not raw conversation text
              if (writtenContent) {
                await writeFileAtomic(wipPath, writtenContent, { encoding: 'utf8' });
              }
            }
          }
        }
      }
    } finally {
      await new Promise<void>((res) => { wipHandle?.end(res); });
    }

    // Determine the primary artifact path (used for broadcast + AgentResult)
    const primaryArtifactPath = writtenPaths[0] ?? this.inferArtifactPath(role, phase);

    if (writtenPaths.length === 0) {
      this.logger.warn('agent.no_writes', `${role} (phase ${phase}) made no write_file calls — inferring artifact path`);
    }

    const costUsd = calculateCostUsd(model, totalInput, totalOutput);

    // Record tokens + cost
    await this.session.recordTokens(projectDir, phase, role, {
      input: totalInput,
      output: totalOutput,
      cost_usd: costUsd,
    });

    // Register every written artifact (M-14); fall back to inferred path if none
    const pathsToRegister = writtenPaths.length > 0 ? writtenPaths : [primaryArtifactPath];
    for (const wp of pathsToRegister) {
      // Only register artifacts that are inside .clados/
      const fullPath = path.join(projectDir, wp);
      const artifactKey = path.relative(claDosDir, fullPath);
      if (artifactKey.startsWith('..') || path.isAbsolute(artifactKey)) {
        // Paths outside .clados/ (e.g. src/, tests/, infra/, docs/) are tracked by the agent:done
        // broadcast but not in session.artifacts (which is used for context injection and cost
        // estimation). This is expected for agents that write to the project tree rather than
        // .clados/. When writtenPaths is empty we inferred this path — the agent.no_writes warn
        // above already signals the real problem; this debug log closes the trace.
        this.logger.debug('agent.artifact_skip', `${role} phase ${phase}: ${wp} is outside .clados/ — not registered in artifacts table`);
        continue;
      }
      try {
        const content = fs.existsSync(fullPath)
          ? await fs.promises.readFile(fullPath, 'utf-8')
          : finalText;
        const tc = await estimateTokens(content, this.anthropic, this.logger);
        await this.session.registerArtifact(projectDir, artifactKey, { path: wp, token_count: tc, version: 1, created_at: new Date().toISOString(), agent: role });
      } catch {
        // Non-fatal: don't fail dispatch over a registration error
      }
    }

    // Update checkpoint: agent complete
    const currentState = await this.session.read(projectDir);
    const completedAgents = [...(currentState.phase_checkpoint?.completed_agents ?? [])];
    if (!completedAgents.includes(errorKey ?? role)) completedAgents.push(errorKey ?? role);
    await this.session.updateCheckpoint(projectDir, {
      completed_agents: completedAgents,
      in_progress_agent: null,
      in_progress_artifact_partial: null,
    });

    this.logger.info('agent.done', `${role} completed — ${totalInput + totalOutput} tokens, $${costUsd.toFixed(4)}`);
    this.broadcast({
      type: 'agent:done',
      phase,
      agent: errorKey ?? role,
      artifact: primaryArtifactPath,
      tokens_used: { input: totalInput, output: totalOutput },
      cost_usd: costUsd,
      context_compressed: compressionNeeded,
    });

    return {
      role,
      phase,
      artifact_path: primaryArtifactPath,
      final_text: finalText,
      tokens_input: totalInput,
      tokens_output: totalOutput,
      cost_usd: costUsd,
    };
  }

  // ─── Tool implementations ─────────────────────────────────────────────────

  private buildToolDefinitions(toolNames: string[]): Anthropic.Tool[] {
    const all: Record<string, Anthropic.Tool> = {
      read_file: {
        name: 'read_file',
        description: 'Read the contents of a file (path relative to project root)',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path relative to project root' } },
          required: ['path'],
        },
      },
      write_file: {
        name: 'write_file',
        description: 'Write content to a file (path relative to project root). Creates parent directories.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
      list_files: {
        name: 'list_files',
        description: 'List the contents of a directory (path relative to project root)',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Directory path relative to project root' } },
          required: ['path'],
        },
      },
    };
    return toolNames.map((name) => all[name]).filter((t): t is Anthropic.Tool => t !== undefined);
  }

  private async processToolCalls(
    content: Anthropic.ContentBlock[],
    projectDir: string,
    deniedPrefixes?: string[],
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const input = block.input as Record<string, string>;
      let toolResult: string;

      try {
        switch (block.name) {
          case 'read_file': {
            if (!input['path']) { toolResult = 'Error: read_file requires a path argument'; break; }
            const filePath = this.resolveSafePath(projectDir, input['path']);
            // Bug 3 fix: include path.sep in the check so 'src' doesn't match 'src-backup/' etc.
            if (deniedPrefixes?.some((p) => {
              const resolvedPrefix = path.resolve(projectDir, p);
              return filePath === resolvedPrefix || filePath.startsWith(resolvedPrefix + path.sep);
            })) {
              toolResult = `Access denied: ${input['path']} is not available to this agent.`;
              break;
            }
            toolResult = await fs.promises.readFile(filePath, 'utf-8');
            break;
          }
          case 'write_file': {
            if (!input['path'] || input['content'] == null) {
              toolResult = 'Error: write_file requires path and content arguments'; break;
            }
            const filePath = this.resolveSafePath(projectDir, input['path']);
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            await writeFileAtomic(filePath, input['content'], { encoding: 'utf8' });
            // Bump spec version only when the Phase 1 API spec is updated (divergence detection)
            if (input['path'] === '01-api-spec.yaml' || input['path'] === '.clados/01-api-spec.yaml') {
              await this.session.bumpSpecVersion(projectDir);
            }
            toolResult = `Written: ${input['path']}`;
            break;
          }
          case 'list_files': {
            if (!input['path']) { toolResult = 'Error: list_files requires a path argument'; break; }
            const dirPath = this.resolveSafePath(projectDir, input['path']);
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            toolResult = entries.map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`).join('\n');
            break;
          }
          default:
            toolResult = `Unknown tool: ${block.name}`;
        }
      } catch (err) {
        toolResult = `Error: ${(err as Error).message}`;
      }

      results.push({ type: 'tool_result', tool_use_id: block.id, content: toolResult });
    }

    return results;
  }

  /** Prevent directory traversal — all file operations scoped to projectDir.
   * Uses relative-path check to handle case-insensitive filesystems (Windows). */
  private resolveSafePath(projectDir: string, requestedPath: string): string {
    const resolved = path.resolve(projectDir, requestedPath);
    const relative = path.relative(path.resolve(projectDir), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path traversal denied: ${requestedPath}`);
    }
    return resolved;
  }

  // ─── Crash recovery ──────────────────────────────────────────────────────────

  private async crashRecover(projectDir: string): Promise<string | null> {
    const state = await this.session.read(projectDir);
    const checkpoint = state.phase_checkpoint;
    if (!checkpoint) return null;

    const partialPath = checkpoint.in_progress_artifact_partial
      ? path.join(projectDir, checkpoint.in_progress_artifact_partial)
      : null;

    if (!partialPath || !fs.existsSync(partialPath)) {
      this.logger.info('crash_recovery', `No partial artifact found — ${checkpoint.in_progress_agent} will restart clean`);
      return null;
    }

    const content = await fs.promises.readFile(partialPath, 'utf-8');
    const ext = path.extname(partialPath);
    const passes = passesStructuralMarkerTest(content, ext);

    if (passes) {
      this.logger.info('crash_recovery', `Partial artifact passes structural test — ${checkpoint.in_progress_agent} will continue from prior output`);
      return content;
    } else {
      this.logger.info('crash_recovery', `Partial artifact fails structural test — ${checkpoint.in_progress_agent} will restart clean`);
      await fs.promises.unlink(partialPath).catch(() => { /* ignore */ });
      return null;
    }
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  private getRegistryEntry(role: string): AgentRegistryEntry {
    const entry = this.registry.agents.find((a) => a.role === role);
    if (!entry) throw new Error(`No registry entry for role: ${role}`);
    return entry;
  }

  private getPhaseAgents(phase: number, config: SessionState['config']): AgentRegistryEntry[] {
    if (phase === 2) {
      const base = ['qa', 'validator',
        ...(config.security_enabled ? ['security'] : []),
        ...(config.wrecker_enabled ? ['wrecker'] : []),
      ];
      // M-19: full-stack has two parallel engineers; include both in cost estimate
      const engineers = config.project_type === 'full-stack' ? ['engineer', 'engineer'] : ['engineer'];
      return [...engineers, ...base].map((r) => this.getRegistryEntry(r)).filter(Boolean);
    }
    const phaseRoles: Record<number, string[]> = {
      0: ['pm', 'validator'],
      1: ['pm', 'architect', 'engineer', 'validator'],
      3: ['docs', 'pm', 'validator'],
      4: ['devops', 'validator'],
    };
    const roles = phaseRoles[phase] ?? [];
    return roles.map((r) => this.getRegistryEntry(r)).filter(Boolean);
  }

  private async loadValidatorFindings(claDosDir: string, phase: number): Promise<Finding[]> {
    const paths: Record<number, string> = {
      0: '00-validator.json',
      1: '01-validator.json',
      2: '02-build/validator.json',
      3: '03-validator.json',
      4: '04-validator.json',
    };
    const filePath = path.join(claDosDir, paths[phase] ?? '');
    if (!filePath || !fs.existsSync(filePath)) return [];

    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = sanitizeJson(raw) as { findings?: Finding[] };
      // Normalise: LLM output may omit status on new findings. Defaulting here
      // ensures every Finding in the pipeline satisfies the non-optional type.
      return (parsed.findings ?? []).map((f) => ({ ...f, status: f.status ?? 'new' }));
    } catch {
      return [];
    }
  }

  private inferArtifactPath(role: string, phase: number): string {
    // Paths prefixed with .clados/ are stored inside the .clados/ directory.
    // This ensures the artifactKey computed via path.relative(claDosDir, ...) is correct.
    const map: Record<string, string> = {
      pm: phase === 3 ? '.clados/03-prd.md' : phase === 1 ? '.clados/01-prd.md' : '.clados/00-concept.md',
      architect: '.clados/01-architecture.md',
      engineer: phase === 1 ? 'src/index.ts' : 'src/',
      qa: 'tests/integration/',
      // Phase 2 Validator lives in the 02-build/ subdirectory
      validator: phase === 2 ? '.clados/02-build/validator.json' : `.clados/0${phase}-validator.json`,
      security: '.clados/02-build/security-report.md',
      wrecker: '.clados/02-build/wrecker.json',
      devops: 'infra/',
      docs: 'docs/',
    };
    return map[role] ?? `.clados/phase${phase}-${role}.txt`;
  }

  private classifyError(errMsg: string): 'api_429' | 'api_5xx' | 'context_length' | 'timeout' | 'parse_error' {
    if (errMsg.includes('429') || errMsg.includes('rate_limit')) return 'api_429';
    if (errMsg.includes('500') || errMsg.includes('502') || errMsg.includes('503')) return 'api_5xx';
    if (errMsg.includes('context_length') || errMsg.includes('too_large')) return 'context_length';
    if (errMsg.includes('timeout')) return 'timeout';
    return 'parse_error';
  }

  private async runTestRunner(projectDir: string): Promise<void> {
    const { runTestRunner } = await import('../agents/_subagents/test-runner.js');
    await runTestRunner(projectDir);
  }
}
