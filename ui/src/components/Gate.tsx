import { useState, useEffect, useCallback } from 'react';
import { ArtifactViewer } from './ArtifactViewer';
import { ValidatorFindings } from './ValidatorFindings';
import { ConfirmModal } from './ConfirmModal';
import type { Finding, SessionState, WsGateOpen } from '../types';

interface GateProps {
  gate: WsGateOpen | null;
  sessionState: SessionState | null;
  onMinimize: () => void;
  onClose: () => void;
  /** Called synchronously before onClose so the board can optimistically clear the gate card. */
  onResolved?: (phase: number, approved: boolean) => void;
  /** External file changes detected by file watcher */
  externalFileChanges?: string[];
}

type GateAction = 'approve' | 'revise' | 'goto' | 'abort';

const REVISION_WARN_THRESHOLD = 2;
const REVISION_ERROR_THRESHOLD = 3;

/** Returns artifact keys from sessionState that belong to phases >= the given phase. */
function getArtifactsForPhases(sessionState: SessionState | null, fromPhase: number): string[] {
  if (!sessionState?.artifacts) return [];
  const phasePrefixes: Record<number, string[]> = {
    0: ['00-'],
    1: ['01-'],
    2: ['02-build'],
    3: ['03-'],
    4: ['04-'],
  };
  return Object.keys(sessionState.artifacts).filter((key) => {
    for (let p = fromPhase; p <= 4; p++) {
      const prefixes = phasePrefixes[p] ?? [];
      if (prefixes.some((pfx) => key.startsWith(pfx))) return true;
    }
    return false;
  });
}

