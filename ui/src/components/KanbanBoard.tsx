import { useEffect, useRef, useState } from 'react';
import { AgentCard } from './AgentCard';
import type { AgentCardState, SessionState, WsEvent } from '../types';
import { PHASE_LABELS } from '../constants';

interface KanbanBoardProps {
  sessionState: SessionState | null;
  events: WsEvent[];
  onRetry: (phase: number, agent: string, errorKey?: string) => void;
  onSkip: (phase: number, agent: string, errorKey?: string) => void;
}

// The ordered agents per phase
const PHASE_AGENTS: Record<number, string[]> = {
  0: ['pm', 'validator'],
  1: ['pm', 'architect', 'engineer', 'validator'],
  2: ['engineer', 'qa', 'validator', 'security', 'wrecker'],
  3: ['docs', 'pm', 'validator'],
  4: ['devops', 'validator'],
};

function buildInitialCards(phase: number): AgentCardState[] {
  return (PHASE_AGENTS[phase] ?? []).map((role) => ({
    role,
    phase,
    status: 'pending',
    currentSection: null,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    artifactKey: null,
    errorMessage: null,
    contextCompressed: false,
    isSkippable: false,
    errorKey: undefined,
  }));
}

export function KanbanBoard({ sessionState, events, onRetry, onSkip }: KanbanBoardProps) {
  // Phase column collapse state (persisted in localStorage)
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>(() => {
    try {
      const saved = localStorage.getItem('clados:collapsed');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });

  // Per-phase, per-agent card state derived from WS events
  const [cards, setCards] = useState<Record<string, AgentCardState>>(() => {
    const initial: Record<string, AgentCardState> = {};
    for (let p = 0; p <= 4; p++) {
      for (const card of buildInitialCards(p)) {
        initial[`${p}:${card.role}`] = card;
      }
    }
    return initial;
  });

  const processedEvents = useRef(new Set<number>());

  useEffect(() => {
    const latestEvent = events[events.length - 1];
    if (!latestEvent) return;

    // On reconnect, App.tsx resets events to [snapshot] (H-8).
    // Clear the index-based dedup set so subsequent real events are processed.
    if (latestEvent.type === 'state:snapshot') {
      processedEvents.current.clear();
      return;
    }

    const idx = events.length - 1;
    if (processedEvents.current.has(idx)) return;
    processedEvents.current.add(idx);

    setCards((prev) => {
      const next = { ...prev };

      switch (latestEvent.type) {
        case 'agent:start': {
          const key = `${latestEvent.phase}:${latestEvent.agent}`;
          next[key] = {
            ...(next[key] ?? buildInitialCards(latestEvent.phase).find((c) => c.role === latestEvent.agent)!),
            status: 'running',
            model: latestEvent.model,
            currentSection: null,
          };
          break;
        }
        case 'agent:stream': {
          const key = `${latestEvent.phase}:${latestEvent.agent}`;
          if (next[key]) {
            next[key] = { ...next[key], currentSection: latestEvent.section };
          }
          break;
        }
        case 'agent:done': {
          const key = `${latestEvent.phase}:${latestEvent.agent}`;
          if (next[key]) {
            next[key] = {
              ...next[key],
              status: 'done',
              inputTokens: latestEvent.tokens_used.input,
              outputTokens: latestEvent.tokens_used.output,
              costUsd: latestEvent.cost_usd,
              artifactKey: latestEvent.artifact,
              contextCompressed: latestEvent.context_compressed,
            };
          }
          break;
        }
        case 'agent:error': {
          const key = `${latestEvent.phase}:${latestEvent.agent}`;
          if (next[key]) {
            next[key] = {
              ...next[key],
              status: 'error',
              errorMessage: latestEvent.message,
              isSkippable: latestEvent.is_skippable,
              errorKey: latestEvent.error_key,
            };
          }
          break;
        }
        case 'agent:skipped': {
          const key = `${latestEvent.phase}:${latestEvent.agent}`;
          if (next[key]) {
            next[key] = { ...next[key], status: 'skipped' };
          }
          break;
        }
        case 'gate:open': {
          // Flag the Validator card for this phase — it's always the gate-owner
          const key = `${latestEvent.phase}:validator`;
          if (next[key]?.status === 'done') {
            next[key] = { ...next[key], status: 'flagged' };
          }
          break;
        }
      }

      return next;
    });
  }, [events]);

  const toggleCollapse = (phase: number) => {
    setCollapsed((prev) => {
      const next = { ...prev, [phase]: !prev[phase] };
      try { localStorage.setItem('clados:collapsed', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const currentPhase = sessionState?.current_phase ?? 0;

  return (
    <div style={styles.board}>
      {[0, 1, 2, 3, 4].map((phase) => {
        const isActive = phase === currentPhase;
        const isDone = sessionState?.phases_completed.includes(phase);
        const isCollapsed = collapsed[phase] ?? false;
        const phaseCards = PHASE_AGENTS[phase].map((role) => cards[`${phase}:${role}`] ?? buildInitialCards(phase).find((c) => c.role === role)!);

        return (
          <div
            key={phase}
            style={{
              ...styles.column,
              ...(isActive ? styles.columnActive : {}),
              ...(isCollapsed ? styles.columnCollapsed : {}),
            }}
          >
            <button style={styles.columnHeader} onClick={() => toggleCollapse(phase)}>
              <span style={{ color: isDone ? '#3fb950' : isActive ? '#58a6ff' : '#8b949e' }}>
                {`Phase ${phase} — ${PHASE_LABELS[phase]}`}
              </span>
              <span style={styles.collapseIcon}>{isCollapsed ? '▶' : '▼'}</span>
            </button>

            {!isCollapsed && (
              <div style={styles.cardList}>
                {phaseCards.map((card) => (
                  <AgentCard
                    key={`${card.phase}:${card.role}`}
                    card={card}
                    onRetry={card.status === 'error' ? () => onRetry(card.phase, card.role, card.errorKey) : undefined}
                    onSkip={card.status === 'error' && card.isSkippable ? () => onSkip(card.phase, card.role, card.errorKey) : undefined}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const styles = {
  board: {
    display: 'flex',
    gap: 12,
    padding: '16px 24px',
    overflowX: 'auto' as const,
    alignItems: 'flex-start',
    minHeight: 'calc(100vh - 48px)',
    marginTop: 48,
  },
  column: {
    flex: '0 0 200px',
    background: '#161b22',
    borderRadius: 8,
    border: '1px solid #30363d',
    overflow: 'hidden',
    transition: 'flex-basis 0.2s',
  },
  columnActive: {
    flex: '0 0 220px',
    borderColor: '#58a6ff',
  },
  columnCollapsed: {
    flex: '0 0 48px',
  },
  columnHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    padding: '10px 12px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: '#e6edf3',
    fontWeight: 600,
    fontSize: 12,
    textAlign: 'left' as const,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
  },
  collapseIcon: {
    fontSize: 10,
    color: '#8b949e',
  },
  cardList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    padding: '0 10px 12px',
  },
};


