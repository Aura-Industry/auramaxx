/**
 * ApprovalRouter — connects to WebSocket, fans out events to adapters.
 *
 * Calls resolve and message logic directly as an in-process trusted
 * component, without fabricating admin tokens or making HTTP requests
 * to itself.
 */

import { WebSocket } from 'ws';
import { resolveAction } from '../resolve-action';
import { handleAppMessage, enqueueAppMessage, waitForQueuedAppMessage } from '../strategy/engine';
import { getDefaultSync } from '../defaults';
import type {
  ApprovalAdapter,
  AdapterContext,
  ActionNotification,
  ActionResolution,
  ResolveOptions,
  ResolveResult,
} from './types';
import { getErrorMessage } from '../error';

export class ApprovalRouter {
  private adapters: ApprovalAdapter[] = [];
  private ws: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isRunning = false;
  private serverUrl: string;
  private defaultAppCache: string | null | undefined = undefined;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  /** Register an adapter to receive events */
  registerAdapter(adapter: ApprovalAdapter): void {
    this.adapters.push(adapter);
  }

  /** Start the router: connect WS, fetch pending, start adapters */
  async start(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;

    if (this.adapters.length === 0) {
      console.log('[adapters] No adapters registered, skipping start');
      return;
    }

    this.isRunning = true;

    // Build adapter context
    const ctx: AdapterContext = {
      resolve: (actionId, approved, opts) => this.resolve(actionId, approved, opts),
      serverUrl: this.serverUrl,
      sendMessage: (appId, text, onProgress, adapter) => this.sendMessage(appId, text, onProgress, adapter),
      resolveApp: (targetApp) => this.resolveApp(targetApp),
    };

    // Start all adapters
    for (const adapter of this.adapters) {
      try {
        await adapter.start(ctx);
        console.log(`[adapters] Started adapter: ${adapter.name}`);
      } catch (err) {
        const msg = getErrorMessage(err);
        console.error(`[adapters] Failed to start adapter ${adapter.name}:`, msg);
      }
    }

    // Connect to WebSocket for live events
    this.connectWebSocket();

    // Fetch any existing pending actions
    await this.fetchPendingActions();

    console.log(`[adapters] Router started with ${this.adapters.length} adapter(s)`);
  }

