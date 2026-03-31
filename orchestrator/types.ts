// ─── Pipeline & project ──────────────────────────────────────────────────────

export type PipelineStatus =
  | 'idle'
  | 'agent_running'
  | 'gate_pending'
  | 'budget_gate_pending'
  | 'abandoned'
  | 'complete';

export type ProjectType = 'backend-only' | 'full-stack' | 'cli-tool' | 'library';

/** Canonical set of agent roles in v1. errorKey suffixes like 'engineer-backend' are NOT roles. */
export type AgentRole =
  | 'pm'
  | 'architect'
  | 'engineer'
  | 'qa'
  | 'validator'
  | 'security'
  | 'wrecker'
  | 'devops'
  | 'docs';

/** The three tool names the Conductor exposes to agents. Any other value in agent-registry.json is a config error. */
export type AgentTool = 'read_file' | 'write_file' | 'list_files';

// ─── Findings & validation ───────────────────────────────────────────────────

export type FindingSeverity = 'must_fix' | 'should_fix' | 'suggestion';

export type FindingStatus =
  | 'new'
  | 'resolved'
  | 'partially_resolved'
  | 'unresolved'
  | 'new_discovery';

export interface Finding {
  /**
   * Stable identifier used for finding override tracking across revisions.
   * Format: `{phase}-{agent}-{category}-{index}`, e.g. `2-validator-security-0`.
   * Must be deterministic per finding so that override_findings[] in GateResponse
   * correctly matches the same finding on repeated gate opens.
   */
  id: string;
  severity: FindingSeverity;
  category: string;
  description: string;
  file?: string;
  line?: number;
  /**
   * Always present — the Validator must set this on every finding.
   * loadValidatorFindings() defaults missing values to 'new' so runtime LLM output
   * that omits the field is normalised before any filter logic runs.
   */
  status: FindingStatus;
}

// ─── Session state ────────────────────────────────────────────────────────────

export interface SessionConfig {
  project_type: ProjectType;
  idea: string;
  security_enabled: boolean;
  wrecker_enabled: boolean;
  is_high_complexity: boolean;
  spend_cap: number | null;
}

export interface PhaseCheckpoint {
  phase: number;
  completed_agents: string[];
  in_progress_agent: string | null;
  in_progress_artifact_partial: string | null;
  spec_version_at_start: number;
  gate_revision_count: number;
  unresolved_streak: number;
}

export interface AgentTokenRecord {
  input: number;
  output: number;
  cost_usd: number;
}

export interface ArtifactRecord {
  path: string;
  token_count: number;
  version: number;
  /** ISO timestamp set when the artifact is first registered (or re-registered on overwrite). */
  created_at?: string;
  /** Role of the agent that produced this artifact. */
  agent?: AgentRole;
}

export interface ConductorDecision {
  phase: number;
  agent: string;
  trigger: string;
  decision: string;
  timestamp: string;
}

export interface ConductorReasoning {
  phase: number;
  context_summary: string;
  question: string;
  response: string;
  timestamp: string;
}

export interface ContextCompressionLogEntry {
  agent: string;
  phase: number;
  artifact: string;
  reason: 'reference_to_summary' | 'required_to_summary';
  timestamp: string;
}

export interface SessionState {
  project_id: string;
  project_name: string;
  created_at: string;
  /** Updated on every atomic state write — useful for diagnosing stale state after a crash. */
  updated_at: string;
  pipeline_status: PipelineStatus;
  config: SessionConfig;
  spec_version: number;
  current_phase: number;
  phase_checkpoint: PhaseCheckpoint | null;
  phases_completed: number[];
  /** Indexed by phase number (as string key), then by agent role */
  agent_tokens_used: Record<string, Record<string, AgentTokenRecord>>;
  total_cost_usd: number;
  conductor_decisions: ConductorDecision[];
  conductor_reasoning: ConductorReasoning[];
  dependency_divergences: string[];
  validator_tier: 'sonnet' | 'opus';
  token_counting_approximate: boolean;
  /** Log of context downgrade decisions per agent dispatch. */
  context_compression_log: ContextCompressionLogEntry[];
  artifacts: Record<string, ArtifactRecord>;
}

// ─── Agent registry ───────────────────────────────────────────────────────────

export type AgentEnabledWhen = 'always' | 'config.security' | 'config.wrecker';

export type ArtifactInjectionType = 'required' | 'reference';

export interface ContextArtifact {
  artifact: string;
  type: ArtifactInjectionType;
}

export interface AgentRegistryEntry {
  role: AgentRole;
  system_prompt: string;
  default_model: string;
  escalation_model: string;
  tools: AgentTool[];
  enabled_when: AgentEnabledWhen;
  context_artifacts: ContextArtifact[];
  system_prompt_tokens: number | null;
  expected_output_tokens_per_turn: number;
  expected_tool_turns: number;
}

