import { useEffect, useRef, useState } from 'react';
import { AgentCard } from './AgentCard';
import type { AgentCardState, SessionConfig, SessionState, WsEvent } from '../types';
import { PHASE_LABELS } from '../constants';

interface KanbanBoardProps {
  sessionState: SessionState | null;
  events: WsEvent[];
  onRetry: (phase: number, agent: string, errorKey?: string) => void;
  onSkip: (phase: number, agent: string, errorKey?: string) => void;
  focusMode: boolean;
  onOpenGate?: () => void;
  /** Set by App when gate is approved/revised — lets us clear the flagged card before WS events arrive */
  resolvedGate?: { phase: number; approved: boolean } | null;
}

const PHASE_AGENTS: Record<number, string[]> = {
  0: ['pm', 'validator'],
  1: ['pm', 'architect', 'engineer', 'validator'],
  3: ['docs', 'pm', 'validator'],
  4: ['devops', 'validator'],
};

type AgentConfig = Pick<SessionConfig, 'project_type' | 'security_enabled' | 'wrecker_enabled'>;

function getPhaseAgents(phase: number, config?: AgentConfig | null): string[] {
  if (phase === 2) {
    const base = config?.project_type === 'full-stack'
      ? ['engineer-backend', 'engineer-frontend', 'qa', 'validator']
      : ['engineer', 'qa', 'validator'];
    if (config?.security_enabled) base.push('security');
    if (config?.wrecker_enabled) base.push('wrecker');
    return base;
  }
  return PHASE_AGENTS[phase] ?? [];
}

const blankCard = (role: string, phase: number): AgentCardState => ({
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
  contextBudgetExhausted: false,
  fullArtifactsFetched: 0,
  isSkippable: false,
  errorKey: undefined,
  retryCount: 0,
});

function buildCardsFromSnapshot(state: SessionState): Record<string, AgentCardState> {
  const result: Record<string, AgentCardState> = {};
  for (let p = 0; p <= 4; p++) {
    for (const role of getPhaseAgents(p, state.config)) {
      const key = `${p}:${role}`;
      let status: AgentCardState['status'] = 'pending';
      const phaseTokens = state.agent_tokens_used?.[String(p)]?.[role];
      const inputTokens = phaseTokens?.input ?? 0;
      const outputTokens = phaseTokens?.output ?? 0;
      const costUsd = phaseTokens?.cost_usd ?? 0;

      if (state.phases_completed.includes(p)) {
        status = 'done';
      } else if (p < state.current_phase) {
        status = costUsd > 0 ? 'done' : 'pending';
      } else if (p === state.current_phase && state.phase_checkpoint) {
        const cp = state.phase_checkpoint;
        if (cp.completed_agents.includes(role)) {
          status = (state.pipeline_status === 'gate_pending' && role === 'validator')
            ? 'flagged'
            : 'done';
        } else if (cp.in_progress_agent === role) {
          status = 'running';
        }
      }

      result[key] = {
        ...blankCard(role, p),
        status,
        inputTokens,
        outputTokens,
        costUsd,
      };
    }
  }
  return result;
}

