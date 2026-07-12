import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import pino from 'pino';
import type {
  ApprovalAdapter,
  AdapterContext,
  ActionNotification,
  ActionResolution,
  ChatMessage,
  ChatReply,
} from './types';
import { resolveDefaultTargetFromCreds } from './whatsapp-native';
import { getErrorMessage } from '../error';
import { getRandomStartBannerQuote } from '../../../lib/startBannerQuotes';

const REQUIRE = createRequire(import.meta.url);
const WHATSAPP_CONNECT_TIMEOUT_MS = 15_000;
const WHATSAPP_RECONNECT_DELAY_MS = 3_000;
const WHATSAPP_MESSAGE_CHUNK_SIZE = 3_000;
const BANNER_WIDTH = 62;
const WHATSAPP_TARGET_KEYS = ['testTarget', 'target', 'to', 'phone', 'recipient', 'chatId', 'jid'] as const;

interface BaileysModuleLike {
  default: (options: Record<string, unknown>) => BaileysSocketLike;
  useMultiFileAuthState: (authDir: string) => Promise<{ state: Record<string, unknown>; saveCreds: () => Promise<void> | void }>;
  fetchLatestBaileysVersion: () => Promise<{ version: number[] }>;
  makeCacheableSignalKeyStore: (keys: unknown, logger: unknown) => unknown;
}

interface BaileysSocketLike {
  ev: {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    off?: (event: string, listener: (...args: unknown[]) => void) => void;
    removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  };
  sendMessage: (jid: string, content: Record<string, unknown>) => Promise<Record<string, unknown>>;
  ws?: {
    close?: () => void;
  };
}

export interface WhatsAppAdapterConfig {
  authDir?: string;
  accounts?: Record<string, unknown>;
  chat?: { enabled?: boolean };
  [key: string]: unknown;
}

interface ResolveCommand {
  approved: boolean;
  actionRef: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasBaileysShape(value: unknown): value is BaileysModuleLike {
  if (!isRecord(value)) return false;
  return (
    typeof value.default === 'function' &&
    typeof value.useMultiFileAuthState === 'function' &&
    typeof value.fetchLatestBaileysVersion === 'function' &&
    typeof value.makeCacheableSignalKeyStore === 'function'
  );
}

function getGlobalModuleRoots(): string[] {
  const roots = new Set<string>();

  const addRoot = (candidate?: string | null): void => {
    if (!candidate) return;
    const normalized = candidate.trim();
    if (!normalized) return;
    roots.add(path.resolve(normalized));
  };

  const execPrefix = path.resolve(process.execPath, '..', '..');
  addRoot(path.join(execPrefix, 'lib', 'node_modules'));

  addRoot(process.env.npm_config_prefix ? path.join(process.env.npm_config_prefix, 'lib', 'node_modules') : null);
  addRoot(process.env.NPM_CONFIG_PREFIX ? path.join(process.env.NPM_CONFIG_PREFIX, 'lib', 'node_modules') : null);

  const maybeGlobalPaths = (REQUIRE as unknown as { globalPaths?: string[] }).globalPaths;
  if (Array.isArray(maybeGlobalPaths)) {
    for (const globalPath of maybeGlobalPaths) addRoot(globalPath);
  }

  addRoot('/usr/local/lib/node_modules');
  addRoot('/opt/homebrew/lib/node_modules');

  return Array.from(roots);
}

function getBaileysCandidatePaths(): string[] {
  const candidates = new Set<string>();
  for (const root of getGlobalModuleRoots()) {
    candidates.add(path.join(root, '@whiskeysockets', 'baileys', 'lib', 'index.js'));
    candidates.add(path.join(root, 'openclaw', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'index.js'));
  }
  return Array.from(candidates);
}

let baileysModulePromise: Promise<BaileysModuleLike> | null = null;

async function loadBaileysModule(): Promise<BaileysModuleLike> {
  if (baileysModulePromise) return baileysModulePromise;

  baileysModulePromise = (async () => {
    try {
      const moduleName = '@whiskeysockets/baileys';
      const direct = await import(moduleName);
      if (hasBaileysShape(direct)) return direct;
    } catch {
      // fall back to global candidates
    }

    for (const candidate of getBaileysCandidatePaths()) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const loaded = await import(pathToFileURL(candidate).href);
        if (hasBaileysShape(loaded)) return loaded;
      } catch {
        // continue scan
      }
    }

    throw new Error('WhatsApp runtime is unavailable. Install @whiskeysockets/baileys or OpenClaw with bundled Baileys.');
  })();

  return baileysModulePromise;
}

