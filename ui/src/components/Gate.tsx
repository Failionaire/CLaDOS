import { useState, useEffect, useCallback } from 'react';
import { ArtifactViewer } from './ArtifactViewer';
import { ValidatorFindings } from './ValidatorFindings';
import type { Finding, WsGateOpen } from '../types';

interface GateProps {
  gate: WsGateOpen | null;
  onMinimize: () => void;
  onClose: () => void;
  /** Called synchronously before onClose so the board can optimistically clear the gate card. */
  onResolved?: (phase: number, approved: boolean) => void;
}

type GateAction = 'approve' | 'revise' | 'goto' | 'abort';

const REVISION_WARN_THRESHOLD = 2;
const REVISION_ERROR_THRESHOLD = 3;

export function Gate({ gate, onMinimize, onClose, onResolved }: GateProps) {
  const [artifactContent, setArtifactContent] = useState<string>('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [revisionNote, setRevisionNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [gotoTarget, setGotoTarget] = useState<number>(1);

  // Reset state when gate changes
  useEffect(() => {
    if (!gate) return;
    setOverrides({});
    setRevisionNote('');
    setError(null);
    setMoreOpen(false);
    setFindings(gate.findings ?? []);
    const primaryArtifact = gate.artifacts[0];
    if (!primaryArtifact) {
      setLoading(false);
      return;
    }

    setLoading(true);
    fetch(`/project/artifact?path=${encodeURIComponent(primaryArtifact)}`)
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.text();
      })
      .then((text) => setArtifactContent(text))
      .catch((e: Error) => {
        setArtifactContent('');
        setError(e.message);
      })
      .finally(() => setLoading(false));
  }, [gate]);

  const handleOverrideChange = (id: string, checked: boolean) => {
    setOverrides((prev) => ({ ...prev, [id]: checked }));
  };

  const sendGateResponse = useCallback(async (action: GateAction, extra?: Record<string, unknown>) => {
    if (!gate) return;
    setError(null);
    try {
      const resp = await fetch('/gate/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          revision_text: action === 'revise' ? revisionNote : undefined,
          override_findings: Object.keys(overrides).filter((k) => overrides[k]),
          ...extra,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // Optimistically clear the gate card in the board before waiting for WS events
      if ((action === 'approve' || action === 'revise') && gate) {
        onResolved?.(gate.phase, action === 'approve');
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [gate, revisionNote, overrides, onClose, onResolved]);

  if (!gate) return null;

  // ── Overflow gate — context-length blocker ──────────────────────────────
  if (gate.overflow) {
    return (
      <>
        <div style={styles.overlay} onClick={onMinimize} />
        <div style={styles.floatingModal}>
          <div style={styles.modalHeader}>
            <div style={{ fontWeight: 600, fontSize: 13, color: '#f85149' }}>Context Overflow</div>
            <div style={{ flex: 1 }} />
            <button style={styles.iconBtn} onClick={onMinimize} title="Minimize">─</button>
            <button style={styles.iconBtn} onClick={onMinimize} title="Close">✕</button>
          </div>
          <div style={{ padding: '16px 20px', color: '#e6edf3', fontSize: 13, lineHeight: 1.6 }}>
            {gate.overflow_message ?? "This agent's inputs are too large to process even with compression. You can simplify the inputs or stop here."}
          </div>
          <div style={{ padding: '0 20px 16px', display: 'flex', gap: 8 }}>
            <button
              style={{ ...styles.approveBtn, background: '#2d1419', borderColor: '#f85149', color: '#f85149' }}
              onClick={() => sendGateResponse('abort')}
            >
              Stop project
            </button>
          </div>
        </div>
      </>
    );
  }

  const revisionCount = gate.revision_count;
  const revisionColor = revisionCount >= REVISION_ERROR_THRESHOLD
    ? '#f85149'
    : revisionCount >= REVISION_WARN_THRESHOLD
      ? '#d29922'
      : '#8b949e';

  // must_fix findings block approval
  const mustFixCount = findings.filter((f) =>
    f.severity === 'must_fix' &&
    f.status !== 'resolved' &&
    !overrides[f.id]
  ).length;
  const approveBlocked = mustFixCount > 0;

  // should_fix / suggestion findings that are unresolved and haven't been overridden trigger a warning confirm
  const nonBlockingUnaddressed = findings.filter((f) =>
    (f.severity === 'should_fix' || f.severity === 'suggestion') &&
    f.status !== 'resolved' &&
    !overrides[f.id]
  ).length;

  const handleApprove = () => {
    if (approveBlocked) return;
    if (nonBlockingUnaddressed > 0) {
      const confirmed = window.confirm(
        `You have ${nonBlockingUnaddressed} unaddressed recommendation${nonBlockingUnaddressed === 1 ? '' : 's'}. Approving now will pass these unresolved choices into the next phase. Are you sure you want to proceed?`
      );
      if (!confirmed) return;
    }
    sendGateResponse('approve');
  };

  return (
    <>
      {/* Dim overlay — click to minimize */}
      <div style={styles.overlay} onClick={onMinimize} />

      {/* Floating modal */}
      <div style={styles.floatingModal} onClick={() => setMoreOpen(false)}>
        <div style={styles.modalHeader}>
          <div style={{ flexShrink: 0 }}>
            <div style={styles.modalTitle}>
              Gate {gate.gate_number} — Phase {gate.phase} review
            </div>
            <div style={styles.modalSub}>
              <span style={{ color: revisionColor }}>
                Revision {revisionCount} of 3 before Opus escalation
              </span>
              {gate.next_phase_cost_estimate && (
                <span> · Next phase: <span style={{ color: '#3fb950' }}>{gate.next_phase_cost_estimate}</span></span>
              )}
            </div>
          </div>

          <div style={{ flex: 1 }} />

          {approveBlocked && (
            <span style={styles.blockingIndicator}>
              ⚠ {mustFixCount} {mustFixCount === 1 ? 'issue' : 'issues'} to resolve
            </span>
          )}

          <button
            style={{ ...styles.approveBtn, opacity: approveBlocked ? 0.4 : 1 }}
            disabled={approveBlocked}
            onClick={handleApprove}
            title={approveBlocked ? `${mustFixCount} must-fix finding(s) need overrides or resolution` : 'Approve and continue'}
          >
            Approve →
          </button>

          <button style={styles.reviseBtn} onClick={() => sendGateResponse('revise')}>
            ↺ Revise
          </button>

          <div style={styles.moreWrapper}>
            <button style={styles.moreBtn} onClick={(e) => { e.stopPropagation(); setMoreOpen((v) => !v); }}>
              ⚠ More
            </button>
            {moreOpen && (
              <div style={styles.moreMenu} onClick={(e) => e.stopPropagation()}>
                <div style={styles.moreMenuSection}>Go back to gate</div>
                <div style={styles.moreMenuRow}>
                  <select
                    style={styles.moreSelect}
                    value={gotoTarget}
                    onChange={(e) => setGotoTarget(Number(e.target.value))}
                  >
                    {Array.from({ length: gate.gate_number - 1 }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>Gate {n}</option>
                    ))}
                  </select>
                  <button
                    style={styles.moreMenuBtn}
                    onClick={() => {
                      if (window.confirm(`Roll back to Gate ${gotoTarget}? Work from Gate ${gotoTarget} onward will be archived.`)) {
                        sendGateResponse('goto', { goto_gate: gotoTarget });
                      }
                    }}
                    disabled={gate.gate_number <= 1}
                  >
                    Roll back
                  </button>
                </div>
                <button
                  style={styles.moreMenuBtn}
                  onClick={() => {
                    if (window.confirm(`Restart Phase ${gate.phase}? All agents in this phase will re-run from scratch.`)) {
                      sendGateResponse('goto', { goto_gate: gate.gate_number });
                    }
                  }}
                >
                  Restart this phase
                </button>
                <button
                  style={{ ...styles.moreMenuBtn, ...styles.abandonBtn }}
                  onClick={() => {
                    if (window.confirm('Abandon this project? All artifacts are preserved but the pipeline will stop.')) {
                      sendGateResponse('abort');
                    }
                  }}
                >
                  Abandon project
                </button>
              </div>
            )}
          </div>

          <button style={styles.iconBtn} onClick={onMinimize} title="Minimize">─</button>
          <button style={styles.iconBtn} onClick={onMinimize} title="Close">✕</button>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        {/* 3-column body */}
        <div style={styles.modalBody}>

          {/* Left: Generated document */}
          <div style={styles.pane}>
            <div style={styles.paneHeaderArea}>
              <div style={styles.paneLabel}>Generated document</div>
              {gate.artifacts[0] && (
                <div style={styles.filenameChip}>{gate.artifacts[0]}</div>
              )}
            </div>
            <div style={styles.paneScroll}>
              {loading
                ? <div style={styles.loading}>Loading…</div>
                : <ArtifactViewer content={artifactContent} artifactKey={gate.artifacts[0] ?? ''} />
              }
            </div>
          </div>

          {/* Middle: Your feedback */}
          <div style={{ ...styles.pane, borderLeft: '1px solid #30363d', borderRight: '1px solid #30363d' }}>
            <div style={styles.paneHeaderArea}>
              <div style={styles.paneLabel}>Your feedback</div>
            </div>
            <div style={styles.paneScroll}>
              <p style={styles.questionsPlaceholder}>
                No structured questions yet — the PM or Architect will surface open questions here in a future revision.
              </p>
            </div>
            <div style={styles.revisionArea}>
              <textarea
                style={styles.revisionTextarea}
                placeholder="Add a general note or instruction for the next revision…"
                value={revisionNote}
                onChange={(e) => setRevisionNote(e.target.value)}
              />
            </div>
          </div>

          {/* Right: Findings */}
          <div style={styles.pane}>
            <div style={styles.paneHeaderArea}>
              <div style={styles.paneLabel}>Findings ({findings.length})</div>
            </div>
            <div style={styles.paneScroll}>
              <ValidatorFindings findings={findings} overrides={overrides} onOverrideChange={handleOverrideChange} />
            </div>
          </div>

        </div>
      </div>
    </>
  );
}

const styles = {
  overlay: {
    position: 'fixed' as const,
    top: 48,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.35)',
    zIndex: 190,
  },
  floatingModal: {
    position: 'fixed' as const,
    top: 80,
    left: 28,
    right: 28,
    minHeight: 480,
    maxHeight: 'calc(100vh - 108px)',
    background: '#161b22',
    border: '1px solid #EF9F27',
    borderRadius: 8,
    zIndex: 200,
    display: 'flex',
    flexDirection: 'column' as const,
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    overflow: 'hidden',
  },
  modalHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 16px',
    borderBottom: '1px solid #30363d',
    background: 'rgba(239,159,39,0.06)',
    flexShrink: 0,
  },
  modalTitle: {
    fontWeight: 600,
    fontSize: 13,
    color: '#d29922',
  },
  modalSub: {
    fontSize: 11,
    color: '#8b949e',
    marginTop: 2,
  },
  modalBody: {
    display: 'grid',
    gridTemplateColumns: '1fr 1.1fr 1fr',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  pane: {
    display: 'flex',
    flexDirection: 'column' as const,
    minHeight: 0,
    overflow: 'hidden',
  },
  paneHeaderArea: {
    flexShrink: 0,
    borderBottom: '1px solid #30363d',
  },
  paneLabel: {
    padding: '6px 12px',
    fontSize: 11,
    fontWeight: 500,
    color: '#8b949e',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    background: '#21262d',
  },
  filenameChip: {
    padding: '4px 12px',
    fontSize: 11,
    color: '#8b949e',
    fontFamily: 'monospace',
    background: '#0d1117',
    borderTop: '1px solid #21262d',
  },
  paneScroll: {
    flex: 1,
    overflowY: 'auto' as const,
    minHeight: 0,
  },
  questionsPlaceholder: {
    margin: 0,
    padding: '14px 14px',
    fontSize: 12,
    color: '#484f58',
    fontStyle: 'italic',
    lineHeight: 1.55,
  },
  revisionArea: {
    flexShrink: 0,
    borderTop: '1px solid #30363d',
    padding: 8,
  },
  revisionTextarea: {
    width: '100%',
    background: '#0d1117',
    border: '1px solid #30363d',
    color: '#e6edf3',
    fontSize: 12,
    padding: '8px 10px',
    resize: 'none' as const,
    outline: 'none',
    fontFamily: 'inherit',
    lineHeight: 1.5,
    borderRadius: 4,
    height: 72,
    boxSizing: 'border-box' as const,
  },
  loading: {
    padding: 16,
    color: '#8b949e',
    fontSize: 13,
  },
  error: {
    background: '#3b1219',
    color: '#f85149',
    padding: '6px 16px',
    fontSize: 12,
    borderBottom: '1px solid #f85149',
    flexShrink: 0,
  },
  blockingIndicator: {
    color: '#d29922',
    fontSize: 12,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  approveBtn: {
    background: '#1a2e1a',
    border: '1px solid #3fb950',
    color: '#3fb950',
    borderRadius: 6,
    padding: '5px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
  },
  reviseBtn: {
    background: '#2d1e00',
    border: '1px solid #d29922',
    color: '#d29922',
    borderRadius: 6,
    padding: '5px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
  },
  iconBtn: {
    background: 'transparent',
    border: '1px solid #30363d',
    color: '#8b949e',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 13,
    cursor: 'pointer',
    lineHeight: 1,
    flexShrink: 0,
  } as React.CSSProperties,
  moreWrapper: {
    position: 'relative' as const,
    flexShrink: 0,
  },
  moreBtn: {
    background: '#21262d',
    border: '1px solid #6e7681',
    color: '#d29922',
    borderRadius: 6,
    padding: '5px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  moreMenu: {
    position: 'absolute' as const,
    top: '110%',
    right: 0,
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 6,
    padding: '8px',
    minWidth: 220,
    zIndex: 300,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  },
  moreMenuSection: {
    fontSize: 11,
    color: '#8b949e',
    padding: '0 4px 4px',
    borderBottom: '1px solid #21262d',
  },
  moreMenuRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
  },
  moreSelect: {
    flex: 1,
    background: '#0d1117',
    border: '1px solid #30363d',
    color: '#e6edf3',
    borderRadius: 4,
    padding: '4px 6px',
    fontSize: 12,
  } as React.CSSProperties,
  moreMenuBtn: {
    background: '#21262d',
    border: '1px solid #30363d',
    color: '#e6edf3',
    borderRadius: 4,
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
  } as React.CSSProperties,
  abandonBtn: {
    color: '#f85149',
    borderColor: '#f85149',
    background: '#3b1219',
    width: '100%',
    marginTop: 4,
  } as React.CSSProperties,
};

