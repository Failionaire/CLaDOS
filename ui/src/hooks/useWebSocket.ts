import { useEffect, useRef, useState, useCallback } from 'react';
import type { WsEvent, SessionState } from '../types';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'failed';

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
  const failCountRef = useRef(0);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (unmountedRef.current) { ws.close(); return; }
      failCountRef.current = 0;
      setConnectionStatus('connected');
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
      wsRef.current?.close();
    };
  }, [connect]);

  return { connectionStatus, sessionState, lastEvent };
}
