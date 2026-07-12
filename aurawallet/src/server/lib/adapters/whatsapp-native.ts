import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import pino from 'pino';

const REQUIRE = createRequire(import.meta.url);
const WHATSAPP_CONNECT_TIMEOUT_MS = 15_000;

export interface BaileysModuleLike {
  default: (options: Record<string, unknown>) => BaileysSocketLike;
  useMultiFileAuthState: (authDir: string) => Promise<{ state: Record<string, unknown>; saveCreds: () => Promise<void> | void }>;
  fetchLatestBaileysVersion: () => Promise<{ version: number[] }>;
  makeCacheableSignalKeyStore: (keys: unknown, logger: unknown) => unknown;
}

export interface BaileysSocketLike {
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

export interface WhatsAppNativeSendInput {
  authDir: string;
  target: string;
  text: string;
  timeoutMs?: number;
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

export async function loadBaileysModule(): Promise<BaileysModuleLike> {
  if (baileysModulePromise) return baileysModulePromise;

  baileysModulePromise = (async () => {
    try {
      const moduleName = '@whiskeysockets/baileys';
      const direct = await import(moduleName);
      if (hasBaileysShape(direct)) return direct;
    } catch {
      // fall back to globally installed copies
    }

    for (const candidate of getBaileysCandidatePaths()) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const loaded = await import(pathToFileURL(candidate).href);
        if (hasBaileysShape(loaded)) return loaded;
      } catch {
        // keep scanning candidates
      }
    }

    throw new Error('WhatsApp native runtime is unavailable. Install @whiskeysockets/baileys or OpenClaw with bundled Baileys.');
  })();

  return baileysModulePromise;
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
    // Baileys send targets should not include device suffixes like :1.
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

function extractStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const output = error.output;
  if (isRecord(output) && typeof output.statusCode === 'number') {
    return output.statusCode;
  }
  if (typeof error.status === 'number') return error.status;
  return undefined;
}

function closeSocketQuietly(sock: BaileysSocketLike): void {
  try {
    sock.ws?.close?.();
  } catch {
    // no-op
  }
}

async function waitForSocketConnection(sock: BaileysSocketLike, timeoutMs: number): Promise<void> {
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
      const connection = update.connection;

      if (connection === 'open') {
        detach();
        resolve();
        return;
      }

      if (connection === 'close') {
        detach();
        const lastDisconnect = update.lastDisconnect;
        const status = extractStatusCode(lastDisconnect);
        const reason = status ? `status=${status}` : 'connection closed';
        reject(new Error(`WhatsApp connection closed (${reason})`));
      }
    };

    sock.ev.on('connection.update', onUpdate);
  });
}

export async function resolveDefaultTargetFromCreds(authDir: string): Promise<string | null> {
  try {
    const credsPath = path.join(authDir, 'creds.json');
    const raw = await fsp.readFile(credsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;

    const me = parsed.me;
    if (!isRecord(me)) return null;

    const id = me.id;
    if (typeof id === 'string' && id.trim()) return id.trim();
    return null;
  } catch {
    return null;
  }
}

export async function sendWhatsAppMessageNative(input: WhatsAppNativeSendInput): Promise<{ messageId?: string }> {
  const mod = await loadBaileysModule();
  const logger = pino({ level: 'silent' });

  const { state, saveCreds } = await mod.useMultiFileAuthState(input.authDir);
  const stateRecord = state as Record<string, unknown>;
  const creds = stateRecord.creds;
  const keys = stateRecord.keys;

  if (!creds || !keys) {
    throw new Error(`Invalid WhatsApp auth state at ${input.authDir}`);
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
    browser: ['auramaxx', 'server', '0.0.10'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const onCredsUpdate = (): void => {
    void Promise.resolve(saveCreds()).catch(() => {
      // ignore creds persistence failures during test-send
    });
  };
  sock.ev.on('creds.update', onCredsUpdate);

  try {
    await waitForSocketConnection(sock, input.timeoutMs ?? WHATSAPP_CONNECT_TIMEOUT_MS);

    const jid = toWhatsAppJid(input.target);
    const sent = await sock.sendMessage(jid, { text: input.text });

    const key = isRecord(sent) ? sent.key : undefined;
    const messageId = isRecord(key) && typeof key.id === 'string' ? key.id : undefined;
    return { messageId };
  } finally {
    if (typeof sock.ev.off === 'function') {
      sock.ev.off('creds.update', onCredsUpdate);
    } else if (typeof sock.ev.removeListener === 'function') {
      sock.ev.removeListener('creds.update', onCredsUpdate);
    }
    closeSocketQuietly(sock);
  }
}
