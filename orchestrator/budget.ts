import type { AgentRegistryEntry, SessionState } from './types.js';
import type { SessionManager } from './session.js';

/** Price per 1M tokens in USD (update when Anthropic reprices) */
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6':  { input: 3.00, output: 15.00 },
  'claude-opus-4-6':    { input: 5.00, output: 25.00 },
  'claude-haiku-4-5':   { input: 1.00, output: 5.00  },
};

export const BUDGET_MARGIN = 1.2; // 20% projection margin
export const SUMMARIZER_BUDGET_CAP_FRACTION = 0.05; // 5% of remaining budget

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = MODEL_PRICES[model];
  if (!price) {
    throw new Error(`Unknown model ID: "${model}" — add it to MODEL_PRICES in budget.ts`);
  }
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

export function projectDispatchCost(
  entry: AgentRegistryEntry,
  model: string,
  contextTokens: number,
): number {
  const estimatedOutputTokens = entry.expected_output_tokens_per_turn * entry.expected_tool_turns;
  // context_tokens are input; estimated output tokens are output — priced separately
  return calculateCostUsd(model, contextTokens, estimatedOutputTokens) * BUDGET_MARGIN;
}

export class BudgetGate extends Error {
  constructor(
    public readonly currentSpendUsd: number,
    public readonly remainingBudgetUsd: number,
    public readonly blockedAgent: string,
    public readonly projectedCostUsd: number,
  ) {
    super(`Budget gate: ${blockedAgent} would exceed spend cap`);
    this.name = 'BudgetGate';
  }
}

export class BudgetManager {
  constructor(private readonly session: SessionManager) {}

  /**
   * Pre-dispatch check: throws BudgetGate if the projected cost would breach the cap.
   * Never enforced mid-stream.
   *
   * State is re-read from disk on every call so that parallel dispatches (e.g.
   * backend + frontend engineers) each see the latest spend total rather than
   * sharing a stale snapshot captured before the first dispatch started.
   */
  async checkPreDispatch(
    projectDir: string,
    entry: AgentRegistryEntry,
    model: string,
    contextTokens: number,
  ): Promise<void> {
    const state = await this.session.read(projectDir);
    const { spend_cap } = state.config;
    if (spend_cap === null) return;

    const projected = projectDispatchCost(entry, model, contextTokens);
    const remaining = spend_cap - state.total_cost_usd;

    if (projected > remaining) {
      await this.session.update(projectDir, { pipeline_status: 'budget_gate_pending' });
      throw new BudgetGate(state.total_cost_usd, remaining, entry.role, projected);
    }
  }

  /**
   * Check whether the next summarizer call would push cumulative summarizer spend
   * past 5% of remaining budget. Returns false if the call should be skipped.
   *
   * NOTE: The caller is responsible for tracking and accumulating
   * `cumulativeSummarizerCost` across all summarizer dispatches in the session.
   * This value is not persisted here — the caller must read it from session state
   * (or a local accumulator) and pass it consistently on every call.
   */
  checkSummarizerBudget(
    projectedSummarizerCost: number,
    cumulativeSummarizerCost: number,
    state: SessionState,
  ): boolean {
    const { spend_cap } = state.config;
    if (spend_cap === null) return true;

    const remaining = spend_cap - state.total_cost_usd;
    const cap = remaining * SUMMARIZER_BUDGET_CAP_FRACTION;
    // Apply the same 20% margin used for agent dispatches for consistent accounting.
    return cumulativeSummarizerCost + projectedSummarizerCost * BUDGET_MARGIN <= cap;
  }

  /**
   * Format a cost estimate string for display in the gate header.
   * e.g. "~$0.45"
   */
  static formatEstimate(usd: number): string {
    return `~$${usd.toFixed(2)}`;
  }

  /**
   * Compute next-phase cost estimate for the gate header.
   * Single-pass only — no revision speculation.
   */
  static estimateNextPhase(
    agents: AgentRegistryEntry[],
    models: Record<string, string>,
    contextTokens: Record<string, number>,
  ): string {
    let total = 0;
    for (const entry of agents) {
      const model = models[entry.role]!;
      const ctx = contextTokens[entry.role];
      if (ctx === undefined) {
        // Context not yet available — omit this agent rather than use a
        // placeholder that would misrepresent the estimate.
        continue;
      }
      // Include system prompt tokens so the estimate matches the dispatch-path
      // accounting, where system_prompt_tokens is always part of input cost.
      const inputTokens = ctx + (entry.system_prompt_tokens ?? 0);
      total += projectDispatchCost(entry, model, inputTokens);
    }
    return BudgetManager.formatEstimate(total);
  }
}
