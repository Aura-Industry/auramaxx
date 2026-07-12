import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { hasAnyPermission, validateToken, extractBearerToken } from '@/lib/auth-client';
import { DATA_PATHS } from '@/server/lib/config';

const WALLET_API = process.env.WALLET_SERVER_URL || 'http://localhost:4242';
const DEFAULT_OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const DEFAULT_OPENCLAW_WHATSAPP_ROOT = path.join(os.homedir(), '.openclaw', 'credentials', 'whatsapp');
const WHATSAPP_IMPORT_ROOT = path.join(DATA_PATHS.wallets, 'adapters', 'whatsapp');
const GENERIC_SECRET_KEYS = new Set([
  'token',
  'botToken',
  'apiKey',
  'apikey',
  'secret',
  'password',
  'accessToken',
  'refreshToken',
]);

export interface AdapterEntry {
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  chat?: { enabled?: boolean };
}

interface AdapterSecrets {
  [key: string]: string;
}

interface OpenClawRoot {
  channels?: Record<string, unknown>;
}

export interface OpenClawSource {
  configPath: string;
  configDir: string;
  channels: Record<string, unknown>;
}

export interface ChannelValidationResult {
  channel: string;
  exists: boolean;
  supported: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
  details: Record<string, unknown>;
}

export interface ChannelImportResult {
  channel: string;
  imported: boolean;
  errors: string[];
  warnings: string[];
  details: Record<string, unknown>;
  validation: ChannelValidationResult;
  adapter?: {
    type: string;
    enabled: boolean;
  };
}

interface PreparedImport {
  entry: AdapterEntry;
  secrets?: AdapterSecrets;
  warnings?: string[];
  details?: Record<string, unknown>;
}

interface ImportOptions {
  chatEnabled?: boolean;
}

interface WhatsAppSourceDir {
  accountId: string;
  sourceDir: string;
}

interface WalletAdapterUpsertResponse {
  success?: boolean;
  error?: string;
  storedSecrets?: string[];
}