export interface AgentRegistry {
  agents: AgentRegistryEntry[];
  rate_limit_tpm: number;
  utility_models: {
    token_counter: string;
    summarizer: string;
    conductor: string;
  };
  model_prices: Record<string, { input: number; output: number }>;
}

// ─── Agent dispatch ───────────────────────────────────────────────────────────

export interface DispatchVariables {
  project_type?: ProjectType;
  [key: string]: string | undefined;
}

export interface AgentDispatchConfig {
  role: AgentRole;
  phase: number;
  projectDir: string;
  /** Injected into system prompt via {{variable_name}} syntax */
  variables?: DispatchVariables;
  /** Override the default model (e.g., for escalation) */
  modelOverride?: string;
  /** Override context artifacts for this specific dispatch */
  contextArtifacts?: ContextArtifact[];
  /** Extra text prepended to the user context message */
  contextPrefix?: string;
  /** File path prefixes that read_file must deny (used for QA asymmetric context) */
  deniedPrefixes?: string[];
  /** Key used in agentErrorResolves map; defaults to role if unset (used for full-stack parallel engineers) */
  errorKey?: string;
}

export interface AgentResult {
  role: AgentRole;
  phase: number;
  artifact_path: string;
  final_text: string;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number;
}

// ─── WebSocket events (server → client) ──────────────────────────────────────

export interface WsAgentStart {
  type: 'agent:start';
  phase: number;
  agent: string;
  model: string;
}

export interface WsAgentStream {
  type: 'agent:stream';
  phase: number;
  agent: string;
  section: string;
}

export interface WsAgentDone {
  type: 'agent:done';
  phase: number;
  agent: string;
  artifact: string;
  tokens_used: { input: number; output: number };
  cost_usd: number;
  context_compressed: boolean;
  /** Number of full artifacts the agent fetched via read_file during a compressed-context run. */
  full_artifacts_fetched: number;
}

export interface WsAgentError {
  type: 'agent:error';
  phase: number;
  agent: string;
  error_type: 'api_429' | 'api_5xx' | 'context_length' | 'timeout' | 'parse_error';
  message: string;
  retry_count: number;
  is_skippable: boolean;
  /** Matches the agentErrorResolves map key; equals role unless errorKey was set on the dispatch config */
  error_key?: string;
}

export interface WsAgentSkipped {
  type: 'agent:skipped';
  phase: number;
  agent: string;
}

export interface WsGateOpen {
  type: 'gate:open';
  phase: number;
  gate_number: number;
  artifacts: string[];
  findings: Finding[];
  revision_count: number;
  next_phase_cost_estimate: string;
  /** Set when the gate is forced due to context-length overflow (not a normal review gate). */
  overflow?: boolean;
  /** Human-readable message shown when overflow is true. */
  overflow_message?: string;
}

export interface WsBudgetGate {
  type: 'budget:gate';
  current_spend_usd: number;
  remaining_budget_usd: number;
  blocked_agent: string;
  projected_cost_usd: number;
}

export interface WsStateSnapshot {
  type: 'state:snapshot';
  state: SessionState;
}

export type WsServerEvent =
  | WsAgentStart
  | WsAgentStream
  | WsAgentDone
  | WsAgentError
  | WsAgentSkipped
  | WsGateOpen
  | WsBudgetGate
  | WsStateSnapshot;

// ─── Gate actions (REST) ──────────────────────────────────────────────────────

/** Derives from GateResponse so it never drifts from the discriminated union. */
export type GateAction = GateResponse['action'];

export type GateResponse =
  | { action: 'approve'; override_findings?: string[] }
  | { action: 'revise'; revision_text: string; override_findings?: string[] }
  | { action: 'abort' }
  | { action: 'goto'; goto_gate: number };

// ─── Contract validator output ────────────────────────────────────────────────

export type ContractFinding =
  | { type: 'missing_route'; method: string; path: string; message: string }
  | { type: 'undeclared_route'; method: string; path: string; file: string; line: number; message: string }
  | { type: 'unresolved_import'; file: string; line: number; message: string };

export interface ContractValidatorResult {
  passed: boolean;
  findings: ContractFinding[];
  spec_endpoint_count: number;
  registered_route_count: number;
}

// ─── Test runner output ────────────────────────────────────────────────────────

export interface TestSuiteResult {
  passed: boolean;
  total: number;
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  duration_ms: number;
  failures: Array<{ test: string; message: string }>;
}

export interface TestRunnerResult extends TestSuiteResult {
  wrecker_tests?: TestSuiteResult;
}

// ─── Log entry ────────────────────────────────────────────────────────────────

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  phase: number | null;
  agent: string | null;
  event: string;
  message: string;
  data?: Record<string, unknown>;
}