export function KanbanBoard({ sessionState, events, onRetry, onSkip, focusMode, onOpenGate, resolvedGate }: KanbanBoardProps) {
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>(() => {
    try {
      const saved = localStorage.getItem('clados:collapsed');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });

  // Auto-collapse phases when they are newly marked as completed.
  // Only auto-collapses on viewports narrower than 1400px — on wider screens users can
  // see all columns simultaneously so collapsing is not needed for focus.
  // User can still expand manually (their explicit false stays respected).
  const prevCompletedRef = useRef(new Set<number>());
  useEffect(() => {
    const nowCompleted = new Set(sessionState?.phases_completed ?? []);
    const newlyDone: number[] = [];
    for (const p of nowCompleted) {
      if (!prevCompletedRef.current.has(p)) newlyDone.push(p);
    }
    prevCompletedRef.current = nowCompleted;
    if (newlyDone.length > 0 && window.innerWidth < 1400) {
      setCollapsed((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const p of newlyDone) {
          if (prev[p] !== false) { // don't override explicit user expand
            next[p] = true;
            changed = true;
          }
        }
        if (!changed) return prev;
        try { localStorage.setItem('clados:collapsed', JSON.stringify(next)); } catch {}
        return next;
      });
    }
  }, [sessionState?.phases_completed]);

  const [cards, setCards] = useState<Record<string, AgentCardState>>(() => {
    const initial: Record<string, AgentCardState> = {};
    const basePhase2 = ['engineer', 'qa', 'validator'];
    for (let p = 0; p <= 4; p++) {
      const roles = p === 2 ? basePhase2 : (PHASE_AGENTS[p] ?? []);
      for (const role of roles) {
        initial[`${p}:${role}`] = blankCard(role, p);
      }
    }
    return initial;
  });

  const processedEvents = useRef(new Set<number>());

  // Optimistically clear the "Review required" gate card when the user approves or revises
  // at the gate — before the first agent:start WS event arrives from the server.
  useEffect(() => {
    if (!resolvedGate) return;
    setCards((prev) => {
      const next = { ...prev };
      for (const [key, card] of Object.entries(next)) {
        if (card.status === 'flagged' && card.role === 'validator' && card.phase === resolvedGate.phase) {
          next[key] = { ...card, status: resolvedGate.approved ? 'done' : 'pending' };
        }
      }
      return next;
    });
  }, [resolvedGate]);

  useEffect(() => {
    const latestEvent = events[events.length - 1];
    if (!latestEvent) return;

    if (latestEvent.type === 'state:snapshot') {
      processedEvents.current.clear();
      setCards(buildCardsFromSnapshot(latestEvent.state));
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
          const prev_card = next[key];
          next[key] = {
            ...(prev_card ?? blankCard(latestEvent.agent, latestEvent.phase)),
            status: prev_card?.status === 'error' ? 'retrying' : 'running',
            model: latestEvent.model,
            currentSection: null,
          };
          // Clear any 'flagged' validator cards that this agent start implies are resolved:
          // - Same phase, non-validator starting → revision cycle began, gate is no longer open
          // - Earlier phase, any agent starting → that phase was approved, validator is done
          if (latestEvent.agent !== 'validator') {
            for (const [cardKey, cardState] of Object.entries(next)) {
              if (cardState.status === 'flagged' && cardState.role === 'validator') {
                if (cardState.phase < latestEvent.phase) {
                  next[cardKey] = { ...cardState, status: 'done' };
                } else if (cardState.phase === latestEvent.phase) {
                  next[cardKey] = { ...cardState, status: 'pending' };
                }
              }
            }
          }
          break;
        }
        case 'agent:stream': {
          const key = `${latestEvent.phase}:${latestEvent.agent}`;
          if (next[key]) {
            const prevSection = next[key].currentSection;
            const prevSections = next[key].sections ?? [];
            // Push the previous current section to the completed list
            const sections = prevSection && prevSection !== latestEvent.section
              ? [...prevSections, prevSection]
              : prevSections;
            next[key] = {
              ...next[key],
              currentSection: latestEvent.section,
              sections,
              // §8.2: Update approximate output tokens from stream
              ...(latestEvent.tokens_out != null ? { outputTokens: latestEvent.tokens_out } : {}),
            };
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
              contextBudgetExhausted: latestEvent.context_budget_exhausted ?? false,
              fullArtifactsFetched: latestEvent.full_artifacts_fetched ?? 0,
              retryCount: 0,
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
              errorType: latestEvent.error_type,
              isSkippable: latestEvent.is_skippable,
              errorKey: latestEvent.error_key,
              retryCount: latestEvent.retry_count,
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
  const pipelineStatus = sessionState?.pipeline_status ?? 'idle';

  // §7.3 — empty kanban state
  if (pipelineStatus === 'idle' && sessionState !== null) {
    return (
      <div className="board" id="board" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
        <div style={{
          border: '1px dashed var(--border)',
          padding: '40px 32px',
          textAlign: 'center',
          maxWidth: 480,
          fontFamily: 'var(--font-mono)',
        }}>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '0 0 8px' }}>
            The Enrichment Center reminds you that all test subjects must press <strong style={{ color: 'var(--ap-orange)' }}>'Create'</strong> to begin.
          </p>
          <p style={{ color: 'var(--text-4)', fontSize: 11, margin: 0, fontStyle: 'italic' }}>
            No pipeline running. Configure a project on the Home screen.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="board" id="board">
      {[0, 1, 2, 3, 4].map((phase) => {
        const isActive = phase === currentPhase;
        const isDone = sessionState?.phases_completed.includes(phase);
        const colStateClass = isDone ? 'done' : isActive ? 'active' : 'pending';
        const colStateLabel = isDone ? 'Done' : isActive ? 'Active' : 'Pending';
        
        const isCollapsed = collapsed[phase] ?? (focusMode && !isActive);
        const phaseCards = getPhaseAgents(phase, sessionState?.config).map(
          (role) => cards[`${phase}:${role}`] ?? blankCard(role, phase),
        );

        return (
          <div
            key={phase}
            id={`col-${phase}`}
            className={`col ${isCollapsed ? 'collapsed' : ''} ${colStateClass}`}
          >
            <div className={`col-header ${colStateClass}`} onClick={() => toggleCollapse(phase)} style={{ cursor: 'pointer' }}>
              <span className="col-phase-name">{`Phase ${phase} — ${PHASE_LABELS[phase]}`}</span>
              <span className={`chip chip-${isDone ? 'green' : isActive ? 'orange' : 'muted'}`}>
                <span className="dot" />{colStateLabel}
              </span>
            </div>

            <div className="col-cards">
              <div className="agent-group">
                {phaseCards.map((card) => (
                  <AgentCard
                    key={`${card.phase}:${card.role}`}
                    card={card}
                    onRetry={card.status === 'error' ? () => onRetry(card.phase, card.role, card.errorKey) : undefined}
                    onSkip={card.status === 'error' && card.isSkippable ? () => onSkip(card.phase, card.role, card.errorKey) : undefined}
                    onOpenGate={onOpenGate}
                  />
                ))}
              </div>
            </div>

            {isCollapsed && (
              <button className="col-toggle" onClick={() => toggleCollapse(phase)}>
                Expand
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}


