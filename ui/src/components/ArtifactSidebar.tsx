import { useState, useEffect } from 'react';
import type { SessionState } from '../types';
import { ArtifactViewer } from './ArtifactViewer';
import { VersionDropdown } from './VersionDropdown';

interface ArtifactSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  sessionState: SessionState | null;
}

export function ArtifactSidebar({ isOpen, onClose, sessionState }: ArtifactSidebarProps) {
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Group artifacts roughly by phase based on the file name prefix (e.g. 0-pm.md -> Phase 0)
  const artifacts = sessionState?.artifacts ?? {};
  // Filter out raw validator JSON — findings are already surfaced in the Gate panel
  const artifactKeys = Object.keys(artifacts).filter((k) => !k.match(/validator\.json$/i)).sort();

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
  }, [selectedArtifact, isOpen, refreshKey]);

  // Keep selected artifact valid if it disappears (shouldn't really happen)
  useEffect(() => {
    if (selectedArtifact && !artifacts[selectedArtifact]) {
      setSelectedArtifact(null);
      setContent('');
    }
  }, [artifacts, selectedArtifact]);

  if (!isOpen) return null;

  return (
    <div className="sidebar-panel" style={styles.container}>
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
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>📄 {key}</span>
                <VersionDropdown
                  artifactKey={key}
                  currentVersion={artifacts[key]?.version ?? 1}
                  onReverted={() => setRefreshKey(k => k + 1)}
                />
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
    top: 62,
    right: 0,
    bottom: 0,
    width: '600px',
    backgroundColor: 'var(--panel)',
    borderLeft: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column' as const,
    zIndex: 90,
    boxShadow: 'var(--shadow-md)',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'var(--surface)',
  },
  headerTitle: {
    fontWeight: 600,
    fontSize: 14,
    color: 'var(--text)',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-3)',
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
    borderRight: '1px solid var(--border)',
    overflowY: 'auto' as const,
    padding: '8px 0',
  },
  empty: {
    padding: 16,
    color: 'var(--text-3)',
    fontSize: 13,
    textAlign: 'center' as const,
  },
  fileItem: {
    padding: '6px 16px',
    fontSize: 13,
    color: 'var(--text-2)',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  fileItemSelected: {
    backgroundColor: 'var(--ap-orange-lo)',
    color: 'var(--ap-orange)',
    borderRight: '2px solid var(--ap-orange)',
  },
  content: {
    flex: 1,
    overflowY: 'auto' as const,
    backgroundColor: 'var(--bg)',
  },
};
