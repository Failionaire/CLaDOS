/**
 * CLI subcommand: clados cost
 *
 * Usage: clados cost <project-dir>
 *
 * Reads session state and prints a detailed cost breakdown:
 * - Per-phase, per-agent spend
 * - Input/output token separation
 * - Revision cycle and escalation cost analysis
 * - Re-invocation cost history
 * - Context compression savings estimate
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionState, AgentTokenRecord } from '../types.js';

const PHASE_NAMES: Record<number, string> = {
  0: 'Concept',
  1: 'Architecture',
  2: 'Build',
  3: 'Document',
  4: 'Infra',
};

/** Per-million-token prices — fallback if agent-registry.json isn't accessible */
const DEFAULT_PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-haiku-4-5':          { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-opus-4-6':           { input: 5.00, output: 25.00 },
};

export async function costCommand(args: string[]): Promise<void> {
  const projectDir = args[0];
  if (!projectDir) {
    console.error('Usage: clados cost <project-dir>');
    process.exit(1);
  }

  const resolvedDir = path.resolve(projectDir);
  const statePath = path.join(resolvedDir, '.clados', '00-session-state.json');

  if (!fs.existsSync(statePath)) {
    console.error(`No CLaDOS session found at ${resolvedDir}`);
    console.error('Make sure the path points to a project with a .clados/ directory.');
    process.exit(1);
  }

  let state: SessionState;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    console.error('Failed to parse session state.');
    process.exit(1);
  }

  // ─── Header ─────────────────────────────────────────────────────────────────
  console.log();
  console.log(`Project: ${state.project_name}`);
  console.log(`Total: $${state.total_cost_usd.toFixed(2)}`);
  console.log();

  // ─── Per-phase breakdown ────────────────────────────────────────────────────
  let totalInput = 0;
  let totalOutput = 0;

  const phaseKeys = Object.keys(state.agent_tokens_used)
    .map(Number)
    .sort((a, b) => a - b);

  for (const phaseNum of phaseKeys) {
    const phaseKey = String(phaseNum);
    const agents = state.agent_tokens_used[phaseKey];
    if (!agents) continue;

    const phaseName = PHASE_NAMES[phaseNum] ?? `Phase ${phaseNum}`;
    const phaseCost = sumCost(agents);
    const agentBreakdown = Object.entries(agents)
      .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
      .map(([role, record]) => `${role} $${record.cost_usd.toFixed(2)}`)
      .join(', ');

    const label = `Phase ${phaseNum} — ${phaseName}:`;
    console.log(`${label.padEnd(26)} $${phaseCost.toFixed(2)}  (${agentBreakdown})`);

    // Track totals
    for (const record of Object.values(agents)) {
      totalInput += record.input;
      totalOutput += record.output;
    }

    // Show revision cycles
    const revisionDecisions = (state.conductor_decisions ?? []).filter(
      (d) => d.phase === phaseNum && d.trigger === 'gate_revision',
    );
    for (let i = 0; i < revisionDecisions.length; i++) {
      console.log(`  └─ Revision ${i + 1}:       (re-run after must_fix findings)`);
    }

    // Show escalation if validator tier was upgraded for this phase
    const escalationDecisions = (state.conductor_decisions ?? []).filter(
      (d) => d.phase === phaseNum && d.trigger === 'escalation',
    );
    for (const esc of escalationDecisions) {
      console.log(`  └─ Escalation:       (${esc.decision})`);
    }
  }

  // ─── Token breakdown ───────────────────────────────────────────────────────
  console.log();
  console.log('Token breakdown:');

  // Estimate per-token cost split using average prices
  const avgInputPrice = estimateAvgTokenPrice(state, 'input');
  const avgOutputPrice = estimateAvgTokenPrice(state, 'output');
  const inputCostEstimate = (totalInput / 1_000_000) * avgInputPrice;
  const outputCostEstimate = (totalOutput / 1_000_000) * avgOutputPrice;

  console.log(`  Input:  ${totalInput.toLocaleString()} tokens ($${inputCostEstimate.toFixed(2)})`);
  console.log(`  Output: ${totalOutput.toLocaleString()} tokens ($${outputCostEstimate.toFixed(2)})`);

  // ─── Context compression savings ───────────────────────────────────────────
  const compressionEntries = state.context_compression_log ?? [];
  if (compressionEntries.length > 0) {
    // Estimate savings: each compression typically saves ~60% of the artifact tokens
    const compressedArtifacts = new Set(compressionEntries.map((e) => e.artifact));
    let estimatedTokensSaved = 0;
    for (const artKey of compressedArtifacts) {
      const artRecord = state.artifacts?.[artKey];
      if (artRecord) {
        // Summarization typically reduces to ~40% of original, so savings ≈ 60%
        estimatedTokensSaved += Math.round(artRecord.token_count * 0.6);
      }
    }
    if (estimatedTokensSaved > 0) {
      const savedCost = (estimatedTokensSaved / 1_000_000) * avgInputPrice;
      console.log();
      console.log(`Context compression saved: ~${estimatedTokensSaved.toLocaleString()} tokens ($${savedCost.toFixed(2)} estimated)`);
    }
  }

  // ─── Re-invocation history ─────────────────────────────────────────────────
  const reinvocations = state.reinvocations ?? [];
  if (reinvocations.length > 0) {
    console.log();
    console.log('Re-invocations:');
    for (let i = 0; i < reinvocations.length; i++) {
      const r = reinvocations[i]!;
      const phaseName = PHASE_NAMES[r.actual_entry_phase] ?? `Phase ${r.actual_entry_phase}`;
      console.log(`  ${i + 1}. Phase ${r.actual_entry_phase} (${phaseName}) — ${r.timestamp}`);
      if (r.change_description) console.log(`     ${r.change_description}`);
    }
  }

  console.log();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sumCost(agents: Record<string, AgentTokenRecord>): number {
  return Object.values(agents).reduce((sum, r) => sum + r.cost_usd, 0);
}

