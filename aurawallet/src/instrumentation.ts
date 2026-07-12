/**
 * Next.js instrumentation hook
 * Sets up WebSocket server for real-time events
 */

export async function register() {
  // Only run on server
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { setupWebSocketServer } = await import('./lib/websocket-setup');
    setupWebSocketServer();
  }
}
