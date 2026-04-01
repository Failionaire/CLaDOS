import React, { useState, useEffect } from 'react';
import { Topbar } from './components/Topbar';
import { KanbanBoard } from './components/KanbanBoard';
import { Gate } from './components/Gate';
import { ActivityLog } from './components/ActivityLog';
import { HomeScreen } from './components/HomeScreen';
import { ArtifactSidebar } from './components/ArtifactSidebar';
import { useWebSocket } from './hooks/useWebSocket';
import type { WsEvent, WsGateOpen, WsBudgetGate } from './types';

export default function App() {
  const { connectionStatus, sessionState, lastEvent } = useWebSocket();
  const [events, setEvents] = useState<WsEvent[]>([]);
  const [currentGate, setCurrentGate] = useState<WsGateOpen | null>(null);
  const [gateVisible, setGateVisible] = useState(false);
  const [budgetGate, setBudgetGate] = useState<WsBudgetGate | null>(null);
  const [newCapInput, setNewCapInput] = useState('');
  const [focusMode, setFocusMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Light/dark theme toggle (§7.5)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return (localStorage.getItem('clados:theme') as 'dark' | 'light') ?? 'dark'; } catch { return 'dark'; }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('clados:theme', theme); } catch {}
  }, [theme]);
  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');
  // Optimistic card state: set when gate is approved/revised so the board clears before WS events
  const [resolvedGate, setResolvedGate] = useState<{ phase: number; approved: boolean } | null>(null);

  // Accumulate events; reset to just the snapshot on reconnect (H-8)
  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.type === 'state:snapshot') {
      setEvents([lastEvent]);  // reset on reconnect — don't mix stale pre-disconnect events
      
      // Clear gates if they are no longer pending in the state snapshot
      if (lastEvent.state.pipeline_status !== 'gate_pending') {
        setCurrentGate(null);
        setGateVisible(false);
      }
      if (lastEvent.state.pipeline_status !== 'budget_gate_pending') {
        setBudgetGate(null);
      }
    } else {
      setEvents((prev) => [...prev, lastEvent]);
    }

    if (lastEvent.type === 'gate:open') {
      setCurrentGate(lastEvent);
      // We no longer automatically pop the gate open to avoid interrupting the user.
      // The user must click the "Gate X ↑" button in the Topbar to open it.
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

  // Show home screen when connected but no project is loaded yet
  const showHome = connectionStatus === 'connected' && sessionState === null;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingTop: '62px' }}>
      <Topbar
        sessionState={sessionState}
        connectionStatus={connectionStatus}
        onFocusGate={() => setGateVisible(true)}
        hasPendingGate={currentGate !== null && !gateVisible}
        gateNumber={currentGate?.gate_number}
        focusMode={focusMode}
        onToggleFocus={() => setFocusMode((v) => !v)}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        sidebarOpen={sidebarOpen}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <KanbanBoard
        sessionState={sessionState}
        events={events}
        onRetry={handleRetry}
        onSkip={handleSkip}
        focusMode={focusMode}
        resolvedGate={resolvedGate}
        onOpenGate={() => {
          if (currentGate) setGateVisible(true);
        }}
      />

      {/* Minimized gate bar — shows below the board when gate is pending but modal is hidden */}
      {!gateVisible && currentGate && (
        <div
          className="gate-minimized-bar"
          style={minimizedBarStyles.bar}
          onClick={() => setGateVisible(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setGateVisible(true)}
        >
          <span className="dot" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)', flexShrink: 0, animation: 'pulse-dot 1s ease-in-out infinite' }} />
          <div style={minimizedBarStyles.label}>
            Gate {currentGate.gate_number} — awaiting review
          </div>
          <div style={minimizedBarStyles.sub}>
            Revision {currentGate.revision_count ?? 0} of 3
            {currentGate.next_phase_cost_estimate && ` · next phase ${currentGate.next_phase_cost_estimate}`}
          </div>
          <span className="chip chip-muted">↑ expand</span>
        </div>
      )}

      <ActivityLog events={events} />

      <ArtifactSidebar 
        isOpen={sidebarOpen} 
        onClose={() => setSidebarOpen(false)} 
        sessionState={sessionState} 
      />

      {showHome && <HomeScreen />}

      {gateVisible && currentGate && (
        <Gate
          gate={currentGate}
          onMinimize={() => setGateVisible(false)}
          onResolved={(phase, approved) => setResolvedGate({ phase, approved })}
          onClose={() => {
            setGateVisible(false);
            setCurrentGate(null);
          }}
        />
      )}

      {budgetGate && (
        <div style={budgetGateStyles.overlay}>
          <div className="confirm-panel" style={budgetGateStyles.modal}>
            <div className="hazard-bar amber" />
            <div style={budgetGateStyles.title}>Budget Gate</div>
            <div style={budgetGateStyles.body}>
              <p style={{ margin: '0 0 4px', fontStyle: 'italic', color: 'var(--text-3)', fontSize: 12 }}>
                Science isn't free. Neither is this.
              </p>
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
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>
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
                className="btn btn-primary"
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
                className="btn btn-danger"
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

const minimizedBarStyles = {
  bar: {
    margin: '0 16px 12px',
    padding: '9px 14px',
    background: 'var(--surface)',
    borderTop: '2px solid var(--amber)',
    border: '1px solid var(--amber-border)',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    cursor: 'pointer',
  } as React.CSSProperties,
  dot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: 'var(--amber)',
    flexShrink: 0,
  },
  label: {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--amber)',
    flex: 1,
  },
  sub: {
    fontSize: 11,
    color: 'var(--text-3)',
  },
  expandChip: {
    fontSize: 11,
    color: 'var(--text-3)',
    padding: '3px 8px',
    border: '1px solid var(--border)',
  },
};

const budgetGateStyles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'var(--overlay)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 400,
  },
  modal: {
    background: 'var(--panel)',
    border: '1px solid var(--amber-border)',
    padding: 24,
    width: 380,
    color: 'var(--text)',
  },
  title: {
    fontWeight: 700,
    fontSize: 15,
    color: 'var(--amber)',
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
    color: 'var(--text-3)',
    padding: '3px 0',
  },
  actions: {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
  },
  continueBtn: {
    background: 'var(--green-lo)',
    border: '1px solid var(--green-border)',
    color: 'var(--green)',
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
  },
  capInput: {
    width: '100%',
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    padding: '6px 10px',
    fontSize: 13,
    boxSizing: 'border-box' as const,
  },
  stopBtn: {
    background: 'var(--red-lo)',
    border: '1px solid var(--red-border)',
    color: 'var(--red)',
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
  },
};
