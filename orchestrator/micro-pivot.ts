/**
 * Micro-pivot module — handles architecture change requests during Build phase.
 *
 * When an Engineer emits a `request_architecture_change` tool call, the Conductor:
 * 1. Pauses the Engineer
 * 2. Dispatches Architect with the change request
 * 3. Opens a MicroGate for user approval
 * 4. If approved: applies Architect changes, resumes Engineer with updated context
 * 5. If rejected: resumes Engineer with denial context
 */

import type { MicroPivot, MicroGateResponse, WsMicroGateOpen, WsServerEvent } from './types.js';
import type { SessionManager } from './session.js';
import type { Logger } from './logger.js';
import crypto from 'crypto';

const MAX_PIVOTS_PER_PHASE = 3;

export interface MicroPivotContext {
  phase: number;
  requestingAgent: string;
  changeRequest: string;
}

export interface MicroPivotResult {
  approved: boolean;
  architectResponse?: string;
  architectDiff?: string;
  rejectionReason?: string;
}

/**
 * Check whether a micro-pivot is allowed (under the per-phase limit).
 */
export async function canRequestPivot(
  session: SessionManager,
  projectDir: string,
  phase: number,
): Promise<boolean> {
  const state = await session.read(projectDir);
  const pivots = (state.micro_pivots ?? []).filter(p => p.phase === phase);
  return pivots.length < MAX_PIVOTS_PER_PHASE;
}

/**
 * Create a new micro-pivot record and persist it to session state.
 */
export async function createPivot(
  session: SessionManager,
  projectDir: string,
  ctx: MicroPivotContext,
): Promise<MicroPivot> {
  const pivot: MicroPivot = {
    id: crypto.randomUUID(),
    phase: ctx.phase,
    requesting_agent: ctx.requestingAgent,
    change_request: ctx.changeRequest,
    timestamp: new Date().toISOString(),
  };

  const state = await session.read(projectDir);
  await session.update(projectDir, {
    micro_pivots: [...(state.micro_pivots ?? []), pivot],
  });

  return pivot;
}

/**
 * Update a pivot with the Architect's response and the user's decision.
 */
export async function resolvePivot(
  session: SessionManager,
  projectDir: string,
  pivotId: string,
  architectResponse: string,
  architectDiff: string,
  decision: MicroGateResponse,
): Promise<void> {
  const state = await session.read(projectDir);
  const pivots = (state.micro_pivots ?? []).map(p => {
    if (p.id !== pivotId) return p;
    return {
      ...p,
      architect_response: architectResponse,
      architect_diff: architectDiff,
      user_decision: decision.action === 'approve' ? 'approved' as const : 'rejected' as const,
      rejection_reason: decision.rejection_reason,
    };
  });
  await session.update(projectDir, { micro_pivots: pivots });
}

/**
 * Build the WsMicroGateOpen event for broadcasting.
 */
export function buildMicroGateEvent(
  pivot: MicroPivot,
  architectResponse: string,
  proposedDiff: string,
  affectedFiles: string[],
): WsMicroGateOpen {
  return {
    type: 'micro:gate',
    pivot_id: pivot.id,
    phase: pivot.phase,
    requesting_agent: pivot.requesting_agent,
    change_request: pivot.change_request,
    architect_response: architectResponse,
    proposed_diff: proposedDiff,
    affected_files: affectedFiles,
  };
}

/**
 * Open a micro-gate and wait for user response.
 */
export function openMicroGate(
  event: WsMicroGateOpen,
  broadcast: (e: WsServerEvent) => void,
  setResolve: (resolver: (r: MicroGateResponse) => void) => void,
  setEvent: (e: WsServerEvent) => void,
  logger: Logger,
): Promise<MicroGateResponse> {
  return new Promise((resolve) => {
    setResolve(resolve);
    setEvent(event);
    broadcast(event);
    logger.info('micro_pivot.gate_opened', `Micro-pivot gate opened: ${event.pivot_id}`);
  });
}
