import fs from 'fs/promises';
import { getRandomStartBannerQuote } from '../../../lib/startBannerQuotes';
import {
  ensureApiKeysMigrated,
  readApiKeyValueByService,
  readApiKeyValueByServiceName,
} from '../apikey-migration';
import { prisma } from '../db';
import { getErrorMessage } from '../error';
import { validateExternalUrl } from '../network';
import { resolveDefaultTargetFromCreds, sendWhatsAppMessageNative } from './whatsapp-native';

type AdapterEntry = {
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  chat?: { enabled?: boolean };
};

type AdapterConfigRoot = {
  enabled?: boolean;
  adapters?: AdapterEntry[];
  chat?: { defaultApp?: string };
};

export type SupportedAdapterType = 'telegram' | 'webhook' | 'whatsapp' | 'discord';

export interface AdapterDeliveryResult {
  success: boolean;
  message?: string;
  error?: string;
  status?: number;
  details?: Record<string, unknown>;
}

const ADAPTER_FETCH_TIMEOUT_MS = 5_000;
const WHATSAPP_TARGET_KEYS = ['testTarget', 'target', 'to', 'phone', 'recipient', 'chatId', 'jid'] as const;
const TELEGRAM_CHAT_ID_KEYS = ['chatId', 'chat_id', 'chatID'] as const;
const TELEGRAM_TOKEN_CONFIG_KEYS = ['botToken', 'token'] as const;
const DISCORD_TOKEN_KEYS = ['botToken', 'token'] as const;
const DISCORD_CHANNEL_ID_KEYS = ['channelId', 'channel_id'] as const;
const BANNER_WIDTH = 62;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatBannerSubtitle(subtitle: string): string {
  const upper = subtitle.trim().toUpperCase() || 'STARTING';
  return upper.slice(0, 38);
}

function buildDecoratedBanner(subtitle: string): string {
  const sub = formatBannerSubtitle(subtitle);
  const line1 = '  .-' + ' '.repeat(BANNER_WIDTH - 4) + '-.';
  const line2 = "  |   .----------." + ' '.repeat(BANNER_WIDTH - 19) + '|';
  const line3 = "  |   |\\  \\  \\|    A U R A" + ' '.repeat(BANNER_WIDTH - 30) + '|';
  const line4 = "  |   |\\  \\  \\|    M A X X . S H" + ' '.repeat(BANNER_WIDTH - 36) + '|';
  const line5 = `  |   |\\  \\  \\|    ${sub}${' '.repeat(Math.max(0, BANNER_WIDTH - 23 - sub.length))}|`;
  const line6 = "  |   '----------'" + ' '.repeat(BANNER_WIDTH - 19) + '|';
  const line7 = "  '-" + ' '.repeat(BANNER_WIDTH - 4) + "-'";
  return [line1, line2, line3, line4, line5, line6, line7].join('\n');
}

async function getAdapterConfig(type: SupportedAdapterType): Promise<Record<string, unknown> | null> {
  const appConfig = await prisma.appConfig.findUnique({ where: { id: 'global' } });
  if (!appConfig?.adapterConfig) return null;

  let parsed: AdapterConfigRoot;
  try {
    parsed = JSON.parse(appConfig.adapterConfig) as AdapterConfigRoot;
  } catch {
    return null;
  }

  const entry = parsed.adapters?.find((adapter) => adapter.type === type);
  if (!entry || !isRecord(entry.config)) return null;
  return entry.config;
}

