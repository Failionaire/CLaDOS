import { useEffect, useRef, useState, useCallback } from 'react';
import type { WsEvent, SessionState } from '../types';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnected' | 'disconnected' | 'failed';

interface UseWebSocketReturn {
  connectionStatus: ConnectionStatus;
  sessionState: SessionState | null;
  lastEvent: WsEvent | null;
}

const RECONNECT_INTERVAL_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 5;

export function useWebSocket(): UseWebSocketReturn {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [lastEvent, setLastEvent] = useState<WsEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);
  const reconnectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadConnectionRef = useRef(false);
  const failCountRef = useRef(0);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (unmountedRef.current) { ws.close(); return; }
      const wasDisconnected = hadConnectionRef.current;
      failCountRef.current = 0;
      hadConnectionRef.current = true;
      if (wasDisconnected) {
        setConnectionStatus('reconnected');
        reconnectedTimerRef.current = setTimeout(() => {
          if (!unmountedRef.current) setConnectionStatus('connected');
        }, 3000);
      } else {
        setConnectionStatus('connected');
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (unmountedRef.current) return;
      let parsed: WsEvent;
      try {
        parsed = JSON.parse(event.data as string) as WsEvent;
      } catch {
        return;
      }

      setLastEvent(parsed);

      if (parsed.type === 'state:snapshot') {
        setSessionState(parsed.state);
      } else if (parsed.type === 'agent:start') {
        // Incrementally advance current_phase and pipeline_status so the topbar
        // updates without waiting for the next full state:snapshot.
        setSessionState((prev) => {
          if (!prev) return prev;
          const newPhase = Math.max(prev.current_phase, parsed.phase);
          // When advancing to a new phase, mark all prior phases as completed.
          const newPhasesCompleted =
            newPhase > prev.current_phase
              ? [...new Set([...prev.phases_completed, ...Array.from({ length: newPhase }, (_, i) => i)])]
              : prev.phases_completed;
          return {
            ...prev,
            pipeline_status: 'agent_running',
            current_phase: newPhase,
            phases_completed: newPhasesCompleted,
          };
        });
      } else if (parsed.type === 'agent:done') {
        // Incrementally update running cost, per-agent token tallies, and artifact list
        // so the topbar cost chip and the Files sidebar stay live without a full re-sync.
        setSessionState((prev) => {
          if (!prev) return prev;
          const phaseKey = String(parsed.phase);
          const prevRecord = prev.agent_tokens_used[phaseKey]?.[parsed.agent];
          const newRecord = {
            input: (prevRecord?.input ?? 0) + parsed.tokens_used.input,
            output: (prevRecord?.output ?? 0) + parsed.tokens_used.output,
            cost_usd: (prevRecord?.cost_usd ?? 0) + parsed.cost_usd,
          };
          // Only register artifacts whose path lives inside .clados/ — the sidebar
          // only serves those paths and the key in sessionState.artifacts is relative
          // to .clados/ (without the prefix).
          let newArtifacts = prev.artifacts;
          const artPath = parsed.artifact;
          if (artPath.startsWith('.clados/') || artPath.startsWith('.clados\\')) {
            const artKey = artPath.substring(8).replace(/\\/g, '/');
            if (!prev.artifacts[artKey]) {
              newArtifacts = {
                ...prev.artifacts,
                [artKey]: { path: artPath, token_count: 0, version: 1 },
              };
            }
          }
          return {
            ...prev,
            total_cost_usd: Math.round((prev.total_cost_usd + parsed.cost_usd) * 1_000_000) / 1_000_000,
            agent_tokens_used: {
              ...prev.agent_tokens_used,
              [phaseKey]: {
                ...(prev.agent_tokens_used[phaseKey] ?? {}),
                [parsed.agent]: newRecord,
              },
            },
            artifacts: newArtifacts,
          };
        });
      } else if (parsed.type === 'gate:open') {
        // Mark pipeline as waiting so the topbar status updates immediately.
        setSessionState((prev) => {
          if (!prev) return prev;
          return { ...prev, pipeline_status: 'gate_pending' };
        });
      }
    };

    ws.onclose = () => {
      if (unmountedRef.current) return;
      failCountRef.current += 1;
      if (failCountRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setConnectionStatus('failed');
        return;
      }
      setConnectionStatus('disconnected');
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_INTERVAL_MS);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (reconnectedTimerRef.current) clearTimeout(reconnectedTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { connectionStatus, sessionState, lastEvent };
}
