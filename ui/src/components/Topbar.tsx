import { useState } from 'react';
import type { PipelineStatus, SessionState } from '../types';
import { PHASE_LABELS } from '../constants';

interface TopbarProps {
  sessionState: SessionState | null;
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'failed';
  onFocusGate: () => void;
  hasPendingGate: boolean;
  gateNumber?: number;
  focusMode: boolean;
  onToggleFocus: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  idle: '#8b949e',
  agent_running: '#58a6ff',
  gate_pending: '#d29922',
  budget_gate_pending: '#f85149',
  complete: '#3fb950',
  abandoned: '#8b949e',
};

function getStatusText(status: PipelineStatus, gateNumber?: number): string {
  switch (status) {
    case 'idle': return 'Ready to start';
    case 'agent_running': return 'Agents running…';
    case 'gate_pending':
      return gateNumber != null ? `Waiting for your decision at Gate ${gateNumber}` : 'Waiting for your decision';
    case 'budget_gate_pending': return 'Budget limit reached';
    case 'complete': return 'Complete ✓';
    case 'abandoned': return 'Abandoned';
    default: return '';
  }
}

export function Topbar({ sessionState, connectionStatus, onFocusGate, hasPendingGate, gateNumber, focusMode, onToggleFocus }: TopbarProps) {
  const [showCostBreakdown, setShowCostBreakdown] = useState(false);
  const status = sessionState?.pipeline_status ?? 'idle';
  const phase = sessionState?.current_phase ?? 0;
  const costUsd = sessionState?.total_cost_usd ?? 0;
  const showCost = (sessionState?.total_cost_usd ?? 0) > 0;
  const projectName = sessionState?.project_name ?? 'CLaDOS';

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

  const statusColor = STATUS_COLORS[status] ?? '#8b949e';
  const statusText = getStatusText(status as PipelineStatus, gateNumber);

  return (
    <header style={styles.bar}>
      {connectionStatus !== 'connected' && (
        <div style={{ ...styles.reconnectBanner, ...(connectionStatus === 'failed' ? styles.reconnectBannerFailed : {}) }}>
          {connectionStatus === 'connecting' && 'Connecting…'}
          {connectionStatus === 'disconnected' && 'Connection lost — reconnecting…'}
          {connectionStatus === 'failed' && 'Could not reconnect — restart CLaDOS to continue'}
        </div>
      )}

      <div style={styles.inner}>
        <div style={styles.left}>
          <span style={styles.logo}>CLaDOS</span>
          <span style={styles.sep}>/</span>
          <span style={styles.projectName}>{projectName}</span>
        </div>

        <div style={styles.center}>
          {PHASE_LABELS.map((label, i) => (
            <div
              key={i}
              style={{
                ...styles.phaseChip,
                ...(i === phase ? styles.phaseChipActive : {}),
                ...(sessionState?.phases_completed.includes(i) ? styles.phaseChipDone : {}),
              }}
            >
              {label}
            </div>
          ))}
        </div>

        <div style={styles.right}>
          {/* Status indicator: dot + text */}
          <div style={styles.statusRow}>
            <div style={styles.statusDot(statusColor)} />
            <span style={{ ...styles.statusText, color: statusColor }}>{statusText}</span>
          </div>

          {/* Focus mode toggle */}
          {sessionState && sessionState.pipeline_status !== 'idle' && (
            <button
              style={{ ...styles.focusToggleBtn, ...(focusMode ? styles.focusToggleBtnActive : {}) }}
              onClick={onToggleFocus}
              title="Focus mode — collapse non-active phases"
            >
              Focus
            </button>
          )}

          {/* Cost total with per-phase breakdown on hover */}
          {showCost && (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setShowCostBreakdown(true)}
              onMouseLeave={() => setShowCostBreakdown(false)}
            >
              <span style={styles.costLabel}>${costUsd.toFixed(4)} used</span>
              {showCostBreakdown && phaseBreakdown.length > 0 && (
                <div style={styles.costTooltip}>
                  {phaseBreakdown.map(({ phase: p, cost }) => (
                    <div key={p} style={styles.costTooltipRow}>
                      <span>Phase {p} — {PHASE_LABELS[p]}</span>
                      <span>${cost.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Gate review button */}
          {hasPendingGate && (
            <button style={styles.gateBtn} onClick={onFocusGate}>
              Gate {gateNumber} ↑
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

const styles = {
  bar: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    background: '#161b22',
    borderBottom: '1px solid #30363d',
  },
  reconnectBanner: {
    background: '#b45309',
    color: '#fef3c7',
    textAlign: 'center' as const,
    padding: '4px 0',
    fontSize: 12,
    fontWeight: 500,
  },
  reconnectBannerFailed: {
    background: '#7d1313',
    color: '#fca5a5',
  },
  inner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 20px',
    height: 48,
    gap: 16,
  },
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: '0 0 auto',
  },
  logo: {
    fontWeight: 700,
    fontSize: 16,
    color: '#58a6ff',
    letterSpacing: '-0.5px',
  },
  sep: {
    color: '#30363d',
    fontSize: 16,
  },
  projectName: {
    color: '#8b949e',
    fontSize: 13,
    maxWidth: 200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  center: {
    display: 'flex',
    gap: 6,
    flex: '1 1 auto',
    justifyContent: 'center',
  },
  phaseChip: {
    padding: '3px 10px',
    borderRadius: 12,
    fontSize: 12,
    color: '#8b949e',
    background: '#21262d',
    border: '1px solid #30363d',
    cursor: 'default',
  } as React.CSSProperties,
  phaseChipActive: {
    color: '#58a6ff',
    background: '#1f3a5c',
    borderColor: '#58a6ff',
  } as React.CSSProperties,
  phaseChipDone: {
    color: '#3fb950',
    background: '#1a2e1a',
    borderColor: '#3fb950',
  } as React.CSSProperties,
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flex: '0 0 auto',
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: (color: string) => ({
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }) as React.CSSProperties,
  statusText: {
    fontSize: 12,
    fontWeight: 500,
    whiteSpace: 'nowrap' as const,
  },
  focusToggleBtn: {
    background: 'transparent',
    border: '1px solid #30363d',
    color: '#8b949e',
    borderRadius: 5,
    padding: '3px 10px',
    fontSize: 12,
    cursor: 'pointer',
  } as React.CSSProperties,
  focusToggleBtnActive: {
    color: '#58a6ff',
    borderColor: '#58a6ff',
    background: '#1f3a5c',
  } as React.CSSProperties,
  costLabel: {
    fontSize: 12,
    color: '#8b949e',
    fontVariantNumeric: 'tabular-nums',
    cursor: 'default',
  },
  gateBtn: {
    background: '#3b2800',
    color: '#d29922',
    border: '1px solid #d29922',
    borderRadius: 6,
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  } as React.CSSProperties,
  costTooltip: {
    position: 'absolute' as const,
    right: 0,
    top: 'calc(100% + 4px)',
    background: '#21262d',
    border: '1px solid #30363d',
    borderRadius: 6,
    padding: '8px 12px',
    minWidth: 200,
    zIndex: 200,
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  },
  costTooltipRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 16,
    padding: '2px 0',
    fontSize: 12,
    color: '#e6edf3',
    fontVariantNumeric: 'tabular-nums' as const,
  },
};

