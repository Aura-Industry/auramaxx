/**
 * Telegram adapter — full bidirectional approval via Telegram Bot API.
 *
 * Uses long-polling (getUpdates) with raw fetch calls — no npm dependencies.
 * Sends inline keyboard buttons for Approve/Reject, edits messages on resolution.
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

/** Flavor text rotation for generic thinking time between tool calls */
const FLAVOR_TEXTS = [
  'auramaxxing...',
  'mogging prompt peasants...',
  'thinking with my big brain...',
  'controlling cortisol spike...',
  'channeling main character energy...',
  'ascending beyond mortal comprehension...',
  'i will not double text...',
  'consulting the blockchain elders...',
  'asking the smart contracts nicely...',
  'in my bag rn...',
  'downloading more RAM...',
  'mainnet mindset activated...',
  'reading the whitepaper backwards...',
  'gas fees for my thoughts...',
];

export interface TelegramAdapterConfig {
  /** Telegram Bot API token (from @BotFather) */
  botToken: string;
  /** Chat ID to send notifications to and accept callbacks from */
  chatId: string | number;
  /** Chat configuration — opt-in for agent chat */
  chat?: { enabled?: boolean };
}

export class TelegramAdapter implements ApprovalAdapter {
  readonly name = 'telegram';
  private config: TelegramAdapterConfig;
  private ctx: AdapterContext | null = null;
  private pollAbort: AbortController | null = null;
  private isRunning = false;
  private updateOffset = 0;

  /** Maps actionId → Telegram messageId for editing on resolution */
  private actionMessages = new Map<string, number>();

  constructor(config: TelegramAdapterConfig) {
    this.config = config;
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;

    // Verify bot token by calling getMe
    const me = await this.apiCall('getMe', {});
    if (!me?.result) {
      console.error('[adapters] telegram: invalid bot token or network error — not starting');
      return;
    }
    const username = (me.result as unknown as { username?: string }).username;
    console.log(`[adapters] telegram: connected as @${username}`);

    // Clear any existing webhook so long-polling works
    await this.apiCall('deleteWebhook', { drop_pending_updates: false });

    this.isRunning = true;
    this.startPolling();
  }

