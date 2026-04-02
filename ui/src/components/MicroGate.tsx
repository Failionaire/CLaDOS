import { useState } from 'react';
import type { WsMicroGateOpen } from '../types';

interface MicroGateProps {
  gate: WsMicroGateOpen;
  onClose: () => void;
}

export function MicroGate({ gate, onClose }: MicroGateProps) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (action: 'approve' | 'reject') => {
    setSubmitting(true);
    try {
      await fetch('/gate/micro/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(action === 'reject' && reason ? { rejection_reason: reason } : {}),
        }),
      });
      onClose();
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <div style={styles.overlay}>
      <div className="confirm-panel" style={styles.modal}>
        <div className="hazard-bar amber" />
        <div style={styles.header}>
          <span style={styles.title}>Architecture Change Requested</span>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            by {gate.requesting_agent} · Phase {gate.phase}
          </span>
        </div>

        <div style={styles.body}>
          {/* Left — change request */}
          <div style={styles.half}>
            <div style={styles.sectionLabel}>Change Request</div>
            <div style={styles.textBlock}>{gate.change_request}</div>
          </div>

          {/* Right — architect response + diff */}
          <div style={styles.half}>
            <div style={styles.sectionLabel}>Architect Response</div>
            <div style={styles.textBlock}>{gate.architect_response}</div>

            {gate.proposed_diff && (
              <>
                <div style={{ ...styles.sectionLabel, marginTop: 10 }}>Proposed Diff</div>
                <pre style={styles.diff}>{gate.proposed_diff}</pre>
              </>
            )}

            {gate.affected_files.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)' }}>
                Affected: {gate.affected_files.join(', ')}
              </div>
            )}
          </div>
        </div>

        {/* Reject reason */}
        {rejecting && (
          <div style={{ padding: '0 20px 12px' }}>
            <label style={{ fontSize: 11, color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>
              Rejection reason (optional)
            </label>
            <input
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Why is this change not appropriate?"
              style={styles.input}
              autoFocus
            />
          </div>
        )}

        <div style={styles.actions}>
          {!rejecting ? (
            <>
              <button
                className="btn btn-primary"
                disabled={submitting}
                onClick={() => submit('approve')}
              >
                Approve
              </button>
              <button
                className="btn btn-danger"
                disabled={submitting}
                onClick={() => setRejecting(true)}
              >
                Reject
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-danger"
                disabled={submitting}
                onClick={() => submit('reject')}
              >
                Confirm Reject
              </button>
              <button
                className="btn btn-ghost"
                disabled={submitting}
                onClick={() => setRejecting(false)}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'var(--overlay)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 400,
  },
  modal: {
    background: 'var(--panel)',
    border: '1px solid var(--amber-border)',
    width: 700,
    maxHeight: '80vh',
    overflow: 'auto',
    color: 'var(--text)',
  },
  header: {
    padding: '16px 20px 8px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  title: {
    fontWeight: 700,
    fontSize: 15,
    color: 'var(--amber)',
  },
  body: {
    display: 'flex',
    gap: 16,
    padding: '8px 20px 16px',
  },
  half: {
    flex: 1,
    minWidth: 0,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-3)',
    textTransform: 'uppercase' as const,
    marginBottom: 4,
    letterSpacing: '0.05em',
  },
  textBlock: {
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--text-2)',
    whiteSpace: 'pre-wrap' as const,
  },
  diff: {
    fontSize: 11,
    fontFamily: 'var(--font-mono, monospace)',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    padding: 10,
    overflow: 'auto',
    maxHeight: 200,
    whiteSpace: 'pre' as const,
    color: 'var(--text-2)',
  },
  input: {
    width: '100%',
    padding: '6px 10px',
    fontSize: 13,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    borderRadius: 3,
    boxSizing: 'border-box' as const,
  },
  actions: {
    padding: '0 20px 16px',
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
  },
};
