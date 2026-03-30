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
  const cardRef = useRef<HTMLDivElement | null>(null);
  const colorIdxRef = useRef(0);

  useEffect(() => {
    if (card.status !== 'running') {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      if (cardRef.current) cardRef.current.style.borderColor = STATUS_BORDER[card.status];
      return;
    }

    let startTime: number | null = null;
    const CYCLE_DURATION = 3000;

    const animate = (ts: number) => {
      if (!startTime) startTime = ts;
      const elapsed = (ts - startTime) % CYCLE_DURATION;
      const progress = elapsed / CYCLE_DURATION;

      const colorIdx = Math.floor(progress * CYCLE_COLORS.length) % CYCLE_COLORS.length;
      if (cardRef.current && colorIdx !== colorIdxRef.current) {
        colorIdxRef.current = colorIdx;
        cardRef.current.style.borderColor = CYCLE_COLORS[colorIdx];
      }

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [card.status]);

  return (
    <div
      ref={cardRef}
      style={{
        ...styles.card,
        background: STATUS_COLORS[card.status],
        borderColor: STATUS_BORDER[card.status],
      }}
    >
      <div style={styles.header}>
        <span style={styles.role}>{card.role}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {card.model && (card.status === 'running' || card.status === 'done') && (
            <span style={styles.modelLabel}>{card.model}</span>
          )}
          <span style={{ ...styles.statusBadge, color: STATUS_BORDER[card.status] }}>
            {STATUS_LABEL[card.status]}
          </span>
        </div>
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

      {(onRetry || (onSkip && card.status === 'error')) && (
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
    transition: 'border-color 0.4s',
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
  modelLabel: {
    fontSize: 10,
    color: '#6e7681',
    fontFamily: 'monospace',
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