function resultError(status: number, error: string, details?: Record<string, unknown>): AdapterDeliveryResult {
  return {
    success: false,
    status,
    error,
    ...(details ? { details } : {}),
  };
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number = ADAPTER_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function readStringByKeys(config: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readStringOrNumberByKeys(
  config: Record<string, unknown> | null,
  keys: readonly string[],
): string | number | null {
  if (!config) return null;
  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function readTelegramBotToken(config: Record<string, unknown> | null): string | null {
  const candidates = [
    readApiKeyValueByServiceName('adapter:telegram', 'botToken'),
    readApiKeyValueByService('adapter:telegram'),
    config ? readStringByKeys(config, TELEGRAM_TOKEN_CONFIG_KEYS) : null,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function resolveWhatsAppTarget(config: Record<string, unknown>): string | null {
  const topLevel = readStringByKeys(config, WHATSAPP_TARGET_KEYS);
  if (topLevel) return topLevel;

  const accounts = config.accounts;
  if (!isRecord(accounts)) return null;

  for (const accountConfig of Object.values(accounts)) {
    if (!isRecord(accountConfig)) continue;
    const accountTarget = readStringByKeys(accountConfig, WHATSAPP_TARGET_KEYS);
    if (accountTarget) return accountTarget;
  }

  return null;
}

function extractChatId(value: unknown): string | number | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

async function detectTelegramChatIdFromUpdates(botToken: string): Promise<string | number | null> {
  const updatesResp = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/getUpdates?timeout=0&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}`, {
    method: 'GET',
  });
  const updatesData = await updatesResp.json() as {
    ok?: boolean;
    result?: Array<{ message?: { chat?: { id?: string | number; type?: string } } }>;
  };

  if (!updatesData.ok || !Array.isArray(updatesData.result)) {
    return null;
  }

  for (const update of [...updatesData.result].reverse()) {
    const message = update.message;
    if (!message) continue;
    const chatType = message.chat?.type;
    if (chatType && chatType !== 'private') continue;

    const chatId = extractChatId(message.chat?.id);
    if (chatId !== null) {
      return chatId;
    }
  }

  return null;
}

async function persistTelegramChatId(chatId: string | number): Promise<void> {
  const appConfig = await prisma.appConfig.findUnique({ where: { id: 'global' } });

  let parsed: AdapterConfigRoot = {
    enabled: false,
    adapters: [],
  };
  if (appConfig?.adapterConfig) {
    try {
      parsed = JSON.parse(appConfig.adapterConfig) as AdapterConfigRoot;
    } catch {
      // Keep default shape.
    }
  }

  const adapters = Array.isArray(parsed.adapters) ? parsed.adapters : [];
  const telegramIndex = adapters.findIndex((adapter) => adapter.type.trim().toLowerCase() === 'telegram');
  if (telegramIndex < 0) return;

  const target = adapters[telegramIndex];
  const nextConfig = isRecord(target.config) ? { ...target.config } : {};
  nextConfig.chatId = chatId;
  adapters[telegramIndex] = {
    ...target,
    config: nextConfig,
  };

  const nextRoot: AdapterConfigRoot = {
    ...parsed,
    adapters,
  };

  await prisma.appConfig.upsert({
    where: { id: 'global' },
    update: { adapterConfig: JSON.stringify(nextRoot) },
    create: { id: 'global', adapterConfig: JSON.stringify(nextRoot) },
  });
}

function collectWhatsAppAuthDirs(config: Record<string, unknown>): Set<string> {
  const authDirs = new Set<string>();

  const topLevelAuthDir = config.authDir;
  if (typeof topLevelAuthDir === 'string' && topLevelAuthDir.trim()) {
    authDirs.add(topLevelAuthDir.trim());
  }

  const accounts = config.accounts;
  if (isRecord(accounts)) {
    for (const rawAccount of Object.values(accounts)) {
      if (!isRecord(rawAccount)) continue;
      const accountAuthDir = rawAccount.authDir;
      if (typeof accountAuthDir === 'string' && accountAuthDir.trim()) {
        authDirs.add(accountAuthDir.trim());
      }
    }
  }

  return authDirs;
}

async function partitionExistingDirs(authDirs: Iterable<string>): Promise<{ existing: string[]; missing: string[] }> {
  const existing: string[] = [];
  const missing: string[] = [];

  for (const dir of authDirs) {
    try {
      await fs.access(dir);
      existing.push(dir);
    } catch {
      missing.push(dir);
    }
  }

  return { existing, missing };
}

async function sendTelegram(text: string): Promise<AdapterDeliveryResult> {
  await ensureApiKeysMigrated();
  const config = await getAdapterConfig('telegram');
  const botToken = readTelegramBotToken(config);
  if (!botToken) {
    return resultError(400, 'Telegram bot token not configured');
  }

  let chatId = readStringOrNumberByKeys(config, TELEGRAM_CHAT_ID_KEYS);
  if (chatId === null) {
    try {
      const detected = await detectTelegramChatIdFromUpdates(botToken);
      if (detected !== null) {
        chatId = detected;
        await persistTelegramChatId(detected).catch(() => {
          // Non-fatal: use detected chat ID for this send even if persistence fails.
        });
      }
    } catch {
      // Keep fallback hint path below.
    }
  }

  if (chatId === null) {
    let hintMessage = 'Telegram chat ID not configured. Complete Telegram setup to detect chat ID.';
    try {
      const meResp = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/getMe`, {
        method: 'GET',
      });
      const meData = await meResp.json() as { ok?: boolean; result?: { username?: string } };
      const username = meData.ok ? meData.result?.username : undefined;
      if (username && username.trim()) {
        const normalized = username.trim().replace(/^@+/, '');
        const link = `https://t.me/${normalized}`;
        hintMessage = `Telegram chat ID not configured. Open @${normalized} (${link}), type /start, then test again.`;
      } else {
        hintMessage = 'Telegram chat ID not configured. Open your Telegram bot, type /start, then test again.';
      }
    } catch {
      // Keep fallback hint when Telegram API lookup fails.
    }
    return resultError(400, hintMessage);
  }

  const response = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: String(chatId),
      text: `<b>AuraMaxx</b>\n\n${escapeHtml(text)}`,
      parse_mode: 'HTML',
    }),
  });

  const data = await response.json() as { ok?: boolean; description?: string };
  if (!data.ok) {
    return {
      success: false,
      error: data.description || 'Failed to send test message',
    };
  }

  return { success: true, message: 'Telegram test sent.' };
}

