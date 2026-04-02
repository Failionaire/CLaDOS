import { useState, useEffect, useRef } from 'react';
import type { SessionState } from '../types';

// ─── Phase cost estimates & GLaDOS bar helpers ───────────────────────────────

// Rough per-phase cost estimates (USD) — used for flex sizing before actual data exists.
// Build dominates intentionally; √-scaled so the ratio is visible but not absurd.
const PHASE_COST_EST = [0.05, 0.35, 6.0, 0.30, 0.15];

const PHASE_UPPER = ['CONCEPT', 'ARCH', 'BUILD', 'DOCS', 'INFRA'];

const SUBLABELS = {
  done: [
    ['completed. finally.', 'test subject survived.', 'results: inconclusive but positive.'],
    ['overengineered, naturally.', 'the cake is not a lie this time.', 'blueprints locked in.'],
    ['it compiled. mostly.', 'code generated. pray it works.', 'ready for testing.'],
    ['documented. you\'re welcome.', 'words about code about words.', 'manual: complete.'],
    ['deployed. godspeed.', 'containerized. it\'s someone else\'s problem now.', 'shipping. no refunds.'],
  ],
  running: [
    ['structuring your idea.', 'processing your "vision."', 'turning caffeine into specs.'],
    ['overthinking the schema.', 'designing the architecture.', 'drawing boxes and arrows.'],
    ['synthesizing code...', 'writing code. try not to watch.', 'compiling neurons...'],
    ['writing things down.', 'documenting the undocumentable.', 'generating prose.'],
    ['containerizing everything.', 'wrapping it up. literally.', 'deploying with confidence. mostly.'],
  ],
  gate: [
    ['concept ready.', 'your idea, now with structure.'],
    ['architecture ready.', 'the blueprint awaits judgment.'],
    ['build complete.', 'code awaits the validator.'],
    ['docs ready.', 'words assembled. review them.'],
    ['ready to ship.', 'one button away from production.'],
  ],
};

function getFlexes(sessionState: SessionState | null): number[] {
  return PHASE_COST_EST.map((est, i) => {
    const phaseData = sessionState?.agent_tokens_used[String(i)];
    const actual = phaseData ? Object.values(phaseData).reduce((s, t) => s + t.cost_usd, 0) : 0;
    return Math.max(0.3, Math.sqrt(actual > 0.001 ? actual : est));
  });
}