function readStringByKeys(config: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function collectAuthDirs(config: Record<string, unknown>): string[] {
  const dirs = new Set<string>();
  const topLevelAuthDir = config.authDir;
  if (typeof topLevelAuthDir === 'string' && topLevelAuthDir.trim()) {
    dirs.add(topLevelAuthDir.trim());
  }

  const accounts = config.accounts;
  if (isRecord(accounts)) {
    for (const raw of Object.values(accounts)) {
      if (!isRecord(raw)) continue;
      const accountAuthDir = raw.authDir;
      if (typeof accountAuthDir === 'string' && accountAuthDir.trim()) {
        dirs.add(accountAuthDir.trim());
      }
    }
  }

  return Array.from(dirs);
}

function resolveTargetFromConfig(config: Record<string, unknown>): string | null {
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

function toWhatsAppJid(target: string): string {
  const trimmed = target.trim().replace(/^whatsapp:/i, '');
  if (!trimmed) {
    throw new Error('WhatsApp target is empty');
  }

  if (trimmed.includes('@')) {
    const atIndex = trimmed.lastIndexOf('@');
    const localPartRaw = trimmed.slice(0, atIndex);
    const domainPart = trimmed.slice(atIndex + 1);
    if (!localPartRaw || !domainPart) {
      throw new Error(`Invalid WhatsApp target: ${target}`);
    }
    const localPart = localPartRaw.includes(':')
      ? localPartRaw.slice(0, localPartRaw.indexOf(':'))
      : localPartRaw;
    if (!localPart) {
      throw new Error(`Invalid WhatsApp target: ${target}`);
    }
    return `${localPart}@${domainPart}`;
  }

  const digits = trimmed.replace(/\D+/g, '');
  if (!digits) {
    throw new Error(`Invalid WhatsApp target: ${target}`);
  }

  return `${digits}@s.whatsapp.net`;
}

function normalizeJid(jid: string): string {
  const trimmed = jid.trim();
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex <= 0) return trimmed;
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  const normalizedLocal = local.includes(':')
    ? local.slice(0, local.indexOf(':'))
    : local;
  return `${normalizedLocal}@${domain}`.toLowerCase();
}

function closeSocketQuietly(sock: BaileysSocketLike): void {
  try {
    sock.ws?.close?.();
  } catch {
    // no-op
  }
}

function extractStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const output = error.output;
  if (isRecord(output) && typeof output.statusCode === 'number') {
    return output.statusCode;
  }
  if (typeof error.status === 'number') return error.status;
  return undefined;
}

function parseResolveCommand(text: string): ResolveCommand | null {
  const match = text.trim().match(/^\/?(approve|accept|yes|reject|deny|no)(?:\s+([A-Za-z0-9._:-]+))?$/i);
  if (!match) return null;

  const action = match[1].toLowerCase();
  const approved = action === 'approve' || action === 'accept' || action === 'yes';
  return {
    approved,
    actionRef: match[2] ? match[2].trim() : null,
  };
}

function extractMessageText(rawMessage: unknown): string | null {
  if (!isRecord(rawMessage)) return null;
  const conversation = rawMessage.conversation;
  if (typeof conversation === 'string' && conversation.trim()) return conversation.trim();

  const extended = rawMessage.extendedTextMessage;
  if (isRecord(extended) && typeof extended.text === 'string' && extended.text.trim()) {
    return extended.text.trim();
  }

  const image = rawMessage.imageMessage;
  if (isRecord(image) && typeof image.caption === 'string' && image.caption.trim()) {
    return image.caption.trim();
  }

  const video = rawMessage.videoMessage;
  if (isRecord(video) && typeof video.caption === 'string' && video.caption.trim()) {
    return video.caption.trim();
  }

  return null;
}

function splitText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const chunk = text.slice(cursor, cursor + size);
    chunks.push(chunk);
    cursor += size;
  }
  return chunks;
}

