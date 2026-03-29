import type { SessionState } from '../types';

interface TopbarProps {
  sessionState: SessionState | null;
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'failed';
  onFocusGate: () => void;
  hasPendingGate: boolean;
}

const PHASE_LABELS = ['Concept', 'Planning', 'Build', 'Docs', 'Infra'];

const STATUS_COLORS: Record<string, string> = {
  idle: '#8b949e',
  agent_running: '#58a6ff',
  gate_pending: '#d29922',
  budget_gate_pending: '#f85149',
  complete: '#3fb950',
  abandoned: '#8b949e',
};

export function Topbar({ sessionState, connectionStatus, onFocusGate, hasPendingGate }: TopbarProps) {
  const status = sessionState?.pipeline_status ?? 'idle';
  const phase = sessionState?.current_phase ?? 0;
  const costUsd = sessionState?.total_cost_usd ?? 0;
  const projectName = sessionState?.project_name ?? 'CLaDOS';

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
          <div style={styles.statusDot(STATUS_COLORS[status])} title={status} />
          <span style={styles.costLabel}>${costUsd.toFixed(4)}</span>
          {hasPendingGate && (
            <button style={styles.focusBtn} onClick={onFocusGate}>
              Review ↑
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
  },
  reconnectBannerFailed: {
    background: '#7d1313',
    color: '#fca5a5',
  },
  inner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 24px',
    height: 48,
    gap: 16,
  },
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flex: '0 0 auto',
  },
  logo: {
    fontWeight: 700,
    fontSize: 16,
    color: '#58a6ff',
    letterSpacing: '-0.5px',
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
  statusDot: (color: string) => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: color,
  }) as React.CSSProperties,
  costLabel: {
    fontSize: 12,
    color: '#8b949e',
    fontVariantNumeric: 'tabular-nums',
    marginLeft: 4,
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flex: '0 0 auto',
  },
  focusBtn: {
    background: '#d29922',
    color: '#000',
    border: 'none',
    borderRadius: 6,
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
};

export default Topbar;
