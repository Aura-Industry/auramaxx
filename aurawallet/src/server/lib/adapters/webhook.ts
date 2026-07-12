/**
 * Webhook adapter — notification-only.
 *
 * POSTs action notifications and resolutions to a configured URL.
 * Useful for Slack incoming webhooks, Discord webhooks, ntfy, or
 * any HTTP endpoint that wants to receive approval events.
 *
 * This adapter does NOT handle responses — it only pushes events out.
 * To approve/reject from a webhook target, build a bidirectional adapter
 * (like the Telegram adapter) or have the target POST to /actions/:id/resolve.
 */

import { createHmac } from 'crypto';
import { validateExternalUrl } from '../network';
import type {
  ApprovalAdapter,
  AdapterContext,
  ActionNotification,
  ActionResolution,
} from './types';
import { getErrorMessage } from '../error';

export interface WebhookAdapterConfig {
  /** URL to POST notifications to */
  url: string;
  /** Optional HMAC-SHA256 secret for signing payloads */
  secret?: string;
  /** Optional custom headers to include */
  headers?: Record<string, string>;
}

export class WebhookAdapter implements ApprovalAdapter {
  readonly name: string;
  private config: WebhookAdapterConfig;

  constructor(config: WebhookAdapterConfig) {
    this.name = `webhook:${new URL(config.url).hostname}`;
    this.config = config;
    // Validate URL synchronously at construction — DNS check happens at send time
    const parsed = new URL(config.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Webhook URL must use http: or https: (got ${parsed.protocol})`);
    }
  }

  async start(_ctx: AdapterContext): Promise<void> {
    // Nothing to initialize
  }

  async notify(action: ActionNotification): Promise<void> {
    await this.post('action:created', action);
  }

  async resolved(resolution: ActionResolution): Promise<void> {
    await this.post('action:resolved', resolution);
  }

  async stop(): Promise<void> {
    // Nothing to clean up
  }

  private async post(eventType: string, data: unknown): Promise<void> {
    const payload = JSON.stringify({ type: eventType, data, timestamp: Date.now() });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    };

    // Add HMAC signature if secret is configured
    if (this.config.secret) {
      const signature = createHmac('sha256', this.config.secret)
        .update(payload)
        .digest('hex');
      headers['X-Signature-256'] = `sha256=${signature}`;
    }

    try {
      await validateExternalUrl(this.config.url);
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers,
        body: payload,
        redirect: 'error',
      });

      if (!response.ok) {
        console.error(`[adapters] ${this.name} POST failed: ${response.status}`);
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error(`[adapters] ${this.name} POST error:`, msg);
    }
  }
}
