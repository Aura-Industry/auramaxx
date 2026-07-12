/**
 * Adapter registry and factory.
 *
 * Maps adapter type names to constructors. Built-in types (webhook, telegram)
 * are registered at import time. Third-party types can be registered via
 * registerAdapterType().
 */

import type { ApprovalAdapter, AdapterFactory } from './types';
import { WebhookAdapter, type WebhookAdapterConfig } from './webhook';
import { TelegramAdapter, type TelegramAdapterConfig } from './telegram';
import { WhatsAppAdapter, type WhatsAppAdapterConfig } from './whatsapp';
import { DiscordAdapter, type DiscordAdapterConfig } from './discord';
import { getErrorMessage } from '../error';
import {
  ensureApiKeysMigrated,
  listApiKeyCredentials,
  readApiKeyValueByServiceName,
} from '../apikey-migration';

const registry = new Map<string, AdapterFactory>();

/** Register a custom adapter type */
export function registerAdapterType(type: string, factory: AdapterFactory): void {
  registry.set(type, factory);
}

/** Internal config shape used by createAdapters and loadAdaptersFromDb */
interface AdapterEntry {
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  chat?: { enabled?: boolean };
}

/** Create adapter instances from structured config, skipping disabled entries */
export function createAdapters(entries: AdapterEntry[]): ApprovalAdapter[] {
  const adapters: ApprovalAdapter[] = [];

  for (const entry of entries) {
    if (!entry.enabled) continue;

    const factory = registry.get(entry.type);
    if (!factory) {
      console.warn(`[adapters] Unknown adapter type: ${entry.type}`);
      continue;
    }

    try {
      const config = entry.chat ? { ...entry.config, chat: entry.chat } : entry.config;
      adapters.push(factory(config));
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error(`[adapters] Failed to create ${entry.type} adapter:`, msg);
    }
  }

  return adapters;
}

/**
 * Load and create adapters from the database.
 *
 * Reads adapter settings from AppConfig.adapterConfig (enabled flags, non-secret config)
 * and secrets from agent-backed API key credentials (service = 'adapter:<type>').
 * Merges them to create instances.
 */
export async function loadAdaptersFromDb(): Promise<ApprovalAdapter[]> {
  // Never load adapters during tests
  if (process.env.NODE_ENV === 'test') return [];

  // Lazy import to avoid circular deps
  const { prisma } = await import('../db');

  // 1. Read adapter config from AppConfig
  const appConfig = await prisma.appConfig.findUnique({
    where: { id: 'global' },
  });

  if (!appConfig?.adapterConfig) return [];

  let parsed: { enabled?: boolean; chat?: { defaultApp?: string }; adapters?: AdapterEntry[] };
  try {
    parsed = JSON.parse(appConfig.adapterConfig);
  } catch {
    console.error('[adapters] Invalid adapterConfig JSON in AppConfig');
    return [];
  }

  if (!parsed.enabled || !parsed.adapters?.length) return [];

  // 2. Read all adapter secrets from agent-backed API key credentials.
  await ensureApiKeysMigrated();
  const secretKeys = listApiKeyCredentials().filter((credential) =>
    credential.service.startsWith('adapter:'),
  );

  // Build a lookup: { 'telegram': { botToken: '...' }, 'webhook': { secret: '...' } }
  const secretsByType: Record<string, Record<string, string>> = {};
  for (const key of secretKeys) {
    const adapterType = key.service.replace('adapter:', '');
    const value = readApiKeyValueByServiceName(key.service, key.name);
    if (!value) continue;
    if (!secretsByType[adapterType]) secretsByType[adapterType] = {};
    secretsByType[adapterType][key.name] = value;
  }

  // 3. Merge secrets into adapter configs and create instances
  const entries: AdapterEntry[] = parsed.adapters.map((a) => ({
    type: a.type,
    enabled: a.enabled,
    config: { ...a.config, ...(secretsByType[a.type] || {}) },
    chat: a.chat,
  }));

  return createAdapters(entries);
}

// Register built-in adapter types
registerAdapterType('webhook', (config) => new WebhookAdapter(config as unknown as WebhookAdapterConfig));
registerAdapterType('telegram', (config) => new TelegramAdapter(config as unknown as TelegramAdapterConfig));
registerAdapterType('whatsapp', (config) => new WhatsAppAdapter(config as unknown as WhatsAppAdapterConfig));
registerAdapterType('discord', (config) => new DiscordAdapter(config as unknown as DiscordAdapterConfig));