  async notify(action: ActionNotification): Promise<void> {
    // Notification-only: send plain message without inline keyboard
    if (action.type === 'notify') {
      const text = this.formatInfoNotification(action);
      try {
        await this.apiCall('sendMessage', {
          chat_id: this.config.chatId,
          text,
          parse_mode: 'HTML',
        });
      } catch (err) {
        const msg = getErrorMessage(err);
        console.error(`[adapters] telegram notify error:`, msg);
      }
      return;
    }

    const text = this.formatNotification(action);
    const inlineKeyboard = {
      inline_keyboard: [[
        { text: 'Approve', callback_data: `approve:${action.id}` },
        { text: 'Reject', callback_data: `reject:${action.id}` },
      ]],
    };

    try {
      const result = await this.apiCall('sendMessage', {
        chat_id: this.config.chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: JSON.stringify(inlineKeyboard),
      });

      if (result?.result?.message_id) {
        this.actionMessages.set(action.id, result.result.message_id);
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error(`[adapters] telegram notify error:`, msg);
    }
  }

  async resolved(resolution: ActionResolution): Promise<void> {
    const messageId = this.actionMessages.get(resolution.id);
    if (!messageId) return;

    const status = resolution.approved ? 'APPROVED' : 'REJECTED';
    const text = `${status} by ${resolution.resolvedBy}\nAction: ${resolution.id.slice(0, 8)}... (${resolution.type})`;

    try {
      await this.apiCall('editMessageText', {
        chat_id: this.config.chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.debug('[adapters] telegram: failed to edit resolved message:', getErrorMessage(err));
    }

    this.actionMessages.delete(resolution.id);
  }

  async stop(): Promise<void> {
    console.log('[adapters] telegram: stopping');
    this.isRunning = false;
    if (this.pollAbort) {
      this.pollAbort.abort();
      this.pollAbort = null;
    }
    this.actionMessages.clear();
  }

  private formatInfoNotification(action: ActionNotification): string {
    const meta = (action.metadata || {}) as Record<string, unknown>;
    const lines: string[] = [
      `<b>${escapeHtml(action.summary)}</b>`,
      `<b>Source:</b> ${escapeHtml(action.source)}`,
    ];

    if (meta.contractAddress) {
      lines.push(`<b>DexScreener:</b> <a href="https://dexscreener.com/base/${meta.contractAddress}">View Chart</a>`);
    }

    if (meta.symbol) {
      lines.push(`<b>Symbol:</b> ${escapeHtml(String(meta.symbol))}`);
    }
    if (meta.marketCap) {
      const mc = Number(meta.marketCap);
      const formatted = mc >= 1_000_000
        ? `$${(mc / 1_000_000).toFixed(1)}M`
        : mc >= 1000
          ? `$${(mc / 1000).toFixed(1)}K`
          : `$${mc.toFixed(0)}`;
      lines.push(`<b>Market Cap:</b> ${formatted}`);
    }
    if (meta.risk != null) {
      lines.push(`<b>Risk:</b> ${meta.risk}/10`);
    }

    if (Array.isArray(meta.socialLinks)) {
      const linkStrs: string[] = [];
      for (const link of meta.socialLinks as Array<{ name?: string; link?: string }>) {
        if (link.link) {
          linkStrs.push(`<a href="${escapeHtml(link.link)}">${escapeHtml(link.name || 'Link')}</a>`);
        }
      }
      if (linkStrs.length > 0) {
        lines.push(`<b>Links:</b> ${linkStrs.join(' | ')}`);
      }
    }

    if (meta.evaluation && typeof meta.evaluation === 'string') {
      // Truncate very long evaluations for Telegram (max ~3500 chars to stay under 4096 limit)
      let evalText = meta.evaluation as string;
      if (evalText.length > 3000) {
        evalText = evalText.slice(0, 3000) + '...';
      }
      lines.push('');
      lines.push(escapeHtml(evalText));
    }

    return lines.join('\n');
  }

  private formatNotification(action: ActionNotification): string {
    const vs = action.verifiedSummary || (action.metadata?.verifiedSummary as ActionNotification['verifiedSummary']);

    const lines = [
      `<b>New Action Request</b>`,
      `<b>Type:</b> ${escapeHtml(action.type)}`,
      `<b>Source:</b> ${escapeHtml(action.source)}`,
    ];

    // Use verified one-liner as primary summary when available
    if (vs?.oneLiner) {
      lines.push(`<b>Action:</b> ${escapeHtml(vs.oneLiner)}`);
      if (action.summary !== vs.oneLiner) {
        lines.push(`<b>Agent says:</b> <i>${escapeHtml(action.summary)}</i>`);
      }
    } else {
      lines.push(`<b>Summary:</b> ${escapeHtml(action.summary)}`);
    }

    lines.push(`<b>ID:</b> <code>${action.id.slice(0, 12)}</code>`);

    if (action.expiresAt) {
      const expires = new Date(action.expiresAt).toISOString();
      lines.push(`<b>Expires:</b> ${expires}`);
    }

    // Show discrepancy warnings
    if (vs?.discrepancies && vs.discrepancies.length > 0) {
      lines.push('');
      for (const d of vs.discrepancies) {
        const icon = d.severity === 'critical' ? '🚨' : d.severity === 'warning' ? '⚠️' : 'ℹ️';
        lines.push(`${icon} <b>${escapeHtml(d.severity.toUpperCase())}</b>: ${escapeHtml(d.field)} — agent says "${escapeHtml(d.agentClaim)}", actual: ${escapeHtml(d.actual)}`);
      }
    }

    return lines.join('\n');
  }

  /** Start long-polling loop for Telegram updates */
  private startPolling(): void {
    console.log('[adapters] telegram: polling started');
    const poll = async () => {
      while (this.isRunning) {
        try {
          this.pollAbort = new AbortController();
          const result = await this.apiCall('getUpdates', {
            offset: this.updateOffset,
            timeout: 30,
          }, this.pollAbort.signal);

          if (!result?.result) continue;

          for (const update of result.result) {
            if (update.update_id == null) continue;
            this.updateOffset = update.update_id + 1;

            if (update.callback_query) {
              await this.handleCallback(update.callback_query);
            } else if (update.message?.text) {
              await this.handleChatMessage(update.message as TelegramMessage);
            }
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') break;
          const msg = getErrorMessage(err);
          console.error('[adapters] telegram: polling error:', msg);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
      console.log('[adapters] telegram: polling stopped');
    };
    poll();
  }

  /** Handle an inline keyboard callback */
  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    // Security: only accept callbacks from the configured chat
    const chatId = String(query.message?.chat?.id);
    if (chatId !== String(this.config.chatId)) return;

    const data = query.data;
    if (!data) return;

    const match = data.match(/^(approve|reject):(.+)$/);
    if (!match) return;

    const [, action, actionId] = match;
    const approved = action === 'approve';

    // Answer the callback to remove loading state
    await this.apiCall('answerCallbackQuery', {
      callback_query_id: query.id,
      text: approved ? 'Approving...' : 'Rejecting...',
    }).catch(() => {});

    // Resolve the action
    if (this.ctx) {
      const result = await this.ctx.resolve(actionId, approved);
      if (!result.success) {
        // Notify the user of the error
        await this.apiCall('sendMessage', {
          chat_id: this.config.chatId,
          text: `Failed to ${action}: ${result.error}`,
        }).catch(() => {});
      }
    }
  }

  /** Handle incoming chat messages (adapter interface) */
  async onMessage(message: ChatMessage): Promise<ChatReply | null> {
    if (this.config.chat?.enabled !== true) return null;
    if (!this.ctx) return null;

    const appId = await this.ctx.resolveApp(message.targetApp);
    if (!appId) {
      return { text: 'No AI app configured. Set a default app in adapter settings.' };
    }

    const result = await this.ctx.sendMessage(appId, message.text, undefined, 'telegram');
    if (result.error) {
      return { text: `Error: ${result.error}` };
    }

    return result.reply ? { text: result.reply } : null;
  }

  /** Handle a text message from the Telegram polling loop */
  private async handleChatMessage(message: TelegramMessage): Promise<void> {
    // Chat must be opted in
    if (this.config.chat?.enabled !== true) return;

    // Security: only accept messages from the configured chat
    if (!this.config.chatId) {
      console.error('[adapters] telegram: chatId not configured — cannot process messages. Re-save adapter config with your chat ID.');
      return;
    }
    const chatId = String(message.chat?.id);
    if (chatId !== String(this.config.chatId)) {
      console.warn(`[adapters] telegram: ignoring message from chat ${chatId} (expected ${this.config.chatId})`);
      return;
    }

    const text = message.text || '';
    if (!text.trim()) return;

    console.log(`[adapters] telegram: chat message from ${chatId}: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);

    // Show "typing..." indicator while AI processes (re-send every 4s since it expires after ~5s)
    const sendTyping = () => this.apiCall('sendChatAction', {
      chat_id: this.config.chatId,
      action: 'typing',
    }).catch(() => { /* non-fatal */ });
    await sendTyping();
    const typingInterval = setInterval(sendTyping, 4000);

    // Progress status message — editable in place.
    // Delayed: wait a few seconds before showing the first flavor text so
    // quick replies don't flash a status message at all.
    let statusMessageId: number | null = null;
    let creatingStatusMessage = false;
    let flavorIndex = 0;

    const createStatusMessage = (text: string) => {
      if (statusMessageId || creatingStatusMessage) return;
      creatingStatusMessage = true;
      this.apiCall('sendMessage', {
        chat_id: this.config.chatId,
        text,
      }).then((res) => {
        statusMessageId = res?.result?.message_id ?? null;
      }).catch(() => {
        // Non-fatal — proceed without status message
      }).finally(() => {
        creatingStatusMessage = false;
      });
    };

    const onProgress = (status: string) => {
      const progressText = status || FLAVOR_TEXTS[flavorIndex++ % FLAVOR_TEXTS.length];
      if (statusMessageId) {
        this.apiCall('editMessageText', {
          chat_id: this.config.chatId,
          message_id: statusMessageId,
          text: progressText,
        }).catch(() => {});
      } else if (status) {
        // Explicit progress means work is ongoing; create status message immediately.
        createStatusMessage(progressText);
      }
    };

    // Delay the initial status message — no need to spam on quick replies
    const statusDelay = setTimeout(async () => {
      if (statusMessageId || creatingStatusMessage) return;
      const initialText = FLAVOR_TEXTS[flavorIndex++ % FLAVOR_TEXTS.length];
      createStatusMessage(initialText);
    }, 3000);

    // Rotate flavor text on a timer when no tool-call progress fires
    const flavorInterval = setInterval(() => {
      if (statusMessageId) onProgress('');
    }, 10_000);

    const cleanupTimers = () => {
      clearTimeout(statusDelay);
      clearInterval(typingInterval);
      clearInterval(flavorInterval);
    };

    const deleteStatusMessage = async () => {
      if (statusMessageId) {
        await this.apiCall('deleteMessage', {
          chat_id: this.config.chatId,
          message_id: statusMessageId,
        }).catch(() => {});
      }
    };

    // Route through the message chain with the progress callback
    if (!this.ctx) {
      cleanupTimers();
      return;
    }

    const appId = await this.ctx.resolveApp();
    if (!appId) {
      cleanupTimers();
      await deleteStatusMessage();
      await this.apiCall('sendMessage', {
        chat_id: this.config.chatId,
        text: 'No AI app configured. Set a default app in adapter settings.',
      }).catch(() => {});
      return;
    }

    let result: { reply: string | null; error?: string };
    try {
      result = await this.ctx.sendMessage(appId, text, onProgress, 'telegram');
    } finally {
      cleanupTimers();
    }

    // Delete status message before sending real reply (await to prevent double-texting)
    await deleteStatusMessage();

    if (result.error) {
      await this.apiCall('sendMessage', {
        chat_id: this.config.chatId,
        text: `Error: ${result.error}`,
      }).catch(() => {});
      return;
    }

    if (!result.reply) {
      console.log('[adapters] telegram: no reply generated for chat message');
      return;
    }

    await this.sendLongMessage(result.reply);
  }

  /**
   * Send a long message, converting markdown to Telegram HTML and splitting
   * into chunks that respect the 4096-char limit. Falls back to plain text
   * if HTML parsing fails on a chunk.
   */
  private async sendLongMessage(reply: string): Promise<void> {
    const html = markdownToTelegramHtml(reply);
    const chunks = splitMessage(html, 4000); // leave headroom under 4096
    for (const chunk of chunks) {
      // Try HTML first, fall back to plain text if Telegram rejects the markup
      const sent = await this.apiCall('sendMessage', {
        chat_id: this.config.chatId,
        text: chunk,
        parse_mode: 'HTML',
      });
      if (!sent) {
        // HTML parse failed (unclosed tags from split) — retry as plain text
        const plain = chunk.replace(/<[^>]+>/g, '');
        const fallback = await this.apiCall('sendMessage', {
          chat_id: this.config.chatId,
          text: plain || '(message could not be rendered)',
        });
        if (!fallback) {
          console.error('[adapters] telegram: failed to send chat reply chunk even as plain text');
        }
      }
    }
  }

  /** Call a Telegram Bot API method */
  private async apiCall(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TelegramApiResponse | null> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/${method}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[adapters] telegram API ${method} failed: ${response.status} ${text}`);
      return null;
    }

    return response.json() as Promise<TelegramApiResponse>;
  }
}

// Minimal Telegram types (no npm dependency)
interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id: number }; message_id?: number };
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  from?: { id: number; first_name?: string };
}

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id?: number; update_id?: number; callback_query?: TelegramCallbackQuery; message?: TelegramMessage }[] & { message_id?: number };
}

