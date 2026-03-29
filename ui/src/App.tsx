import { useState, useEffect } from 'react';
import { Topbar } from './components/Topbar';
import { KanbanBoard } from './components/KanbanBoard';
import { Gate } from './components/Gate';
import { useWebSocket } from './hooks/useWebSocket';
import type { WsEvent, WsGateOpen } from './types';

export default function App() {
  const { connectionStatus, sessionState, lastEvent } = useWebSocket();
  const [events, setEvents] = useState<WsEvent[]>([]);
  const [currentGate, setCurrentGate] = useState<WsGateOpen | null>(null);
  const [gateVisible, setGateVisible] = useState(false);

  // Accumulate all events
  useEffect(() => {
    if (!lastEvent) return;
    setEvents((prev) => [...prev, lastEvent]);

    if (lastEvent.type === 'gate:open' || lastEvent.type === 'budget:gate') {
      if (lastEvent.type === 'gate:open') {
        setCurrentGate(lastEvent);
        setGateVisible(true);
      }
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
    </div>
  );
}
