'use client';

import { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';
import type { WalletEvent, WalletEventType, WorkspaceEvent, WorkspaceEventType, ThemeEvent, ThemeEventType } from '@/lib/events';

type AnyEvent = WalletEvent | WorkspaceEvent | ThemeEvent;
type AnyEventType = WalletEventType | WorkspaceEventType | ThemeEventType | '*';
type EventCallback = (event: AnyEvent) => void;

interface WebSocketContextValue {
  connected: boolean;
  reconnected: boolean;
  dismissReconnected: () => void;
  subscribe: (eventType: AnyEventType, callback: EventCallback) => () => void;
  send: (event: WorkspaceEvent | ThemeEvent) => void;
  lastEvent: AnyEvent | null;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

// Reconnection settings
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const RECONNECT_MULTIPLIER = 1.5;

interface WebSocketProviderProps {
  children: ReactNode;
  url?: string;
  token?: string | null;  // Auth token for workspace mutations
}

export function WebSocketProvider({
  children,
  url = typeof window !== 'undefined'
    ? ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
      // Force IPv4 loopback in local dev to avoid localhost/::1 resolution failures.
      ? `ws://127.0.0.1:${parseInt(window.location.port || '4747', 10) + 1}`
      : `wss://wallet-ws.${window.location.hostname.split('.').slice(1).join('.')}`
    : `ws://127.0.0.1:${parseInt(process.env.DASHBOARD_PORT || '4747', 10) + 1}`,
  token,
}: WebSocketProviderProps) {
  const [connected, setConnected] = useState(false);
  const [reconnected, setReconnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<AnyEvent | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const subscribersRef = useRef<Map<string, Set<EventCallback>>>(new Map());
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  // Track whether we've had a successful connection before (to distinguish reconnect from first connect)
  const hasConnectedRef = useRef(false);
  // Track whether we were disconnected (to detect reconnection vs token-change reconnect)
  const wasDisconnectedRef = useRef(false);

  // Use refs to avoid stale closures in callbacks
  const urlRef = useRef(url);
  const tokenRef = useRef(token);

  // Track connection version to ignore stale onclose handlers
  const connectionVersionRef = useRef(0);

  // Update refs when props change
  useEffect(() => {
    urlRef.current = url;
  }, [url]);

  // Send a message to the WebSocket server
  const send = useCallback((event: WorkspaceEvent | ThemeEvent) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event));
    }
    // Silently drop messages when not connected - this can happen during reconnection
  }, []);

  // Subscribe to events
  const subscribe = useCallback((eventType: AnyEventType, callback: EventCallback) => {
    if (!subscribersRef.current.has(eventType)) {
      subscribersRef.current.set(eventType, new Set());
    }
    subscribersRef.current.get(eventType)!.add(callback);

    // Return unsubscribe function
    return () => {
      const subscribers = subscribersRef.current.get(eventType);
      if (subscribers) {
        subscribers.delete(callback);
        if (subscribers.size === 0) {
          subscribersRef.current.delete(eventType);
        }
      }
    };
  }, []);

  // Notify subscribers of an event
  const notifySubscribers = useCallback((event: AnyEvent) => {
    // Notify specific event type subscribers
    const typeSubscribers = subscribersRef.current.get(event.type);
    if (typeSubscribers) {
      typeSubscribers.forEach((callback) => callback(event));
    }

    // Notify wildcard subscribers
    const wildcardSubscribers = subscribersRef.current.get('*');
    if (wildcardSubscribers) {
      wildcardSubscribers.forEach((callback) => callback(event));
    }
  }, []);

  // Connect to WebSocket - stable function that reads from refs
  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Close existing connection if any
    if (wsRef.current) {
      const state = wsRef.current.readyState;
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
        wsRef.current.close();
        wsRef.current = null;
      }
    }

    // Increment version to ignore stale onclose handlers
    connectionVersionRef.current += 1;
    const thisVersion = connectionVersionRef.current;

    // Get current values from refs
    const currentUrl = urlRef.current;
    const currentToken = tokenRef.current;

    try {
      const ws = new WebSocket(currentUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current || connectionVersionRef.current !== thisVersion) return;
        // Send auth token as first message (instead of URL query param)
        if (currentToken) {
          ws.send(JSON.stringify({ type: 'auth', token: currentToken }));
        }
        // Detect reconnection after a disconnect (server restart)
        if (hasConnectedRef.current && wasDisconnectedRef.current) {
          setReconnected(true);
        }
        hasConnectedRef.current = true;
        wasDisconnectedRef.current = false;
        setConnected(true);
        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY;
      };

      ws.onmessage = (messageEvent) => {
        if (!mountedRef.current) return;
        try {
          const event = JSON.parse(messageEvent.data) as AnyEvent;

          // Skip connection confirmation messages
          if ((event as { type: string }).type === 'connected') {
            return;
          }

          setLastEvent(event);
          notifySubscribers(event);
        } catch (err) {
          console.error('[WS] Failed to parse message:', err);
        }
      };

      ws.onclose = () => {
        // Ignore if this is a stale connection
        if (connectionVersionRef.current !== thisVersion) return;
        if (!mountedRef.current) return;

        wasDisconnectedRef.current = true;
        setConnected(false);
        wsRef.current = null;

        // Schedule reconnect with exponential backoff
        const delay = reconnectDelayRef.current;
        reconnectDelayRef.current = Math.min(
          delay * RECONNECT_MULTIPLIER,
          MAX_RECONNECT_DELAY
        );

        reconnectTimeoutRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // Browser WebSocket error events are opaque (`{}`); onclose handles retry.
      };
    } catch (err) {
      console.error('[WS] Failed to connect:', err);
      // Schedule reconnect
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(
        delay * RECONNECT_MULTIPLIER,
        MAX_RECONNECT_DELAY
      );
      reconnectTimeoutRef.current = setTimeout(connect, delay);
    }
  }, [notifySubscribers]); // Stable - only depends on stable notifySubscribers

  // Handle token changes - reconnect with new token
  useEffect(() => {
    const oldToken = tokenRef.current;
    tokenRef.current = token;

    // If token actually changed, reconnect (even if no active connection yet)
    if (oldToken !== token) {
      // Small delay to ensure initial connection attempt has started
      setTimeout(() => {
        if (mountedRef.current) {
          connect();
        }
      }, 100);
    }
  }, [token, connect]);

  // Connect on mount, cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    tokenRef.current = token;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount/unmount

  const dismissReconnected = useCallback(() => {
    setReconnected(false);
  }, []);

  const value: WebSocketContextValue = {
    connected,
    reconnected,
    dismissReconnected,
    subscribe,
    send,
    lastEvent,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket(): WebSocketContextValue {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
}
