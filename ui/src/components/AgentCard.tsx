import type { AgentCardState } from '../types';

interface AgentCardProps {
  card: AgentCardState;
  onRetry?: () => void;
  onSkip?: () => void;
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

export function AgentCard({ card, onRetry, onSkip }: AgentCardProps) {
  const isGateCard = card.role === 'validator';
  const roleDisplay = card.role.replace('-', ' ');
  const cssSafeStatus = card.status === 'retrying' ? 'running retrying' : card.status;
  const badgeClass = `badge badge-${card.status === 'retrying' ? 'running' : card.status}`;
  
  const iconData = AGENT_ICONS[card.role] || { icon: 'icon-pm', short: 'AI' };

  if (isGateCard) {
    return (
      <div className={`gate-card gate-${card.status === 'flagged' ? 'active' : card.status === 'pending' ? 'pending' : 'approved'}`}>
        {card.status === 'flagged' ? 'Review required' : card.status === 'done' ? 'Gate approved' : 'Gate pending'}
      </div>
    );
  }

  return (
    <div className={`card is-${cssSafeStatus}`}>
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

      {card.status === 'done' && (
        <>
          <div className="card-desc">
            {card.inputTokens.toLocaleString()} in · {card.outputTokens.toLocaleString()} out · ${card.costUsd.toFixed(4)}
          </div>
          <div className="card-indicators">
             {card.contextCompressed && <span className="indicator indicator-compressed">compressed</span>}
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