  /** Stop the router and all adapters */
  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    for (const adapter of this.adapters) {
      try {
        await adapter.stop();
      } catch (err) {
        const msg = getErrorMessage(err);
        console.error(`[adapters] Error stopping adapter ${adapter.name}:`, msg);
      }
    }
  }

  /** Resolve an action by calling resolveAction() directly */
  async resolve(actionId: string, approved: boolean, opts?: ResolveOptions): Promise<ResolveResult> {
    try {
      const result = await resolveAction(actionId, approved, {
        walletAccess: opts?.walletAccess,
        limits: opts?.limits,
      });
      if (!result.success) {
        return { success: false, error: (result.data.error as string) || 'Unknown error' };
      }
      return {
        success: true,
        token: result.data.token as string | undefined,
        agentId: result.data.agentId as string | undefined,
      };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  }

  /** Route a chat message to an app's AI via the strategy engine directly */
  async sendMessage(appId: string, text: string, onProgress?: (status: string) => void, adapter?: string): Promise<{ reply: string | null; error?: string }> {
    try {
      const adapterName = adapter || 'unknown';

      // Fast path for direct chat handlers (same routing style as apps.ts).
      if (appId === '__system__' || appId === 'agent-chat') {
        const direct = await handleAppMessage(appId, text, onProgress, adapterName);
        if (direct.error) {
          return { reply: null, error: direct.error };
        }
        return { reply: direct.reply };
      }

      // Queue path for other apps
      const requestId = await enqueueAppMessage(appId, text, adapterName);
      const timeoutMs = getDefaultSync<number>('strategy.message_timeout_ms', 120_000);
      const result = await waitForQueuedAppMessage(requestId, timeoutMs);

      if (result.status === 'timeout') {
        return { reply: null, error: result.error || 'Timed out waiting for message processing' };
      }

      if (result.status === 'error') {
        return { reply: null, error: result.error || 'Message processing failed' };
      }

      return { reply: result.reply };
    } catch (err) {
      const msg = getErrorMessage(err);
      return { reply: null, error: msg };
    }
  }

  /** Resolve which app should handle a message */
  async resolveApp(targetApp?: string): Promise<string | null> {
    if (targetApp) return targetApp;

    // Return cached value if available
    if (this.defaultAppCache !== undefined) return this.defaultAppCache;

    try {
      const { prisma } = await import('../db');
      const appConfig = await prisma.appConfig.findUnique({
        where: { id: 'global' },
      });

      if (appConfig?.adapterConfig) {
        const parsed = JSON.parse(appConfig.adapterConfig) as { chat?: { defaultApp?: string } };
        // Fall back to system chat if no specific app is configured
        this.defaultAppCache = parsed.chat?.defaultApp ?? '__system__';
      } else {
        this.defaultAppCache = '__system__';
      }
    } catch (err) {
      console.warn('[adapters] failed to resolve default app:', getErrorMessage(err));
      this.defaultAppCache = '__system__';
    }

    return this.defaultAppCache;
  }

  /** Clear the cached default app (call after config changes) */
  clearAppCache(): void {
    this.defaultAppCache = undefined;
  }

  /** Connect to WebSocket server for live events */
  private connectWebSocket(): void {
    const wsUrl = process.env.WS_URL ?? 'ws://localhost:4748';
    if (!wsUrl) return;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[adapters] WebSocket connected');
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleEvent(event);
        } catch (err) {
          console.debug('[adapters] malformed websocket message:', getErrorMessage(err));
        }
      });

      this.ws.on('close', () => {
        if (this.isRunning) {
          this.reconnectTimeout = setTimeout(() => {
            this.connectWebSocket();
          }, 3000);
        }
      });

      this.ws.on('error', (error) => {
        console.error('[adapters] WebSocket error:', error.message);
      });
    } catch {
      if (this.isRunning) {
        this.reconnectTimeout = setTimeout(() => {
          this.connectWebSocket();
        }, 3000);
      }
    }
  }

  /** Handle incoming WebSocket event */
  private handleEvent(event: { type: string; data: unknown }): void {
    if (event.type === 'action:created') {
      const notification = event.data as ActionNotification;
      this.fanOutNotify(notification);
    } else if (event.type === 'action:resolved') {
      const resolution = event.data as ActionResolution;
      this.fanOutResolved(resolution);
    }
  }

  /** Fetch existing pending actions via direct prisma query */
  private async fetchPendingActions(): Promise<void> {
    try {
      const { prisma } = await import('../db');
      const actions = await prisma.humanAction.findMany({
        where: {
          status: 'pending',
          NOT: { type: 'strategy:message' },
        },
        orderBy: { createdAt: 'desc' },
      });

      for (const action of actions) {
        // Map raw DB row to ActionNotification shape
        let metadata: { source?: string; summary?: string } & Record<string, unknown> = {};
        try { metadata = JSON.parse(action.metadata || '{}'); } catch {}

        const notification: ActionNotification = {
          id: action.id,
          type: action.type,
          source: metadata.source || (metadata.agentId ? `agent:${metadata.agentId}` : 'unknown'),
          summary: (metadata.summary as string) || action.type,
          expiresAt: null,
          metadata,
        };
        this.fanOutNotify(notification);
      }

      if (actions.length > 0) {
        console.log(`[adapters] Notified adapters of ${actions.length} pending action(s)`);
      }
    } catch (err) {
      console.debug('[adapters] pending actions fetch failed:', getErrorMessage(err));
    }
  }

  /** Fan out a notification to all adapters */
  private fanOutNotify(action: ActionNotification): void {
    for (const adapter of this.adapters) {
      adapter.notify(action).catch(err => {
        const msg = getErrorMessage(err);
        console.error(`[adapters] ${adapter.name} notify error:`, msg);
      });
    }
  }

  /** Fan out a resolution to all adapters */
  private fanOutResolved(resolution: ActionResolution): void {
    for (const adapter of this.adapters) {
      adapter.resolved(resolution).catch(err => {
        const msg = getErrorMessage(err);
        console.error(`[adapters] ${adapter.name} resolved error:`, msg);
      });
    }
  }
}
