// Shared types for CLaDOS UI — mirrors orchestrator/types.ts

export type PipelineStatus =
  | 'idle'
  | 'agent_running'
  | 'gate_pending'
  | 'budget_gate_pending'
  | 'abandoned'
  | 'complete';

export type ProjectType = 'backend-only' | 'full-stack' | 'cli-tool' | 'library';

export type FindingSeverity = 'must_fix' | 'should_fix' | 'suggestion';

export type FindingStatus =
  | 'new'
  | 'resolved'
  | 'partially_resolved'
  | 'unresolved'
  | 'new_discovery';

export interface Finding {
  id: string;
  severity: FindingSeverity;
  category: string;
  description: string;
  file?: string;
  line?: number;
  status: FindingStatus;
  /** UI-only: tracks whether the user has overridden this finding. Not stored in orchestrator state. */
  override?: boolean;
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

export interface SessionConfig {
  project_type: ProjectType;
  idea: string;
  security_enabled: boolean;
  wrecker_enabled: boolean;
  is_high_complexity: boolean;
  spend_cap: number | null;
}

export interface AgentTokenRecord {
  input: number;
  output: number;
  cost_usd: number;
}

export interface SessionState {
  project_id: string;
  project_name: string;
  created_at: string;
  updated_at: string;
  pipeline_status: PipelineStatus;
  config: SessionConfig;
  spec_version: number;
  current_phase: number;
  phase_checkpoint: PhaseCheckpoint | null;
  phases_completed: number[];
  agent_tokens_used: Record<string, Record<string, AgentTokenRecord>>;
  total_cost_usd: number;
  conductor_decisions: Array<{
    phase: number;
    agent: string;
    trigger: string;
    decision: string;
    timestamp: string;
  }>;
  dependency_divergences: string[];
  validator_tier: 'sonnet' | 'opus';
  artifacts: Record<string, { path: string; token_count: number; version: number; created_at?: string; agent?: string }>;
}

// WebSocket event types

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

export type WsEvent =
  | WsAgentStart
  | WsAgentStream
  | WsAgentDone
  | WsAgentError
  | WsAgentSkipped
  | WsGateOpen
  | WsBudgetGate
  | WsStateSnapshot;

// AgentStatus tracks per-agent UI state derived from WS events
export type AgentCardStatus = 'pending' | 'running' | 'retrying' | 'done' | 'flagged' | 'error' | 'skipped';

export interface AgentCardState {
  role: string;
  phase: number;
  status: AgentCardStatus;
  currentSection: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  artifactKey: string | null;
  errorMessage: string | null;
  contextCompressed: boolean;
  fullArtifactsFetched: number;
  isSkippable: boolean;
  errorKey?: string;
  retryCount: number;
}
