import type { Finding, FindingSeverity } from '../types';

interface ValidatorFindingsProps {
  findings: Finding[];
  onOverrideChange: (id: string, overridden: boolean) => void;
}

const SEVERITY_ORDER: FindingSeverity[] = ['must_fix', 'should_fix', 'suggestion'];

const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  must_fix: 'Must fix',
  should_fix: 'Should fix',
  suggestion: 'Suggestion',
};

const SEVERITY_COLORS: Record<FindingSeverity, string> = {
  must_fix: '#f85149',
  should_fix: '#d29922',
  suggestion: '#58a6ff',
};

const STATUS_LABEL: Record<string, string> = {
  new: 'New',
  resolved: 'Resolved',
  partially_resolved: 'Partial',
  unresolved: 'Unresolved',
  new_discovery: 'Discovery',
};

export function ValidatorFindings({ findings, onOverrideChange }: ValidatorFindingsProps) {
  const sorted = [...findings].sort((a, b) => {
    return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  });

  if (sorted.length === 0) {
    return <div style={styles.empty}>No findings.</div>;
  }

  return (
    <div style={styles.list}>
      {sorted.map((finding) => (
        <div key={finding.id} style={{
          ...styles.item,
          opacity: finding.status === 'resolved' ? 0.5 : 1,
        }}>
          <div style={styles.itemHeader}>
            <span style={{ ...styles.severityDot, background: SEVERITY_COLORS[finding.severity] }} />
            <span style={{ ...styles.severityLabel, color: SEVERITY_COLORS[finding.severity] }}>
              {SEVERITY_LABELS[finding.severity]}
            </span>
            {finding.status && (
              <span style={styles.statusLabel}>{STATUS_LABEL[finding.status] ?? finding.status}</span>
            )}
            <label style={styles.overrideLabel}>
              <input
                type="checkbox"
                checked={finding.override ?? false}
                onChange={(e) => onOverrideChange(finding.id, e.target.checked)}
                style={{ marginRight: 4 }}
              />
              Override
            </label>
          </div>

          <div style={styles.category}>{finding.category}</div>
          <div style={styles.description}>{finding.description}</div>
          {finding.file && (
            <div style={styles.location}>
              {finding.file}
              {finding.line != null && `:${finding.line}`}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const styles = {
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    padding: 12,
  },
  item: {
    background: '#21262d',
    borderRadius: 6,
    padding: '8px 10px',
    border: '1px solid #30363d',
  },
  itemHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  severityDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0,
  },
  severityLabel: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  statusLabel: {
    fontSize: 11,
    color: '#8b949e',
    marginLeft: 4,
  },
  overrideLabel: {
    marginLeft: 'auto',
    fontSize: 11,
    color: '#8b949e',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
  },
  category: {
    fontSize: 11,
    color: '#8b949e',
    marginBottom: 2,
    fontWeight: 500,
  },
  description: {
    fontSize: 13,
    color: '#e6edf3',
    lineHeight: 1.4,
  },
  location: {
    marginTop: 4,
    fontSize: 11,
    color: '#8b949e',
    fontFamily: 'monospace',
  },
  empty: {
    padding: 16,
    color: '#8b949e',
    fontSize: 13,
  },
};

export default ValidatorFindings;
