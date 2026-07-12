import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { WalletEvent, WorkspaceEvent, ThemeEvent } from './events';
import { WORKSPACE_EVENTS, THEME_EVENTS, APP_EVENTS } from './events';
import { handleWorkspaceMessage } from './workspace-handlers';
import { handleThemeMessage } from './theme-handlers';
import { validateToken, hasAnyPermission, TokenValidationResult } from './auth-client';
import { log as rootLog } from './pino';

const log = rootLog.child({ component: 'ws' });

// Singleton WebSocket server for Next.js
let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

// Heartbeat interval (30 seconds)
const HEARTBEAT_INTERVAL = 30000;
let heartbeatTimer: NodeJS.Timeout | null = null;

interface ExtendedWebSocket extends WebSocket {
  isAlive?: boolean;
  auth?: TokenValidationResult;  // Auth info for this connection
}

// Workspace mutation events that require workspace:modify permission
const WORKSPACE_MUTATION_EVENTS = [
  WORKSPACE_EVENTS.WORKSPACE_CREATED,
  WORKSPACE_EVENTS.WORKSPACE_DELETED,
  WORKSPACE_EVENTS.WORKSPACE_UPDATED,
  WORKSPACE_EVENTS.APP_ADDED,
  WORKSPACE_EVENTS.APP_REMOVED,
  WORKSPACE_EVENTS.APP_UPDATED,
];

/**
 * Check if client has permission to perform workspace mutations
 * Requires valid token with workspace:modify permission (or admin)
 */
function canModifyWorkspace(ws: ExtendedWebSocket): boolean {
  // No auth = deny (auth required for mutations)
  if (!ws.auth) return false;

  // Invalid token = deny
  if (!ws.auth.valid) return false;

  // Admin always allowed
  if (ws.auth.isAdmin) return true;

  // Check for workspace:modify permission
  return hasAnyPermission(ws.auth, ['workspace:modify']);
}

/**
 * Get or create the WebSocket server singleton
 */
