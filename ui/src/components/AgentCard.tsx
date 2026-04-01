import { useState, useEffect, useRef } from 'react';
import type { AgentCardState } from '../types';

interface AgentCardProps {
  card: AgentCardState;
  onRetry?: () => void;
  onSkip?: () => void;
  onOpenGate?: () => void;
}

const BADGE_LABEL: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  retrying: 'Retrying',
  done: 'Done',
  flagged: 'Flagged',
  error: 'Error',
  skipped: 'Skipped',
};

// §3.2 — role → CSS class mapping
const ROLE_CLASS: Record<string, string> = {
  pm: 'rc-pm',
  architect: 'rc-arch',
  engineer: 'rc-eng',
  'engineer-backend': 'rc-eng',
  'engineer-frontend': 'rc-eng',
  qa: 'rc-qa',
  security: 'rc-sec',
  validator: 'rc-val',
  docs: 'rc-docs',
  devops: 'rc-devops',
  wrecker: 'rc-wrecker',
};

// §3.3 — core eye pulse class by role
const PULSE_CLASS: Record<string, string> = {
  pm: 'pulse-slow',
  architect: 'pulse-fast',
  engineer: 'pulse-fast',
  'engineer-backend': 'pulse-fast',
  'engineer-frontend': 'pulse-fast',
  qa: 'pulse-slow',
  security: 'pulse-fast',
  validator: 'pulse-slow',
  docs: 'pulse-slow',
  devops: 'pulse-fast',
  wrecker: 'pulse-flick',
};

// §3.4 — taglines
const TAGLINES: Record<string, string> = {
  pm: "I have a plan. You won't like it.",
  architect: "I'm designing the future. Try to keep up.",
  engineer: "Making things. Try not to break them.",
  'engineer-backend': "Making the backend. Try not to break it.",
  'engineer-frontend': "Making the frontend. Try not to break it.",
  qa: "I break things so you don't have to.",
  security: "Everything is a threat until proven otherwise.",
  validator: "Your code is guilty until proven innocent.",
  docs: "Someone has to write this down.",
  devops: "Works on my machine. Now it works on yours.",
  wrecker: "I break things because I enjoy it.",
};

// §3.8 — error type classification
const ERROR_BADGE: Record<string, { label: string; cls: string }> = {
  api_429: { label: 'Rate limit', cls: 'err-rate-limit' },
  api_5xx: { label: 'Server error', cls: 'err-server' },
  context_length: { label: 'Ctx overflow', cls: 'err-ctx-overflow' },
  timeout: { label: 'Timeout', cls: 'err-timeout' },
  parse_error: { label: 'Parse error', cls: 'err-parse' },
};

const AGENT_SHORT: Record<string, string> = {
  pm: 'PM',
  architect: 'ARCH',
  engineer: 'ENG',
  'engineer-backend': 'BE',
  'engineer-frontend': 'FE',
  qa: 'QA',
  security: 'SEC',
  validator: 'VAL',
  docs: 'DOCS',
  devops: 'CD',
  wrecker: 'WRK',
};