interface WalletAdaptersListResponse {
  success?: boolean;
  adapters?: Array<{
    type?: string;
    secretKeys?: string[];
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeChannel(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizePathWithHome(inputPath: string): string {
  if (!inputPath) return inputPath;
  if (inputPath === '~') return os.homedir();
  if (/^~[\\/]/.test(inputPath)) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function resolveMaybeRelative(baseDir: string, inputPath: string): string {
  const expanded = normalizePathWithHome(inputPath.trim());
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(baseDir, expanded);
}

function sanitizeSegment(input: string): string {
  const safe = input.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return safe || 'default';
}

function extractEnabled(config: Record<string, unknown>): boolean {
  return typeof config.enabled === 'boolean' ? config.enabled : true;
}

function stripKeys(config: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const deny = new Set(keys);
  for (const [key, value] of Object.entries(config)) {
    if (deny.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function extractChatConfig(
  config: Record<string, unknown>,
  chatEnabledOverride?: boolean,
): { chat: { enabled: boolean } } {
  if (typeof chatEnabledOverride === 'boolean') {
    return { chat: { enabled: chatEnabledOverride } };
  }
  const chat = config.chat;
  if (isRecord(chat) && typeof chat.enabled === 'boolean') {
    return { chat: { enabled: chat.enabled } };
  }
  // Default chat ON for synced channels unless source config or caller says otherwise.
  return { chat: { enabled: true } };
}

function resolveChannelKey(channels: Record<string, unknown>, requested: string): string | null {
  const target = normalizeChannel(requested);
  for (const key of Object.keys(channels)) {
    if (normalizeChannel(key) === target) return key;
  }
  return null;
}

function collectWhatsAppSourceDirs(channelConfig: Record<string, unknown>, source: OpenClawSource): WhatsAppSourceDir[] {
  const dirs: WhatsAppSourceDir[] = [];
  const accounts = channelConfig.accounts;

  if (isRecord(accounts)) {
    for (const [accountId, raw] of Object.entries(accounts)) {
      const accountConfig = isRecord(raw) ? raw : {};
      const accountAuthDir = typeof accountConfig.authDir === 'string' && accountConfig.authDir.trim()
        ? accountConfig.authDir
        : path.join(DEFAULT_OPENCLAW_WHATSAPP_ROOT, accountId);
      dirs.push({
        accountId,
        sourceDir: resolveMaybeRelative(source.configDir, accountAuthDir),
      });
    }
  }

  if (dirs.length > 0) return dirs;

  const topLevel = typeof channelConfig.authDir === 'string' && channelConfig.authDir.trim()
    ? channelConfig.authDir
    : path.join(DEFAULT_OPENCLAW_WHATSAPP_ROOT, 'default');

  dirs.push({
    accountId: 'default',
    sourceDir: resolveMaybeRelative(source.configDir, topLevel),
  });
  return dirs;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function validateTelegram(channel: string, rawConfig: unknown): Promise<ChannelValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const details: Record<string, unknown> = {};

  if (!isRecord(rawConfig)) {
    errors.push('Channel config is not an object.');
    return { channel, exists: true, supported: true, valid: false, errors, warnings, details };
  }

  const enabled = extractEnabled(rawConfig);
  details.enabled = enabled;
  const hasBotToken = typeof rawConfig.botToken === 'string' && rawConfig.botToken.trim().length > 0;
  details.hasBotToken = hasBotToken;

  if (!hasBotToken) {
    errors.push('telegram.botToken is missing.');
  }

  const hasChatId = typeof rawConfig.chatId === 'string' || typeof rawConfig.chatId === 'number';
  details.hasChatId = hasChatId;
  if (!hasChatId) {
    warnings.push('chatId is not set; Telegram notifications will not send until chatId is configured.');
  }

  return {
    channel,
    exists: true,
    supported: true,
    valid: errors.length === 0,
    errors,
    warnings,
    details,
  };
}

async function validateWhatsApp(channel: string, rawConfig: unknown, source: OpenClawSource): Promise<ChannelValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const details: Record<string, unknown> = {};

  if (!isRecord(rawConfig)) {
    errors.push('Channel config is not an object.');
    return { channel, exists: true, supported: true, valid: false, errors, warnings, details };
  }

  const enabled = extractEnabled(rawConfig);
  const sources = collectWhatsAppSourceDirs(rawConfig, source);
  const checks: Array<{ accountId: string; sourceDir: string; exists: boolean }> = [];

  for (const sourceDir of sources) {
    const exists = await pathExists(sourceDir.sourceDir);
    checks.push({ ...sourceDir, exists });
    if (!exists) {
      warnings.push(`WhatsApp auth directory not found for account "${sourceDir.accountId}": ${sourceDir.sourceDir}. Config will sync without local session files.`);
    }
  }

  details.enabled = enabled;
  details.accounts = checks;
  if (checks.length > 1) {
    warnings.push('Multiple WhatsApp accounts detected; all account sessions will be copied.');
  }

  return {
    channel,
    exists: true,
    supported: true,
    valid: true,
    errors,
    warnings,
    details,
  };
}

async function validateGeneric(channel: string, rawConfig: unknown): Promise<ChannelValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const details: Record<string, unknown> = {};

  if (!isRecord(rawConfig)) {
    errors.push('Channel config is not an object.');
    return { channel, exists: true, supported: true, valid: false, errors, warnings, details };
  }

  details.enabled = extractEnabled(rawConfig);
  warnings.push(`Channel "${channel}" will be imported as adapter type "${channel}", but no built-in runtime adapter exists yet.`);

  return {
    channel,
    exists: true,
    supported: true,
    valid: true,
    errors,
    warnings,
    details,
  };
}

async function prepareTelegramImport(
  channel: string,
  rawConfig: Record<string, unknown>,
  chatEnabledOverride?: boolean,
): Promise<PreparedImport> {
  const enabled = extractEnabled(rawConfig);
  const chat = extractChatConfig(rawConfig, chatEnabledOverride);
  const config = stripKeys(rawConfig, ['enabled', 'botToken', 'chat']);
  const botToken = String(rawConfig.botToken);

  return {
    entry: {
      type: channel,
      enabled,
      config,
      chat: chat.chat,
    },
    secrets: {
      botToken,
    },
  };
}

async function prepareWhatsAppImport(
  channel: string,
  rawConfig: Record<string, unknown>,
  source: OpenClawSource,
  chatEnabledOverride?: boolean,
): Promise<PreparedImport> {
  const enabled = extractEnabled(rawConfig);
  const chat = extractChatConfig(rawConfig, chatEnabledOverride);
  const sourceDirs = collectWhatsAppSourceDirs(rawConfig, source);
  const warnings: string[] = [];

  await fs.mkdir(WHATSAPP_IMPORT_ROOT, { recursive: true, mode: 0o700 });

  const accountDestinations: Array<{ accountId: string; sourceDir: string; destinationDir: string }> = [];
  for (const account of sourceDirs) {
    const sourceDir = path.resolve(account.sourceDir);
    const destinationDir = path.join(WHATSAPP_IMPORT_ROOT, sanitizeSegment(account.accountId));

    const sourceExists = await pathExists(sourceDir);
    if (!sourceExists) {
      warnings.push(`Skipped WhatsApp session copy for "${account.accountId}" (missing: ${sourceDir}).`);
      continue;
    }

    if (sourceDir === path.resolve(destinationDir)) {
      accountDestinations.push({
        accountId: account.accountId,
        sourceDir,
        destinationDir,
      });
      continue;
    }
    await fs.rm(destinationDir, { recursive: true, force: true });
    await fs.mkdir(destinationDir, { recursive: true, mode: 0o700 });
    await fs.cp(sourceDir, destinationDir, { recursive: true, force: true });
    accountDestinations.push({
      accountId: account.accountId,
      sourceDir,
      destinationDir,
    });
  }

  const config = stripKeys(rawConfig, ['enabled', 'chat']);
  const accounts = config.accounts;
  if (isRecord(accounts)) {
    const nextAccounts: Record<string, unknown> = {};
    for (const [accountId, raw] of Object.entries(accounts)) {
      const destination = accountDestinations.find((entry) => entry.accountId === accountId);
      const sourceAccount = sourceDirs.find((entry) => entry.accountId === accountId);
      const accountConfig = isRecord(raw) ? { ...raw } : {};
      accountConfig.authDir = destination?.destinationDir
        ?? accountConfig.authDir
        ?? sourceAccount?.sourceDir;
      nextAccounts[accountId] = accountConfig;
    }
    config.accounts = nextAccounts;
  } else if (accountDestinations.length > 0) {
    config.authDir = accountDestinations[0].destinationDir;
  } else if (typeof config.authDir !== 'string' || !config.authDir.trim()) {
    config.authDir = sourceDirs[0]?.sourceDir;
  }

  if (accountDestinations.length === 0) {
    warnings.push('No WhatsApp local session directories were copied. Channel config was synced only.');
  }

  return {
    entry: {
      type: channel,
      enabled,
      config,
      chat: chat.chat,
    },
    warnings,
    details: {
      copiedAccounts: accountDestinations,
    },
  };
}

async function prepareGenericImport(
  channel: string,
  rawConfig: Record<string, unknown>,
  chatEnabledOverride?: boolean,
): Promise<PreparedImport> {
  const enabled = extractEnabled(rawConfig);
  const chat = extractChatConfig(rawConfig, chatEnabledOverride);
  const config = stripKeys(rawConfig, ['enabled', 'chat']);

  const secretFields: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(config)) {
    if (!GENERIC_SECRET_KEYS.has(key)) continue;
    if (typeof value !== 'string' || !value.trim()) continue;
    secretFields.push({ key, value });
  }

  const secrets: AdapterSecrets = {};
  for (const secret of secretFields) {
    secrets[secret.key] = secret.value;
    delete config[secret.key];
  }

  const warnings: string[] = [];
  if (secretFields.length > 0) {
    warnings.push(`Stored ${secretFields.length} secret field(s) in adapter secret storage.`);
  }

  return {
    entry: {
      type: channel,
      enabled,
      config,
      chat: chat.chat,
    },
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    warnings,
    details: {
      storedSecretKeys: secretFields.map((entry) => entry.key),
    },
  };
}

async function upsertAdapterViaWallet(token: string, entry: AdapterEntry, secrets?: AdapterSecrets): Promise<WalletAdapterUpsertResponse> {
  const body: {
    type: string;
    enabled: boolean;
    config: Record<string, unknown>;
    chat?: { enabled?: boolean };
    secrets?: AdapterSecrets;
  } = {
    type: entry.type,
    enabled: entry.enabled,
    config: entry.config,
  };
  if (entry.chat) {
    body.chat = entry.chat;
  }
  if (secrets && Object.keys(secrets).length > 0) {
    body.secrets = secrets;
  }

  const response = await fetch(`${WALLET_API}/adapters`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  const data = await response.json().catch(() => ({})) as WalletAdapterUpsertResponse;
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Failed to save adapter config (${response.status})`);
  }
  return data;
}

async function readAdapterSecretKeys(token: string, type: string): Promise<string[]> {
  const response = await fetch(`${WALLET_API}/adapters`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });

  const data = await response.json().catch(() => ({})) as WalletAdaptersListResponse;
  if (!response.ok || data.success === false) {
    throw new Error(`Failed to verify adapter secrets (${response.status})`);
  }

  const adapters = Array.isArray(data.adapters) ? data.adapters : [];
  const target = adapters.find((adapter) => normalizeChannel(String(adapter.type || '')) === normalizeChannel(type));
  if (!target || !Array.isArray(target.secretKeys)) return [];
  return target.secretKeys.filter((key): key is string => typeof key === 'string');
}

export async function authorizeAdapterManage(request: NextRequest): Promise<{ ok: true; token: string } | { ok: false; response: NextResponse }> {
  const token = extractBearerToken(request.headers.get('authorization'));
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Authorization bearer token is required' },
        { status: 401 },
      ),
    };
  }

  const validation = await validateToken(token);
  if (!validation.valid || !validation.payload) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: validation.error || 'Invalid or expired token' },
        { status: 401 },
      ),
    };
  }

  if (!hasAnyPermission(validation, ['adapter:manage'])) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'adapter:manage permission is required' },
        { status: 403 },
      ),
    };
  }

  return { ok: true, token };
}

export async function resolveOpenClawSource(openclawConfigPath?: string): Promise<OpenClawSource> {
  const resolvedPath = openclawConfigPath && openclawConfigPath.trim()
    ? resolveMaybeRelative(process.cwd(), openclawConfigPath)
    : DEFAULT_OPENCLAW_CONFIG_PATH;

  const raw = await fs.readFile(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw) as OpenClawRoot;
  const channels = isRecord(parsed.channels) ? parsed.channels : {};

  return {
    configPath: resolvedPath,
    configDir: path.dirname(resolvedPath),
    channels,
  };
}

export async function validateOpenClawChannel(source: OpenClawSource, requestedChannel: string): Promise<ChannelValidationResult> {
  const resolvedKey = resolveChannelKey(source.channels, requestedChannel);
  const normalized = normalizeChannel(requestedChannel);

  if (!resolvedKey) {
    return {
      channel: normalized,
      exists: false,
      supported: false,
      valid: false,
      errors: [`Channel "${requestedChannel}" not found in ${source.configPath}`],
      warnings: [],
      details: {},
    };
  }

  const rawConfig = source.channels[resolvedKey];
  const channel = normalizeChannel(resolvedKey);

  if (channel === 'telegram') {
    return validateTelegram(channel, rawConfig);
  }
  if (channel === 'whatsapp') {
    return validateWhatsApp(channel, rawConfig, source);
  }
  return validateGeneric(channel, rawConfig);
}

export async function importOpenClawChannel(
  source: OpenClawSource,
  requestedChannel: string,
  token: string,
  options: ImportOptions = {},
): Promise<ChannelImportResult> {
  const validation = await validateOpenClawChannel(source, requestedChannel);
  if (!validation.exists || !validation.valid) {
    return {
      channel: validation.channel,
      imported: false,
      errors: [...validation.errors],
      warnings: [...validation.warnings],
      details: { ...validation.details },
      validation,
    };
  }

  const resolvedKey = resolveChannelKey(source.channels, requestedChannel);
  if (!resolvedKey) {
    return {
      channel: normalizeChannel(requestedChannel),
      imported: false,
      errors: [`Channel "${requestedChannel}" not found in ${source.configPath}`],
      warnings: [],
      details: {},
      validation,
    };
  }

  const rawConfig = source.channels[resolvedKey];
  if (!isRecord(rawConfig)) {
    return {
      channel: normalizeChannel(resolvedKey),
      imported: false,
      errors: ['Channel config is not an object.'],
      warnings: [],
      details: {},
      validation,
    };
  }

  try {
    const channel = normalizeChannel(resolvedKey);
    let prepared: PreparedImport;

    if (channel === 'telegram') {
      prepared = await prepareTelegramImport(channel, rawConfig, options.chatEnabled);
    } else if (channel === 'whatsapp') {
      prepared = await prepareWhatsAppImport(channel, rawConfig, source, options.chatEnabled);
    } else {
      prepared = await prepareGenericImport(channel, rawConfig, options.chatEnabled);
    }

    const saved = await upsertAdapterViaWallet(token, prepared.entry, prepared.secrets);
    let verifiedSecretKeys: string[] = saved.storedSecrets || [];
    if (prepared.secrets && Object.keys(prepared.secrets).length > 0) {
      verifiedSecretKeys = await readAdapterSecretKeys(token, prepared.entry.type);
      const expected = Object.keys(prepared.secrets);
      const missing = expected.filter((key) => !verifiedSecretKeys.includes(key));
      if (missing.length > 0) {
        throw new Error(`Failed to persist adapter secrets for ${prepared.entry.type}: ${missing.join(', ')}`);
      }
    }

    return {
      channel,
      imported: true,
      errors: [],
      warnings: [...validation.warnings, ...(prepared.warnings || [])],
      details: {
        ...validation.details,
        ...(prepared.details || {}),
        ...(verifiedSecretKeys.length > 0 ? { storedSecrets: verifiedSecretKeys } : {}),
      },
      validation,
      adapter: {
        type: prepared.entry.type,
        enabled: prepared.entry.enabled,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import failed';
    return {
      channel: normalizeChannel(resolvedKey),
      imported: false,
      errors: [message],
      warnings: [...validation.warnings],
      details: { ...validation.details },
      validation,
    };
  }
}