function shortActionId(actionId: string): string {
  return actionId.slice(0, 12);
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

function buildBannerMessage(subtitle: string, ...lines: string[]): string {
  const quote = getRandomStartBannerQuote();
  const body = lines.filter((line) => typeof line === 'string' && line.trim().length > 0);
  return `${buildDecoratedBanner(subtitle)}\n  ${quote}${body.length > 0 ? `\n\n${body.join('\n')}` : ''}`;
}

export class WhatsAppAdapter implements ApprovalAdapter {
  readonly name = 'whatsapp';
  private config: Record<string, unknown>;
  private ctx: AdapterContext | null = null;
  private isRunning = false;
  private isConnected = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private sock: BaileysSocketLike | null = null;
  private authDir: string | null = null;
  private targetJid: string | null = null;
  private allowedJids = new Set<string>();
  private allowFromJids = new Set<string>();
  private allowAllSenders = false;
  private pendingActions = new Set<string>();
  private shortActionMap = new Map<string, string>();
  private latestActionId: string | null = null;
  private sentMessageIds = new Map<string, number>();
  private credsUpdateListener: ((...args: unknown[]) => void) | null = null;
  private connectionUpdateListener: ((...args: unknown[]) => void) | null = null;
  private messageUpsertListener: ((...args: unknown[]) => void) | null = null;

  constructor(config: WhatsAppAdapterConfig) {
    this.config = isRecord(config) ? config : {};
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.isRunning = true;

    try {
      await this.prepareConfig();
      await this.ensureConnected();
      console.log('[adapters] whatsapp: started');
    } catch (err) {
      console.error('[adapters] whatsapp: failed to start:', getErrorMessage(err));
    }
  }

  async notify(action: ActionNotification): Promise<void> {
    if (action.type === 'notify') {
      const text = this.formatInfoNotification(action);
      await this.sendText(text).catch((err) => {
        console.error('[adapters] whatsapp notify error:', getErrorMessage(err));
      });
      return;
    }

    this.pendingActions.add(action.id);
    this.shortActionMap.set(shortActionId(action.id).toLowerCase(), action.id);
    this.latestActionId = action.id;

    const text = this.formatActionNotification(action);
    await this.sendText(text).catch((err) => {
      console.error('[adapters] whatsapp notify error:', getErrorMessage(err));
    });
  }

  async resolved(resolution: ActionResolution): Promise<void> {
    if (!this.pendingActions.has(resolution.id)) return;

    this.pendingActions.delete(resolution.id);
    const shortId = shortActionId(resolution.id).toLowerCase();
    if (this.shortActionMap.get(shortId) === resolution.id) {
      this.shortActionMap.delete(shortId);
    }
    if (this.latestActionId === resolution.id) {
      this.latestActionId = null;
    }

    const status = resolution.approved ? 'APPROVED' : 'REJECTED';
    const actionLine = `Action ${shortActionId(resolution.id)} ${resolution.approved ? 'approved' : 'rejected'}.`;
    const text = buildBannerMessage(status, actionLine, `Resolved by ${resolution.resolvedBy}.`);
    await this.sendText(text).catch((err) => {
      console.debug('[adapters] whatsapp: failed to send resolution message:', getErrorMessage(err));
    });
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.isConnected = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.pendingActions.clear();
    this.shortActionMap.clear();
    this.latestActionId = null;
    this.sentMessageIds.clear();
    this.allowedJids.clear();
    this.allowFromJids.clear();
    this.allowAllSenders = false;

    this.detachAndCloseSocket();
    console.log('[adapters] whatsapp: stopped');
  }

  async onMessage(message: ChatMessage): Promise<ChatReply | null> {
    if (!this.ctx) return null;
    const chat = this.config.chat;
    if (!isRecord(chat) || chat.enabled !== true) return null;

    const appId = await this.ctx.resolveApp(message.targetApp);
    if (!appId) {
      return { text: 'No AI app configured. Set a default app in adapter settings.' };
    }

    const result = await this.ctx.sendMessage(appId, message.text, undefined, 'whatsapp');
    if (result.error) {
      return { text: `Error: ${result.error}` };
    }

    return result.reply ? { text: result.reply } : null;
  }

  private async prepareConfig(): Promise<void> {
    const authDir = await this.resolveAuthDir();
    if (!authDir) {
      throw new Error('No valid WhatsApp authDir found (missing creds.json). Re-sync from OpenClaw.');
    }
    this.authDir = authDir;

    const targetFromConfig = resolveTargetFromConfig(this.config);
    const defaultTarget = await resolveDefaultTargetFromCreds(authDir);
    const chosenTarget = targetFromConfig || defaultTarget;
    if (!chosenTarget) {
      throw new Error('WhatsApp target is not configured and no default account was found in creds.json.');
    }

    this.targetJid = toWhatsAppJid(chosenTarget);
    this.allowedJids = new Set<string>([
      normalizeJid(this.targetJid),
    ]);
    if (defaultTarget) {
      this.allowedJids.add(normalizeJid(toWhatsAppJid(defaultTarget)));
    }

    this.allowFromJids.clear();
    this.allowAllSenders = false;
    const allowFrom = this.config.allowFrom;
    if (Array.isArray(allowFrom)) {
      for (const raw of allowFrom) {
        if (typeof raw !== 'string') continue;
        const entry = raw.trim();
        if (!entry) continue;
        if (entry === '*') {
          this.allowAllSenders = true;
          continue;
        }
        try {
          this.allowFromJids.add(normalizeJid(toWhatsAppJid(entry)));
        } catch {
          if (entry.includes('@')) {
            this.allowFromJids.add(normalizeJid(entry));
          }
        }
      }
    }
  }

  private async resolveAuthDir(): Promise<string | null> {
    const candidates = collectAuthDirs(this.config);
    if (candidates.length === 0) return null;

    for (const dir of candidates) {
      try {
        await fsp.access(path.join(dir, 'creds.json'));
        return dir;
      } catch {
        // keep scanning
      }
    }

    return null;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.isRunning) return;
    if (this.isConnected && this.sock) return;
    if (!this.authDir) {
      throw new Error('WhatsApp authDir is not configured');
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });
    await this.connectPromise;
  }

  private async connect(): Promise<void> {
    const authDir = this.authDir;
    if (!authDir) {
      throw new Error('Missing WhatsApp authDir');
    }

    this.detachAndCloseSocket();
    this.isConnected = false;

    const mod = await loadBaileysModule();
    const logger = pino({ level: 'silent' });
    const { state, saveCreds } = await mod.useMultiFileAuthState(authDir);
    const stateRecord = state as Record<string, unknown>;
    const creds = stateRecord.creds;
    const keys = stateRecord.keys;

    if (!creds || !keys) {
      throw new Error(`Invalid WhatsApp auth state at ${authDir}`);
    }

    const { version } = await mod.fetchLatestBaileysVersion();
    const sock = mod.default({
      auth: {
        creds,
        keys: mod.makeCacheableSignalKeyStore(keys, logger),
      },
      version,
      logger,
      printQRInTerminal: false,
      browser: ['auramaxx', 'adapter', '0.0.1'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock = sock;

    this.credsUpdateListener = () => {
      void Promise.resolve(saveCreds()).catch(() => {
        // non-fatal
      });
    };
    sock.ev.on('creds.update', this.credsUpdateListener);

    this.connectionUpdateListener = (rawUpdate: unknown) => {
      void this.handleConnectionUpdate(rawUpdate);
    };
    sock.ev.on('connection.update', this.connectionUpdateListener);

    this.messageUpsertListener = (rawUpsert: unknown) => {
      void this.handleMessagesUpsert(rawUpsert);
    };
    sock.ev.on('messages.upsert', this.messageUpsertListener);

    await this.waitForConnection(sock, WHATSAPP_CONNECT_TIMEOUT_MS);
    this.isConnected = true;
  }

  private async waitForConnection(sock: BaileysSocketLike, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        detach();
        reject(new Error('Timed out waiting for WhatsApp connection'));
      }, timeoutMs);

      const detach = (): void => {
        clearTimeout(timeout);
        if (typeof sock.ev.off === 'function') {
          sock.ev.off('connection.update', onUpdate);
        } else if (typeof sock.ev.removeListener === 'function') {
          sock.ev.removeListener('connection.update', onUpdate);
        }
      };

      const onUpdate = (rawUpdate: unknown): void => {
        const update = isRecord(rawUpdate) ? rawUpdate : {};
        if (update.connection === 'open') {
          detach();
          resolve();
        }
      };

      sock.ev.on('connection.update', onUpdate);
    });
  }

  private async handleConnectionUpdate(rawUpdate: unknown): Promise<void> {
    const update = isRecord(rawUpdate) ? rawUpdate : {};
    const connection = update.connection;

    if (connection === 'open') {
      this.isConnected = true;
      console.log('[adapters] whatsapp: connected');
      return;
    }

    if (connection !== 'close') return;

    this.isConnected = false;
    const status = extractStatusCode(update.lastDisconnect);
    if (status === 401) {
      console.error('[adapters] whatsapp: session logged out (status=401). Re-sync from OpenClaw.');
      return;
    }

    const reason = status ? `status=${status}` : 'connection closed';
    console.warn(`[adapters] whatsapp: disconnected (${reason})`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.isRunning) return;
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      void this.ensureConnected().catch((err) => {
        console.error('[adapters] whatsapp: reconnect failed:', getErrorMessage(err));
        this.scheduleReconnect();
      });
    }, WHATSAPP_RECONNECT_DELAY_MS);
  }

  private detachAndCloseSocket(): void {
    if (!this.sock) return;
    const sock = this.sock;

    if (this.credsUpdateListener) {
      if (typeof sock.ev.off === 'function') {
        sock.ev.off('creds.update', this.credsUpdateListener);
      } else if (typeof sock.ev.removeListener === 'function') {
        sock.ev.removeListener('creds.update', this.credsUpdateListener);
      }
      this.credsUpdateListener = null;
    }

    if (this.connectionUpdateListener) {
      if (typeof sock.ev.off === 'function') {
        sock.ev.off('connection.update', this.connectionUpdateListener);
      } else if (typeof sock.ev.removeListener === 'function') {
        sock.ev.removeListener('connection.update', this.connectionUpdateListener);
      }
      this.connectionUpdateListener = null;
    }

    if (this.messageUpsertListener) {
      if (typeof sock.ev.off === 'function') {
        sock.ev.off('messages.upsert', this.messageUpsertListener);
      } else if (typeof sock.ev.removeListener === 'function') {
        sock.ev.removeListener('messages.upsert', this.messageUpsertListener);
      }
      this.messageUpsertListener = null;
    }

    closeSocketQuietly(sock);
    this.sock = null;
  }

  private async handleMessagesUpsert(rawUpsert: unknown): Promise<void> {
    if (!this.ctx) return;
    if (!isRecord(rawUpsert)) return;

    const messages = rawUpsert.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    for (const rawMessage of messages) {
      if (!isRecord(rawMessage)) continue;

      const key = isRecord(rawMessage.key) ? rawMessage.key : null;
      const message = rawMessage.message;
      if (!key || !isRecord(message)) continue;

      const id = typeof key.id === 'string' ? key.id : '';
      if (id && this.sentMessageIds.has(id)) {
        this.sentMessageIds.delete(id);
        continue;
      }

      const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : '';
      if (!remoteJid) continue;
      if (!this.isAllowedSender(remoteJid)) {
        console.warn(
          `[adapters] whatsapp: ignoring message from ${remoteJid} (allowed: ${Array.from(this.allowedJids).join(', ')})`,
        );
        continue;
      }

      const text = extractMessageText(message);
      if (!text) continue;

      await this.handleIncomingText(remoteJid, text);
    }

    this.pruneSentMessageIds();
  }

  private isAllowedSender(remoteJid: string): boolean {
    if (this.allowAllSenders) return true;
    if (this.allowedJids.size === 0) return false;
    const normalized = normalizeJid(remoteJid);
    if (this.allowedJids.has(normalized)) return true;
    if (this.allowFromJids.has(normalized)) return true;
    return false;
  }

  private async handleIncomingText(senderId: string, text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;

    const resolveCommand = parseResolveCommand(clean);
    if (resolveCommand) {
      let actionId = this.resolveActionId(resolveCommand.actionRef);
      if (!actionId) {
        actionId = await this.resolveActionIdFromDb(resolveCommand.actionRef);
      }
      if (!actionId) {
        console.warn('[adapters] whatsapp: could not match action for resolve command', {
          requested: resolveCommand.actionRef || '(latest)',
          pendingCount: this.pendingActions.size,
        });
        await this.sendText(
          'Could not match that action ID. Reply with "approve <id>" or "reject <id>".',
        ).catch(() => {});
        return;
      }

      console.log(`[adapters] whatsapp: resolving ${actionId} via chat command (${resolveCommand.approved ? 'approve' : 'reject'})`);
      const result = await this.ctx!.resolve(actionId, resolveCommand.approved);
      if (result.success) {
        const verb = resolveCommand.approved ? 'approved' : 'rejected';
        const subtitle = resolveCommand.approved ? 'APPROVED' : 'REJECTED';
        const actionLine = `Action ${shortActionId(actionId)} ${verb}.`;
        await this.sendText(buildBannerMessage(subtitle, actionLine)).catch(() => {});
      } else {
        const verb = resolveCommand.approved ? 'approve' : 'reject';
        await this.sendText(`Failed to ${verb} ${shortActionId(actionId)}: ${result.error || 'unknown error'}`).catch(() => {});
      }
      return;
    }

    const reply = await this.onMessage({
      text: clean,
      senderId,
    });
    if (!reply?.text) return;

    await this.sendText(reply.text).catch((err) => {
      console.error('[adapters] whatsapp: failed to send chat reply:', getErrorMessage(err));
    });
  }

  private resolveActionId(actionRef: string | null): string | null {
    if (actionRef) {
      if (this.pendingActions.has(actionRef)) return actionRef;

      const normalized = actionRef.toLowerCase();
      const mapped = this.shortActionMap.get(normalized);
      if (mapped && this.pendingActions.has(mapped)) return mapped;

      const prefixMatches = Array.from(this.pendingActions).filter((id) => id.toLowerCase().startsWith(normalized));
      if (prefixMatches.length === 1) return prefixMatches[0];
      return null;
    }

    if (this.latestActionId && this.pendingActions.has(this.latestActionId)) {
      return this.latestActionId;
    }
    if (this.pendingActions.size === 1) {
      return Array.from(this.pendingActions)[0];
    }
    return null;
  }

  private async resolveActionIdFromDb(actionRef: string | null): Promise<string | null> {
    try {
      const { prisma } = await import('../db');

      if (actionRef) {
        const normalized = actionRef.trim().toLowerCase();
        if (!normalized) return null;

        const candidates = await prisma.humanAction.findMany({
          where: {
            status: 'pending',
          },
          select: {
            id: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 25,
        });

        const matches = candidates
          .map((row) => row.id)
          .filter((id) => id.toLowerCase() === normalized || id.toLowerCase().startsWith(normalized));
        if (matches.length === 1) return matches[0];
        return null;
      }

      const pending = await prisma.humanAction.findMany({
        where: {
          status: 'pending',
        },
        select: {
          id: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 2,
      });

      if (pending.length === 1) return pending[0].id;
      return null;
    } catch {
      return null;
    }
  }

  private async sendText(text: string): Promise<void> {
    if (!this.targetJid) {
      throw new Error('WhatsApp target is not configured');
    }

    await this.ensureConnected();
    const sock = this.sock;
    if (!sock) {
      throw new Error('WhatsApp socket is not connected');
    }

    const chunks = splitText(text, WHATSAPP_MESSAGE_CHUNK_SIZE);
    for (const chunk of chunks) {
      const sent = await sock.sendMessage(this.targetJid, { text: chunk });
      const key = isRecord(sent) ? sent.key : undefined;
      const id = isRecord(key) && typeof key.id === 'string' ? key.id : null;
      if (id) {
        this.sentMessageIds.set(id, Date.now());
      }
    }
  }

  private pruneSentMessageIds(): void {
    if (this.sentMessageIds.size <= 500) return;
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, timestamp] of this.sentMessageIds.entries()) {
      if (timestamp < cutoff) {
        this.sentMessageIds.delete(id);
      }
    }
    while (this.sentMessageIds.size > 500) {
      const oldest = this.sentMessageIds.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sentMessageIds.delete(oldest);
    }
  }

  private formatInfoNotification(action: ActionNotification): string {
    const lines = [
      action.summary,
      `Source: ${action.source}`,
    ];
    return lines.join('\n');
  }

  private formatActionNotification(action: ActionNotification): string {
    const vs = action.verifiedSummary || (action.metadata?.verifiedSummary as ActionNotification['verifiedSummary']);
    const shortId = shortActionId(action.id);
    const lines = [
      'New Action Request',
      `Type: ${action.type}`,
      `Source: ${action.source}`,
    ];

    if (vs?.oneLiner) {
      lines.push(`Action: ${vs.oneLiner}`);
      if (action.summary !== vs.oneLiner) {
        lines.push(`Agent says: ${action.summary}`);
      }
    } else {
      lines.push(`Summary: ${action.summary}`);
    }

    lines.push(`ID: ${shortId}`);

    if (action.expiresAt) {
      lines.push(`Expires: ${new Date(action.expiresAt).toISOString()}`);
    }

    lines.push('');
    lines.push(`Reply with "approve ${shortId}" or "reject ${shortId}"`);
    return lines.join('\n');
  }
}
