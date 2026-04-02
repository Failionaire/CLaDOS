import { useState, useEffect } from 'react';
import type { ProjectType } from '../types';

interface ProjectSummary {
  name: string;
  pipeline_status: string;
  created_at: string;
  updated_at: string;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'idle':               return 'not started';
    case 'agent_running':      return 'in progress';
    case 'gate_pending':       return 'awaiting review';
    case 'budget_gate_pending':return 'budget gate';
    case 'complete':           return 'complete ✓';
    case 'abandoned':          return 'abandoned';
    default:                   return status;
  }
}

export function HomeScreen() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProject, setSelectedProject] = useState('');

  // New project form
  const [name, setName] = useState('');
  const [idea, setIdea] = useState('');
  const [projectType, setProjectType] = useState<ProjectType>('backend-only');
  const [securityEnabled, setSecurityEnabled] = useState(false);
  const [wreckerEnabled, setWreckerEnabled] = useState(false);
  const [guidedMode, setGuidedMode] = useState(true);
  const [refinerEnabled, setRefinerEnabled] = useState(false);
  const [spendCap, setSpendCap] = useState('');
  const [templates, setTemplates] = useState<{ name: string; description: string; config: Record<string, unknown>; stack_preset?: Record<string, string> }[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/projects/list')
      .then((r) => r.json())
      .then((data: ProjectSummary[]) => {
        setProjects(data);
        if (data.length > 0) setSelectedProject(data[0].name);
      })
      .catch(() => {});
    fetch('/templates/list')
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setTemplates(data); })
      .catch(() => {});
  }, []);

  const handleOpen = async () => {
    if (!selectedProject) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch('/projects/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selectedProject }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(text || `HTTP ${resp.status}`);
      }
      // WS will broadcast state:snapshot → App switches to pipeline view
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) { setError('Project name is required.'); return; }
    if (!idea.trim()) { setError('Please describe your idea.'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch('/projects/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          idea: idea.trim(),
          project_type: projectType,
          security_enabled: securityEnabled,
          wrecker_enabled: wreckerEnabled,
          spend_cap: spendCap ? parseFloat(spendCap) : null,
          autonomy_mode: guidedMode ? 'guided' : 'autonomous',
          refiner_enabled: refinerEnabled,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(text || `HTTP ${resp.status}`);
      }
      // WS will broadcast state:snapshot → App switches to pipeline view
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  };

  const canCreate = !submitting && name.trim().length > 0 && idea.trim().length > 0;

  return (
    <div style={styles.overlay}>
      <div className="home-card" style={styles.card}>
        {/* Aperture logo (§5.2) */}
        <div style={styles.logoRow}>
          <svg width="44" height="44" viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0 }}>
            <circle cx="10" cy="10" r="9" stroke="var(--ap-orange)" strokeWidth="1.4" fill="none"/>
            <path d="M10 4 L6.5 16 M10 4 L13.5 16 M7.8 12 L12.2 12"
                  stroke="var(--ap-orange)" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
          <span className="home-logo-text">CLaDOS</span>
        </div>
        <div style={styles.tagline}>Multi-agent software development pipeline</div>

        {/* ── Existing projects ─────────────────────────────────────── */}
        {projects.length > 0 && (
          <>
            <div style={styles.sectionTitle}>Resume a project</div>
            <div style={styles.openRow}>
              <select
                style={{ ...styles.select, flex: 1 }}
                value={selectedProject}
                onChange={(e) => setSelectedProject(e.target.value)}
                disabled={submitting}
              >
                {projects.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} — {statusLabel(p.pipeline_status)}
                  </option>
                ))}
              </select>
              <button
                style={{ ...styles.actionBtn, ...styles.openBtn, opacity: submitting ? 0.55 : 1 }}
                disabled={submitting}
                onClick={handleOpen}
              >
                Open →
              </button>
            </div>

            <div style={styles.divider}>
              <div style={styles.dividerLine} />
              <span style={styles.dividerText}>or create a new project</span>
              <div style={styles.dividerLine} />
            </div>
          </>
        )}

        {/* ── New project form ────────────────────────────────────────── */}
        {templates.length > 0 && (
          <>
            <label style={styles.label}>Template</label>
            <select
              style={styles.select}
              onChange={(e) => {
                const tpl = templates.find(t => t.name === e.target.value);
                if (tpl) {
                  if (tpl.config.project_type) setProjectType(tpl.config.project_type as ProjectType);
                  if (tpl.config.security_enabled != null) setSecurityEnabled(!!tpl.config.security_enabled);
                  if (tpl.config.wrecker_enabled != null) setWreckerEnabled(!!tpl.config.wrecker_enabled);
                }
              }}
              disabled={submitting}
            >
              <option value="">— No template —</option>
              {templates.map(t => (
                <option key={t.name} value={t.name}>{t.name} — {t.description}</option>
              ))}
            </select>
          </>
        )}

        <label style={styles.label}>Project name</label>
        <input
          style={styles.input}
          type="text"
          placeholder="url-shortener"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus={projects.length === 0}
          disabled={submitting}
        />

        <label style={styles.label}>Describe your idea</label>
        <textarea
          style={styles.textarea}
          placeholder="A REST API for managing tasks, with user auth, projects, and due dates…"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={4}
          disabled={submitting}
        />

        <label style={styles.label}>Project type</label>
        <select
          style={styles.select}
          value={projectType}
          onChange={(e) => setProjectType(e.target.value as ProjectType)}
          disabled={submitting}
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
              style={{ accentColor: 'var(--red)' }}
              disabled={submitting}
            />
            <span>Security</span>
            <span style={styles.toggleHint}>Threat model &amp; dependency audit</span>
          </label>
          <label style={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={wreckerEnabled}
              onChange={(e) => setWreckerEnabled(e.target.checked)}
              style={{ accentColor: 'var(--amber)' }}
              disabled={submitting}
            />
            <span>Wrecker</span>
            <span style={styles.toggleHint}>Adversarial edge-case tests</span>
          </label>
          <label style={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={guidedMode}
              onChange={(e) => setGuidedMode(e.target.checked)}
              style={{ accentColor: 'var(--ap-blue)' }}
              disabled={submitting}
            />
            <span>Guided mode</span>
            <span style={styles.toggleHint}>Agents ask clarifying questions before proceeding</span>
          </label>
          <label style={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={refinerEnabled}
              onChange={(e) => setRefinerEnabled(e.target.checked)}
              style={{ accentColor: 'var(--green)' }}
              disabled={submitting}
            />
            <span>Refiner</span>
            <span style={styles.toggleHint}>Auto-fix should_fix and suggestion findings</span>
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
          disabled={submitting}
        />

        {error && <div style={styles.error}>{error}</div>}

        <button
          className="btn btn-primary"
          style={{ opacity: canCreate ? 1 : 0.55, marginTop: 24, width: '100%' }}
          disabled={!canCreate}
          onClick={handleCreate}
        >
          {submitting ? 'Starting…' : 'Create →'}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'var(--bg)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    zIndex: 50,
    padding: '40px 20px',
    overflowY: 'auto',
  },
  card: {
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    padding: '28px 32px',
    width: '100%',
    maxWidth: 520,
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    flexShrink: 0,
    position: 'relative',
  },
  logoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 4,
  },
  logo: {
    fontWeight: 700,
    fontSize: 20,
    color: 'var(--ap-orange)',
    letterSpacing: '0.20em',
  },
  tagline: {
    color: 'var(--text-3)',
    fontSize: 13,
    marginBottom: 28,
  },
  sectionTitle: {
    fontWeight: 600,
    fontSize: 13,
    color: 'var(--text)',
    marginBottom: 8,
  },
  openRow: {
    display: 'flex',
    gap: 8,
    marginBottom: 4,
  },
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    margin: '24px 0',
  },
  dividerLine: {
    flex: 1,
    height: 1,
    background: 'var(--border)',
  },
  dividerText: {
    fontSize: 12,
    color: 'var(--text-3)',
    whiteSpace: 'nowrap',
  },
  label: {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text)',
    marginTop: 20,
    marginBottom: 6,
  },
  input: {
    width: '100%',
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    fontSize: 14,
    padding: '8px 12px',
    outline: 'none',
    boxSizing: 'border-box',
  },
  textarea: {
    width: '100%',
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    fontSize: 14,
    padding: '10px 12px',
    resize: 'vertical',
    fontFamily: 'inherit',
    lineHeight: 1.5,
    outline: 'none',
    boxSizing: 'border-box',
  },
  select: {
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    fontSize: 14,
    padding: '8px 12px',
    outline: 'none',
    boxSizing: 'border-box',
    width: '100%',
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
    color: 'var(--text)',
  },
  toggleHint: {
    fontSize: 12,
    color: 'var(--text-3)',
  },
  optional: {
    fontWeight: 400,
    color: 'var(--text-3)',
  },
  error: {
    background: 'var(--red-lo)',
    border: '1px solid var(--red-border)',
    color: 'var(--red)',
    padding: '8px 12px',
    fontSize: 13,
    marginTop: 12,
  },
  actionBtn: {
    padding: '9px 20px',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    border: 'none',
    transition: 'opacity 0.15s',
  },
  openBtn: {
    background: 'var(--ap-blue-lo)',
    border: '1px solid var(--ap-blue-border)',
    color: 'var(--ap-blue)',
    whiteSpace: 'nowrap',
  },
  createBtn: {
    background: 'var(--green-lo)',
    border: '1px solid var(--green-border)',
    color: 'var(--green)',
    width: '100%',
  },
};
