import { useState, useEffect } from 'react';
import { Topbar } from './components/Topbar';
import { KanbanBoard } from './components/KanbanBoard';
import { Gate } from './components/Gate';
import { useWebSocket } from './hooks/useWebSocket';
import type { WsEvent, WsGateOpen, WsBudgetGate } from './types';

export default function App() {
  const { connectionStatus, sessionState, lastEvent } = useWebSocket();
  const [events, setEvents] = useState<WsEvent[]>([]);
  const [currentGate, setCurrentGate] = useState<WsGateOpen | null>(null);
  const [gateVisible, setGateVisible] = useState(false);
  const [budgetGate, setBudgetGate] = useState<WsBudgetGate | null>(null);
  const [newCapInput, setNewCapInput] = useState('');

  // Accumulate events; reset to just the snapshot on reconnect (H-8)
  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.type === 'state:snapshot') {
      setEvents([lastEvent]);  // reset on reconnect — don't mix stale pre-disconnect events
    } else {
      setEvents((prev) => [...prev, lastEvent]);
    }

    if (lastEvent.type === 'gate:open') {
      setCurrentGate(lastEvent);
      setGateVisible(true);
    } else if (lastEvent.type === 'budget:gate') {
      const suggested = (lastEvent.current_spend_usd + lastEvent.projected_cost_usd * 2).toFixed(2);
      setNewCapInput(suggested);
      setBudgetGate(lastEvent);
    }
  }, [lastEvent]);

  const handleRetry = async (_phase: number, agent: string, errorKey?: string) => {
    try {
      await fetch('/agent/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: errorKey ?? agent }),
      });
    } catch (e) {
      console.error('Retry failed:', e);
    }
  };

  const handleSkip = async (_phase: number, agent: string, errorKey?: string) => {
    try {
      await fetch('/agent/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: errorKey ?? agent }),
      });
    } catch (e) {
      console.error('Skip failed:', e);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Topbar
        sessionState={sessionState}
        connectionStatus={connectionStatus}
        onFocusGate={() => setGateVisible(true)}
        hasPendingGate={currentGate !== null && !gateVisible}
      />

      <KanbanBoard
        sessionState={sessionState}
        events={events}
        onRetry={handleRetry}
        onSkip={handleSkip}
      />

      {gateVisible && currentGate && (
        <Gate
          gate={currentGate}
          onClose={() => {
            setGateVisible(false);
            setCurrentGate(null);
          }}
        />
      )}

      {budgetGate && (
        <div style={budgetGateStyles.overlay}>
          <div style={budgetGateStyles.modal}>
            <div style={budgetGateStyles.title}>Budget Gate</div>
            <div style={budgetGateStyles.body}>
              <p style={{ margin: '0 0 12px' }}>
                Agent <strong>{budgetGate.blocked_agent}</strong> is blocked — projected cost exceeds your remaining budget.
              </p>
              <div style={budgetGateStyles.row}>
                <span>Projected cost</span>
                <span>${budgetGate.projected_cost_usd.toFixed(4)}</span>
              </div>
              <div style={budgetGateStyles.row}>
                <span>Remaining budget</span>
                <span>${budgetGate.remaining_budget_usd.toFixed(4)}</span>
              </div>
              <div style={budgetGateStyles.row}>
                <span>Total spent so far</span>
                <span>${budgetGate.current_spend_usd.toFixed(4)}</span>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#8b949e', marginBottom: 4 }}>
                New spend cap ($)
              </label>
              <input
                type="number"
                min={budgetGate.current_spend_usd + budgetGate.projected_cost_usd}
                step="0.01"
                value={newCapInput}
                onChange={(e) => setNewCapInput(e.target.value)}
                style={budgetGateStyles.capInput}
              />
            </div>
            <div style={budgetGateStyles.actions}>
              <button
                style={budgetGateStyles.continueBtn}
                onClick={async () => {
                  const cap = parseFloat(newCapInput);
                  if (isNaN(cap) || cap <= 0) return;
                  try {
                    await fetch('/budget/update', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ new_cap: cap }),
                    });
                  } catch { /* best-effort */ }
                  setBudgetGate(null);
                }}
              >
                Allow &amp; continue
              </button>
              <button
                style={budgetGateStyles.stopBtn}
                onClick={async () => {
                  try {
                    await fetch('/budget/abort', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                    });
                  } catch { /* best-effort */ }
                  setBudgetGate(null);
                }}
              >
                Stop pipeline
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const budgetGateStyles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 400,
  },
  modal: {
    background: '#161b22',
    border: '1px solid #d29922',
    borderRadius: 8,
    padding: 24,
    width: 380,
    color: '#e6edf3',
  },
  title: {
    fontWeight: 700,
    fontSize: 15,
    color: '#d29922',
    marginBottom: 16,
  },
  body: {
    fontSize: 13,
    lineHeight: 1.6,
    marginBottom: 16,
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 12,
    color: '#8b949e',
    padding: '3px 0',
  },
  actions: {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
  },
  continueBtn: {
    background: '#1a2e1a',
    border: '1px solid #3fb950',
    color: '#3fb950',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
  },
  capInput: {
    width: '100%',
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 6,
    color: '#e6edf3',
    padding: '6px 10px',
    fontSize: 13,
    boxSizing: 'border-box' as const,
  },
  stopBtn: {
    background: '#3b1219',
    border: '1px solid #f85149',
    color: '#f85149',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
  },
};
