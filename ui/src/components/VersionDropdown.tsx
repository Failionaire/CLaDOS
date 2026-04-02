import { useState, useEffect, useRef } from 'react';

interface VersionDropdownProps {
  artifactKey: string;
  currentVersion: number;
  onReverted: () => void;
}

interface VersionEntry {
  version: number;
  filename: string;
}

export function VersionDropdown({ artifactKey, currentVersion, onReverted }: VersionDropdownProps) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Fetch versions when opened
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`/artifact/versions?path=${encodeURIComponent(artifactKey)}`)
      .then(r => r.json())
      .then((data: { versions: VersionEntry[] }) => {
        setVersions(data.versions);
        setLoading(false);
      })
      .catch(() => {
        setVersions([]);
        setLoading(false);
      });
  }, [open, artifactKey]);

  const handleRevert = async (version: number) => {
    try {
      await fetch('/artifact/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: artifactKey, version }),
      });
      onReverted();
      setOpen(false);
    } catch { /* best-effort */ }
  };

  if (currentVersion <= 1) return null;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className="btn btn-ghost"
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        style={{ fontSize: 10, padding: '1px 5px', color: 'var(--text-3)' }}
        title="Version history"
      >
        v{currentVersion} ▾
      </button>
      {open && (
        <div style={styles.dropdown}>
          {loading ? (
            <div style={styles.item}>Loading...</div>
          ) : versions.length === 0 ? (
            <div style={styles.item}>No previous versions</div>
          ) : (
            versions.map(v => (
              <div key={v.version} style={styles.item}>
                <span style={{ flex: 1 }}>v{v.version}</span>
                {v.version !== currentVersion ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 10, color: 'var(--blue)' }}
                    onClick={(e) => { e.stopPropagation(); handleRevert(v.version); }}
                  >
                    Revert
                  </button>
                ) : (
                  <span style={{ fontSize: 10, color: 'var(--green, #22c55e)' }}>current</span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  dropdown: {
    position: 'absolute' as const,
    top: '100%',
    right: 0,
    minWidth: 140,
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    boxShadow: 'var(--shadow-md)',
    zIndex: 200,
    padding: 4,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 8px',
    fontSize: 12,
    color: 'var(--text-2)',
  },
};
