import { useState } from 'react';
import type { ProjectType } from '../types';

interface SetupScreenProps {
  projectName: string;
}

export function SetupScreen({ projectName }: SetupScreenProps) {
  const [idea, setIdea] = useState('');
  const [projectType, setProjectType] = useState<ProjectType>('backend-only');
  const [securityEnabled, setSecurityEnabled] = useState(false);
  const [wreckerEnabled, setWreckerEnabled] = useState(false);
  const [spendCap, setSpendCap] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = async () => {
    if (!idea.trim()) {
      setError('Please describe your idea.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch('/project/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idea: idea.trim(),
          project_type: projectType,
          security_enabled: securityEnabled,
          wrecker_enabled: wreckerEnabled,
          spend_cap: spendCap ? parseFloat(spendCap) : null,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(text || `HTTP ${resp.status}`);
      }
      // Pipeline now starts; WS events will drive the UI forward
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <div style={styles.header}>
          <span style={styles.logo}>CLaDOS</span>
          <span style={styles.sep}>/</span>
          <span style={styles.projectName}>{projectName || 'new project'}</span>
        </div>

        <div style={styles.phase}>Phase 0 — Concept</div>
        <div style={styles.subtitle}>Tell CLaDOS what you want to build.</div>

        <label style={styles.label}>Describe your idea</label>
        <textarea
          style={styles.textarea}
          placeholder="A REST API for managing tasks, with user auth, projects, and due dates…"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={5}
          autoFocus
        />

        <label style={styles.label}>Project type</label>
        <select
          style={styles.select}
          value={projectType}
          onChange={(e) => setProjectType(e.target.value as ProjectType)}
        >
          <option value="backend-only">Backend API</option>
          <option value="full-stack">Full-Stack App</option>
          <option value="cli-tool">CLI Tool</option>
          <option value="library">Library</option>
        </select>

        <label style={styles.label}>Optional agents</label>
        <div style={styles.toggleRow}>
          <label style={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={securityEnabled}
              onChange={(e) => setSecurityEnabled(e.target.checked)}
              style={{ accentColor: '#f85149' }}
            />
            <span>Security</span>
            <span style={styles.toggleHint}>Threat model &amp; dependency audit</span>
          </label>
          <label style={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={wreckerEnabled}
              onChange={(e) => setWreckerEnabled(e.target.checked)}
              style={{ accentColor: '#d29922' }}
            />
            <span>Wrecker</span>
            <span style={styles.toggleHint}>Adversarial edge-case tests</span>
          </label>
        </div>

        <label style={styles.label}>
          Spend cap <span style={styles.optional}>(optional, $)</span>
        </label>
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder="e.g. 5.00"
          style={styles.input}
          value={spendCap}
          onChange={(e) => setSpendCap(e.target.value)}
        />

        {error && <div style={styles.error}>{error}</div>}

        <button
          style={{ ...styles.startBtn, opacity: submitting || !idea.trim() ? 0.55 : 1 }}
          disabled={submitting || !idea.trim()}
          onClick={handleStart}
        >
          {submitting ? 'Starting…' : 'Start →'}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: '#0d1117',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
    padding: 24,
  },
  card: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 12,
    padding: 32,
    width: '100%',
    maxWidth: 560,
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 20,
  },
  logo: {
    fontWeight: 700,
    fontSize: 16,
    color: '#58a6ff',
    letterSpacing: '-0.5px',
  },
  sep: {
    color: '#30363d',
    fontSize: 18,
  },
  projectName: {
    color: '#8b949e',
    fontSize: 14,
  },
  phase: {
    fontWeight: 700,
    fontSize: 18,
    color: '#e6edf3',
    marginBottom: 4,
  },
  subtitle: {
    color: '#8b949e',
    fontSize: 14,
    marginBottom: 8,
  },
  label: {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    color: '#e6edf3',
    marginTop: 20,
    marginBottom: 6,
  },
  textarea: {
    width: '100%',
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 6,
    color: '#e6edf3',
    fontSize: 14,
    padding: '10px 12px',
    resize: 'vertical',
    fontFamily: 'inherit',
    lineHeight: 1.5,
    outline: 'none',
    boxSizing: 'border-box',
  },
  select: {
    width: '100%',
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 6,
    color: '#e6edf3',
    fontSize: 14,
    padding: '8px 12px',
    outline: 'none',
    boxSizing: 'border-box',
  },
  toggleRow: {
    display: 'flex',
    gap: 24,
    flexWrap: 'wrap',
    marginTop: 4,
  },
  toggleLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    fontSize: 14,
    color: '#e6edf3',
  },
  toggleHint: {
    fontSize: 12,
    color: '#8b949e',
  },
  input: {
    width: '100%',
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 6,
    color: '#e6edf3',
    fontSize: 14,
    padding: '8px 12px',
    outline: 'none',
    boxSizing: 'border-box',
  },
  optional: {
    fontWeight: 400,
    color: '#8b949e',
  },
  error: {
    background: '#3b1219',
    border: '1px solid #f85149',
    color: '#f85149',
    borderRadius: 6,
    padding: '8px 12px',
    fontSize: 13,
    marginTop: 12,
  },
  startBtn: {
    background: '#1a2e1a',
    border: '1px solid #3fb950',
    color: '#3fb950',
    borderRadius: 8,
    padding: '10px 24px',
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    marginTop: 24,
    width: '100%',
  },
};
