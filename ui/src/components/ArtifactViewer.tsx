import ReactMarkdown from 'react-markdown';

interface ArtifactViewerProps {
  content: string;
  artifactKey: string;
}

function detectFormat(key: string): 'markdown' | 'yaml' | 'json' | 'text' {
  if (key.endsWith('.md')) return 'markdown';
  if (key.endsWith('.yaml') || key.endsWith('.yml')) return 'yaml';
  if (key.endsWith('.json')) return 'json';
  return 'text';
}

export function ArtifactViewer({ content, artifactKey }: ArtifactViewerProps) {
  const format = detectFormat(artifactKey);

  if (format === 'markdown') {
    return (
      <div style={styles.mdContainer}>
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    );
  }

  // YAML, JSON, and plain text all render as syntax-highlighted pre blocks
  return (
    <pre style={styles.pre}>
      <code>{content}</code>
    </pre>
  );
}

const styles = {
  mdContainer: {
    padding: 16,
    fontSize: 14,
    lineHeight: 1.6,
    color: 'var(--text)',
  } as React.CSSProperties,
  pre: {
    margin: 0,
    padding: 16,
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--text)',
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    overflowWrap: 'anywhere' as const,
    overflowX: 'auto' as const,
  },
};