export function AgentCard({ card, onRetry, onSkip, onOpenGate }: AgentCardProps) {
  const isGateCard = card.role === 'validator';
  const roleDisplay = card.role.replace('-', ' ');
  const cssSafeStatus = card.status === 'retrying' ? 'running retrying' : card.status;
  const badgeClass = `badge badge-${card.status === 'retrying' ? 'running' : card.status}`;
  const rcClass = ROLE_CLASS[card.role] ?? 'rc-pm';

  // §16: after 60s in retrying state, flip to amber "long retry" indicator
  const [isLongRetry, setIsLongRetry] = useState(false);
  useEffect(() => {
    if (card.status !== 'retrying') {
      setIsLongRetry(false);
      return;
    }
    const timer = setTimeout(() => setIsLongRetry(true), 60_000);
    return () => clearTimeout(timer);
  }, [card.status, card.retryCount]);

  // §3.5 — elapsed timer for running cards
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (card.status === 'running' || card.status === 'retrying') {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
      return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }
    setElapsed(0);
    if (timerRef.current) clearInterval(timerRef.current);
  }, [card.status]);

  const isRunning = card.status === 'running' || card.status === 'retrying';
  const isDone = card.status === 'done';

  if (isGateCard) {
    const isFlagged = card.status === 'flagged';

    let gateVariant: string;
    if (isFlagged) gateVariant = 'active';
    else if (isRunning) gateVariant = 'running';
    else if (isDone) gateVariant = 'approved';
    else gateVariant = 'pending';

    let gateLabel: string;
    if (isFlagged) gateLabel = 'Review required';
    else if (isRunning) gateLabel = card.status === 'retrying' ? 'Reviewing… (retry)' : 'Reviewing…';
    else if (isDone) gateLabel = 'Gate approved';
    else gateLabel = 'Gate pending';

    return (
      <div
        className={`gate-card gate-${gateVariant}`}
        onClick={isFlagged ? onOpenGate : undefined}
        style={isFlagged ? { cursor: 'pointer' } : {}}
        title={isFlagged ? 'Click to open review gate' : undefined}
      >
        {gateLabel}
      </div>
    );
  }

  return (
    <div
      className={`agent-card is-${cssSafeStatus} ${rcClass}${isDone ? ' is-done' : ''}`}
      style={isLongRetry ? { borderColor: 'var(--amber)' } : undefined}
      title={isRunning ? TAGLINES[card.role] : undefined}
    >
      <div className="card-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Core eye indicator for running cards (§3.3) */}
          {isRunning && (
            <span className={`core-eye ${PULSE_CLASS[card.role] ?? 'pulse-slow'}`} />
          )}
          <span className="card-role-tag">{AGENT_SHORT[card.role] ?? card.role.toUpperCase()}</span>
          <span className="card-name">{roleDisplay}</span>
        </div>
        <span className={badgeClass}>{BADGE_LABEL[card.status]}</span>
      </div>

      {/* §3.6 — section checklist for running cards */}
      {isRunning && (card.sections?.length || card.currentSection) && (
        <div className="card-section-list">
          {card.sections?.map((s, i) => (
            <div key={i} className="card-section-item done-section">
              <span className="section-check checked">✓</span>
              <span>{s}</span>
            </div>
          ))}
          {card.currentSection && (
            <div className="card-section-item active-section">
              <span className="section-check writing">✍</span>
              <span>{card.currentSection}</span>
            </div>
          )}
        </div>
      )}

      {/* Elapsed time for running cards (§3.5) */}
      {isRunning && elapsed > 0 && (
        <span className="card-elapsed"><span className="elapsed-val">{elapsed}s</span></span>
      )}

      {isRunning && isLongRetry && (
        <div className="card-desc" style={{ color: 'var(--amber)' }}>
          Retrying — attempt {card.retryCount} of 3
        </div>
      )}

      {/* §3.7 — mini token bar for running cards */}
      {isRunning && card.outputTokens > 0 && (
        <>
          <div className="card-token-bar">
            <div className="card-token-fill growing" style={{ width: `${Math.min(100, (card.outputTokens / 4000) * 100)}%` }} />
          </div>
          <div className="card-token-label">
            <span>{card.outputTokens.toLocaleString()} tokens out</span>
          </div>
        </>
      )}

      {isDone && (
        <>
          <div className="card-stats">
            <span className="stat">{card.inputTokens.toLocaleString()} in</span>
            <span className="stat">{card.outputTokens.toLocaleString()} out</span>
            <span className="stat">${card.costUsd.toFixed(4)}</span>
          </div>
          <div className="card-indicators">
             {card.contextCompressed && <span className="indicator indicator-compressed">compressed</span>}
             {card.contextCompressed && card.fullArtifactsFetched > 0 && (
               <span className="indicator indicator-compressed" style={{ marginLeft: 4 }}>
                 fetched {card.fullArtifactsFetched} full artifact{card.fullArtifactsFetched === 1 ? '' : 's'}
               </span>
             )}
          </div>
          {card.artifactKey && (
            <a className="artifact-link" href={`/project/artifact?path=${encodeURIComponent(card.artifactKey)}`} target="_blank" rel="noreferrer">
              {card.artifactKey}
            </a>
          )}
        </>
      )}

      {card.status === 'error' && (
        <>
          {/* §3.8 — error type badge */}
          {card.errorType && ERROR_BADGE[card.errorType] && (
            <span className={`error-type-badge ${ERROR_BADGE[card.errorType].cls}`}>
              {ERROR_BADGE[card.errorType].label}
            </span>
          )}
          <div className="card-desc" style={{ color: 'var(--red)', marginTop: 4 }}>{card.errorMessage}</div>
          <div className="card-actions">
            {onRetry && (
              <button className="card-action-btn" onClick={onRetry}>
                {card.errorType === 'context_length' ? 'Retry with compression' : 'Retry'}
              </button>
            )}
            {onSkip && card.isSkippable && <button className="card-action-btn" onClick={onSkip}>Skip</button>}
          </div>
        </>
      )}
    </div>
  );
}
