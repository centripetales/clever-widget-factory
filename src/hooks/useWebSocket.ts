import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

// --- Types ---

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

type MessageHandler = (payload: any) => void;

interface WebSocketMessage {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface UseWebSocketReturn {
  status: ConnectionStatus;
  sendMessage: (type: string, payload: Record<string, unknown>) => boolean;
  subscribe: (type: string, handler: MessageHandler) => () => void;
  connectionId: string | null;
}

// --- Singleton state (shared across all hook consumers) ---

let singletonWs: WebSocket | null = null;
let singletonStatus: ConnectionStatus = 'disconnected';
let singletonConnectionId: string | null = null;
let singletonConnecting = false;

// Subscribers: Map<messageType, Set<handler>>
const subscribers = new Map<string, Set<MessageHandler>>();

// Status change listeners (one per hook instance)
const statusListeners = new Set<(status: ConnectionStatus) => void>();
const connectionIdListeners = new Set<(id: string | null) => void>();

// Reconnect state
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

// Teardown debounce state
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

// Keepalive ping state
const PING_INTERVAL_MS = 30 * 1000; // 30 seconds
const PONG_TIMEOUT_MS = 10 * 1000; // 10 seconds
let pingIntervalTimer: ReturnType<typeof setInterval> | null = null;
let pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

// --- Helpers ---

function setStatus(status: ConnectionStatus) {
  singletonStatus = status;
  statusListeners.forEach((listener) => listener(status));
}

function setConnectionId(id: string | null) {
  singletonConnectionId = id;
  connectionIdListeners.forEach((listener) => listener(id));
}

function sendPing() {
  if (!singletonWs || singletonWs.readyState !== WebSocket.OPEN) return;

  const message: WebSocketMessage = {
    type: 'ping',
    payload: {},
    timestamp: new Date().toISOString(),
  };
  singletonWs.send(JSON.stringify(message));

  // Set a timeout — if no pong received within PONG_TIMEOUT_MS, close and reconnect
  if (pongTimeoutTimer) clearTimeout(pongTimeoutTimer);
  pongTimeoutTimer = setTimeout(() => {
    console.warn('[useWebSocket] Pong timeout — closing connection to trigger reconnect');
    pongTimeoutTimer = null;
    if (singletonWs) {
      singletonWs.close();
    }
  }, PONG_TIMEOUT_MS);
}

function startPingInterval() {
  stopPingInterval();
  pingIntervalTimer = setInterval(sendPing, PING_INTERVAL_MS);
}

function stopPingInterval() {
  if (pingIntervalTimer) {
    clearInterval(pingIntervalTimer);
    pingIntervalTimer = null;
  }
  if (pongTimeoutTimer) {
    clearTimeout(pongTimeoutTimer);
    pongTimeoutTimer = null;
  }
}

function routeMessage(data: string) {
  try {
    const message = JSON.parse(data);
    const { type, payload } = message;

    if (!type) return;

    // Handle pong internally — clear the pong timeout
    if (type === 'pong') {
      if (pongTimeoutTimer) {
        clearTimeout(pongTimeoutTimer);
        pongTimeoutTimer = null;
      }
    }

    // If the server sends a connection_id, capture it
    if (type === 'connection' && payload?.connectionId) {
      setConnectionId(payload.connectionId as string);
    }

    const handlers = subscribers.get(type);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(payload);
        } catch (err) {
          console.error(`[useWebSocket] Error in subscriber for "${type}":`, err);
        }
      });
    }
  } catch {
    console.warn('[useWebSocket] Received non-JSON message, ignoring');
  }
}

async function getJwtToken(forceRefresh = false): Promise<string | null> {
  try {
    const session = await fetchAuthSession({ forceRefresh });
    const idToken = session.tokens?.idToken;
    if (!idToken) return null;
    return typeof idToken === 'string' ? idToken : idToken.toString();
  } catch (error) {
    console.error('[useWebSocket] Failed to get JWT token:', error);
    return null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return; // already scheduled

  const delay = Math.min(Math.pow(2, reconnectAttempt) * 1000, 30000);
  reconnectAttempt++;
  setStatus('reconnecting');

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Force token refresh on reconnection — the token may have expired during disconnect
    connectWebSocket(true);
  }, delay);
}

