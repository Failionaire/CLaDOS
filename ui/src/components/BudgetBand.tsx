import React, { useState } from 'react';
import type { SessionState, WsBudgetGate } from '../types';

interface BudgetBandProps {
  sessionState: SessionState | null;
  budgetGate: WsBudgetGate | null;
  onRaiseCap: (newCap: number) => void;
  onAbort: () => void;
  onDismissGate: () => void;
}

export function BudgetBand({ sessionState, budgetGate, onRaiseCap, onAbort, onDismissGate }: BudgetBandProps) {
  const [expanded, setExpanded] = useState(false);
  const [capInput, setCapInput] = useState('');

  if (!sessionState) return null;
  const { config, total_cost_usd } = sessionState;
  const cap = config.spend_cap;
  if (cap === null) return null;

  const pct = Math.min((total_cost_usd / cap) * 100, 100);
  const remaining = cap - total_cost_usd;
  const isWarning = pct >= 80;
  const isBlocked = budgetGate !== null;

  // Set suggested cap when budget gate opens
  React.useEffect(() => {
    if (budgetGate) {
      const suggested = (budgetGate.current_spend_usd + budgetGate.projected_cost_usd * 2).toFixed(2);
      setCapInput(suggested);
      setExpanded(true);
    }
  }, [budgetGate]);

  const barColor = isBlocked ? 'var(--red)' : isWarning ? 'var(--amber)' : 'var(--green, #22c55e)';

  return (
    <div style={styles.wrapper} className={isBlocked ? 'budget-blocked' : ''}>
      {/* Collapsed bar */}
      <div
        style={styles.bar}
        onClick={() => setExpanded(v => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && setExpanded(v => !v)}
      >
        <span style={{ fontSize: 11, color: 'var(--text-3)', minWidth: 52 }}>
          ${total_cost_usd.toFixed(2)}
        </span>
        <div style={styles.track}>
          <div style={{ ...styles.fill, width: `${pct}%`, background: barColor }} />
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-3)', minWidth: 52, textAlign: 'right' }}>
          ${cap.toFixed(2)}
        </span>
        {isBlocked && (
          <span className="chip" style={{ background: 'var(--red)', color: '#fff', fontSize: 10, marginLeft: 6 }}>
            BLOCKED
          </span>
        )}
        <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 4 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={styles.details}>
          <div style={styles.row}>
            <span>Spent</span>
            <span>${total_cost_usd.toFixed(4)}</span>
          </div>
          <div style={styles.row}>
            <span>Remaining</span>
            <span>${remaining.toFixed(4)}</span>
          </div>
          <div style={styles.row}>
            <span>Cap</span>
            <span>${cap.toFixed(2)}</span>
          </div>

          {isBlocked && budgetGate && (
            <>
              <div style={{ ...styles.row, color: 'var(--red)', fontWeight: 500, marginTop: 8 }}>
                <span>{budgetGate.blocked_agent} blocked</span>
                <span>needs ${budgetGate.projected_cost_usd.toFixed(4)}</span>
              </div>

              <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
                <label style={{ fontSize: 11, color: 'var(--text-3)' }}>New cap $</label>
                <input
                  type="number"
                  min={total_cost_usd + budgetGate.projected_cost_usd}
                  step="0.01"
                  value={capInput}
                  onChange={e => setCapInput(e.target.value)}
                  style={styles.input}
                />
              </div>

              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    const val = parseFloat(capInput);
                    if (isNaN(val) || val <= 0) return;
                    onRaiseCap(val);
                    onDismissGate();
                  }}
                >
                  Raise &amp; continue
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => {
                    onAbort();
                    onDismissGate();
                  }}
                >
                  Stop pipeline
                </button>
              </div>
            </>
          )}

          {/* Optional agent toggles */}
          <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>Optional agents</div>
            <ToggleRow label="Security" enabled={config.security_enabled} field="security_enabled" />
            <ToggleRow label="Wrecker" enabled={config.wrecker_enabled} field="wrecker_enabled" />
            {config.refiner_enabled !== undefined && (
              <ToggleRow label="Refiner" enabled={config.refiner_enabled} field="refiner_enabled" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ToggleRow({ label, enabled, field }: { label: string; enabled: boolean; field: string }) {
  const toggle = async () => {
    try {
      await fetch('/config/toggle-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, enabled: !enabled }),
      });
    } catch { /* best-effort */ }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 0' }}>
      <span style={{ fontSize: 12 }}>{label}</span>
      <button
        className={`btn btn-ghost btn-sm`}
        style={{ fontSize: 11, color: enabled ? 'var(--green, #22c55e)' : 'var(--text-3)' }}
        onClick={toggle}
      >
        {enabled ? 'ON' : 'OFF'}
      </button>
    </div>
  );
}

const styles = {
  wrapper: {
    margin: '0 16px 8px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 4,
  } as React.CSSProperties,
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    cursor: 'pointer',
  } as React.CSSProperties,
  track: {
    flex: 1,
    height: 6,
    background: 'var(--surface-2, #333)',
    borderRadius: 3,
    overflow: 'hidden',
  } as React.CSSProperties,
  fill: {
    height: '100%',
    borderRadius: 3,
    transition: 'width 0.3s ease',
  } as React.CSSProperties,
  details: {
    padding: '0 12px 10px',
    borderTop: '1px solid var(--border)',
  } as React.CSSProperties,
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 12,
    padding: '3px 0',
    color: 'var(--text-2)',
  } as React.CSSProperties,
  input: {
    width: 80,
    padding: '3px 6px',
    fontSize: 12,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    borderRadius: 3,
  } as React.CSSProperties,
};
