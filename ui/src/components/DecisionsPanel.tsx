import { useMemo } from 'react';
import type { SessionState } from '../types';

interface DecisionsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  sessionState: SessionState | null;
}

interface DecisionEntry {
  type: 'autonomous' | 'conductor' | 'user';
  phase: number;
  agent: string;
  text: string;
  timestamp: string;
}

const TYPE_COLORS: Record<DecisionEntry['type'], string> = {
  autonomous: 'var(--ap-blue)',
  conductor: 'var(--amber)',
  user: 'var(--green)',
};

const TYPE_LABELS: Record<DecisionEntry['type'], string> = {
  autonomous: 'Auto',
  conductor: 'Conductor',
  user: 'User',
};

export function DecisionsPanel({ isOpen, onClose, sessionState }: DecisionsPanelProps) {
  const entries = useMemo<DecisionEntry[]>(() => {
    if (!sessionState) return [];
    const result: DecisionEntry[] = [];

    // Conductor decisions (autonomous agent choices)
    for (const d of sessionState.conductor_decisions ?? []) {
      result.push({
        type: 'autonomous',
        phase: d.phase,
        agent: d.agent,
        text: `${d.trigger}: ${d.decision}`,
        timestamp: d.timestamp,
      });
    }

    // Conductor reasoning (escape hatch reasoning)
    for (const r of sessionState.conductor_reasoning ?? []) {
      result.push({
        type: 'conductor',
        phase: r.phase,
        agent: 'conductor',
        text: `${r.question}\n→ ${r.response}`,
        timestamp: r.timestamp,
      });
    }

    // Agent question answers
    for (const q of sessionState.agent_questions ?? []) {
      if (q.user_answer) {
        result.push({
          type: 'user',
          phase: q.phase,
          agent: q.agent,
          text: `Q: ${q.question}\nA: ${q.user_answer}`,
          timestamp: q.answered_at ?? '',
        });
      }
    }

    // Sort by timestamp
    result.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return result;
  }, [sessionState]);

  if (!isOpen) return null;

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>Decisions</span>
        <button style={styles.closeBtn} onClick={onClose}>✕</button>
      </div>
      <div style={styles.body}>
        {entries.length === 0 && (
          <div style={styles.empty}>No decisions recorded yet.</div>
        )}
        {entries.map((entry, i) => (
          <div key={i} style={styles.entry}>
            <div style={styles.entryHeader}>
              <span style={{ ...styles.typeBadge, background: TYPE_COLORS[entry.type] }}>
                {TYPE_LABELS[entry.type]}
              </span>
              <span style={styles.phaseLabel}>Phase {entry.phase}</span>
              <span style={styles.agentLabel}>{entry.agent}</span>
            </div>
            <div style={styles.entryText}>{entry.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'fixed',
    top: 62,
    right: 0,
    bottom: 0,
    width: 400,
    background: 'var(--panel)',
    borderLeft: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 150,
    boxShadow: 'var(--shadow-lg)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px',
    borderBottom: '1px solid var(--border-dim)',
    flexShrink: 0,
  },
  title: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--text)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
    fontSize: 14,
    cursor: 'pointer',
    padding: '2px 6px',
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  empty: {
    fontSize: 12,
    color: 'var(--text-4)',
    textAlign: 'center',
    padding: 24,
  },
  entry: {
    padding: '8px 10px',
    background: 'var(--surface)',
    border: '1px solid var(--border-dim)',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  entryHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  typeBadge: {
    fontSize: 9,
    fontWeight: 700,
    color: 'var(--bg)',
    padding: '1px 5px',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  phaseLabel: {
    fontSize: 10,
    color: 'var(--text-3)',
    fontWeight: 500,
  },
  agentLabel: {
    fontSize: 10,
    color: 'var(--text-4)',
    fontFamily: 'var(--font-mono)',
  },
  entryText: {
    fontSize: 12,
    color: 'var(--text-2)',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
  },
};