function cleanupConnection() {
  stopPingInterval();

  if (singletonWs) {
    // Remove handlers before closing to avoid triggering onclose reconnect
    singletonWs.onopen = null;
    singletonWs.onclose = null;
    singletonWs.onerror = null;
    singletonWs.onmessage = null;

    if (singletonWs.readyState === WebSocket.OPEN || singletonWs.readyState === WebSocket.CONNECTING) {
      singletonWs.close();
    }
    singletonWs = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  singletonConnecting = false;
}

async function connectWebSocket(forceTokenRefresh = false) {
  // Guard against concurrent connection attempts
  if (singletonConnecting) return;
  if (singletonWs && singletonWs.readyState === WebSocket.OPEN) return;

  const wsUrl = import.meta.env.VITE_WS_API_URL;
  if (!wsUrl) {
    console.warn('[useWebSocket] VITE_WS_API_URL not configured, skipping WebSocket connection');
    setStatus('disconnected');
    return;
  }

  singletonConnecting = true;
  setStatus('connecting');

  const token = await getJwtToken(forceTokenRefresh);
  if (!token) {
    console.warn('[useWebSocket] No JWT token available, cannot connect');
    singletonConnecting = false;
    setStatus('disconnected');
    scheduleReconnect();
    return;
  }

  try {
    const ws = new WebSocket(`${wsUrl}?token=${token}`);
    singletonWs = ws;

    ws.onopen = () => {
      singletonConnecting = false;
      reconnectAttempt = 0;
      setStatus('connected');
      startPingInterval();
    };

    ws.onmessage = (event) => {
      routeMessage(event.data);
    };

    ws.onerror = (event) => {
      console.error('[useWebSocket] Connection error:', event);
    };

    ws.onclose = (event) => {
      singletonConnecting = false;
      singletonWs = null;
      setConnectionId(null);
      stopPingInterval();

      // Only reconnect if there are still active consumers (statusListeners)
      if (statusListeners.size > 0) {
        scheduleReconnect();
      } else {
        setStatus('disconnected');
      }
    };
  } catch (error) {
    console.error('[useWebSocket] Failed to create WebSocket:', error);
    singletonConnecting = false;
    singletonWs = null;
    setStatus('disconnected');
    scheduleReconnect();
  }
}

// --- Hook ---

/**
 * Returns the current WebSocket connection ID (if connected).
 * Can be called outside of React components (e.g. from apiService).
 */
export function getWebSocketConnectionId(): string | null {
  return singletonConnectionId;
}

export function useWebSocket(): UseWebSocketReturn {
  const [status, setLocalStatus] = useState<ConnectionStatus>(singletonStatus);
  const [connectionId, setLocalConnectionId] = useState<string | null>(singletonConnectionId);

  // Track whether this hook instance is mounted
  const mountedRef = useRef(true);

  // Register status and connectionId listeners, and initiate connection
  useEffect(() => {
    mountedRef.current = true;

    const statusHandler = (newStatus: ConnectionStatus) => {
      if (mountedRef.current) setLocalStatus(newStatus);
    };
    const connectionIdHandler = (id: string | null) => {
      if (mountedRef.current) setLocalConnectionId(id);
    };

    statusListeners.add(statusHandler);
    connectionIdListeners.add(connectionIdHandler);

    // Cancel any scheduled connection teardown from recent unmounts
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }

    // Sync with current singleton state
    setLocalStatus(singletonStatus);
    setLocalConnectionId(singletonConnectionId);

    // Initiate connection if not already connected/connecting
    if (!singletonWs && !singletonConnecting && !reconnectTimer) {
      connectWebSocket();
    }

    return () => {
      mountedRef.current = false;
      statusListeners.delete(statusHandler);
      connectionIdListeners.delete(connectionIdHandler);

      // If no more consumers, tear down the connection after a debounce delay
      if (statusListeners.size === 0) {
        if (cleanupTimer) clearTimeout(cleanupTimer);
        cleanupTimer = setTimeout(() => {
          cleanupTimer = null;
          if (statusListeners.size === 0) {
            cleanupConnection();
            setStatus('disconnected');
            setConnectionId(null);
            reconnectAttempt = 0;
          }
        }, 1000); // 1-second debounce delay to absorb React page transitions and remount thrashing
      }
    };
  }, []);

  const sendMessage = useCallback((type: string, payload: Record<string, unknown>): boolean => {
    if (!singletonWs || singletonWs.readyState !== WebSocket.OPEN) {
      console.warn('[useWebSocket] Cannot send message, WebSocket is not connected');
      return false;
    }

    const message: WebSocketMessage = {
      type,
      payload,
      timestamp: new Date().toISOString(),
    };

    singletonWs.send(JSON.stringify(message));
    return true;
  }, []);

  const subscribe = useCallback((type: string, handler: MessageHandler): (() => void) => {
    if (!subscribers.has(type)) {
      subscribers.set(type, new Set());
    }
    subscribers.get(type)!.add(handler);

    // Return unsubscribe function
    return () => {
      const handlers = subscribers.get(type);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          subscribers.delete(type);
        }
      }
    };
  }, []);

  return { status, sendMessage, subscribe, connectionId };
}