async function sendWebhook(text: string): Promise<AdapterDeliveryResult> {
  const config = await getAdapterConfig('webhook');
  const webhookUrl = config?.url;

  if (!(typeof webhookUrl === 'string' && webhookUrl.trim())) {
    return resultError(404, 'Webhook URL not configured');
  }

  try {
    await validateExternalUrl(webhookUrl);
  } catch (err) {
    return resultError(403, getErrorMessage(err));
  }

  const response = await fetchWithTimeout(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'human_action_test',
      data: { text },
      timestamp: Date.now(),
    }),
  });

  if (!response.ok) {
    return {
      success: false,
      error: `Webhook returned ${response.status}`,
    };
  }

  return { success: true, message: 'Webhook test sent.' };
}

async function sendWhatsApp(text: string): Promise<AdapterDeliveryResult> {
  const config = await getAdapterConfig('whatsapp');
  if (!config) {
    return resultError(404, 'WhatsApp adapter not configured');
  }

  const authDirs = collectWhatsAppAuthDirs(config);
  if (authDirs.size === 0) {
    return resultError(400, 'WhatsApp auth directory not configured');
  }

  const { existing, missing } = await partitionExistingDirs(authDirs);
  if (existing.length === 0) {
    return resultError(400, 'WhatsApp session not found. Re-sync from OpenClaw.', { missingAuthDirs: missing });
  }

  const authDir = existing[0];

  let target = resolveWhatsAppTarget(config);
  if (!target) {
    try {
      target = await resolveDefaultTargetFromCreds(authDir);
    } catch (err) {
      return {
        success: false,
        error: `WhatsApp target resolution failed: ${getErrorMessage(err)}`,
      };
    }
  }

  if (!target) {
    return resultError(400, 'WhatsApp target not configured and no default self account was found.');
  }

  try {
    await sendWhatsAppMessageNative({
      authDir,
      target,
      text,
    });
  } catch (err) {
    return {
      success: false,
      error: `WhatsApp test send failed: ${getErrorMessage(err)}`,
      details: missing.length > 0 ? { missingAuthDirs: missing } : undefined,
    };
  }

  return {
    success: true,
    message: 'WhatsApp test sent.',
    details: missing.length > 0 ? { missingAuthDirs: missing } : undefined,
  };
}

async function sendDiscord(text: string): Promise<AdapterDeliveryResult> {
  await ensureApiKeysMigrated();
  const config = await getAdapterConfig('discord');
  if (!config) {
    return resultError(404, 'Discord adapter not configured');
  }

  const botToken = readStringByKeys(config, DISCORD_TOKEN_KEYS)
    || readApiKeyValueByServiceName('adapter:discord', 'botToken')
    || readApiKeyValueByService('adapter:discord');
  const channelId = readStringByKeys(config, DISCORD_CHANNEL_ID_KEYS);

  if (!botToken) {
    return resultError(400, 'Discord bot token not configured');
  }
  if (!channelId) {
    return resultError(400, 'Discord channelId not configured');
  }

  const response = await fetchWithTimeout(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: `**AuraMaxx**\n\n${text}` }),
  });

  if (!response.ok) {
    let details = '';
    try {
      details = await response.text();
    } catch {
      details = '';
    }
    return {
      success: false,
      status: response.status,
      error: details ? `Discord returned ${response.status}: ${details}` : `Discord returned ${response.status}`,
    };
  }

  return { success: true, message: 'Discord test sent.' };
}

export function buildAdapterTestMessage(type: SupportedAdapterType): string {
  const quote = getRandomStartBannerQuote();
  const subtitle = type === 'webhook'
    ? 'WEBHOOK TEST'
    : type === 'telegram'
      ? 'TELEGRAM TEST'
      : type === 'whatsapp'
        ? 'WHATSAPP TEST'
        : 'DISCORD TEST';
  if (type === 'webhook') {
    return `${buildDecoratedBanner(subtitle)}\n  ${quote}\n\nAuraMaxx webhook test`;
  }
  return `${buildDecoratedBanner(subtitle)}\n  ${quote}\n\nAdapter chat is now active.`;
}

export async function sendHumanMessageViaAdapter(
  type: SupportedAdapterType,
  text: string,
): Promise<AdapterDeliveryResult> {
  try {
    if (type === 'telegram') return sendTelegram(text);
    if (type === 'webhook') return sendWebhook(text);
    if (type === 'whatsapp') return sendWhatsApp(text);
    return sendDiscord(text);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        success: false,
        error: 'Test timed out',
      };
    }
    return {
      success: false,
      error: getErrorMessage(err),
    };
  }
}
