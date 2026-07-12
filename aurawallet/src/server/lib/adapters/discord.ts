/**
 * Discord adapter — notification delivery via Discord Bot API.
 *
 * Sends action notifications/resolution updates into a configured channel.
 * Optional chat support can be enabled for future inbound routing.
 */

import type {
  ApprovalAdapter,
  AdapterContext,
  ActionNotification,
  ActionResolution,
  ChatMessage,
  ChatReply,
} from './types';
import { getErrorMessage } from '../error';

export interface DiscordAdapterConfig {
  botToken: string;
  channelId: string;
  chat?: { enabled?: boolean };
}

function escapeDiscord(text: string): string {
  return text.replace(/[*_`~|>]/g, (m) => `\\${m}`);
}

export class DiscordAdapter implements ApprovalAdapter {
  readonly name = 'discord';
  private config: DiscordAdapterConfig;
  private ctx: AdapterContext | null = null;

  constructor(config: DiscordAdapterConfig) {
    this.config = config;
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    if (!this.config.botToken || !this.config.channelId) {
      console.error('[adapters] discord: botToken and channelId are required');
      return;
    }

    try {
      await this.apiCall(`channels/${this.config.channelId}`, { method: 'GET' });
      console.log('[adapters] discord: connected');
    } catch (err) {
      console.error('[adapters] discord: failed to start:', getErrorMessage(err));
    }
  }

  async notify(action: ActionNotification): Promise<void> {
    const text = action.type === 'notify'
      ? this.formatInfoNotification(action)
      : this.formatActionNotification(action);
    await this.sendMessage(text);
  }

  async resolved(resolution: ActionResolution): Promise<void> {
    const status = resolution.approved ? 'APPROVED' : 'REJECTED';
    const text = `**${status}** by ${escapeDiscord(resolution.resolvedBy)}\nAction: ${escapeDiscord(resolution.id.slice(0, 8))}... (${escapeDiscord(resolution.type)})`;
    await this.sendMessage(text);
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  async onMessage(message: ChatMessage): Promise<ChatReply | null> {
    if (this.config.chat?.enabled !== true || !this.ctx) return null;

    const appId = await this.ctx.resolveApp(message.targetApp);
    if (!appId) {
      return { text: 'No AI app configured. Set a default app in adapter settings.' };
    }

    const result = await this.ctx.sendMessage(appId, message.text, undefined, 'discord');
    if (result.error) {
      return { text: `Error: ${result.error}` };
    }

    return result.reply ? { text: result.reply } : null;
  }

  private formatInfoNotification(action: ActionNotification): string {
    return `**${escapeDiscord(action.summary)}**\nSource: ${escapeDiscord(action.source)}`;
  }

  private formatActionNotification(action: ActionNotification): string {
    const vs = action.verifiedSummary || (action.metadata?.verifiedSummary as ActionNotification['verifiedSummary']);
    const lines = [
      '**New Action Request**',
      `Type: ${escapeDiscord(action.type)}`,
      `Source: ${escapeDiscord(action.source)}`,
      `ID: \`${escapeDiscord(action.id.slice(0, 12))}\``,
    ];

    if (vs?.oneLiner) {
      lines.push(`Action: ${escapeDiscord(vs.oneLiner)}`);
      if (action.summary !== vs.oneLiner) lines.push(`Agent says: ${escapeDiscord(action.summary)}`);
    } else {
      lines.push(`Summary: ${escapeDiscord(action.summary)}`);
    }

    if (action.expiresAt) {
      lines.push(`Expires: ${new Date(action.expiresAt).toISOString()}`);
    }

    return lines.join('\n');
  }

  private async sendMessage(content: string): Promise<void> {
    try {
      await this.apiCall(`channels/${this.config.channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
    } catch (err) {
      console.error('[adapters] discord send error:', getErrorMessage(err));
    }
  }

  private async apiCall(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`https://discord.com/api/v10/${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${this.config.botToken}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Discord API ${response.status}: ${text}`);
    }

    if (response.status === 204) return null;
    return response.json().catch(() => null);
  }
}