/**
 * Split a message into chunks that fit within a max length.
 * HTML-tag-aware: closes open tags at the end of each chunk and reopens
 * them at the start of the next, so Telegram's HTML parser doesn't choke.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a split point: prefer newline near the limit, avoid splitting inside a tag
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt <= 0) splitAt = maxLength;

    // Don't split inside an HTML tag — back up to before the '<'
    const lastOpen = remaining.lastIndexOf('<', splitAt);
    const lastClose = remaining.lastIndexOf('>', splitAt);
    if (lastOpen > lastClose) {
      // We're inside a tag — split before it
      splitAt = lastOpen;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).replace(/^\n/, '');

    // Find unclosed tags in this chunk and close them
    const openTags: string[] = [];
    const tagRegex = /<\/?([a-z]+)[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(chunk)) !== null) {
      const tagName = m[1].toLowerCase();
      if (m[0].startsWith('</')) {
        // Closing tag — pop the last matching open tag
        const idx = openTags.lastIndexOf(tagName);
        if (idx !== -1) openTags.splice(idx, 1);
      } else if (!m[0].endsWith('/>')) {
        openTags.push(tagName);
      }
    }

    // Close remaining open tags at end of chunk (reverse order)
    for (let i = openTags.length - 1; i >= 0; i--) {
      chunk += `</${openTags[i]}>`;
    }

    // Reopen them at the start of the next chunk
    if (openTags.length > 0 && remaining.length > 0) {
      remaining = openTags.map(t => `<${t}>`).join('') + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Convert markdown to Telegram-compatible HTML */
export function markdownToTelegramHtml(md: string): string {
  // 1. Extract fenced code blocks — preserve content, no markdown processing inside
  const codeBlocks: string[] = [];
  let text = md.replace(/```\w*\n?([\s\S]*?)```/g, (_, content: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre>${escapeHtml(content.replace(/\n$/, ''))}</pre>`);
    return `\x00CB${idx}\x00`;
  });

  // 2. Extract inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_, content: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(content)}</code>`);
    return `\x00IC${idx}\x00`;
  });

  // 3. Escape HTML in remaining text
  text = escapeHtml(text);

  // 4. Convert markdown patterns
  // Bold: **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__(.+?)__/g, '<b>$1</b>');
  // Strikethrough: ~~text~~
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
  // Headers: # text → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  // Markdown links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 5. Re-insert preserved blocks
  text = text.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[Number(idx)]);
  text = text.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCodes[Number(idx)]);

  return text;
}