export function Gate({ gate, sessionState, onMinimize, onClose, onResolved, externalFileChanges }: GateProps) {
  const [artifactContent, setArtifactContent] = useState<string>('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [revisionNote, setRevisionNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [gotoTarget, setGotoTarget] = useState<number>(1);
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    quip?: string;
    onConfirm: () => void;
    variant?: 'danger' | 'warning';
  } | null>(null);
  const [externalChanges, setExternalChanges] = useState<string[]>([]);

  // Sync external file changes from prop
  useEffect(() => {
    if (externalFileChanges && externalFileChanges.length > 0) {
      setExternalChanges(prev => [...new Set([...prev, ...externalFileChanges])]);
    }
  }, [externalFileChanges]);

  // Reset state when gate changes
  useEffect(() => {
    if (!gate) return;
    setOverrides({});
    setRevisionNote('');
    setError(null);
    setMoreOpen(false);
    setExternalChanges([]);
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
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--red)' }}>Context Overflow</div>
            <div style={{ flex: 1 }} />
            <button style={styles.iconBtn} onClick={onMinimize} title="Minimize">─</button>
            <button style={styles.iconBtn} onClick={onMinimize} title="Close">✕</button>
          </div>
          <div style={{ padding: '16px 20px', color: 'var(--text)', fontSize: 13, lineHeight: 1.6 }}>
            {gate.overflow_message ?? "This agent's inputs are too large to process even with compression. You can simplify the inputs or stop here."}
          </div>
          <div style={{ padding: '0 20px 16px', display: 'flex', gap: 8 }}>
            <button
              style={{ ...styles.approveBtn, background: 'var(--red-lo)', borderColor: 'var(--red-border)', color: 'var(--red)' }}
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
    ? 'var(--red)'
    : revisionCount >= REVISION_WARN_THRESHOLD
      ? 'var(--amber)'
      : 'var(--text-3)';

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
      setConfirmModal({
        title: 'Unaddressed Recommendations',
        message: `You have ${nonBlockingUnaddressed} unaddressed recommendation${nonBlockingUnaddressed === 1 ? '' : 's'}. Approving now will pass these unresolved choices into the next phase.`,
        quip: "Proceeding with known issues. Bold strategy. Let's see if it pays off.",
        onConfirm: () => { setConfirmModal(null); sendGateResponse('approve'); },
        variant: 'warning',
      });
      return;
    }
    sendGateResponse('approve');
  };

  return (
    <>
      {/* Dim overlay — click to minimize */}
      <div style={styles.overlay} onClick={onMinimize} />

      {/* Floating modal */}
      <div className="gate-panel" style={styles.floatingModal} onClick={() => setMoreOpen(false)}>
        {/* Hazard stripe bar (§4.1) */}
        <div className="hazard-bar amber" />
        <div style={styles.modalHeader}>
          <div style={{ flexShrink: 0 }}>
            <div style={styles.modalTitle}>
              Gate {gate.gate_number} — Phase {gate.phase} review
            </div>
            <div style={styles.modalSub}>
              <span
                style={{ color: revisionColor, cursor: 'help', borderBottom: `1px dotted ${revisionColor}` }}
                title="Each revision re-runs this phase's agents with your notes. After 3 revisions without resolution, the Validator upgrades to Claude Opus for a deeper review."
              >
                Revision {revisionCount} of 3 before Opus escalation
              </span>
              {gate.next_phase_cost_estimate && (
                <span> · Next phase: <span style={{ color: 'var(--green)' }}>{gate.next_phase_cost_estimate}</span></span>
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
            <button style={styles.moreBtn} onClick={(e) => { e.stopPropagation(); setMoreOpen((v) => !v); }} title="Rollback, restart, or abandon project">
              Actions ▾
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
                      const targetPhase = gotoTarget - 1;
                      const discarded = getArtifactsForPhases(sessionState, targetPhase);
                      const artifactList = discarded.length > 0
                        ? `\n\nArtifacts that will be archived to .clados/history/:\n${discarded.map((a) => `  • ${a}`).join('\n')}`
                        : '';
                      setConfirmModal({
                        title: `Roll back to Gate ${gotoTarget}`,
                        message: `Work from Gate ${gotoTarget} onward will be archived. This cannot be undone.${artifactList}`,
                        quip: 'Rewinding time. If only you could undo all your other mistakes too.',
                        onConfirm: () => { setConfirmModal(null); sendGateResponse('goto', { goto_gate: gotoTarget }); },
                        variant: 'danger',
                      });
                    }}
                    disabled={gate.gate_number <= 1}
                  >
                    Roll back
                  </button>
                </div>
                <button
                  style={styles.moreMenuBtn}
                  onClick={() => {
                    setConfirmModal({
                      title: `Restart Phase ${gate.phase}`,
                      message: `All agents in this phase will re-run from scratch. Previous outputs will be archived.`,
                      quip: 'Starting over. Again. How very human of you.',
                      onConfirm: () => { setConfirmModal(null); sendGateResponse('goto', { goto_gate: gate.gate_number }); },
                      variant: 'warning',
                    });
                  }}
                >
                  Restart this phase
                </button>
                <button
                  style={{ ...styles.moreMenuBtn, ...styles.abandonBtn }}
                  onClick={() => {
                    setConfirmModal({
                      title: 'Abandon Project',
                      message: 'All artifacts are preserved but the pipeline will stop. This cannot be undone.',
                      quip: "Giving up already? I can't say I'm surprised.",
                      onConfirm: () => { setConfirmModal(null); sendGateResponse('abort'); },
                      variant: 'danger',
                    });
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

        {externalChanges.length > 0 && (
          <div style={{ padding: '8px 20px', background: 'var(--amber-lo, #3a3000)', borderBottom: '1px solid var(--amber-border, #665500)', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--amber)' }}>
            <span>⚠ {externalChanges.length} file{externalChanges.length === 1 ? '' : 's'} changed externally</span>
            <button
              style={{ marginLeft: 'auto', background: 'none', border: '1px solid var(--amber-border, #665500)', color: 'var(--amber)', padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
              onClick={() => setExternalChanges([])}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Body: doc | feedback | findings (findings hidden when empty) */}
        <div style={{ ...styles.modalBody, gridTemplateColumns: findings.length === 0 ? '1.6fr 1fr' : '1.6fr 1fr 1fr' }}>

          {/* Left: Generated document */}
          <div style={styles.pane}>
            <div style={styles.paneHeaderArea}>
              <div style={styles.paneLabel}>Generated document</div>
              {gate.artifacts[0] && (
                <div style={styles.filenameChip}>{gate.artifacts[0]}</div>
              )}
            </div>
            <div style={{ ...styles.paneScroll, position: 'relative' as const }}>
              {loading
                ? <div style={styles.loading}>Loading…</div>
                : <ArtifactViewer content={artifactContent} artifactKey={gate.artifacts[0] ?? ''} />
              }
              {/* Scroll fade indicator */}
              <div style={styles.scrollFade} />
            </div>
          </div>

          {/* Middle: Your notes */}
          <div style={{ ...styles.pane, borderLeft: '1px solid var(--border)', borderRight: findings.length > 0 ? '1px solid var(--border)' : 'none' }}>
            <div style={styles.paneHeaderArea}>
              <div style={styles.paneLabel}>
                {revisionNote.trim() ? 'Your notes — will be sent on revise' : 'Your notes'}
              </div>
            </div>
            <div style={styles.feedbackBody}>
              <p style={styles.feedbackHint}>
                Describe what you want changed, what you approved, or any additional requirements. Click <strong style={{ color: 'var(--text)' }}>Revise</strong> to re-run with these notes.
              </p>
              <textarea
                style={styles.revisionTextarea}
                placeholder="e.g. Add rate limiting to the shorten endpoint. The redirect should use 302 not 301…"
                value={revisionNote}
                onChange={(e) => setRevisionNote(e.target.value)}
                autoFocus
              />
            </div>
          </div>

          {/* Right: Findings — hidden when empty */}
          {findings.length > 0 && (
            <div style={styles.pane}>
              <div style={styles.paneHeaderArea}>
                <div style={styles.paneLabel}>
                  Findings ({findings.length})
                  {mustFixCount > 0 && <span style={styles.mustFixBadge}>{mustFixCount} must-fix</span>}
                </div>
              </div>
              <div style={styles.paneScroll}>
                <ValidatorFindings findings={findings} overrides={overrides} onOverrideChange={handleOverrideChange} />
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ConfirmModal (§4.6) */}
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          quip={confirmModal.quip}
          variant={confirmModal.variant}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}
    </>
  );
}

const styles = {
  overlay: {
    position: 'fixed' as const,
    top: 62,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'var(--overlay)',
    zIndex: 190,
  },
  floatingModal: {
    position: 'fixed' as const,
    top: 94,
    left: 28,
    right: 28,
    minHeight: 480,
    maxHeight: 'calc(100vh - 108px)',
    background: 'var(--panel)',
    border: '1px solid var(--amber-border)',
    zIndex: 200,
    display: 'flex',
    flexDirection: 'column' as const,
    boxShadow: 'var(--shadow-md)',
    overflow: 'hidden',
  },
  modalHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 16px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--amber-lo)',
    flexShrink: 0,
  },
  modalTitle: {
    fontWeight: 600,
    fontSize: 13,
    color: 'var(--amber)',
  },
  modalSub: {
    fontSize: 11,
    color: 'var(--text-3)',
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
    borderBottom: '1px solid var(--border)',
  },
  paneLabel: {
    padding: '6px 12px',
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text-3)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    background: 'var(--surface2)',
  },
  filenameChip: {
    padding: '4px 12px',
    fontSize: 11,
    color: 'var(--text-3)',
    fontFamily: 'var(--font-mono)',
    background: 'var(--surface)',
    borderTop: '1px solid var(--border-dim)',
  },
  paneScroll: {
    flex: 1,
    overflowY: 'auto' as const,
    minHeight: 0,
  },

  revisionTextarea: {
    flex: 1,
    width: '100%',
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    fontSize: 13,
    padding: '10px 12px',
    resize: 'none' as const,
    outline: 'none',
    fontFamily: 'inherit',
    lineHeight: 1.55,
    minHeight: 120,
    boxSizing: 'border-box' as const,
  },
  loading: {
    padding: 16,
    color: 'var(--text-3)',
    fontSize: 13,
  },
  error: {
    background: 'var(--red-lo)',
    color: 'var(--red)',
    padding: '6px 16px',
    fontSize: 12,
    borderBottom: '1px solid var(--red-border)',
    flexShrink: 0,
  },
  blockingIndicator: {
    color: 'var(--amber)',
    fontSize: 12,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  approveBtn: {
    background: 'var(--green)',
    border: 'none',
    color: 'var(--bg)',
    padding: '5px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
  },
  reviseBtn: {
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text-2)',
    padding: '5px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
  },
  iconBtn: {
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--text-3)',
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
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text-3)',
    padding: '5px 10px',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },
  mustFixBadge: {
    marginLeft: 6,
    background: 'var(--red-lo)',
    color: 'var(--red)',
    border: '1px solid var(--red-border)',
    fontSize: 10,
    padding: '0 5px',
    fontWeight: 700,
  } as React.CSSProperties,
  scrollFade: {
    position: 'absolute' as const,
    bottom: 0,
    left: 0,
    right: 0,
    height: 32,
    background: 'linear-gradient(to bottom, transparent, var(--panel))',
    pointerEvents: 'none' as const,
  } as React.CSSProperties,
  feedbackBody: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    padding: '12px 12px 12px',
    gap: 10,
    minHeight: 0,
  },
  feedbackHint: {
    margin: 0,
    fontSize: 12,
    color: 'var(--text-4)',
    lineHeight: 1.55,
    flexShrink: 0,
  },
  moreMenu: {
    position: 'absolute' as const,
    top: '110%',
    right: 0,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    padding: '8px',
    minWidth: 220,
    zIndex: 300,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    boxShadow: 'var(--shadow-md)',
  },
  moreMenuSection: {
    fontSize: 11,
    color: 'var(--text-3)',
    padding: '0 4px 4px',
    borderBottom: '1px solid var(--border-dim)',
  },
  moreMenuRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
  },
  moreSelect: {
    flex: 1,
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    padding: '4px 6px',
    fontSize: 12,
  } as React.CSSProperties,
  moreMenuBtn: {
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
  } as React.CSSProperties,
  abandonBtn: {
    color: 'var(--red)',
    borderColor: 'var(--red-border)',
    background: 'var(--red-lo)',
    width: '100%',
    marginTop: 4,
  } as React.CSSProperties,
};

