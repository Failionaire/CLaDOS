/**
 * `clados doctor` — validates session state integrity.
 *
 * Checks:
 *   1. JSON parse validity
 *   2. SHA-256 checksum match
 *   3. Phase/agent index bounds
 *   4. Artifact file existence
 *   5. Budget arithmetic consistency
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { SessionState } from './types.js';

interface DoctorIssue {
  level: 'error' | 'warning';
  message: string;
}

export interface DoctorResult {
  valid: boolean;
  issues: DoctorIssue[];
  projectDir: string;
}

export async function runDoctor(projectDir: string): Promise<DoctorResult> {
  const issues: DoctorIssue[] = [];
  const claDosDir = path.join(projectDir, '.clados');
  const statePath = path.join(claDosDir, '00-session-state.json');
  const checksumPath = statePath + '.sha256';

  // 1. JSON parse validity
  let state: SessionState;
  let rawJson: string;
  try {
    rawJson = await fs.promises.readFile(statePath, 'utf-8');
  } catch (err) {
    issues.push({ level: 'error', message: `Cannot read session state: ${(err as Error).message}` });
    return { valid: false, issues, projectDir };
  }

  try {
    state = JSON.parse(rawJson) as SessionState;
  } catch (err) {
    issues.push({ level: 'error', message: `Session state is not valid JSON: ${(err as Error).message}` });
    return { valid: false, issues, projectDir };
  }

  // 2. Checksum verification
  try {
    const storedChecksum = (await fs.promises.readFile(checksumPath, 'utf-8')).trim();
    const actualChecksum = crypto.createHash('sha256').update(rawJson).digest('hex');
    if (storedChecksum !== actualChecksum) {
      issues.push({ level: 'error', message: `Checksum mismatch — state file may be corrupt. Expected ${storedChecksum}, got ${actualChecksum}.` });
    }
  } catch {
    issues.push({ level: 'warning', message: 'No checksum file found — cannot verify state integrity. Run a pipeline to generate one.' });
  }

  // 3. Phase/agent index bounds
  if (state.current_phase < 0 || state.current_phase > 4) {
    issues.push({ level: 'error', message: `current_phase ${state.current_phase} is out of bounds (0-4).` });
  }
  for (const p of state.phases_completed) {
    if (p < 0 || p > 4) {
      issues.push({ level: 'error', message: `phases_completed contains out-of-bounds phase ${p}.` });
    }
  }

  if (state.phase_checkpoint) {
    const cp = state.phase_checkpoint;
    if (cp.phase < 0 || cp.phase > 4) {
      issues.push({ level: 'error', message: `phase_checkpoint.phase ${cp.phase} is out of bounds.` });
    }
    if (cp.gate_revision_count < 0) {
      issues.push({ level: 'warning', message: `gate_revision_count is negative: ${cp.gate_revision_count}.` });
    }
  }

  // 4. Artifact file existence
  for (const [key, record] of Object.entries(state.artifacts)) {
    const artifactPath = path.join(claDosDir, key);
    if (!fs.existsSync(artifactPath)) {
      issues.push({ level: 'warning', message: `Registered artifact "${key}" (${record.path}) not found on disk.` });
    }
  }

  // 5. Budget arithmetic consistency
  const computedTotal = Object.values(state.agent_tokens_used)
    .flatMap((agents) => Object.values(agents))
    .reduce((sum, t) => sum + t.cost_usd, 0);
  const roundedComputed = Math.round(computedTotal * 1_000_000) / 1_000_000;
  const roundedStored = Math.round(state.total_cost_usd * 1_000_000) / 1_000_000;
  if (Math.abs(roundedComputed - roundedStored) > 0.000001) {
    issues.push({
      level: 'warning',
      message: `Budget arithmetic inconsistency: sum of agent costs = $${roundedComputed.toFixed(6)}, stored total = $${roundedStored.toFixed(6)}.`,
    });
  }

  // 6. Required fields present
  if (!state.project_id) issues.push({ level: 'error', message: 'Missing project_id.' });
  if (!state.project_name) issues.push({ level: 'error', message: 'Missing project_name.' });
  if (!state.config) issues.push({ level: 'error', message: 'Missing config.' });
  if (!state.pipeline_status) issues.push({ level: 'error', message: 'Missing pipeline_status.' });

  const valid = issues.every((i) => i.level !== 'error');
  return { valid, issues, projectDir };
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push(`\nCLaDOS Doctor — ${result.projectDir}\n`);

  if (result.issues.length === 0) {
    lines.push('  ✓ All checks passed. Session state is healthy.\n');
    return lines.join('\n');
  }

  for (const issue of result.issues) {
    const icon = issue.level === 'error' ? '✗' : '⚠';
    lines.push(`  ${icon} [${issue.level.toUpperCase()}] ${issue.message}`);
  }

  lines.push('');
  lines.push(result.valid ? '  Result: PASS (warnings only)' : '  Result: FAIL');
  lines.push('');
  return lines.join('\n');
}