function PhaseBar({ sessionState, status, phase, gateNumber, elapsed }: {
  sessionState: SessionState | null;
  status: string;
  phase: number;
  gateNumber?: number;
  elapsed?: number;
}) {
  const completed = sessionState?.phases_completed ?? [];
  const agentName = sessionState?.phase_checkpoint?.in_progress_agent ?? null;
  const tokenData = sessionState?.agent_tokens_used ?? {};
  const flexes = getFlexes(sessionState);

  // §9.5 — Sublabel rotation: cycle through quip variants on a slow interval
  const [sublabelIdx, setSublabelIdx] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSublabelIdx((prev) => prev + 1), 8000);
    return () => clearInterval(timer);
  }, []);

  let statusNode: React.ReactNode = null;
  if (status === 'agent_running') {
    const agent = agentName ? agentName.toUpperCase() : 'AGENT';
    const elapsedStr = elapsed && elapsed > 0 ? ` · ${elapsed}s` : '';
    statusNode = <>{`● ${agent} RUNNING${elapsedStr}`}<span className="glados-cursor">_</span></>;
  } else if (status === 'gate_pending') {
    statusNode = `⬡ GATE ${gateNumber ?? phase + 1} — AWAITING REVIEW`;
  } else if (status === 'complete') {
    statusNode = '✓ PIPELINE COMPLETE';
  } else if (status === 'budget_gate_pending') {
    statusNode = '⚠ BUDGET GATE';
  }

  return (
    <div style={{ width: '100%' }}>
      {/* Top row */}
      <div style={barStyles.topRow}>
        <span style={barStyles.topLeft}>
          {`// PHASE ${phase} — ${PHASE_UPPER[phase] ?? String(phase)}`}
        </span>
        <span
          style={barStyles.topRight}
          className={status === 'agent_running' ? 'glados-flicker' : ''}
        >
          {statusNode}
        </span>
      </div>

      {/* Rail 1 — main */}
      <div style={barStyles.rail}>
        {flexes.map((flex, i) => {
          const isDone = completed.includes(i) || status === 'complete';
          const isActive = !isDone && i === phase && status !== 'idle';
          return (
            <div
              key={i}
              style={{ ...barStyles.seg, flex, ...(isDone ? barStyles.segDone : isActive ? barStyles.segActive : barStyles.segPending) }}
              className={isActive && status === 'agent_running' ? 'glados-glow' : ''}
            />
          );
        })}
      </div>

      {/* Rail 2 — shadow */}
      <div style={{ ...barStyles.rail, marginTop: 1 }}>
        {flexes.map((flex, i) => (
          <div key={i} style={{ ...barStyles.seg2, flex }} />
        ))}
      </div>

      {/* Label row */}
      <div style={barStyles.labelRow}>
        {PHASE_COST_EST.map((est, i) => {
          const isDone = completed.includes(i) || status === 'complete';
          const isActive = !isDone && i === phase && status !== 'idle';
          const phaseTokens = tokenData[String(i)];
          const actualCost = phaseTokens ? Object.values(phaseTokens).reduce((s, t) => s + t.cost_usd, 0) : 0;

          let sublabel: string;
          if (isDone) {
            const variants = SUBLABELS.done[i];
            sublabel = variants[sublabelIdx % variants.length];
          } else if (isActive) {
            if (status === 'agent_running') {
              const variants = SUBLABELS.running[i];
              sublabel = actualCost > 0.001 ? `$${actualCost.toFixed(4)} so far` : variants[sublabelIdx % variants.length];
            } else {
              const variants = SUBLABELS.gate[i];
              sublabel = variants[sublabelIdx % variants.length];
            }
          } else {
            sublabel = `~$${est.toFixed(2)} est.`;
          }

          return (
            <div
              key={i}
              style={{ ...barStyles.label, flex: flexes[i], ...(isDone ? barStyles.labelDone : isActive ? barStyles.labelActive : barStyles.labelPending) }}
            >
              {PHASE_UPPER[i]}
              <span style={{ ...barStyles.note, ...(isDone ? barStyles.noteDone : isActive ? barStyles.noteActive : barStyles.notePending) }}>
                {sublabel}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const barStyles = {
  topRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 4,
  },
  topLeft: {
    fontSize: 9,
    fontFamily: 'var(--font-mono)',
    color: 'color-mix(in srgb, var(--ap-orange) 32%, transparent)',
    letterSpacing: '0.07em',
  },
  topRight: {
    fontSize: 9,
    fontFamily: 'var(--font-mono)',
    color: 'var(--ap-orange)',
    letterSpacing: '0.06em',
    whiteSpace: 'nowrap' as const,
  },
  rail: {
    display: 'flex',
    height: 2,
    gap: 1,
    width: '100%',
  },
  seg: {
    flexShrink: 0,
    minWidth: 4,
    height: 2,
  } as React.CSSProperties,
  segDone:    { background: 'var(--ap-orange)' },
  segActive:  { background: 'var(--ap-orange-hi)' },
  segPending: { background: 'var(--border-dim)' },
  seg2: {
    background: 'var(--border-dim)',
    flexShrink: 0,
    height: 2,
    minWidth: 4,
    opacity: 0.55,
  } as React.CSSProperties,
  labelRow: {
    display: 'flex',
    gap: 1,
    marginTop: 5,
  },
  label: {
    fontSize: 9,
    fontFamily: 'var(--font-mono)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 1,
    minWidth: 0,
    overflow: 'hidden',
  } as React.CSSProperties,
  labelDone:    { color: 'var(--ap-orange)' },
  labelActive:  { color: 'var(--ap-orange-hi)' },
  labelPending: { color: 'var(--text-4)' },
  note: {
    fontSize: 8,
    display: 'block',
    overflow: 'hidden',
    whiteSpace: 'nowrap' as const,
    textOverflow: 'ellipsis',
  } as React.CSSProperties,
  noteDone:    { color: 'color-mix(in srgb, var(--ap-orange) 44%, transparent)' },
  noteActive:  { color: 'color-mix(in srgb, var(--ap-orange-hi) 52%, transparent)' },
  notePending: { color: 'var(--border)' },
};

// ─── Topbar ───────────────────────────────────────────────────────────────────

interface TopbarProps {
  sessionState: SessionState | null;
  connectionStatus: 'connecting' | 'connected' | 'reconnected' | 'disconnected' | 'failed';
  onFocusGate: () => void;
  hasPendingGate: boolean;
  gateNumber?: number;
  focusMode: boolean;
  onToggleFocus: () => void;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  onToggleDecisions: () => void;
  decisionsOpen: boolean;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export function Topbar({ sessionState, connectionStatus, onFocusGate, hasPendingGate, gateNumber, focusMode, onToggleFocus, onToggleSidebar, sidebarOpen, onToggleDecisions, decisionsOpen, theme, onToggleTheme }: TopbarProps) {
  const [showCostBreakdown, setShowCostBreakdown] = useState(false);
  const status = sessionState?.pipeline_status ?? 'idle';
  const phase = sessionState?.current_phase ?? 0;
  const costUsd = sessionState?.total_cost_usd ?? 0;
  const showCost = (sessionState?.total_cost_usd ?? 0) > 0;
  const projectName = sessionState?.project_name ?? 'CLaDOS';

  // Elapsed timer for running agents (§2.6)
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (status === 'agent_running') {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
      return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }
    setElapsed(0);
    if (timerRef.current) clearInterval(timerRef.current);
  }, [status, sessionState?.phase_checkpoint?.in_progress_agent]);

  // Phase step counts (§2.5) — derive from completed_agents in the checkpoint
  const phaseAgentsDone = sessionState?.phase_checkpoint?.completed_agents?.length ?? 0;
  const phaseAgentsTotal = phaseAgentsDone + (sessionState?.phase_checkpoint?.in_progress_agent ? 1 : 0);

  const phaseBreakdown = (() => {
    if (!sessionState?.agent_tokens_used) return [];
    return Object.entries(sessionState.agent_tokens_used)
      .map(([p, agents]) => ({
        phase: Number(p),
        cost: Object.values(agents).reduce((sum, t) => sum + t.cost_usd, 0),
      }))
      .filter((e) => e.cost > 0)
      .sort((a, b) => a.phase - b.phase);
  })();

  // Status chip state
  const statusChip = (() => {
    if (status === 'agent_running') return { cls: 'chip-orange', text: 'Agents running…' };
    if (status === 'gate_pending') return { cls: 'chip-amber', text: 'Gate pending' };
    if (status === 'budget_gate_pending') return { cls: 'chip-red', text: 'Budget gate' };
    if (status === 'complete') return { cls: 'chip-green', text: 'Complete' };
    return null;
  })();

  return (
    <header className="topbar" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100 }}>
      {connectionStatus !== 'connected' && connectionStatus !== 'reconnected' && (
        <div
          className="reconnect-banner"
          style={connectionStatus === 'failed' ? { background: 'var(--red-lo)', borderColor: 'var(--red-border)', color: 'var(--red)' } : undefined}
        >
          <span className="dot" style={connectionStatus === 'failed' ? { background: 'var(--red)' } : undefined} />
          {connectionStatus === 'connecting' && 'Connecting…'}
          {connectionStatus === 'disconnected' && "I can't believe you disconnected. Retrying, because apparently I have to."}
          {connectionStatus === 'failed' && "Could not reconnect \u2014 restart CLaDOS to continue. Or don't. See if I care."}
        </div>
      )}

      {connectionStatus === 'reconnected' && (
        <div
          className="reconnect-banner"
          style={{ background: 'var(--green-lo)', borderColor: 'var(--green-border)', color: 'var(--green)' }}
        >
          <span className="dot" style={{ background: 'var(--green)' }} />
          Reconnected
        </div>
      )}

      <div style={styles.inner}>
        {/* Logo area */}
        <div className="topbar-logo-wrap">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0 }}>
            <circle cx="10" cy="10" r="9" stroke="var(--ap-orange)" strokeWidth="1.4" fill="none"/>
            <path d="M10 4 L6.5 16 M10 4 L13.5 16 M7.8 12 L12.2 12"
                  stroke="var(--ap-orange)" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
          <span className="logo-text">CLaDOS</span>
        </div>
        <div className="topbar-sep" />
        <span className="topbar-project">{projectName}</span>

        {/* GLaDOS bar */}
        <div className="topbar-bar-area">
          <PhaseBar sessionState={sessionState} status={status} phase={phase} gateNumber={gateNumber} elapsed={elapsed} />
        </div>

        {/* Right section */}
        <div className="topbar-right">
          {/* Status chip */}
          {statusChip && (
            <span className={`chip ${statusChip.cls}`}><span className="dot" />{statusChip.text}</span>
          )}

          {/* Phase step chip */}
          {status !== 'idle' && status !== 'complete' && phaseAgentsTotal > 0 && (
            <span className="phase-step-chip">
              <span className="step-current">{phaseAgentsDone}</span> of {phaseAgentsTotal}
            </span>
          )}

          {/* Focus mode toggle */}
          {sessionState && sessionState.pipeline_status !== 'idle' && (
            <button
              className={`btn btn-ghost btn-sm${focusMode ? ' active' : ''}`}
              onClick={onToggleFocus}
              title="Focus mode — collapse non-active phases"
            >
              Focus
            </button>
          )}

          {/* Cost badge */}
          {showCost && (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setShowCostBreakdown(true)}
              onMouseLeave={() => setShowCostBreakdown(false)}
            >
              <span className="budget-chip">${costUsd.toFixed(4)} used</span>
              {showCostBreakdown && phaseBreakdown.length > 0 && (
                <div style={styles.costTooltip}>
                  {phaseBreakdown.map(({ phase: p, cost }) => (
                    <div key={p} style={styles.costTooltipRow}>
                      <span>Phase {p} — {['Concept','Architecture','Build','Docs','Infra'][p] ?? `Phase ${p}`}</span>
                      <span>${cost.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Gate review button */}
          {hasPendingGate && (
            <button className="btn btn-gate-pending" onClick={onFocusGate}>
              ⚠ Gate {gateNumber} — review
            </button>
          )}

          {/* Files sidebar toggle */}
          <button
            className={`btn btn-ghost btn-sm${sidebarOpen ? ' active' : ''}`}
            onClick={onToggleSidebar}
            title="View generated files"
          >
            Files
          </button>

          {/* Decisions panel toggle */}
          <button
            className={`btn btn-ghost btn-sm${decisionsOpen ? ' active' : ''}`}
            onClick={onToggleDecisions}
            title="View pipeline decisions"
          >
            Decisions
          </button>

          {/* Theme toggle (§7.5) */}
          <button
            className="btn btn-ghost btn-sm"
            onClick={onToggleTheme}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </div>
    </header>
  );
}

const styles = {
  inner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 18px',
    height: 54,
    gap: 10,
  },
  costTooltip: {
    position: 'absolute' as const,
    right: 0,
    top: 'calc(100% + 4px)',
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    padding: '8px 12px',
    minWidth: 200,
    zIndex: 200,
    boxShadow: 'var(--shadow-md)',
  },
  costTooltipRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 16,
    padding: '2px 0',
    fontSize: 12,
    color: 'var(--text)',
    fontVariantNumeric: 'tabular-nums' as const,
  },
};

