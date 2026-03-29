import { useEffect, useRef } from 'react';
import type { AgentCardState } from '../types';

interface AgentCardProps {
  card: AgentCardState;
  onRetry?: () => void;
  onSkip?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#30363d',
  running: '#1f3a5c',
  done: '#1a2e1a',
  flagged: '#3b2800',
  error: '#3b1219',
  skipped: '#21262d',
};

const STATUS_BORDER: Record<string, string> = {
  pending: '#30363d',
  running: '#58a6ff',
  done: '#3fb950',
  flagged: '#d29922',
  error: '#f85149',
  skipped: '#30363d',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  flagged: 'Flagged',
  error: 'Error',
  skipped: 'Skipped',
};

// Cycling colors for the running animation
const CYCLE_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff'];

export function AgentCard({ card, onRetry, onSkip }: AgentCardProps) {
  const animRef = useRef<number | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const colorIdxRef = useRef(0);

  useEffect(() => {
    if (card.status !== 'running') {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      return;
    }

    let startTime: number | null = null;
    const CYCLE_DURATION = 3000;

    const animate = (ts: number) => {
      if (!startTime) startTime = ts;
      const elapsed = (ts - startTime) % CYCLE_DURATION;
      const progress = elapsed / CYCLE_DURATION;

      if (barRef.current) {
        const colorIdx = Math.floor(progress * CYCLE_COLORS.length) % CYCLE_COLORS.length;
        if (colorIdx !== colorIdxRef.current) {
          colorIdxRef.current = colorIdx;
          barRef.current.style.background = CYCLE_COLORS[colorIdx];
        }
        barRef.current.style.width = `${(progress * 100).toFixed(1)}%`;
      }

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [card.status]);

  return (
    <div style={{
      ...styles.card,
      background: STATUS_COLORS[card.status],
      borderColor: STATUS_BORDER[card.status],
    }}>
      {/* Running animation bar */}
      {card.status === 'running' && (
        <div style={styles.animBarTrack}>
          <div ref={barRef} style={styles.animBar} />
        </div>
      )}

      <div style={styles.header}>
        <span style={styles.role}>{card.role}</span>
        <span style={{ ...styles.statusBadge, color: STATUS_BORDER[card.status] }}>
          {STATUS_LABEL[card.status]}
        </span>
      </div>

      {card.status === 'running' && card.currentSection && (
        <div style={styles.section}>⟳ {card.currentSection}</div>
      )}

      {card.status === 'done' && (
        <div style={styles.meta}>
          <span>{card.inputTokens.toLocaleString()} in</span>
          <span>·</span>
          <span>{card.outputTokens.toLocaleString()} out</span>
          <span>·</span>
          <span>${card.costUsd.toFixed(4)}</span>
          {card.contextCompressed && <span style={styles.compressed}>⬇ compressed</span>}
        </div>
      )}

      {card.status === 'error' && (
        <div style={styles.errorMsg}>{card.errorMessage}</div>
      )}

      {(card.status === 'error' || card.status === 'flagged') && (
        <div style={styles.actions}>
          {onRetry && <button style={styles.retryBtn} onClick={onRetry}>Retry</button>}
          {onSkip && card.status === 'error' && (
            <button style={styles.skipBtn} onClick={onSkip}>Skip</button>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  card: {
    borderRadius: 8,
    border: '1px solid',
    padding: '10px 12px',
    position: 'relative' as const,
    overflow: 'hidden',
    minWidth: 160,
  },
  animBarTrack: {
    position: 'absolute' as const,
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    background: '#21262d',
  },
  animBar: {
    height: '100%',
    width: '0%',
    background: '#58a6ff',
    transition: 'background 0.3s',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  role: {
    fontWeight: 600,
    fontSize: 13,
    color: '#e6edf3',
  },
  statusBadge: {
    fontSize: 11,
    fontWeight: 500,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  section: {
    fontSize: 12,
    color: '#8b949e',
    marginBottom: 4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  meta: {
    display: 'flex',
    gap: 5,
    fontSize: 11,
    color: '#8b949e',
    flexWrap: 'wrap' as const,
  },
  compressed: {
    color: '#d29922',
    fontSize: 11,
  },
  errorMsg: {
    fontSize: 12,
    color: '#f85149',
    marginTop: 4,
    wordBreak: 'break-word' as const,
  },
  actions: {
    display: 'flex',
    gap: 6,
    marginTop: 8,
  },
  retryBtn: {
    background: 'transparent',
    border: '1px solid #f85149',
    color: '#f85149',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
    cursor: 'pointer',
  },
  skipBtn: {
    background: 'transparent',
    border: '1px solid #8b949e',
    color: '#8b949e',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
    cursor: 'pointer',
  },
};

export default AgentCard;
