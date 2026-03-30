import { useState, useEffect } from 'react';
import type { SessionState } from '../types';
import { ArtifactViewer } from './ArtifactViewer';

interface ArtifactSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  sessionState: SessionState | null;
}

export function ArtifactSidebar({ isOpen, onClose, sessionState }: ArtifactSidebarProps) {
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);

  // Group artifacts roughly by phase based on the file name prefix (e.g. 0-pm.md -> Phase 0)
  const artifacts = sessionState?.artifacts ?? {};
  const artifactKeys = Object.keys(artifacts).sort();

  useEffect(() => {
    if (!selectedArtifact || !isOpen) return;

    let active = true;
    setIsLoading(true);
    fetch(`/project/artifact?path=${encodeURIComponent(selectedArtifact)}`)
      .then((res) => (res.ok ? res.text() : 'Failed to load artifact'))
      .then((text) => {
        if (active) {
          setContent(text);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setContent(`Error loading artifact: ${err.message}`);
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedArtifact, isOpen]);

  // Keep selected artifact valid if it disappears (shouldn't really happen)
  useEffect(() => {
    if (selectedArtifact && !artifacts[selectedArtifact]) {
      setSelectedArtifact(null);
      setContent('');
    }
  }, [artifacts, selectedArtifact]);

  if (!isOpen) return null;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.headerTitle}>Generated Files</div>
        <button style={styles.closeBtn} onClick={onClose} title="Close sidebar">
          ×
        </button>
      </div>

      <div style={styles.body}>
        <div style={styles.sidebar}>
          {artifactKeys.length === 0 && (
            <div style={styles.empty}>No files generated yet.</div>
          )}
          {artifactKeys.map((key) => {
            const isSelected = key === selectedArtifact;
            return (
              <div
                key={key}
                style={{ ...styles.fileItem, ...(isSelected ? styles.fileItemSelected : {}) }}
                onClick={() => setSelectedArtifact(key)}
              >
                📄 {key}
              </div>
            );
          })}
        </div>
        <div style={styles.content}>
          {selectedArtifact ? (
            isLoading ? (
              <div style={styles.empty}>Loading...</div>
            ) : (
              <ArtifactViewer content={content} artifactKey={selectedArtifact} />
            )
          ) : (
            <div style={styles.empty}>Select a file to view</div>
          )}
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: {
    position: 'fixed' as const,
    top: 48,
    right: 0,
    bottom: 0,
    width: '600px',
    backgroundColor: '#0d1117',
    borderLeft: '1px solid #30363d',
    display: 'flex',
    flexDirection: 'column' as const,
    zIndex: 90,
    boxShadow: '-4px 0 15px rgba(0,0,0,0.5)',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid #30363d',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#161b22',
  },
  headerTitle: {
    fontWeight: 600,
    fontSize: 14,
    color: '#e6edf3',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#8b949e',
    fontSize: 20,
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: 1,
  },
  body: {
    display: 'flex',
    flexDirection: 'row' as const,
    flex: 1,
    overflow: 'hidden',
  },
  sidebar: {
    width: '200px',
    borderRight: '1px solid #30363d',
    overflowY: 'auto' as const,
    padding: '8px 0',
  },
  empty: {
    padding: 16,
    color: '#8b949e',
    fontSize: 13,
    textAlign: 'center' as const,
  },
  fileItem: {
    padding: '6px 16px',
    fontSize: 13,
    color: '#c9d1d9',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  fileItemSelected: {
    backgroundColor: '#1f6feb33',
    color: '#58a6ff',
    borderRight: '2px solid #58a6ff',
  },
  content: {
    flex: 1,
    overflowY: 'auto' as const,
    backgroundColor: '#010409',
  },
};
