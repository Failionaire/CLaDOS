import { useState, useCallback } from 'react';
import type {
  WsDiscoveryGateOpen,
  WsQuestionGateOpen,
  DiscoveryQuestion,
  AgentQuestion,
} from '../types';

interface QuestionGateProps {
  /** Discovery gate event (Phase 0 two-pass flow). */
  discoveryGate?: WsDiscoveryGateOpen | null;
  /** Agent question gate event (V2 guided mode). */
  questionGate?: WsQuestionGateOpen | null;
  onClose: () => void;
}

const PHASE_LABELS: Record<number, string> = {
  0: 'Concept',
  1: 'Architecture',
  2: 'Build',
  3: 'Document',
  4: 'Infra',
};

export function QuestionGate({ discoveryGate, questionGate, onClose }: QuestionGateProps) {
  const isDiscovery = !!discoveryGate;
  const questions = isDiscovery
    ? (discoveryGate!.questions ?? [])
    : (questionGate?.questions ?? []);

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [additionalContext, setAdditionalContext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleAnswerChange = useCallback((id: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const endpoint = isDiscovery ? '/gate/discovery/respond' : '/gate/question/respond';
      const body = isDiscovery
        ? { answers, additional_context: additionalContext || undefined }
        : { answers };

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [answers, additionalContext, isDiscovery, onClose]);

  if (!discoveryGate && !questionGate) return null;

  const title = isDiscovery
    ? 'Discovery — Clarifying Questions'
    : `Agent Questions — ${questionGate!.agent} (Phase ${questionGate!.phase}: ${PHASE_LABELS[questionGate!.phase] ?? ''})`;

  return (
    <>
      <div style={styles.overlay} onClick={onClose} />
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.title}>{title}</div>
          <button style={styles.closeBtn} onClick={onClose} title="Minimize">—</button>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.body}>
          {/* Understanding section (discovery only) */}
          {isDiscovery && discoveryGate!.understanding && (
            <div style={styles.understandingSection}>
              <div style={styles.sectionLabel}>PM's understanding of your idea</div>
              <div style={styles.understandingText}>{discoveryGate!.understanding}</div>
            </div>
          )}

          {/* Questions */}
          <div style={styles.questionsSection}>
            <div style={styles.sectionLabel}>
              {isDiscovery
                ? 'Answer the questions below, or leave blank to accept the default assumptions.'
                : 'The agent has questions before proceeding. Leave blank to use defaults.'}
            </div>
            {questions.map((q) => {
              const qId = isDiscovery ? (q as DiscoveryQuestion).id : (q as AgentQuestion).id;
              const qText = isDiscovery ? (q as DiscoveryQuestion).question : (q as AgentQuestion).question;
              const rationale = isDiscovery ? (q as DiscoveryQuestion).rationale : '';
              const defaultText = isDiscovery
                ? (q as DiscoveryQuestion).default_assumption
                : (q as AgentQuestion).default_answer;

              return (
                <div key={qId} style={styles.questionCard}>
                  <div style={styles.questionText}>{qText}</div>
                  {rationale && <div style={styles.rationale}>{rationale}</div>}
                  <input
                    style={styles.answerInput}
                    placeholder={defaultText || 'Type your answer...'}
                    value={answers[qId] ?? ''}
                    onChange={(e) => handleAnswerChange(qId, e.target.value)}
                  />
                  {defaultText && (
                    <div style={styles.defaultLabel}>Default: {defaultText}</div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Additional context (discovery only) */}
          {isDiscovery && (
            <div style={styles.additionalSection}>
              <div style={styles.sectionLabel}>Additional context (optional)</div>
              <textarea
                style={styles.additionalTextarea}
                placeholder="Anything else the PM should know..."
                value={additionalContext}
                onChange={(e) => setAdditionalContext(e.target.value)}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button
            style={styles.submitBtn}
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? 'Submitting...' : 'Looks good'}
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
    background: 'rgba(0,0,0,0.55)',
    zIndex: 199,
  },
  modal: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '90vw',
    maxWidth: 640,
    maxHeight: '85vh',
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 200,
    boxShadow: 'var(--shadow-lg)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px',
    borderBottom: '1px solid var(--border-dim)',
    flexShrink: 0,
  },
  title: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--text)',
    letterSpacing: '0.02em',
    textTransform: 'uppercase' as const,
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
    fontSize: 16,
    cursor: 'pointer',
    padding: '2px 8px',
  },
  error: {
    background: 'var(--red-lo)',
    color: 'var(--red)',
    padding: '6px 16px',
    fontSize: 12,
    borderBottom: '1px solid var(--red-border)',
    flexShrink: 0,
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    minHeight: 0,
  },
  understandingSection: {
    padding: '12px',
    background: 'var(--surface)',
    border: '1px solid var(--border-dim)',
  },
  understandingText: {
    fontSize: 13,
    color: 'var(--text-2)',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap' as const,
  },
  sectionLabel: {
    fontSize: 11,
    color: 'var(--text-3)',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    marginBottom: 8,
  },
  questionsSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  questionCard: {
    padding: '10px 12px',
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  questionText: {
    fontSize: 13,
    color: 'var(--text)',
    fontWeight: 500,
    lineHeight: 1.5,
  },
  rationale: {
    fontSize: 11,
    color: 'var(--text-4)',
    lineHeight: 1.4,
    fontStyle: 'italic',
  },
  answerInput: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    fontSize: 13,
    padding: '6px 10px',
    outline: 'none',
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  },
  defaultLabel: {
    fontSize: 11,
    color: 'var(--text-4)',
  },
  additionalSection: {
    display: 'flex',
    flexDirection: 'column',
  },
  additionalTextarea: {
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    fontSize: 13,
    padding: '10px 12px',
    resize: 'vertical' as const,
    outline: 'none',
    fontFamily: 'inherit',
    minHeight: 80,
    width: '100%',
    boxSizing: 'border-box',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    padding: '10px 16px',
    borderTop: '1px solid var(--border-dim)',
    flexShrink: 0,
  },
  submitBtn: {
    background: 'var(--green)',
    border: 'none',
    color: 'var(--bg)',
    padding: '6px 20px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
