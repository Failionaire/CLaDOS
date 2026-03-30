import type { AgentEnabledWhen, SessionConfig } from './types.js';

/**
 * Determine which model to use for a given agent dispatch.
 * Escalation rules (from spec):
 *   1. Phase has been revised 3+ times without resolving must_fix findings
 *   2. Project is flagged as high-complexity at setup
 */
export function resolveModel(
  defaultModel: string,
  escalationModel: string,
  gateRevisionCount: number,
  isHighComplexity: boolean,
): string {
  if (gateRevisionCount >= 3 || isHighComplexity) {
    return escalationModel;
  }
  return defaultModel;
}

/**
 * Evaluate the enabled_when field from the agent registry.
 * Only three valid values in v1 — anything else throws at startup.
 */
export function isAgentEnabled(
  enabledWhen: AgentEnabledWhen,
  config: SessionConfig,
): boolean {
  if (enabledWhen === 'always') return true;
  if (enabledWhen === 'config.security') return config.security_enabled;
  if (enabledWhen === 'config.wrecker') return config.wrecker_enabled;
  throw new Error(`Unknown enabled_when value: ${enabledWhen as string}`);
}

/**
 * Skippable agents — the only ones for which the UI shows a "Skip agent" button.
 * Validator and Contract Validator are never skippable.
 */
export const SKIPPABLE_ROLES = new Set(['wrecker', 'security', 'docs']);

export function isSkippable(role: string): boolean {
  return SKIPPABLE_ROLES.has(role);
}
