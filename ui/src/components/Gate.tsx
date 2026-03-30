import { useState, useEffect, useRef, useCallback } from 'react';
import { ArtifactViewer } from './ArtifactViewer';
import { ValidatorFindings } from './ValidatorFindings';
import type { Finding, WsGateOpen } from '../types';

interface GateProps {
  gate: WsGateOpen | null;
  onClose: () => void;
}

type GateAction = 'approve' | 'revise' | 'goto' | 'abort';
type GateTab = 'artifact' | 'findings';

const MIN_HEIGHT = 200;
const DEFAULT_HEIGHT = 380;
const STORAGE_KEY = 'clados:gate-height';

const REVISION_WARN_THRESHOLD = 2;
const REVISION_ERROR_THRESHOLD = 3;

export function Gate({ gate, onClose }: GateProps) {
  const [height, setHeight] = useState(() => {
    try { return parseInt(localStorage.getItem(STORAGE_KEY) ?? '', 10) || DEFAULT_HEIGHT; }
    catch { return DEFAULT_HEIGHT; }
  });
  const [artifactContent, setArtifactContent] = useState<string>('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [revisionNote, setRevisionNote] = useState('');
  const [activeTab, setActiveTab] = useState<GateTab>('artifact');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [gotoTarget, setGotoTarget] = useState<number>(1);
  const [dragHandleHovered, setDragHandleHovered] = useState(false);
  const [narrowView, setNarrowView] = useState(() => window.innerWidth < 1100);
  const dragStartY = useRef<number | null>(null);
  const dragStartH = useRef<number>(DEFAULT_HEIGHT);
  const liveHeightRef = useRef(height);
  const dragMoveRef = useRef<((e: MouseEvent) => void) | null>(null);
  const dragEndRef = useRef<(() => void) | null>(null);

  // Reset state when gate changes
  useEffect(() => {
    if (!gate) return;
    setOverrides({});
    setRevisionNote('');
    setError(null);
    setMoreOpen(false);
    setActiveTab('artifact');
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

  useEffect(() => {
    const handler = () => setNarrowView(window.innerWidth < 1100);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  useEffect(() => {
    return () => {
      if (dragMoveRef.current) window.removeEventListener('mousemove', dragMoveRef.current);
      if (dragEndRef.current) window.removeEventListener('mouseup', dragEndRef.current);
    };
  }, []);

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
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [gate, revisionNote, overrides, onClose]);

  // Drag-to-resize — closures captured at drag-start so add/remove references are always stable
  const onDragStart = (e: React.MouseEvent) => {
    dragStartY.current = e.clientY;
    dragStartH.current = height;

    const move = (ev: MouseEvent) => {
      const delta = dragStartY.current! - ev.clientY;
      const newH = Math.max(MIN_HEIGHT, dragStartH.current + delta);
      setHeight(newH);
      liveHeightRef.current = newH;
    };

    const end = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', end);
      dragMoveRef.current = null;
      dragEndRef.current = null;
      try { localStorage.setItem(STORAGE_KEY, String(liveHeightRef.current)); } catch {}
    };

    dragMoveRef.current = move;
    dragEndRef.current = end;
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    e.preventDefault();
  };

  if (!gate) return null;

  const revisionCount = gate.revision_count;
  const revisionColor = revisionCount >= REVISION_ERROR_THRESHOLD
    ? '#f85149'
    : revisionCount >= REVISION_WARN_THRESHOLD
      ? '#d29922'
      : '#8b949e';

  const mustFixCount = findings.filter((f) => f.severity === 'must_fix' && !overrides[f.id]).length;
  const approveBlocked = mustFixCount > 0;

  const panelWidth = narrowView ? '100%' : 'calc(40% - 4px)';
  const revisionWidth = narrowView ? '100%' : 'calc(30% - 4px)';
  const findingsWidth = narrowView ? '100%' : 'calc(30% - 4px)';

  return (
    <div style={{ ...styles.drawer, height }}>
      {/* Drag handle */}
      <div
        style={{ ...styles.dragHandle, ...(dragHandleHovered ? { background: '#30363d' } : {}) }}
        onMouseDown={onDragStart}
        onMouseEnter={() => setDragHandleHovered(true)}
        onMouseLeave={() => setDragHandleHovered(false)}
        title="Drag to resize"
      />

      <div style={styles.toolbar}>
        <span style={styles.gateTitle}>
          Gate — Phase {gate.phase}
          <span style={{ ...styles.revisionBadge, color: revisionColor }}>
            {' '}Revision {revisionCount} of 3 before Opus escalation
          </span>
        </span>

        {narrowView && (
          <div style={styles.tabBar}>
            <button
              style={{ ...styles.tab, ...(activeTab === 'artifact' ? styles.tabActive : {}) }}
              onClick={() => setActiveTab('artifact')}
            >Artifact</button>
            <button
              style={{ ...styles.tab, ...(activeTab === 'findings' ? styles.tabActive : {}) }}
              onClick={() => setActiveTab('findings')}
            >Findings ({findings.length})</button>
          </div>
        )}

        <div style={styles.actions}>
          <button
            style={{ ...styles.approveBtn, opacity: approveBlocked ? 0.4 : 1 }}
            disabled={approveBlocked}
            onClick={() => sendGateResponse('approve')}
            title={approveBlocked ? `${mustFixCount} must-fix finding(s) need overrides or resolution` : 'Approve and continue'}
          >
            Approve
          </button>
          <button style={styles.reviseBtn} onClick={() => sendGateResponse('revise')}>
            Revise
          </button>
          <div style={styles.moreWrapper}>
            <button
              style={styles.moreBtn}
              onClick={() => setMoreOpen((v) => !v)}
              title="More options"
            >
              ⚠ More
            </button>
            {moreOpen && (
              <div style={styles.moreMenu}>
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
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.body}>
        {/* Artifact pane */}
        {(!narrowView || activeTab === 'artifact') && (
          <div style={{ ...styles.pane, width: panelWidth }}>
            <div style={styles.paneLabel}>{gate.artifacts[0] ?? ''}</div>
            <div style={styles.paneScroll}>
              {loading
                ? <div style={styles.loading}>Loading…</div>
                : <ArtifactViewer content={artifactContent} artifactKey={gate.artifacts[0] ?? ''} />
              }
            </div>
          </div>
        )}

        {/* Revision note pane (wide view only) */}
        {!narrowView && (
          <div style={{ ...styles.pane, width: revisionWidth }}>
            <div style={styles.paneLabel}>Revision note</div>
            <textarea
              style={styles.revisionTextarea}
              placeholder="Describe what needs to change…"
              value={revisionNote}
              onChange={(e) => setRevisionNote(e.target.value)}
            />
          </div>
        )}

        {/* Findings pane */}
        {(!narrowView || activeTab === 'findings') && (
          <div style={{ ...styles.pane, width: findingsWidth }}>
            <div style={styles.paneLabel}>Findings ({findings.length})</div>
            <div style={styles.paneScroll}>
              <ValidatorFindings findings={findings} overrides={overrides} onOverrideChange={handleOverrideChange} />
            </div>
          </div>
        )}
      </div>

      {/* Revision note on narrow views */}
      {narrowView && activeTab === 'artifact' && (
        <div style={styles.narrowRevision}>
          <textarea
            style={styles.revisionTextarea}
            placeholder="Revision note (optional)…"
            value={revisionNote}
            onChange={(e) => setRevisionNote(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

const styles = {
  drawer: {
    position: 'fixed' as const,
    bottom: 0,
    left: 0,
    right: 0,
    background: '#161b22',
    borderTop: '2px solid #30363d',
    zIndex: 200,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  dragHandle: {
    height: 6,
    cursor: 'ns-resize',
    background: 'transparent',
    borderBottom: '1px solid #30363d',
    flexShrink: 0,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '6px 16px',
    borderBottom: '1px solid #21262d',
    flexShrink: 0,
  },
  gateTitle: {
    fontWeight: 600,
    fontSize: 13,
    color: '#e6edf3',
  },
  revisionBadge: {
    fontSize: 12,
    fontWeight: 400,
  },
  tabBar: {
    display: 'flex',
    gap: 4,
    flex: 1,
  },
  tab: {
    background: 'transparent',
    border: '1px solid #30363d',
    color: '#8b949e',
    borderRadius: 4,
    padding: '3px 10px',
    fontSize: 12,
    cursor: 'pointer',
  } as React.CSSProperties,
  tabActive: {
    color: '#e6edf3',
    borderColor: '#58a6ff',
    background: '#1f3a5c',
  } as React.CSSProperties,
  actions: {
    marginLeft: 'auto',
    display: 'flex',
    gap: 8,
  },
  approveBtn: {
    background: '#1a2e1a',
    border: '1px solid #3fb950',
    color: '#3fb950',
    borderRadius: 6,
    padding: '5px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  reviseBtn: {
    background: '#3b2800',
    border: '1px solid #d29922',
    color: '#d29922',
    borderRadius: 6,
    padding: '5px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  error: {
    background: '#3b1219',
    color: '#f85149',
    padding: '6px 16px',
    fontSize: 12,
    borderBottom: '1px solid #f85149',
  },
  body: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    gap: 8,
    padding: '8px 12px',
    overflow: 'hidden',
    flexWrap: 'wrap' as const,
  },
  pane: {
    display: 'flex',
    flexDirection: 'column' as const,
    minHeight: 0,
    border: '1px solid #30363d',
    borderRadius: 6,
    overflow: 'hidden',
  },
  paneLabel: {
    padding: '4px 10px',
    fontSize: 11,
    color: '#8b949e',
    background: '#21262d',
    borderBottom: '1px solid #30363d',
    fontFamily: 'monospace',
    flexShrink: 0,
  },
  paneScroll: {
    flex: 1,
    overflowY: 'auto' as const,
  },
  loading: {
    padding: 16,
    color: '#8b949e',
    fontSize: 13,
  },
  revisionTextarea: {
    flex: 1,
    width: '100%',
    background: '#0d1117',
    border: 'none',
    color: '#e6edf3',
    fontSize: 13,
    padding: 10,
    resize: 'none' as const,
    outline: 'none',
    fontFamily: 'inherit',
    lineHeight: 1.5,
  },
  narrowRevision: {
    padding: '0 12px 8px',
    flexShrink: 0,
  },
  moreWrapper: {
    position: 'relative' as const,
  },
  moreBtn: {
    background: '#21262d',
    border: '1px solid #6e7681',
    color: '#d29922',
    borderRadius: 6,
    padding: '5px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  moreMenu: {
    position: 'absolute' as const,
    bottom: '110%',
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


