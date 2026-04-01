import { useEffect, useMemo, useRef, useState } from 'react';
import type { WsEvent } from '../types';
import { CONDUCTOR_QUIPS } from '../constants';

interface ActivityLogProps {
  events: WsEvent[];
}

// §6.1 — CSS class mapping for event types
const EVENT_CLASS: Record<string, string> = {
  'agent:start': 'log-start',
  'agent:stream': 'log-stream',
  'agent:done': 'log-done',
  'agent:error': 'log-error',
  'agent:skipped': 'log-skipped',
  'gate:open': 'log-gate',
  'budget:gate': 'log-budget',
  'context:compressed': 'log-compress',
};

function describeEvent(event: WsEvent, elapsed?: string): string | null {
  switch (event.type) {
    case 'agent:start':
      return `Phase ${event.phase}  ${event.agent}  started  ·  ${event.model}`;
    case 'agent:stream':
      return `Phase ${event.phase}  ${event.agent}  ✍  ${event.section}${elapsed ? `  +${elapsed}` : ''}`;
    case 'agent:done':
      return `Phase ${event.phase}  ${event.agent}  done  ·  ${event.tokens_used.input.toLocaleString()} in / ${event.tokens_used.output.toLocaleString()} out  ·  $${event.cost_usd.toFixed(4)}${elapsed ? `  ${elapsed} total` : ''}`;
    case 'agent:error':
      return `Phase ${event.phase}  ${event.agent}  error  ·  ${event.message}`;
    case 'agent:skipped':
      return `Phase ${event.phase}  ${event.agent}  skipped`;
    case 'gate:open':
      return `Phase ${event.phase}  gate ${event.gate_number}  ·  ${event.findings.length} finding${event.findings.length !== 1 ? 's' : ''}  ·  next phase est. ${event.next_phase_cost_estimate}`;
    case 'budget:gate':
      return `Budget gate  ·  $${event.current_spend_usd.toFixed(2)} spent  ·  $${event.projected_cost_usd.toFixed(2)} projected for next agent`;
    case 'context:compressed':
      return `Phase ${event.phase}  ${event.agent}  context compressed  ·  ${event.artifact}  (${event.reason.replace(/_/g, ' ')})`;
    default:
      return null;
  }
}

interface ConductorQuip {
  text: string;
  timestamp: number;
}

export function ActivityLog({ events }: ActivityLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const logEvents = events.filter((e) => e.type !== 'state:snapshot');

  // §8.3 — Cost pace alerts: detect when projected total exceeds 80% of spend cap
  const costAlerts = useMemo(() => {
    const alerts: Array<{ afterIndex: number; text: string }> = [];
    const snapshot = events.find((e) => e.type === 'state:snapshot');
    const spendCap = snapshot?.type === 'state:snapshot' ? snapshot.state.config.spend_cap : null;
    if (!spendCap) return alerts;

    let totalCost = 0;
    const phasesCompleted = new Set<number>();
    const alerted = new Set<number>(); // one alert per phase

    for (let i = 0; i < logEvents.length; i++) {
      const ev = logEvents[i];
      if (ev.type === 'agent:done') {
        totalCost += ev.cost_usd;
        phasesCompleted.add(ev.phase);
        const completedCount = phasesCompleted.size;
        if (completedCount > 0) {
          const avgCostPerPhase = totalCost / completedCount;
          const projectedTotal = avgCostPerPhase * 5;
          if (projectedTotal > spendCap * 0.8 && !alerted.has(ev.phase)) {
            alerted.add(ev.phase);
            alerts.push({
              afterIndex: i,
              text: `Cost pace alert  ·  projected $${projectedTotal.toFixed(2)} exceeds 80% of $${spendCap.toFixed(2)} cap`,
            });
          }
        }
      }
    }
    return alerts;
  }, [events, logEvents]);

  // §6.2 — Track agent start timestamps for elapsed time
  const startTimestamps = useRef<Record<string, number>>({});

  // §6.4 — Conductor commentary timer
  const [quips, setQuips] = useState<ConductorQuip[]>([]);
  const lastStreamTime = useRef<number>(Date.now());
  const quipTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const quipThresholds = useRef<Set<number>>(new Set());

  // Update start timestamps from events
  useEffect(() => {
    for (const event of logEvents) {
      const key = 'phase' in event ? `${event.phase}:${(event as { agent?: string }).agent}` : '';
      if (event.type === 'agent:start') {
        startTimestamps.current[key] = Date.now();
        lastStreamTime.current = Date.now();
        quipThresholds.current.clear();
      } else if (event.type === 'agent:stream') {
        lastStreamTime.current = Date.now();
      }
    }
  }, [logEvents]);

  // Conductor quip timer
  useEffect(() => {
    quipTimerRef.current = setInterval(() => {
      const elapsed = (Date.now() - lastStreamTime.current) / 1000;
      const thresholds = [30, 60, 120];
      for (const threshold of thresholds) {
        if (elapsed >= threshold && !quipThresholds.current.has(threshold)) {
          quipThresholds.current.add(threshold);
          const lastEvent = logEvents[logEvents.length - 1];
          const role = lastEvent && 'agent' in lastEvent ? (lastEvent as { agent: string }).agent : 'default';
          const roleQuips = CONDUCTOR_QUIPS[role] ?? CONDUCTOR_QUIPS.default;
          const quipText = roleQuips[Math.floor(Math.random() * roleQuips.length)];
          setQuips(prev => [...prev, { text: quipText, timestamp: Date.now() }]);
        }
      }
    }, 5000);
    return () => { if (quipTimerRef.current) clearInterval(quipTimerRef.current); };
  }, [logEvents]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, quips]);

  // §6.2 — compute elapsed for an event
  const getElapsed = (event: WsEvent): string | undefined => {
    if (!('phase' in event && 'agent' in event)) return undefined;
    const key = `${event.phase}:${(event as { agent: string }).agent}`;
    const startTime = startTimestamps.current[key];
    if (!startTime) return undefined;
    const sec = Math.round((Date.now() - startTime) / 1000);
    return `${sec}s`;
  };

  // §6.3 — detect phase transitions for separator rows
  let lastPhase: number | null = null;

  return (
    <div className="log-panel">
      <div className="log-header">Activity</div>
      <div ref={scrollRef} className="log-items">
        {logEvents.length === 0 ? (
          <span className="log-row log-stream">Waiting for agents to start…</span>
        ) : (
          <>
            {logEvents.map((event, i) => {
              const text = describeEvent(event, event.type === 'agent:stream' || event.type === 'agent:done' ? getElapsed(event) : undefined);
              if (!text) return null;

              const cls = EVENT_CLASS[event.type] ?? '';
              const phaseNum = 'phase' in event ? (event as { phase: number }).phase : null;

              // §6.3 — phase separator
              let separator = null;
              if (phaseNum !== null && phaseNum !== lastPhase && event.type === 'agent:start') {
                separator = (
                  <div key={`sep-${i}`} className="log-row log-phase-step">
                    ── Phase {phaseNum} ──
                  </div>
                );
                lastPhase = phaseNum;
              }

              // §8.3 — cost pace alert after this event
              const alert = costAlerts.find((a) => a.afterIndex === i);

              return (
                <>
                  {separator}
                  <div key={i} className={`log-row ${cls}`}>{text}</div>
                  {alert && <div key={`cost-${i}`} className="log-row log-cost-alert">{alert.text}</div>}
                </>
              );
            })}
            {/* §6.4 — conductor quips */}
            {quips.map((q, i) => (
              <div key={`quip-${i}`} className="log-row log-conductor">{q.text}</div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