export function getWebSocketServer(): WebSocketServer {
  if (!wss) {
    wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws: ExtendedWebSocket) => {
      ws.isAlive = true;
      clients.add(ws);

      log.debug({ clients: clients.size }, 'client connected');

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // Handle auth message — client sends token after connecting
          if (msg.type === 'auth' && typeof msg.token === 'string') {
            try {
              const result = await validateToken(msg.token);
              ws.auth = result;
              if (result.valid) {
                log.info({ agentId: result.payload?.agentId || 'admin' }, 'client authenticated');
              } else {
                log.warn({ error: result.error }, 'invalid token provided');
              }
              ws.send(JSON.stringify({ type: 'authenticated', valid: result.valid }));
            } catch (err) {
              log.error({ err }, 'token validation failed');
              ws.send(JSON.stringify({ type: 'authenticated', valid: false }));
            }
            return;
          }

          const workspaceEventTypes = Object.values(WORKSPACE_EVENTS);
          const themeEventTypes = Object.values(THEME_EVENTS);

          // Check if this is a workspace event
          if (workspaceEventTypes.includes(msg.type)) {
            // Check permissions for mutation events
            if (WORKSPACE_MUTATION_EVENTS.includes(msg.type)) {
              if (!canModifyWorkspace(ws)) {
                ws.send(JSON.stringify({
                  type: 'error',
                  error: 'Permission denied: workspace:modify required',
                  originalType: msg.type
                }));
                return;
              }
            }

            const response = await handleWorkspaceMessage(msg as WorkspaceEvent);

            // If there's a response (e.g., state:response), send it back to the requesting client
            if (response) {
              ws.send(JSON.stringify(response));
            }

            // For mutations, broadcast to all other clients
            if (WORKSPACE_MUTATION_EVENTS.includes(msg.type)) {
              broadcastExcept(msg, ws);
            }
          }
          // Check if this is a theme event
          else if (themeEventTypes.includes(msg.type)) {
            // Theme changes also require workspace:modify
            const themeMutations = [
              THEME_EVENTS.THEME_MODE_CHANGED,
              THEME_EVENTS.THEME_ACCENT_CHANGED,
              THEME_EVENTS.THEME_UPDATED,
              THEME_EVENTS.WORKSPACE_THEME_UPDATED
            ];

            if (themeMutations.includes(msg.type) && !canModifyWorkspace(ws)) {
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Permission denied: workspace:modify required',
                originalType: msg.type
              }));
              return;
            }

            const response = await handleThemeMessage(msg as ThemeEvent);

            // If there's a response (e.g., theme:response), send it back to the requesting client
            if (response) {
              ws.send(JSON.stringify(response));
            }

            // For mutations, broadcast to all other clients
            if (themeMutations.includes(msg.type)) {
              broadcastExcept(msg, ws);
            }
          }
          // Check if this is a app event
          else if (Object.values(APP_EVENTS).includes(msg.type)) {
            // app:message — broadcast to all clients (agent picks it up)
            if (msg.type === APP_EVENTS.APP_MESSAGE) {
              broadcastExcept(msg, ws);
            }
            // app:response — broadcast to all clients (host bridge picks it up)
            else if (msg.type === APP_EVENTS.APP_RESPONSE) {
              broadcastExcept(msg, ws);
            }
          }
        } catch (err) {
          log.error({ err }, 'failed to handle message');
        }
      });

      ws.on('close', () => {
        clients.delete(ws);
        log.debug({ clients: clients.size }, 'client disconnected');
      });

      ws.on('error', (err) => {
        log.error({ err }, 'client error');
        clients.delete(ws);
      });

      // Send initial connection confirmation
      ws.send(JSON.stringify({
        type: 'connected',
        timestamp: Date.now(),
      }));
    });

    // Start heartbeat if not already running
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        clients.forEach((ws) => {
          const extWs = ws as ExtendedWebSocket;
          if (extWs.isAlive === false) {
            clients.delete(ws);
            return ws.terminate();
          }
          extWs.isAlive = false;
          ws.ping();
        });
      }, HEARTBEAT_INTERVAL);
    }
  }

  return wss;
}

/**
 * Handle WebSocket upgrade request
 */
export function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const server = getWebSocketServer();
  server.handleUpgrade(request, socket, head, (ws) => {
    server.emit('connection', ws, request);
  });
}

/**
 * Broadcast an event to all connected clients
 */
export function broadcast(event: WalletEvent | WorkspaceEvent): void {
  const message = JSON.stringify(event);
  let sent = 0;

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      sent++;
    }
  });

  log.debug({ type: event.type, sent, total: clients.size }, 'broadcast');
}

/**
 * Broadcast an event to all connected clients except one
 */
export function broadcastExcept(event: WalletEvent | WorkspaceEvent, excludeClient: WebSocket): void {
  const message = JSON.stringify(event);
  let sent = 0;

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client !== excludeClient) {
      client.send(message);
      sent++;
    }
  });

  log.debug({ type: event.type, sent, total: clients.size - 1 }, 'broadcast (excluding sender)');
}

/**
 * Get number of connected clients
 */
export function getClientCount(): number {
  return clients.size;
}

/**
 * Get connected clients with their auth info
 */
export function getAuthenticatedClients(): Array<{
  agentId: string;
  isAdmin: boolean;
  permissions: string[];
}> {
  const result: Array<{ agentId: string; isAdmin: boolean; permissions: string[] }> = [];

  clients.forEach((client) => {
    const extWs = client as ExtendedWebSocket;
    if (extWs.auth?.valid) {
      result.push({
        agentId: extWs.auth.payload?.agentId || 'admin',
        isAdmin: extWs.auth.isAdmin || false,
        permissions: extWs.auth.payload?.permissions || ['admin:*']
      });
    }
  });

  return result;
}

/**
 * Cleanup WebSocket server (for testing/shutdown)
 */
export function closeWebSocketServer(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  clients.forEach((client) => {
    client.close();
  });
  clients.clear();

  if (wss) {
    wss.close();
    wss = null;
  }
}
