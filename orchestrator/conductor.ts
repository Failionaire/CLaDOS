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
import { BudgetManager, BudgetGate, calculateCostUsd } from './budget.js';
import {
  resolveContextArtifacts,
  injectVariables,
  validateSystemPromptSections,
  passesStructuralMarkerTest,
  summarizeFile,
  estimateTokens,
} from './context.js';
import {
  resolveModel,
  isAgentEnabled,
  isSkippable,
  OPUS_MODEL,
  HAIKU_MODEL,
} from './escalation.js';
import writeFileAtomic from 'write-file-atomic';

const CLADOS_ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(CLADOS_ROOT, 'agent-registry.json');
const AGENTS_DIR = path.join(CLADOS_ROOT, 'agents');

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
  s = s.slice(start);
  return JSON.parse(s);
}

// ─── WIP path helpers ────────────────────────────────────────────────────────

/** Derive the correct partial-file extension from the agent's expected output type. */
function wipExtForRole(role: string): string {
  const jsonRoles = new Set(['validator', 'qa', 'security', 'wrecker']);
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

  /** Resolved by handleBudgetUpdate() when user raises the spend cap */
  private budgetGateResolve: (() => void) | null = null;

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
  }

  // ─── Gate handling ──────────────────────────────────────────────────────────

  handleGateResponse(response: GateResponse): void {
    if (this.gateResolve) {
      this.gateResolve(response);
      this.gateResolve = null;
    }
  }

  /** Called by server.ts when the user raises the spend cap via POST /budget/update */
  handleBudgetUpdate(): void {
    if (this.budgetGateResolve) {
      this.budgetGateResolve();
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

    await this.session.update(projectDir, {
      current_phase: 0,
      phase_checkpoint: {
        phase: 0,
        completed_agents: [],
        in_progress_agent: null,
        in_progress_artifact_partial: null,
        spec_version_at_start: state.spec_version,
        gate_revision_count: 0,
        unresolved_streak: 0,
      },
    });

    // PM: concept document
    await this.dispatchAgent({
      role: 'pm',
      phase: 0,
      projectDir,
      contextArtifacts: [],
      contextPrefix: `The user's project idea:\n\n${state.config.idea}\n\nProject type: ${state.config.project_type}\n\nWrite the one-page concept document (00-concept.md) for this project.`,
    });

    // Validator: review concept
    await this.dispatchAgent({
      role: 'validator',
      phase: 0,
      projectDir,
      contextArtifacts: [{ artifact: '00-concept.md', type: 'required' }],
      contextPrefix: 'Review the concept for feasibility and obvious gaps. Write your findings to 00-validator.json.',
    });

    await this.openGate(projectDir, 0, 1, ['00-concept.md', '00-validator.json']);
  }

  // ─── Phase 1 — Architecture ─────────────────────────────────────────────────

  private async runPhase1(projectDir: string): Promise<void> {
    const state = await this.session.read(projectDir);

    await this.session.update(projectDir, {
      current_phase: 1,
      phase_checkpoint: {
        phase: 1,
        completed_agents: [],
        in_progress_agent: null,
        in_progress_artifact_partial: null,
        spec_version_at_start: state.spec_version,
        gate_revision_count: 0,
        unresolved_streak: 0,
      },
    });

    // PM: full PRD
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

    // Architect: project skeleton
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

    // Engineer: scaffold
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

    // Validator
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

    await this.openGate(projectDir, 1, 2, [
      '01-prd.md', '01-architecture.md', '01-api-spec.yaml', '01-schema.yaml', '01-validator.json',
    ]);
  }

  // ─── Phase 2 — Build ────────────────────────────────────────────────────────

  private async runPhase2(projectDir: string): Promise<void> {
    const state = await this.session.read(projectDir);
    const claDosDir = path.join(projectDir, '.clados');

    await this.session.update(projectDir, {
      current_phase: 2,
      phase_checkpoint: {
        phase: 2,
        completed_agents: [],
        in_progress_agent: null,
        in_progress_artifact_partial: null,
        spec_version_at_start: state.spec_version,
        gate_revision_count: 0,
        unresolved_streak: 0,
      },
    });

    const isFullStack = state.config.project_type === 'full-stack';

    // Stage A — Implementation
    if (isFullStack) {
      // Backend and frontend engineers run in parallel
      await Promise.all([
        this.dispatchAgent({
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
        }),
        this.dispatchAgent({
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
        }),
      ]);
    } else {
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
      // Contract Validator (automated — not guarded by semaphore)
      runContractValidator(projectDir, specPath, entryFile),

      // QA → TestRunner (sequential pair)
      this.dispatchAgent({
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
      }).then(async () => {
        return runTestRunner(projectDir);
      }),

      // Security (if enabled) — runs parallel to QA
      securityEnabled
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
    if (wreckerEnabled) {
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

    await this.dispatchAgent({
      role: 'validator',
      phase: 2,
      projectDir,
      contextArtifacts: validatorArtifacts,
      contextPrefix: 'Review all build artifacts, test results, and contract findings. Write your findings to 02-build/validator.json.',
    });

    const gateArtifacts = [
      '02-build/backend-engineer-manifest.json',
      ...(isFullStack ? ['02-build/frontend-engineer-manifest.json'] : []),
      '02-build/contract-validator.json',
      '02-build/test-runner.json',
      '02-build/validator.json',
    ];
    await this.openGate(projectDir, 2, 3, gateArtifacts);
  }

  // ─── Phase 3 — Document ──────────────────────────────────────────────────────

  private async runPhase3(projectDir: string): Promise<void> {
    const state = await this.session.read(projectDir);

    await this.session.update(projectDir, {
      current_phase: 3,
      phase_checkpoint: {
        phase: 3,
        completed_agents: [],
        in_progress_agent: null,
        in_progress_artifact_partial: null,
        spec_version_at_start: state.spec_version,
        gate_revision_count: 0,
        unresolved_streak: 0,
      },
    });

    // Docs agent
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

    // PM: final PRD and canonical API spec
    await this.dispatchAgent({
      role: 'pm',
      phase: 3,
      projectDir,
      contextArtifacts: [
        { artifact: '01-prd.md', type: 'reference' },
        { artifact: '01-api-spec.yaml', type: 'reference' },
      ],
      contextPrefix: 'Write the final PRD (03-prd.md) and produce 03-api-spec.yaml as the canonical record of the API as actually built. Read src/ via read_file to verify what was actually implemented.',
    });

    // Validator
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

    await this.openGate(projectDir, 3, 4, ['03-prd.md', '03-api-spec.yaml', '03-validator.json']);
  }

  // ─── Phase 4 — Ship ─────────────────────────────────────────────────────────

  private async runPhase4(projectDir: string): Promise<void> {
    const state = await this.session.read(projectDir);

    await this.session.update(projectDir, {
      current_phase: 4,
      phase_checkpoint: {
        phase: 4,
        completed_agents: [],
        in_progress_agent: null,
        in_progress_artifact_partial: null,
        spec_version_at_start: state.spec_version,
        gate_revision_count: 0,
        unresolved_streak: 0,
      },
    });

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

    await this.openGate(projectDir, 4, 5, [
      '04-validator.json',
      'infra/docker-compose.yml',
      'infra/Dockerfile',
    ]);
  }

  // ─── Gate logic ─────────────────────────────────────────────────────────────

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

    // Estimate next phase cost
    const nextPhaseAgents = this.getPhaseAgents(phase + 1, state.config);
    const nextPhaseCostEstimate = BudgetManager.estimateNextPhase(
      nextPhaseAgents,
      Object.fromEntries(nextPhaseAgents.map((a) => [a.role, resolveModel(a.default_model, a.escalation_model, checkpoint.gate_revision_count, state.config.is_high_complexity)])),
      Object.fromEntries(nextPhaseAgents.map((a) => [a.role, 2000])),
    );

    await this.session.update(projectDir, { pipeline_status: 'gate_pending' });

    this.broadcast({
      type: 'gate:open',
      phase,
      gate_number: gateNumber,
      artifacts: artifactKeys,
      findings,
      revision_count: checkpoint.gate_revision_count,
      next_phase_cost_estimate: nextPhaseCostEstimate,
    });

    this.logger.info('gate.open', `Gate ${gateNumber} open — waiting for human decision`);

    // Wait for human
    const response = await this.waitForGate(projectDir);

    switch (response.action) {
      case 'approve':
        await this.handleGateApprove(projectDir, phase, response);
        break;

      case 'revise':
        await this.handleGateRevise(projectDir, phase, gateNumber, artifactKeys, response);
        break;

      case 'abort':
        await this.session.update(projectDir, { pipeline_status: 'abandoned' });
        this.logger.info('gate.abandoned', 'Project abandoned at gate');
        throw new Error('PIPELINE_ABANDONED');

      case 'goto':
        await this.handleGateGoto(projectDir, phase, response.goto_gate ?? 0);
        throw new Error(`GOTO_PHASE_${response.goto_gate ?? 0}`);
    }
  }

  private async handleGateApprove(
    projectDir: string,
    phase: number,
    response: GateResponse,
  ): Promise<void> {
    const state = await this.session.read(projectDir);

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
  }

  private async handleGateRevise(
    projectDir: string,
    phase: number,
    gateNumber: number,
    artifactKeys: string[],
    response: GateResponse,
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
      const reasoned = await this.conductorReason(projectDir, phase, checkpoint, response.revision_text ?? '')
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
    await this.runPhaseRevision(projectDir, phase, response.revision_text ?? '', conductorGuidance);

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

    await this.session.update(projectDir, { pipeline_status: 'gate_pending' });
    this.broadcast({
      type: 'gate:open',
      phase,
      gate_number: gateNumber,
      artifacts: artifactKeys,
      findings,
      revision_count: revisionCount,
      next_phase_cost_estimate: '~$0.00',
    });

    this.logger.warn(
      'conductor.escape_hatch_terminal',
      `Three guided revisions have not resolved must-fix findings at Phase ${phase}. Human decision required.`,
    );

    const humanResponse = await this.waitForGate(projectDir);

    switch (humanResponse.action) {
      case 'approve':
        await this.handleGateApprove(projectDir, phase, humanResponse);
        break;
      case 'revise':
        await this.session.update(projectDir, { pipeline_status: 'agent_running' });
        await this.runPhaseRevision(projectDir, phase, humanResponse.revision_text ?? '', '');
        await this.openGate(projectDir, phase, gateNumber, artifactKeys);
        break;
      case 'abort':
        await this.session.update(projectDir, { pipeline_status: 'abandoned' });
        throw new Error('PIPELINE_ABANDONED');
      case 'goto':
        await this.handleGateGoto(projectDir, phase, humanResponse.goto_gate ?? 0);
        throw new Error(`GOTO_PHASE_${humanResponse.goto_gate ?? 0}`);
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
        model: OPUS_MODEL,
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
        await this.dispatchAgent({
          role: 'pm', phase: 0, projectDir,
          contextArtifacts: [{ artifact: '00-concept.md', type: 'required' }],
          contextPrefix: revisedContextPrefix,
        });
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
        await this.dispatchAgent({
          role: 'engineer', phase: 2, projectDir,
          contextArtifacts: [
            { artifact: '01-api-spec.yaml', type: 'required' },
            { artifact: '02-build/backend-engineer-manifest.json', type: 'required' },
            { artifact: '02-build/validator.json', type: 'required' },
          ],
          contextPrefix: revisedContextPrefix,
          variables: { project_type: state.config.project_type, engineer_role: 'backend' },
        });
        // For full-stack projects, also re-run the frontend Engineer
        if (isFullStack) {
          await this.dispatchAgent({
            role: 'engineer', phase: 2, projectDir,
            contextArtifacts: [
              { artifact: '01-api-spec.yaml', type: 'required' },
              { artifact: '02-build/frontend-engineer-manifest.json', type: 'required' },
              { artifact: '02-build/validator.json', type: 'required' },
            ],
            contextPrefix: revisedContextPrefix,
            variables: { project_type: state.config.project_type, engineer_role: 'frontend' },
          });
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
          await this.dispatchAgent({
            role: 'pm', phase: 3, projectDir,
            contextArtifacts: [
              { artifact: '01-api-spec.yaml', type: 'reference' },
              { artifact: '03-validator.json', type: 'required' },
            ],
            contextPrefix: revisedContextPrefix,
          });
        }
        await this.dispatchAgent({
          role: 'docs', phase: 3, projectDir,
          contextArtifacts: [
            { artifact: '03-validator.json', type: 'required' },
          ],
          contextPrefix: revisedContextPrefix,
        });
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
            this.broadcast({
              type: 'budget:gate',
              current_spend_usd: err.currentSpendUsd,
              remaining_budget_usd: err.remainingBudgetUsd,
              blocked_agent: err.blockedAgent,
              projected_cost_usd: err.projectedCostUsd,
            });
            // Wait for the user to raise the cap (POST /budget/update)
            await new Promise<void>((resolve) => { this.budgetGateResolve = resolve; });
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
            this.broadcast({ type: 'agent:skipped', phase, agent: role });
            return {
              role,
              phase,
              artifactPath: '',
              finalText: '',
              tokensInput: 0,
              tokensOutput: 0,
              costUsd: 0,
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

    // Inject crash recovery context for a restarted agent (consumed once)
    const recoveryPrefix = this.crashRecoveryPrefix.get(role);
    if (recoveryPrefix) {
      userContent = recoveryPrefix + '\n\n' + userContent;
      this.crashRecoveryPrefix.delete(role);
    }
    if (fullFetchPaths.length > 0) {
      const prefixed = fullFetchPaths.map((p) => `.clados/${p}`);
      userContent += `\n\n[NOTE: The following artifacts were compressed. Use read_file to access them in full: ${prefixed.join(', ')}]`;
    }

    // Count context tokens (for budget check)
    const contextTokens = await estimateTokens(systemPrompt + userContent, this.anthropic, this.logger);

    // Budget pre-check
    await this.budgetManager.checkPreDispatch(projectDir, entry, model, contextTokens, state);

    // Set up WIP artifact path (extension reflects output type; engineer role suffix avoids
    // collision when backend + frontend engineers run concurrently in full-stack mode)
    const engineerSuffix = variables?.engineer_role ? `-${variables.engineer_role}` : '';
    const wipPath = path.join(claDosDir, 'wip', `${phase}-${role}${engineerSuffix}${wipExtForRole(role)}`);
    await fs.promises.mkdir(path.dirname(wipPath), { recursive: true });

    // Update checkpoint: in_progress
    await this.session.updateCheckpoint(projectDir, {
      in_progress_agent: role,
      in_progress_artifact_partial: path.relative(projectDir, wipPath),
    });
    await this.session.update(projectDir, { pipeline_status: 'agent_running' });

    this.logger.setContext(phase, role);
    this.logger.info('agent.dispatch', `Dispatching ${role} (${model})`);
    this.broadcast({ type: 'agent:start', phase, agent: role, model });

    // Retry loop
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? 30_000;
        await new Promise((res) => setTimeout(res, delay));
        this.logger.warn('agent.retry', `Retry attempt ${attempt} for ${role}`);
      }

      try {
        const result = await this.streamingDispatch(
          role, phase, projectDir, claDosDir, wipPath, model,
          systemPrompt, userContent, entry, state, compressionNeeded, deniedPrefixes,
        );
        return result;
      } catch (err) {
        lastError = err as Error;
        const errMsg = String(err);
        const isContextLength = errMsg.includes('context_length') || errMsg.includes('too_large');

        if (isContextLength && attempt === 0) {
          // Downgrade all to summaries and retry once more
          this.logger.warn('agent.context_length', `Context too large for ${role} — downgrading all artifacts`);
          userContent = resolved
            .map((a) => `### ${a.key}\n\n${a.content.slice(0, 500)}...[compressed]`)
            .join('\n\n---\n\n');
          continue;
        }

        const errorType = this.classifyError(errMsg);
        const retryCount = attempt + 1;

        this.broadcast({
          type: 'agent:error',
          phase,
          agent: role,
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
    role: string,
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
  ): Promise<AgentResult> {
    const tools: Anthropic.Tool[] = this.buildToolDefinitions(entry.tools);
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];

    let wipHandle: fs.WriteStream | null = null;
    let currentSection = '';
    let finalText = '';
    let totalInput = 0;
    let totalOutput = 0;
    let finalArtifactPath = '';

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

            // Emit section heading events
            const headingMatch = text.match(/^## (.+)/m);
            if (headingMatch && headingMatch[1] !== currentSection) {
              currentSection = headingMatch[1]!;
              this.broadcast({ type: 'agent:stream', phase, agent: role, section: currentSection });
            }
          }
        }

        const finalMessage = await stream.finalMessage();
        totalInput += finalMessage.usage.input_tokens;
        totalOutput += finalMessage.usage.output_tokens;
        this.tpmTracker.record(finalMessage.usage.input_tokens + finalMessage.usage.output_tokens);

        if (finalMessage.stop_reason === 'end_turn') {
          finalText = assistantText;
          break;
        }

        if (finalMessage.stop_reason === 'tool_use') {
          // Process tool calls
          const toolResults = await this.processToolCalls(
            finalMessage.content, projectDir, deniedPrefixes,
          );
          messages.push({ role: 'assistant', content: finalMessage.content });
          messages.push({ role: 'user', content: toolResults });

          // Update finalArtifactPath from write_file calls
          for (const block of finalMessage.content) {
            if (block.type === 'tool_use' && block.name === 'write_file') {
              const writtenPath = (block.input as { path: string }).path;
              finalArtifactPath = writtenPath;
            }
          }
        }
      }
    } finally {
      await new Promise<void>((res) => { wipHandle?.end(res); });
    }

    // Determine the canonical artifact path from what was written
    const resolvedArtifactPath = finalArtifactPath || this.inferArtifactPath(role, phase);

    const costUsd = calculateCostUsd(model, totalInput, totalOutput);

    // Record tokens + cost
    await this.session.recordTokens(projectDir, phase, role, {
      input: totalInput,
      output: totalOutput,
      cost_usd: costUsd,
    });

    // Register artifact
    const artifactKey = path.relative(claDosDir, path.join(projectDir, resolvedArtifactPath));
    const tokenCount = await estimateTokens(finalText, this.anthropic, this.logger);
    await this.session.registerArtifact(projectDir, artifactKey, {
      path: resolvedArtifactPath,
      token_count: tokenCount,
      version: 1,
    });

    // Update checkpoint: agent complete
    const currentState = await this.session.read(projectDir);
    const completedAgents = [...(currentState.phase_checkpoint?.completed_agents ?? [])];
    if (!completedAgents.includes(role)) completedAgents.push(role);
    await this.session.updateCheckpoint(projectDir, {
      completed_agents: completedAgents,
      in_progress_agent: null,
      in_progress_artifact_partial: null,
    });

    this.logger.info('agent.done', `${role} completed — ${totalInput + totalOutput} tokens, $${costUsd.toFixed(4)}`);
    this.broadcast({
      type: 'agent:done',
      phase,
      agent: role,
      artifact: resolvedArtifactPath,
      tokens_used: { input: totalInput, output: totalOutput },
      cost_usd: costUsd,
      context_compressed: compressionNeeded,
    });

    return {
      role,
      phase,
      artifactPath: resolvedArtifactPath,
      finalText,
      tokensInput: totalInput,
      tokensOutput: totalOutput,
      costUsd,
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
            const filePath = this.resolveSafePath(projectDir, input['path']!);
            if (deniedPrefixes?.some((p) => filePath.startsWith(path.resolve(projectDir, p)))) {
              toolResult = `Access denied: ${input['path']} is not available to this agent.`;
              break;
            }
            toolResult = await fs.promises.readFile(filePath, 'utf-8');
            break;
          }
          case 'write_file': {
            const filePath = this.resolveSafePath(projectDir, input['path']!);
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            await writeFileAtomic(filePath, input['content']!, { encoding: 'utf8' });
            // Bump spec version whenever the API spec is updated (divergence detection)
            if (input['path']?.includes('api-spec.yaml')) {
              await this.session.bumpSpecVersion(projectDir);
            }
            toolResult = `Written: ${input['path']}`;
            break;
          }
          case 'list_files': {
            const dirPath = this.resolveSafePath(projectDir, input['path']!);
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
    const phaseRoles: Record<number, string[]> = {
      0: ['pm', 'validator'],
      1: ['pm', 'architect', 'engineer', 'validator'],
      2: ['engineer', 'qa', 'validator',
          ...(config.security_enabled ? ['security'] : []),
          ...(config.wrecker_enabled ? ['wrecker'] : [])],
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
      return parsed.findings ?? [];
    } catch {
      return [];
    }
  }

  private inferArtifactPath(role: string, phase: number): string {
    const map: Record<string, string> = {
      pm: phase === 3 ? '03-prd.md' : phase === 1 ? '01-prd.md' : '00-concept.md',
      architect: '01-architecture.md',
      engineer: phase === 1 ? 'src/index.ts' : 'src/',
      qa: 'tests/integration/',
      // Phase 2 Validator lives in the 02-build/ subdirectory
      validator: phase === 2 ? '02-build/validator.json' : `0${phase}-validator.json`,
      security: '02-build/security-report.md',
      wrecker: '02-build/wrecker.json',
      devops: 'infra/',
      docs: 'docs/',
    };
    return map[role] ?? `phase${phase}-${role}.txt`;
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
