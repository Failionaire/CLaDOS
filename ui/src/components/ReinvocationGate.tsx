import { useState } from 'react';

interface ReinvocationGateProps {
  detectedPhase: number;
  reasoning: string;
  affectedArtifacts: string[];
  onConfirm: (phase: number) => void;
  onCancel: () => void;
}

const PHASE_LABELS: Record<number, string> = {
  0: 'Concept — full re-run from idea',
  1: 'Architecture — re-design + rebuild',
  2: 'Build — code changes only',
  3: 'Document — update docs only',
  4: 'Infrastructure — deployment changes only',
};

export function ReinvocationGate({
  detectedPhase,
  reasoning,
  affectedArtifacts,
  onConfirm,
  onCancel,
}: ReinvocationGateProps) {
  const [selectedPhase, setSelectedPhase] = useState(detectedPhase);

  return (
    <>
      <div style={styles.overlay} onClick={onCancel} />
      <div style={styles.modal}>
        <div style={styles.header}>
          <div style={styles.title}>Re-invocation — Change Detection</div>
          <button style={styles.closeBtn} onClick={onCancel}>✕</button>
        </div>

        <div style={styles.body}>
          <div style={styles.section}>
            <div style={styles.sectionLabel}>Detected entry phase</div>
            <div style={styles.detectedPhase}>
              Phase {detectedPhase}: {PHASE_LABELS[detectedPhase] ?? 'Unknown'}
            </div>
            <div style={styles.reasoning}>{reasoning}</div>
          </div>

          <div style={styles.section}>
            <div style={styles.sectionLabel}>Override entry phase</div>
            <div style={styles.phaseSelector}>
              {[0, 1, 2, 3, 4].map(p => (
                <button
                  key={p}
                  style={{
                    ...styles.phaseBtn,
                    background: selectedPhase === p ? 'var(--ap-blue-lo, #0d2847)' : 'transparent',
                    borderColor: selectedPhase === p ? 'var(--ap-blue-border, #1a4a80)' : 'var(--border)',
                    color: selectedPhase === p ? 'var(--ap-blue)' : 'var(--text-3)',
                  }}
                  onClick={() => setSelectedPhase(p)}
                >
                  {p}: {PHASE_LABELS[p]?.split(' — ')[0]}
                </button>
              ))}
            </div>
          </div>

          {affectedArtifacts.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionLabel}>Artifacts to regenerate</div>
              <div style={styles.artifactList}>
                {affectedArtifacts.map(a => (
                  <div key={a} style={styles.artifact}>• {a}</div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onCancel}>Cancel</button>
          <button style={styles.confirmBtn} onClick={() => onConfirm(selectedPhase)}>
            Resume from Phase {selectedPhase}
          </button>
        </div>
      </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    zIndex: 999,
  },
  modal: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 520,
    maxHeight: '80vh',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    padding: '14px 20px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text)',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontSize: 16,
  },
  body: {
    padding: '16px 20px',
    overflow: 'auto',
    flex: 1,
  },
  section: {
    marginBottom: 16,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    color: 'var(--text-3)',
    marginBottom: 6,
  },
  detectedPhase: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--ap-blue)',
    marginBottom: 4,
  },
  reasoning: {
    fontSize: 12,
    color: 'var(--text-3)',
    lineHeight: 1.5,
  },
  phaseSelector: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  phaseBtn: {
    padding: '6px 12px',
    border: '1px solid',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 12,
    textAlign: 'left' as const,
  },
  artifactList: {
    fontSize: 12,
    color: 'var(--text)',
    lineHeight: 1.6,
  },
  artifact: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--text-3)',
  },
  footer: {
    padding: '12px 20px',
    borderTop: '1px solid var(--border)',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
  },
  cancelBtn: {
    padding: '6px 16px',
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--text-3)',
    cursor: 'pointer',
    fontSize: 12,
  },
  confirmBtn: {
    padding: '6px 16px',
    background: 'var(--green-lo, #0a2f0a)',
    border: '1px solid var(--green-border, #1a5f1a)',
    color: 'var(--green)',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
};
