/**
 * WebSocket server setup for Next.js
 * Runs on a separate port since Next.js API routes don't support WebSocket upgrades
 */

import { createServer } from 'http';
import { getWebSocketServer, broadcast, getClientCount } from './websocket-server';
import { ensureDefaultWorkspace } from './workspace-handlers';
import type { WalletEvent } from './events';
import { log as rootLog } from './pino';

const log = rootLog.child({ component: 'ws' });

const WS_PORT = parseInt(process.env.WS_PORT || '4748', 10);

let isSetup = false;
let httpServer: ReturnType<typeof createServer> | null = null;

export function setupWebSocketServer() {
  if (isSetup) return;
  isSetup = true;

  // Create a simple HTTP server for WebSocket upgrades and broadcast endpoint
  httpServer = createServer((req, res) => {
    // Health check endpoint
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', websocket: true, clients: getClientCount() }));
      return;
    }

    // Broadcast endpoint - receives events from Express and broadcasts to WebSocket clients
    if (req.url === '/broadcast' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const event: WalletEvent = JSON.parse(body);
          broadcast(event);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, type: event.type }));
        } catch (err) {
          log.error({ err }, 'failed to parse broadcast event');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const wss = getWebSocketServer();

  // Handle WebSocket upgrade
  httpServer.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  httpServer.listen(WS_PORT, '127.0.0.1', async () => {
    log.info({ port: WS_PORT, url: `ws://127.0.0.1:${WS_PORT}` }, 'WebSocket server started');
    // Ensure default workspace exists
    try {
      await ensureDefaultWorkspace();
    } catch (err) {
      log.error({ err }, 'failed to ensure default workspace');
    }
  });
}

export function getWebSocketPort(): number {
  return WS_PORT;
}
