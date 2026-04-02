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
  DiscoveryGateResponse,
  DiscoveryQuestion,
  Finding,
  GateResponse,
  MicroGateResponse,
  PhaseCheckpoint,
  QuestionGateResponse,
  SessionState,
  StackManifest,
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
import { canRequestPivot, createPivot, resolvePivot, buildMicroGateEvent, openMicroGate } from './micro-pivot.js';

const CLADOS_ROOT = path.join(__dirname, '..', '..');
const REGISTRY_PATH = path.join(CLADOS_ROOT, 'agent-registry.json');
const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];
const MAX_RETRIES = 3;
const UNRESOLVED_STREAK_REASON_THRESHOLD = 3;

// ─── Context-length overflow error ───────────────────────────────────────────

class ContextOverflowError extends Error {
  constructor(public readonly agentRole: string, public readonly agentPhase: number) {
    super(`Context overflow for ${agentRole} phase ${agentPhase}`);
  }
}

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

  /** Discovery gate resolver (Phase 0 two-pass flow). */
  private discoveryGateResolve: ((response: DiscoveryGateResponse) => void) | null = null;
  private currentDiscoveryGateEvent: WsServerEvent | null = null;

  /** Question gate resolver (V2 agent questions). */
  private questionGateResolve: ((response: QuestionGateResponse) => void) | null = null;
  private currentQuestionGateEvent: WsServerEvent | null = null;

  /** Micro-pivot gate resolver (V2 micro-pivots). */
  private microGateResolve: ((response: MicroGateResponse) => void) | null = null;
  private currentMicroGateEvent: WsServerEvent | null = null;

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
    if (this.currentDiscoveryGateEvent && ws.readyState === 1) {
      ws.send(JSON.stringify(this.currentDiscoveryGateEvent));
    }
    if (this.currentQuestionGateEvent && ws.readyState === 1) {
      ws.send(JSON.stringify(this.currentQuestionGateEvent));
    }
    if (this.currentMicroGateEvent && ws.readyState === 1) {
      ws.send(JSON.stringify(this.currentMicroGateEvent));
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

  handleDiscoveryGateResponse(response: DiscoveryGateResponse): void {
    if (this.discoveryGateResolve) {
      this.currentDiscoveryGateEvent = null;
      this.discoveryGateResolve(response);
      this.discoveryGateResolve = null;
    }
  }

  handleQuestionGateResponse(response: QuestionGateResponse): void {
    if (this.questionGateResolve) {
      this.currentQuestionGateEvent = null;
      this.questionGateResolve(response);
      this.questionGateResolve = null;
    }
  }

  handleMicroGateResponse(response: MicroGateResponse): void {
    if (this.microGateResolve) {
      this.currentMicroGateEvent = null;
      this.microGateResolve(response);
      this.microGateResolve = null;
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
    const claDosDir = path.join(projectDir, '.clados');

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

    // V2: Two-pass discovery flow — skip if idea is >= 200 words or discovery already completed
    const ideaWords = state.config.idea.trim().split(/\s+/).length;
    const discoveryAlreadyDone = priorCompleted.has('pm-discovery');

    if (ideaWords < 200 && !discoveryAlreadyDone) {
      // Step 1: PM discovery pass
      await this.dispatchAgent({
        role: 'pm',
        phase: 0,
        projectDir,
        contextArtifacts: [],
        contextPrefix: `The user's project idea:\n\n${state.config.idea}\n\nProject type: ${state.config.project_type}\n\nWrite the discovery document (00-discovery.md) with clarifying questions and default assumptions. Do NOT write the concept document yet.`,
        errorKey: 'pm-discovery',
      });

      // Parse 00-discovery.md for questions
      const discoveryPath = path.join(claDosDir, '00-discovery.md');
      let discoveryContent = '';
      if (fs.existsSync(discoveryPath)) {
        discoveryContent = await fs.promises.readFile(discoveryPath, 'utf-8');
      }

      const { understanding, questions } = this.parseDiscoveryDoc(discoveryContent);

      // Open discovery gate — wait for user answers
      const discoveryResponse = await this.openDiscoveryGate(understanding, questions);

      // Persist answers to session state
      await this.session.update(projectDir, {
        discovery_answers: discoveryResponse.answers,
        discovery_additional_context: discoveryResponse.additional_context ?? undefined,
      });
    }

    // Step 2 (or direct path if idea >= 200 words): PM writes concept doc
    if (!priorCompleted.has('pm')) {
      const freshState = await this.session.read(projectDir);
      let contextPrefix = `The user's project idea:\n\n${freshState.config.idea}\n\nProject type: ${freshState.config.project_type}\n\nWrite the one-page concept document (00-concept.md) for this project.`;

      // Inject discovery context if available
      if (freshState.discovery_answers && Object.keys(freshState.discovery_answers).length > 0) {
        const discoveryPath = path.join(claDosDir, '00-discovery.md');
        let discoveryDoc = '';
        if (fs.existsSync(discoveryPath)) {
          discoveryDoc = await fs.promises.readFile(discoveryPath, 'utf-8');
        }

        const answersBlock = Object.entries(freshState.discovery_answers)
          .map(([id, answer]) => `- ${id}: ${answer}`)
          .join('\n');

        contextPrefix += `\n\n---\n\nDiscovery document:\n${discoveryDoc}\n\nUser's answers to clarifying questions:\n${answersBlock}`;

        if (freshState.discovery_additional_context) {
          contextPrefix += `\n\nAdditional context from user:\n${freshState.discovery_additional_context}`;
        }
      }

      await this.dispatchAgent({
        role: 'pm',
        phase: 0,
        projectDir,
        contextArtifacts: [],
        contextPrefix,
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

  /** Parse 00-discovery.md into structured understanding + questions. */
  private parseDiscoveryDoc(content: string): { understanding: string; questions: DiscoveryQuestion[] } {
    const lines = content.split('\n');
    let understanding = '';
    const questions: DiscoveryQuestion[] = [];

    let section: 'none' | 'understanding' | 'questions' | 'assumptions' = 'none';
    const questionTexts: string[] = [];
    const assumptions: string[] = [];

    for (const line of lines) {
      if (/^##\s+My understanding/i.test(line)) { section = 'understanding'; continue; }
      if (/^##\s+Clarifying questions/i.test(line)) { section = 'questions'; continue; }
      if (/^##\s+Assumptions/i.test(line)) { section = 'assumptions'; continue; }
      if (/^##\s/.test(line)) { section = 'none'; continue; }
      if (/^#\s/.test(line)) continue; // title

      if (section === 'understanding') {
        understanding += line + '\n';
      } else if (section === 'questions') {
        const match = line.match(/^\d+\.\s+(.+)/);
        if (match?.[1]) questionTexts.push(match[1]);
      } else if (section === 'assumptions') {
        const match = line.match(/^\d+\.\s+(.+)/);
        if (match?.[1]) assumptions.push(match[1]);
      }
    }

    for (let i = 0; i < questionTexts.length; i++) {
      const qText = questionTexts[i];
      if (!qText) continue;
      // Split question from rationale if parenthetical exists
      const parenMatch = qText.match(/^(.+?)\s*\((.+)\)\s*$/);
      questions.push({
        id: `q-${i + 1}`,
        question: parenMatch ? parenMatch[1]!.trim() : qText.trim(),
        rationale: parenMatch ? parenMatch[2]!.trim() : '',
        default_assumption: assumptions[i]?.trim() ?? '',
      });
    }

    return { understanding: understanding.trim(), questions };
  }

  /** Open a discovery gate and wait for the user's response. */
  private async openDiscoveryGate(
    understanding: string,
    questions: DiscoveryQuestion[],
  ): Promise<DiscoveryGateResponse> {
    const event = {
      type: 'discovery:gate' as const,
      phase: 0 as const,
      understanding,
      questions,
    };
    this.currentDiscoveryGateEvent = event;
    this.broadcast(event);
    this.logger.info('gate.discovery', `Discovery gate opened with ${questions.length} questions`);

    return new Promise<DiscoveryGateResponse>((resolve) => {
      this.discoveryGateResolve = resolve;
    });
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

    // V2: Read and persist stack manifest if not already loaded
    if (!state.stack_manifest) {
      const stackPath = path.join(claDosDir, '01-stack.json');
      if (fs.existsSync(stackPath)) {
        try {
          const stackRaw = await fs.promises.readFile(stackPath, 'utf-8');
          const stack: StackManifest = JSON.parse(stackRaw);
          await this.session.update(projectDir, { stack_manifest: stack });
          this.logger.info('stack.loaded', `Stack manifest loaded: ${stack.language}/${stack.backend_framework}`);
        } catch (e) {
          this.logger.warn('stack.parse_error', `Failed to parse 01-stack.json: ${(e as Error).message}`);
        }
      }
    }

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

    // #10: Detect dependency divergences after engineers complete
    await this.detectDependencyDivergences(projectDir);

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

    // Refiner (optional) — runs after Validator, fixes should_fix and suggestion findings
    const refinerEntry = this.getRegistryEntry('refiner');
    const refinerEnabled = isAgentEnabled(refinerEntry.enabled_when, state.config);
    if (refinerEnabled && !priorCompleted.has('refiner')) {
      await this.dispatchAgent({
        role: 'refiner',
        phase: 2,
        projectDir,
        contextArtifacts: [
          { artifact: '02-build/validator.json', type: 'required' },
        ],
        contextPrefix: 'Fix all should_fix and suggestion findings from the Validator report. Write your change log to 02-build/refiner.json.',
        variables: { project_type: state.config.project_type },
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
      ...(refinerEnabled ? ['02-build/refiner.json'] : []),
    ];
    await this.openGate(projectDir, 2, 3, gateArtifacts);
  }

  // ─── Dependency divergence detection (#10) ─────────────────────────────────

  private async detectDependencyDivergences(projectDir: string): Promise<void> {
    const claDosDir = path.join(projectDir, '.clados');
    try {
      // Parse declared packages from 01-architecture.md (code blocks + bullet lists)
      const archContent = await fs.promises.readFile(
        path.join(claDosDir, '01-architecture.md'), 'utf-8',
      );
      const declaredPackages = new Set<string>();
      // Fenced code blocks
      for (const codeBlock of archContent.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
        for (const line of codeBlock[1]!.split('\n')) {
          const pkg = line.trim().split(/\s/)[0] ?? '';
          if (pkg && /^[a-z@][a-z0-9._\-/]*$/i.test(pkg) && !pkg.includes(':')) {
            declaredPackages.add(pkg);
          }
        }
      }
      // Bullet list entries: `- package` or `* package`
      for (const m of archContent.matchAll(/^[ \t]*[-*]\s+([a-z@][a-z0-9._\-/]*)(?:\s|$)/gim)) {
        declaredPackages.add(m[1]!);
      }

      // Read engineer manifest(s) and extract declared dependencies
      const manifestFiles = [
        '02-build/backend-engineer-manifest.json',
        '02-build/frontend-engineer-manifest.json',
      ];
      const manifestDeps = new Set<string>();
      for (const mf of manifestFiles) {
        try {
          const raw = await fs.promises.readFile(path.join(claDosDir, mf), 'utf-8');
          const manifest = JSON.parse(raw) as { dependencies?: Record<string, string> };
          for (const dep of Object.keys(manifest.dependencies ?? {})) {
            manifestDeps.add(dep);
          }
        } catch { /* manifest may not exist */ }
      }

      const divergences = [...manifestDeps].filter((d) => !declaredPackages.has(d));
      if (divergences.length > 0) {
        await this.session.update(projectDir, { dependency_divergences: divergences });
        this.logger.info(
          'dependency_divergence',
          `New packages introduced by engineer: ${divergences.join(', ')}`,
        );
      }
    } catch (err) {
      this.logger.warn('dependency_divergence', `Failed to detect divergences: ${String(err)}`);
    }
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
        contextPrefix: 'Write README, changelog, and runbook based on the actual functioning codebase. Read src/ and tests/ via read_file as needed. Write to docs/. Also produce 03-api-spec-draft.yaml as specified in your instructions.',
        variables: { project_type: state.config.project_type },
      });
    }

    // PM: final PRD and canonical API spec.
    // PM reads 03-api-spec-draft.yaml (produced by Docs) as base, preserves 01-api-spec.yaml unchanged.
    if (!priorCompleted.has('pm')) {
      await this.dispatchAgent({
        role: 'pm',
        phase: 3,
        projectDir,
        contextArtifacts: [
          { artifact: '01-prd.md', type: 'required' },
          { artifact: '01-api-spec.yaml', type: 'reference' },
          { artifact: '03-api-spec-draft.yaml', type: 'required' },
          { artifact: '02-build/test-runner.json', type: 'reference' },
        ],
        contextPrefix: 'Write the final PRD (03-prd.md). Then produce 03-api-spec.yaml as the canonical record of the API as actually built — use 03-api-spec-draft.yaml (produced by the Docs agent) as your base, and verify against src/ routes via read_file if needed. 01-api-spec.yaml is the original design artifact — preserve it unchanged.',
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

  // ─── Context overflow gate ───────────────────────────────────────────────────

  /**
   * Open a special gate when an agent's inputs are too large to process even after compression.
   * Only shows a Stop button — no Approve/Revise actions are meaningful here.
   */
  private async openContextOverflowGate(
    projectDir: string,
    phase: number,
    agentRole: string,
  ): Promise<void> {
    await this.session.update(projectDir, { pipeline_status: 'gate_pending' });

    const overflowEvent: WsServerEvent = {
      type: 'gate:open',
      phase,
      gate_number: phase + 1,
      artifacts: [],
      findings: [],
      revision_count: 0,
      next_phase_cost_estimate: '',
      overflow: true,
      overflow_message: `The ${agentRole} agent\u2019s inputs are too large to process even with compression. You can simplify the inputs or stop here.`,
    };
    this.currentGateEvent = overflowEvent;
    this.broadcast(overflowEvent);

    this.logger.warn(
      'conductor.context_overflow_gate',
      `Context overflow gate opened for ${agentRole} at phase ${phase}`,
    );

    // Wait for human — only abort/approve are meaningful here
    for (;;) {
      const response = await this.waitForGate(projectDir);
      if (response.action === 'abort' || response.action === 'approve') {
        this.currentGateEvent = null;
        return;
      }
      this.broadcast(overflowEvent);
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
            contextArtifacts: [
              { artifact: '01-prd.md', type: 'reference' },
              { artifact: '01-api-spec.yaml', type: 'reference' },
              { artifact: '03-api-spec-draft.yaml', type: 'required' },
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

    // V2: Auto-inject stack manifest variables into all dispatches (phases 2-4)
    if (phase >= 2) {
      const stackState = await this.session.read(projectDir);
      if (stackState.stack_manifest) {
        const stackVars: Record<string, string> = {
          language: stackState.stack_manifest.language,
          backend_framework: stackState.stack_manifest.backend_framework,
          orm: stackState.stack_manifest.orm,
          test_runner: stackState.stack_manifest.test_runner,
          package_manager: stackState.stack_manifest.package_manager,
          container_base: stackState.stack_manifest.container_base,
          runtime: stackState.stack_manifest.runtime,
          database: stackState.stack_manifest.database,
        };
        config = { ...config, variables: { ...stackVars, ...variables } };

        // Inject stack reference profile into context prefix
        const stackProfilePath = path.join(CLADOS_ROOT, 'stacks', `${stackState.stack_manifest.language}.md`);
        if (fs.existsSync(stackProfilePath)) {
          const stackProfile = await fs.promises.readFile(stackProfilePath, 'utf-8');
          const existing = config.contextPrefix ?? '';
          config = {
            ...config,
            contextPrefix: `${existing}\n\n---\n\n## Stack Reference (${stackState.stack_manifest.language})\n\n${stackProfile}`,
          };
        }
      }
    }
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
          // ── Context overflow gate ────────────────────────────────────────────
          if (err instanceof ContextOverflowError) {
            await this.openContextOverflowGate(projectDir, err.agentPhase, err.agentRole);
            await this.session.update(projectDir, { pipeline_status: 'abandoned' });
            throw new Error('PIPELINE_ABANDONED');
          }

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

  /**
   * Dispatch an agent with V2 question detection.
   * After the agent completes, checks if it wrote a {phase}-questions.json file.
   * If in guided mode, opens a question gate, waits for answers, and re-dispatches.
   * In autonomous mode, logs default answers and re-dispatches immediately.
   */
  async dispatchAgentWithQuestions(config: AgentDispatchConfig): Promise<AgentResult> {
    const result = await this.dispatchAgent(config);
    const { phase, projectDir } = config;
    const claDosDir = path.join(projectDir, '.clados');

    // Check if a questions file was written
    const questionsPath = path.join(claDosDir, `${String(phase).padStart(2, '0')}-questions.json`);
    if (!fs.existsSync(questionsPath)) return result;

    let rawQuestions: Array<{ id: string; question: string; default_answer: string }>;
    try {
      const raw = await fs.promises.readFile(questionsPath, 'utf-8');
      rawQuestions = JSON.parse(raw);
      if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return result;
    } catch {
      return result;
    }

    const state = await this.session.read(projectDir);
    const isGuided = state.config.autonomy_mode !== 'autonomous';
    const agentQuestions: import('./types.js').AgentQuestion[] = rawQuestions.map((q) => ({
      id: q.id,
      agent: config.role,
      phase,
      question: q.question,
      default_answer: q.default_answer,
    }));

    let answersMap: Record<string, string>;

    if (isGuided) {
      // Open question gate and wait for user
      const event = {
        type: 'question:gate' as const,
        phase,
        agent: config.errorKey ?? config.role,
        questions: agentQuestions,
      };
      this.currentQuestionGateEvent = event;
      this.broadcast(event);
      this.logger.info('gate.question', `Question gate opened for ${config.role} phase ${phase}`);

      const response = await new Promise<import('./types.js').QuestionGateResponse>((resolve) => {
        this.questionGateResolve = resolve;
      });
      answersMap = response.answers;
    } else {
      // Autonomous: use defaults
      answersMap = {};
      for (const q of agentQuestions) {
        answersMap[q.id] = q.default_answer;
      }
      this.logger.info('questions.auto', `Auto-answered ${agentQuestions.length} questions for ${config.role}`);
    }

    // Persist answers
    const updatedQuestions = agentQuestions.map((q) => ({
      ...q,
      user_answer: answersMap[q.id] || q.default_answer,
      answered_at: new Date().toISOString(),
    }));
    const existingQuestions = state.agent_questions ?? [];
    await this.session.update(projectDir, {
      agent_questions: [...existingQuestions, ...updatedQuestions],
    });

    // Build answers context and re-dispatch
    const answersContext = updatedQuestions
      .map((q) => `Q: ${q.question}\nA: ${q.user_answer}`)
      .join('\n\n');

    const redispatchConfig: AgentDispatchConfig = {
      ...config,
      contextPrefix: `${config.contextPrefix ?? ''}\n\n---\n\nClarifying questions and answers:\n${answersContext}\n\nProceed with your main task using these answers.`,
    };

    return this.dispatchAgent(redispatchConfig);
  }

  private async dispatchWithRetry(
    config: AgentDispatchConfig,
    entry: AgentRegistryEntry,
    state: SessionState,
    checkpoint: SessionState['phase_checkpoint'],
  ): Promise<AgentResult> {
    const { role, phase, projectDir, variables, contextArtifacts, contextPrefix, modelOverride, errorKey, deniedPrefixes } = config;
    const claDosDir = path.join(projectDir, '.clados');
    const dispatchStartedAt = Date.now();

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

    // #12: Capture context downgrade log entries to persist to session state
    const compressionLog: import('./types.js').ContextCompressionLogEntry[] = [];
    const onDowngradeLog = (artifact: string, reason: 'reference_to_summary' | 'required_to_summary'): void => {
      compressionLog.push({ agent: role, phase, artifact, reason, timestamp: new Date().toISOString() });
    };

    // #13: Track first use of token-count fallback per session
    let approximateFlagWritten = state.token_counting_approximate;
    const onApproximate = async (): Promise<void> => {
      if (!approximateFlagWritten) {
        approximateFlagWritten = true;
        await this.session.update(projectDir, { token_counting_approximate: true });
      }
    };

    const { resolved, compressionNeeded, fullFetchPaths, budgetExhausted } = await resolveContextArtifacts(
      claDosDir,
      artifacts,
      this.anthropic,
      this.logger,
      summarizerBudgetCheck,
      onSummarizerCost,
      onDowngradeLog,
    );

    // Record summarizer cost and compression log to session state
    if (cumulativeSummarizerCost > 0) {
      await this.session.recordTokens(projectDir, phase, 'summarizer', {
        input: 0,
        output: 0,
        cost_usd: cumulativeSummarizerCost,
      });
    }
    if (compressionLog.length > 0) {
      const freshState = await this.session.read(projectDir);
      await this.session.update(projectDir, {
        context_compression_log: [...(freshState.context_compression_log ?? []), ...compressionLog],
      });
      // §8.1: Broadcast context compression events to the UI
      for (const entry of compressionLog) {
        this.broadcast({
          type: 'context:compressed',
          phase: entry.phase,
          agent: entry.agent,
          artifact: entry.artifact,
          reason: entry.reason,
        });
      }
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
          systemPrompt, userContent, entry, state, compressionNeeded, deniedPrefixes, errorKey, fullFetchPaths, budgetExhausted,
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
          // Already compressed and still too large — force overflow gate
          this.logger.warn('agent.context_overflow', `${role} context too large even after compression — forcing overflow gate`);
          throw new ContextOverflowError(role, phase);
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
      elapsed_ms: Date.now() - dispatchStartedAt,
      artifact_path: this.inferArtifactPath(role, phase),
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
    fullFetchPaths?: string[],
    budgetExhausted?: boolean,
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
    let fullArtifactFetchCount = 0;  // #17: count full artifact reads in a compressed context run

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
                this.broadcast({ type: 'agent:stream', phase, agent: errorKey ?? role, section: currentSection, tokens_out: Math.ceil(assistantText.length / 4) });
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
            finalMessage.content, projectDir, deniedPrefixes, fullFetchPaths,
            (count) => { fullArtifactFetchCount += count; },
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
                if (wipHandle) {
                  await new Promise<void>((res) => { wipHandle!.end(res); });
                  wipHandle = null;
                }
                await writeFileAtomic(wipPath, writtenContent, { encoding: 'utf8' });
                wipHandle = fs.createWriteStream(wipPath, { flags: 'a', encoding: 'utf8' });
              }
            }
          }

          // Micro-pivot interception: check if Engineer requested an architecture change
          for (const block of finalMessage.content) {
            if (block.type === 'tool_use' && block.name === 'request_architecture_change') {
              const pivotInput = block.input as { reason: string; proposed_change: string };
              const changeRequest = `${pivotInput.reason}\n\nProposed change: ${pivotInput.proposed_change}`;

              if (!(await canRequestPivot(this.session, projectDir, phase))) {
                // Over pivot limit — inject denial context
                messages.push({
                  role: 'user',
                  content: `Architecture change denied: maximum of 3 micro-pivots per phase reached. Continue with the current architecture.`,
                });
                this.logger.warn('micro_pivot.limit_reached', `Phase ${phase}: ${role} hit pivot limit of 3`);
              } else {
                // Create pivot record
                const pivot = await createPivot(this.session, projectDir, {
                  phase,
                  requestingAgent: role,
                  changeRequest,
                });

                // Dispatch Architect to review the request
                this.logger.info('micro_pivot.architect_dispatch', `Dispatching Architect for micro-pivot ${pivot.id}`);
                const architectResult = await this.dispatchAgent({
                  role: 'architect',
                  phase,
                  projectDir,
                  contextArtifacts: [
                    { artifact: '01-architecture.md', type: 'required' },
                    { artifact: '01-api-spec.yaml', type: 'required' },
                    { artifact: '01-schema.yaml', type: 'required' },
                  ],
                  contextPrefix: `The Engineer is requesting an architecture change during Build.\n\nChange request:\n${changeRequest}\n\nReview this request. If reasonable, update the architecture/schema files. Write a summary of your changes to .clados/micro-pivot-${pivot.id}.md including a unified diff of what changed.`,
                });

                // Read Architect response
                let architectResponse = 'Architect reviewed the request.';
                let proposedDiff = '';
                const pivotResponsePath = path.join(projectDir, '.clados', `micro-pivot-${pivot.id}.md`);
                if (fs.existsSync(pivotResponsePath)) {
                  architectResponse = await fs.promises.readFile(pivotResponsePath, 'utf-8');
                  const diffMatch = architectResponse.match(/```diff\n([\s\S]*?)```/);
                  if (diffMatch?.[1]) proposedDiff = diffMatch[1];
                }

                // Open micro gate
                const affectedFiles = ['01-architecture.md', '01-api-spec.yaml', '01-schema.yaml'];
                const gateEvent = buildMicroGateEvent(pivot, architectResponse, proposedDiff, affectedFiles);
                const response = await openMicroGate(
                  gateEvent,
                  this.broadcast,
                  (resolver) => { this.microGateResolve = resolver; },
                  (evt) => { this.currentMicroGateEvent = evt; },
                  this.logger,
                );

                // Resolve pivot
                await resolvePivot(this.session, projectDir, pivot.id, architectResponse, proposedDiff, response);

                if (response.action === 'approve') {
                  this.logger.info('micro_pivot.approved', `Micro-pivot ${pivot.id} approved`);
                  // Inject updated context for the Engineer
                  const updatedArch = fs.existsSync(path.join(projectDir, '.clados', '01-architecture.md'))
                    ? await fs.promises.readFile(path.join(projectDir, '.clados', '01-architecture.md'), 'utf-8')
                    : '';
                  messages.push({
                    role: 'user',
                    content: `Architecture change APPROVED. The Architect has updated the architecture and schema files. Here is the updated architecture:\n\n${updatedArch}\n\nContinue building with the updated architecture.`,
                  });
                } else {
                  this.logger.info('micro_pivot.rejected', `Micro-pivot ${pivot.id} rejected: ${response.rejection_reason ?? 'no reason'}`);
                  messages.push({
                    role: 'user',
                    content: `Architecture change DENIED.${response.rejection_reason ? ` Reason: ${response.rejection_reason}.` : ''} Continue with the current architecture.`,
                  });
                }
              }
              break; // Only handle first pivot request per turn
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
      // Safety net: if the inferred path is inside .clados/ and we have text, write it to disk
      // so that loadValidatorFindings() and other readers can access it via fs.existsSync().
      const inferredAbsolute = path.resolve(projectDir, primaryArtifactPath);
      const inferredRelative = path.relative(claDosDir, inferredAbsolute);
      if (!inferredRelative.startsWith('..') && !path.isAbsolute(inferredRelative) && finalText.trim().length > 0) {
        await fs.promises.mkdir(path.dirname(inferredAbsolute), { recursive: true });
        await writeFileAtomic(inferredAbsolute, finalText, { encoding: 'utf8' });
      }
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
      full_artifacts_fetched: fullArtifactFetchCount,
      context_budget_exhausted: budgetExhausted ?? false,
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
      request_architecture_change: {
        name: 'request_architecture_change',
        description: 'Request a change to the project architecture or schema. Use this when the current architecture cannot support a required feature. The Architect will review and propose changes for human approval.',
        input_schema: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Why the current architecture needs to change' },
            proposed_change: { type: 'string', description: 'What specific change you need' },
          },
          required: ['reason', 'proposed_change'],
        },
      },
    };
    return toolNames.map((name) => all[name]).filter((t): t is Anthropic.Tool => t !== undefined);
  }

  private async processToolCalls(
    content: Anthropic.ContentBlock[],
    projectDir: string,
    deniedPrefixes?: string[],
    fullFetchPaths?: string[],
    onFullFetch?: (count: number) => void,
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
            // #17: track when agent reads a compressed artifact in full
            if (fullFetchPaths?.some((p) => {
              const resolvedArtifact = path.resolve(projectDir, '.clados', p);
              return filePath === resolvedArtifact;
            })) {
              onFullFetch?.(1);
            }
            toolResult = await fs.promises.readFile(filePath, 'utf-8');
            break;
          }
          case 'write_file': {
            if (!input['path'] || input['content'] == null) {
              toolResult = 'Error: write_file requires path and content arguments'; break;
            }
            const filePath = this.resolveSafePath(projectDir, input['path']);
            let writeContent = input['content'];
            // #3: sanitize JSON before writing to prevent invalid files from blocking the pipeline
            if (input['path'].endsWith('.json')) {
              try {
                const parsed = sanitizeJson(writeContent);
                writeContent = JSON.stringify(parsed, null, 2);
              } catch (jsonErr) {
                toolResult = `Error: write_file content is not valid JSON — ${(jsonErr as Error).message}. Please output only valid JSON without markdown fences.`;
                break;
              }
            }
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            await writeFileAtomic(filePath, writeContent, { encoding: 'utf8' });
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
            if (block.name === 'request_architecture_change') {
              // Handled after processToolCalls returns — just acknowledge here
              const input2 = block.input as Record<string, string>;
              toolResult = `Architecture change request registered: "${input2['reason']}". The Conductor will pause your execution, consult the Architect, and resume you with the outcome.`;
            } else {
              toolResult = `Unknown tool: ${block.name}`;
            }
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
