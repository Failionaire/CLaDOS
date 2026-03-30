import { useEffect, useRef } from 'react';
import type { WsEvent } from '../types';

interface ActivityLogProps {
  events: WsEvent[];
}

function describeEvent(event: WsEvent): string | null {
  switch (event.type) {
    case 'agent:start':
      return `Phase ${event.phase}  ${event.agent}  started  ·  ${event.model}`;
    case 'agent:stream':
      return `Phase ${event.phase}  ${event.agent}  ✍  ${event.section}`;
    case 'agent:done':
      return `Phase ${event.phase}  ${event.agent}  done  ·  ${event.tokens_used.input.toLocaleString()} in / ${event.tokens_used.output.toLocaleString()} out  ·  $${event.cost_usd.toFixed(4)}`;
    case 'agent:error':
      return `Phase ${event.phase}  ${event.agent}  error  ·  ${event.message}`;
    case 'agent:skipped':
      return `Phase ${event.phase}  ${event.agent}  skipped`;
    case 'gate:open':
      return `Phase ${event.phase}  gate ${event.gate_number}  ·  ${event.findings.length} finding${event.findings.length !== 1 ? 's' : ''}  ·  next phase est. ${event.next_phase_cost_estimate}`;
    case 'budget:gate':
      return `Budget gate  ·  $${event.current_spend_usd.toFixed(2)} spent  ·  $${event.projected_cost_usd.toFixed(2)} projected for next agent`;
    default:
      return null;
  }
}

function eventColor(event: WsEvent): string {
  switch (event.type) {
    case 'agent:start':   return '#58a6ff';
    case 'agent:stream':  return '#6e7681';
    case 'agent:done':    return '#3fb950';
    case 'agent:error':   return '#f85149';
    case 'agent:skipped': return '#484f58';
    case 'gate:open':     return '#d29922';
    case 'budget:gate':   return '#f85149';
    default:              return '#6e7681';
  }
}

export function ActivityLog({ events }: ActivityLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const logEvents = events.filter((e) => e.type !== 'state:snapshot');

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <div style={styles.container}>
      <div style={styles.label}>Activity</div>
      <div ref={scrollRef} style={styles.log}>
        {logEvents.length === 0 ? (
          <span style={styles.empty}>Waiting for agents to start…</span>
        ) : (
          logEvents.map((event, i) => {
            const text = describeEvent(event);
            if (!text) return null;
            return (
              <div key={i} style={{ ...styles.line, color: eventColor(event) }}>
                {text}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    position: 'fixed' as const,
    bottom: 0,
    left: 0,
    right: 0,
    height: 120,
    background: '#0d1117',
    borderTop: '1px solid #21262d',
    display: 'flex',
    flexDirection: 'column' as const,
    zIndex: 100,
  },
  label: {
    padding: '3px 14px',
    fontSize: 10,
    color: '#484f58',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
    borderBottom: '1px solid #161b22',
    flexShrink: 0,
  },
  log: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '4px 14px 6px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 1,
  },
  line: {
    fontSize: 12,
    fontFamily: '"SF Mono", "Fira Code", "Consolas", monospace',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    lineHeight: '1.6',
    flexShrink: 0,
  },
  empty: {
    fontSize: 12,
    color: '#484f58',
    fontFamily: 'monospace',
    lineHeight: '1.6',
  },
};
