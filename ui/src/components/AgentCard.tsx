import { useState, useEffect } from 'react';
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

const AGENT_ICONS: Record<string, { icon: string, short: string }> = {
  pm: { icon: 'icon-pm', short: 'PM' },
  architect: { icon: 'icon-arch', short: 'AR' },
  engineer: { icon: 'icon-eng', short: 'EN' },
  'engineer-backend': { icon: 'icon-eng', short: 'BE' },
  'engineer-frontend': { icon: 'icon-eng', short: 'FE' },
  qa: { icon: 'icon-qa', short: 'QA' },
  security: { icon: 'icon-sec', short: 'SC' },
  validator: { icon: 'icon-val', short: 'V' },
  docs: { icon: 'icon-doc', short: 'DX' },
  devops: { icon: 'icon-cd', short: 'CD' },
};

export function AgentCard({ card, onRetry, onSkip, onOpenGate }: AgentCardProps) {
  const isGateCard = card.role === 'validator';
  const roleDisplay = card.role.replace('-', ' ');
  const cssSafeStatus = card.status === 'retrying' ? 'running retrying' : card.status;
  const badgeClass = `badge badge-${card.status === 'retrying' ? 'running' : card.status}`;

  // #16: after 60s in retrying state, flip to amber "long retry" indicator
  const [isLongRetry, setIsLongRetry] = useState(false);
  useEffect(() => {
    if (card.status !== 'retrying') {
      setIsLongRetry(false);
      return;
    }
    const timer = setTimeout(() => setIsLongRetry(true), 60_000);
    return () => clearTimeout(timer);
  }, [card.status, card.retryCount]); // reset timer on each new retry attempt

  const iconData = AGENT_ICONS[card.role] || { icon: 'icon-pm', short: 'AI' };

  if (isGateCard) {
    const isFlagged = card.status === 'flagged';
    const isRunning = card.status === 'running' || card.status === 'retrying';
    const isDone = card.status === 'done';

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
    <div className={`card is-${cssSafeStatus}`} style={isLongRetry ? { borderColor: '#d29922' } : undefined}>
      <div className="card-row">
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span className={`agent-icon ${iconData.icon}`}>{iconData.short}</span>
          <div className="agent-group">
            <span className="agent-name">{roleDisplay}</span>
            {card.model && card.status !== 'pending' && typeof card.model === 'string' && (
              <span className="agent-nickname">{card.model.split('-').slice(0, 2).join(' ')}</span>
            )}
          </div>
        </div>
        <span className={badgeClass}>{BADGE_LABEL[card.status]}</span>
      </div>

      {(card.status === 'running' || card.status === 'retrying') && card.currentSection && (
        <div className="card-desc">⟳ {card.currentSection}</div>
      )}

      {(card.status === 'running' || card.status === 'retrying') && isLongRetry && (
        <div className="card-desc" style={{ color: '#d29922' }}>
          Retrying — attempt {card.retryCount} of 3
        </div>
      )}

      {card.status === 'done' && (
        <>
          <div className="card-desc">
            {card.inputTokens.toLocaleString()} in · {card.outputTokens.toLocaleString()} out · ${card.costUsd.toFixed(4)}
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
          <div className="card-desc" style={{ color: 'var(--red)', marginTop: 4 }}>{card.errorMessage}</div>
          <div className="card-actions">
            {onRetry && <button className="card-action-btn" onClick={onRetry}>Retry</button>}
            {onSkip && card.isSkippable && <button className="card-action-btn" onClick={onSkip}>Skip</button>}
          </div>
        </>
      )}
    </div>
  );
}