/**
 * Estimate average per-million-token price across used models.
 * Since session state doesn't track which model each agent used,
 * we derive from total cost and token counts.
 */
function estimateAvgTokenPrice(state: SessionState, type: 'input' | 'output'): number {
  let totalTokens = 0;
  let totalCost = 0;

  for (const agents of Object.values(state.agent_tokens_used)) {
    for (const record of Object.values(agents)) {
      totalTokens += type === 'input' ? record.input : record.output;
      totalCost += record.cost_usd;
    }
  }

  if (totalTokens === 0) return type === 'input' ? 3.0 : 15.0;

  // Split cost proportionally between input and output using default Sonnet pricing ratio
  // Input is ~16.7% of cost per token, output is ~83.3% at Sonnet prices
  const inputRatio = 3.0 / (3.0 + 15.0); // 0.167
  const outputRatio = 15.0 / (3.0 + 15.0); // 0.833

  const allInput = Object.values(state.agent_tokens_used)
    .flatMap((a) => Object.values(a))
    .reduce((s, r) => s + r.input, 0);
  const allOutput = Object.values(state.agent_tokens_used)
    .flatMap((a) => Object.values(a))
    .reduce((s, r) => s + r.output, 0);

  if (allInput === 0 && allOutput === 0) return type === 'input' ? 3.0 : 15.0;

  // Weighted estimate: total cost split by token-weighted ratio
  const inputCostShare = totalCost * (allInput * inputRatio) / (allInput * inputRatio + allOutput * outputRatio);
  const outputCostShare = totalCost - inputCostShare;

  if (type === 'input') {
    return allInput > 0 ? (inputCostShare / allInput) * 1_000_000 : 3.0;
  }
  return allOutput > 0 ? (outputCostShare / allOutput) * 1_000_000 : 15.0;
}
