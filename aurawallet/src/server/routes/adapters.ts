import { Router, Request, Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import pino from 'pino';
import { prisma } from '../lib/db';
import { requireWalletAuth } from '../middleware/auth';
import { requirePermissionForRoute } from '../lib/permissions';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';
import { ApprovalRouter, loadAdaptersFromDb } from '../lib/adapters';
import { buildAdapterTestMessage, sendHumanMessageViaAdapter, type SupportedAdapterType } from '../lib/adapters/delivery';
import { DATA_PATHS, SERVER_PORT } from '../lib/config';
import {
  APIKEY_DB_PLACEHOLDER,
  ensureApiKeysMigrated,
  listApiKeyCredentials,
  readApiKeyValueByService,
  readApiKeyValueByServiceName,
  upsertApiKeyCredential,
} from '../lib/apikey-migration';
import { isUnlocked } from '../lib/cold';
import { logger } from '../lib/logger';
import { getErrorMessage } from '../lib/error';
import { loadBaileysModule, type BaileysSocketLike } from '../lib/adapters/whatsapp-native';

/** Reference to the live approval router (set via setApprovalRouter) */
let approvalRouter: ApprovalRouter | null = null;

/** In-memory nonce store for Telegram chat ID auto-detection */
interface SetupNonce {
  botToken: string;
  botUsername: string;
  expiresAt: number;
  /** getUpdates offset — skip all updates before this ID */
  offset?: number;
}
const telegramSetupNonces = new Map<string, SetupNonce>();

/** Exported for testing */
export { telegramSetupNonces };

type WhatsAppSetupStatus = 'idle' | 'waiting_qr' | 'qr_ready' | 'connected' | 'error';

interface WhatsAppSetupSession {
  setupId: string;
  authDir: string;
  status: WhatsAppSetupStatus;
  qr: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  sock: BaileysSocketLike | null;
  onCredsUpdate: ((...args: unknown[]) => void) | null;
  onConnectionUpdate: ((...args: unknown[]) => void) | null;
  restartInFlight: boolean;
  restartAttempts: number;
  timeout: NodeJS.Timeout | null;
}

const WHATSAPP_SETUP_TTL_MS = 5 * 60_000;
const WHATSAPP_SETUP_CONNECT_TIMEOUT_MS = 8_000;
const WHATSAPP_SETUP_RESTART_DELAY_MS = 350;
const WHATSAPP_SETUP_MAX_RESTARTS = 8;
let whatsappSetupSession: WhatsAppSetupSession | null = null;

/** Called from server/index.ts to share the approval router reference */
export function setApprovalRouter(router: ApprovalRouter | null): void {
  approvalRouter = router;
}

/** Called from server/index.ts to read current router */
export function getApprovalRouter(): ApprovalRouter | null {
  return approvalRouter;
}

const router = Router();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringByKeys(config: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function getDefaultWhatsAppAuthDir(): string {
  return path.join(DATA_PATHS.wallets, 'adapters', 'whatsapp', 'default');
}

function normalizeConnectionCloseReason(raw: unknown): string {
  const fallback = 'connection closed';
  const statusCode = extractConnectionStatusCode(raw);
  if (typeof statusCode === 'number') return `status=${statusCode}`;
  return fallback;
}

function extractConnectionStatusCode(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const output = raw.output;
  if (!isRecord(output)) return null;
  const statusCode = output.statusCode;
  if (typeof statusCode === 'number' && Number.isFinite(statusCode)) return statusCode;
  return null;
}

function serializeWhatsAppSetupSession(session: WhatsAppSetupSession | null): {
  success: boolean;
  setupId?: string;
  status: WhatsAppSetupStatus;
  qr?: string | null;
  error?: string | null;
  authDir?: string;
  expiresAt?: number;
} {
  if (!session) {
    return { success: true, status: 'idle' };
  }
  return {
    success: true,
    setupId: session.setupId,
    status: session.status,
    qr: session.qr,
    error: session.error,
    authDir: session.authDir,
    expiresAt: session.expiresAt,
  };
}

function clearWhatsAppSetupSessionTimeout(session: WhatsAppSetupSession | null): void {
  if (!session?.timeout) return;
  clearTimeout(session.timeout);
  session.timeout = null;
}

function closeWhatsAppSetupSocket(session: WhatsAppSetupSession | null): void {
  if (!session?.sock) return;
  const sock = session.sock;
  if (session.onCredsUpdate) {
    if (typeof sock.ev.off === 'function') {
      sock.ev.off('creds.update', session.onCredsUpdate);
    } else if (typeof sock.ev.removeListener === 'function') {
      sock.ev.removeListener('creds.update', session.onCredsUpdate);
    }
    session.onCredsUpdate = null;
  }
  if (session.onConnectionUpdate) {
    if (typeof sock.ev.off === 'function') {
      sock.ev.off('connection.update', session.onConnectionUpdate);
    } else if (typeof sock.ev.removeListener === 'function') {
      sock.ev.removeListener('connection.update', session.onConnectionUpdate);
    }
    session.onConnectionUpdate = null;
  }
  try {
    sock.ws?.close?.();
  } catch {
    // no-op
  }
  session.sock = null;
}

function destroyWhatsAppSetupSession(): void {
  if (!whatsappSetupSession) return;
  clearWhatsAppSetupSessionTimeout(whatsappSetupSession);
  closeWhatsAppSetupSocket(whatsappSetupSession);
  whatsappSetupSession = null;
}

function refreshWhatsAppSetupSessionExpiry(session: WhatsAppSetupSession, ttlMs: number = WHATSAPP_SETUP_TTL_MS): void {
  clearWhatsAppSetupSessionTimeout(session);
  session.expiresAt = Date.now() + ttlMs;
  session.timeout = setTimeout(() => {
    if (whatsappSetupSession?.setupId === session.setupId) {
      destroyWhatsAppSetupSession();
    }
  }, ttlMs);
}

function cleanupExpiredWhatsAppSetupSession(): void {
  if (!whatsappSetupSession) return;
  if (whatsappSetupSession.expiresAt <= Date.now()) {
    destroyWhatsAppSetupSession();
  }
}

function collectWhatsAppAuthDirsFromConfig(config: Record<string, unknown> | null | undefined): string[] {
  const dirs = new Set<string>();

  const addDir = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    dirs.add(path.resolve(trimmed));
  };

  if (config) {
    addDir(config.authDir);
    const accounts = config.accounts;
    if (isRecord(accounts)) {
      for (const rawAccount of Object.values(accounts)) {
        if (!isRecord(rawAccount)) continue;
        addDir(rawAccount.authDir);
      }
    }
  }

  if (dirs.size === 0) {
    dirs.add(path.resolve(getDefaultWhatsAppAuthDir()));
  }

  return Array.from(dirs);
}

async function purgeWhatsAppAuthState(config: Record<string, unknown> | null | undefined): Promise<void> {
  const authDirs = collectWhatsAppAuthDirsFromConfig(config);
  for (const authDir of authDirs) {
    try {
      await fs.rm(authDir, { recursive: true, force: true });
    } catch {
      // non-fatal cleanup
    }
  }
}

async function ensureWhatsAppAdapterConfig(authDir: string): Promise<void> {
  const appConfig = await prisma.appConfig.findUnique({ where: { id: 'global' } });
  let current: {
    enabled: boolean;
    chat?: { defaultApp?: string };
    adapters: Array<{ type: string; enabled: boolean; config: Record<string, unknown>; chat?: { enabled?: boolean } }>;
  } = {
    enabled: true,
    adapters: [],
  };

  if (appConfig?.adapterConfig) {
    try {
      current = JSON.parse(appConfig.adapterConfig);
    } catch {
      // fallback to default shape
    }
  }

  const idx = current.adapters.findIndex((entry) => entry.type.trim().toLowerCase() === 'whatsapp');
  const existing = idx >= 0 ? current.adapters[idx] : null;
  const nextConfig = existing?.config && isRecord(existing.config) ? { ...existing.config } : {};
  if (!readStringByKeys(nextConfig, ['authDir'])) {
    nextConfig.authDir = authDir;
  }
  if (!Array.isArray(nextConfig.allowFrom)) {
    nextConfig.allowFrom = ['*'];
  }
  if (typeof nextConfig.dmPolicy !== 'string') {
    nextConfig.dmPolicy = 'open';
  }
  if (typeof nextConfig.groupPolicy !== 'string') {
    nextConfig.groupPolicy = 'allowlist';
  }

  const nextEntry = {
    type: 'whatsapp',
    enabled: existing?.enabled ?? true,
    config: nextConfig,
    chat: existing?.chat ?? { enabled: true },
  };

  if (idx >= 0) {
    current.adapters[idx] = nextEntry;
  } else {
    current.adapters.push(nextEntry);
  }
  current.enabled = current.enabled || nextEntry.enabled;

  await prisma.appConfig.upsert({
    where: { id: 'global' },
    update: { adapterConfig: JSON.stringify(current) },
    create: { id: 'global', adapterConfig: JSON.stringify(current) },
  });
}

function scheduleWhatsAppSetupReconnect(session: WhatsAppSetupSession, reason: string): void {
  if (!whatsappSetupSession || whatsappSetupSession.setupId !== session.setupId) return;
  if (session.restartInFlight) return;

  if (session.restartAttempts >= WHATSAPP_SETUP_MAX_RESTARTS) {
    session.status = 'error';
    session.error = `WhatsApp setup failed after ${WHATSAPP_SETUP_MAX_RESTARTS} reconnect attempts (${reason}). Try Generate QR again.`;
    closeWhatsAppSetupSocket(session);
    refreshWhatsAppSetupSessionExpiry(session, 60_000);
    return;
  }

  session.restartInFlight = true;
  session.restartAttempts += 1;
  session.status = 'waiting_qr';
  session.qr = null;
  session.error = null;
  closeWhatsAppSetupSocket(session);
  refreshWhatsAppSetupSessionExpiry(session, WHATSAPP_SETUP_TTL_MS);

  setTimeout(() => {
    void (async () => {
      if (!whatsappSetupSession || whatsappSetupSession.setupId !== session.setupId) return;
      try {
        await attachWhatsAppSetupSocket(session);
      } catch (err) {
        if (!whatsappSetupSession || whatsappSetupSession.setupId !== session.setupId) return;
        session.status = 'error';
        session.error = `WhatsApp setup reconnect failed: ${getErrorMessage(err)}`;
        closeWhatsAppSetupSocket(session);
        refreshWhatsAppSetupSessionExpiry(session, 60_000);
      } finally {
        if (whatsappSetupSession && whatsappSetupSession.setupId === session.setupId) {
          session.restartInFlight = false;
        }
      }
    })();
  }, WHATSAPP_SETUP_RESTART_DELAY_MS);
}

async function attachWhatsAppSetupSocket(session: WhatsAppSetupSession): Promise<void> {
  const mod = await loadBaileysModule();
  const loggerInstance = pino({ level: 'silent' });
  const { state, saveCreds } = await mod.useMultiFileAuthState(session.authDir);
  const stateRecord = state as Record<string, unknown>;
  const creds = stateRecord.creds;
  const keys = stateRecord.keys;
  if (!creds || !keys) {
    throw new Error(`Invalid WhatsApp auth state at ${session.authDir}`);
  }

  const { version } = await mod.fetchLatestBaileysVersion();
  closeWhatsAppSetupSocket(session);
  const sock = mod.default({
    auth: {
      creds,
      keys: mod.makeCacheableSignalKeyStore(keys, loggerInstance),
    },
    version,
    logger: loggerInstance,
    printQRInTerminal: false,
    browser: ['auramaxx', 'setup', '0.0.1'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  session.sock = sock;

  session.onCredsUpdate = () => {
    void Promise.resolve(saveCreds()).catch(() => {
      // non-fatal
    });
  };
  sock.ev.on('creds.update', session.onCredsUpdate);

  session.onConnectionUpdate = (rawUpdate: unknown) => {
    if (!whatsappSetupSession || whatsappSetupSession.setupId !== session.setupId) return;
    const update = isRecord(rawUpdate) ? rawUpdate : {};
    session.updatedAt = Date.now();

    const rawQr = update.qr;
    if (typeof rawQr === 'string' && rawQr.trim().length > 0) {
      session.qr = rawQr.trim();
      session.status = 'qr_ready';
      session.error = null;
      session.restartAttempts = 0;
      refreshWhatsAppSetupSessionExpiry(session, WHATSAPP_SETUP_TTL_MS);
    }

    const connection = update.connection;
    if (connection === 'open') {
      session.status = 'connected';
      session.qr = null;
      session.error = null;
      session.restartInFlight = false;
      session.restartAttempts = 0;
      closeWhatsAppSetupSocket(session);
      refreshWhatsAppSetupSessionExpiry(session, 60_000);
      return;
    }

    if (connection === 'close' && session.status !== 'connected') {
      const statusCode = extractConnectionStatusCode(update.lastDisconnect);
      const reason = normalizeConnectionCloseReason(update.lastDisconnect);
      if (statusCode === 401) {
        session.status = 'error';
        session.error = 'WhatsApp session logged out. Generate a new QR and scan again.';
        closeWhatsAppSetupSocket(session);
        refreshWhatsAppSetupSessionExpiry(session, 60_000);
        return;
      }
      scheduleWhatsAppSetupReconnect(session, reason);
    }
  };
  sock.ev.on('connection.update', session.onConnectionUpdate);
}

async function startWhatsAppSetupSession(): Promise<WhatsAppSetupSession> {
  cleanupExpiredWhatsAppSetupSession();
  if (whatsappSetupSession) {
    // Adapter config may have been deleted while an in-memory setup session still exists.
    // Re-ensure the config so test/send flows stay consistent with setup state.
    await ensureWhatsAppAdapterConfig(whatsappSetupSession.authDir);
    if (
      (whatsappSetupSession.status === 'error' ||
        (!whatsappSetupSession.sock && whatsappSetupSession.status !== 'connected')) &&
      !whatsappSetupSession.restartInFlight
    ) {
      whatsappSetupSession.status = 'waiting_qr';
      whatsappSetupSession.error = null;
      whatsappSetupSession.qr = null;
      whatsappSetupSession.restartAttempts = 0;
      try {
        await attachWhatsAppSetupSocket(whatsappSetupSession);
      } catch (err) {
        whatsappSetupSession.status = 'error';
        whatsappSetupSession.error = `Failed to start WhatsApp setup: ${getErrorMessage(err)}`;
      }
    }
    if (whatsappSetupSession.status !== 'connected') {
      refreshWhatsAppSetupSessionExpiry(whatsappSetupSession, WHATSAPP_SETUP_TTL_MS);
    }
    return whatsappSetupSession;
  }

  const setupId = randomBytes(12).toString('base64url');
  const authDir = getDefaultWhatsAppAuthDir();
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  await ensureWhatsAppAdapterConfig(authDir);

  const session: WhatsAppSetupSession = {
    setupId,
    authDir,
    status: 'waiting_qr',
    qr: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + WHATSAPP_SETUP_TTL_MS,
    sock: null,
    onCredsUpdate: null,
    onConnectionUpdate: null,
    restartInFlight: false,
    restartAttempts: 0,
    timeout: null,
  };
  whatsappSetupSession = session;
  refreshWhatsAppSetupSessionExpiry(session, WHATSAPP_SETUP_TTL_MS);

  try {
    await attachWhatsAppSetupSocket(session);
  } catch (err) {
    session.status = 'error';
    session.error = `Failed to start WhatsApp setup: ${getErrorMessage(err)}`;
  }

  return session;
}

async function getAdapterConfigByType(type: string): Promise<Record<string, unknown> | null> {
  const appConfig = await prisma.appConfig.findUnique({
    where: { id: 'global' },
  });
  if (!appConfig?.adapterConfig) return null;

  try {
    const parsed = JSON.parse(appConfig.adapterConfig) as {
      adapters?: Array<{ type?: string; config?: Record<string, unknown> }>;
    };
    const normalizedType = type.trim().toLowerCase();
    const entry = parsed.adapters?.find((adapter) =>
      typeof adapter.type === 'string' && adapter.type.trim().toLowerCase() === normalizedType,
    );
    if (!entry || !isRecord(entry.config)) return null;
    return entry.config;
  } catch {
    return null;
  }
}

function listAdapterSecretNames(): Record<string, string[]> {
  const records = listApiKeyCredentials().filter((credential) =>
    credential.service.startsWith('adapter:'),
  );

  const byType: Record<string, string[]> = {};
  for (const record of records) {
    const adapterType = record.service.replace('adapter:', '');
    if (!byType[adapterType]) byType[adapterType] = [];
    byType[adapterType].push(record.name);
  }
  return byType;
}

async function readAdapterSecret(type: string, name: string): Promise<string | null> {
  await ensureApiKeysMigrated();
  const service = `adapter:${type}`;
  const direct = readApiKeyValueByServiceName(service, name);
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }

  if (type === 'telegram' && name === 'botToken') {
    const fallbackToken = readApiKeyValueByService(service);
    if (typeof fallbackToken === 'string' && fallbackToken.trim()) {
      return fallbackToken.trim();
    }

    const config = await getAdapterConfigByType(type);
    if (config) {
      const legacyToken = readStringByKeys(config, ['botToken', 'token']);
      if (legacyToken) return legacyToken;
    }
  }

  return null;
}

// GET /adapters — List configured adapters
router.get('/', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ADAPTER_MANAGE, 'adapter:manage'), async (_req: Request, res: Response) => {
  try {
    const appConfig = await prisma.appConfig.findUnique({
      where: { id: 'global' },
    });

    let config: { enabled: boolean; chat?: { defaultApp?: string }; adapters: Array<{ type: string; enabled: boolean; config: Record<string, unknown>; chat?: { enabled?: boolean } }> } = {
      enabled: false,
      adapters: [],
    };

    if (appConfig?.adapterConfig) {
      try {
        config = JSON.parse(appConfig.adapterConfig);
      } catch {
        // Invalid JSON, return default
      }
    }

    await ensureApiKeysMigrated();
    const secretsByType = listAdapterSecretNames();

    // Annotate adapters with secret status
    const adapters = (config.adapters || []).map((a) => ({
      type: a.type,
      enabled: a.enabled,
      config: a.config,
      chat: a.chat,
      hasSecrets: (secretsByType[a.type] || []).length > 0,
      secretKeys: secretsByType[a.type] || [],
    }));

    res.json({
      success: true,
      enabled: config.enabled,
      chat: config.chat,
      adapters,
      running: approvalRouter !== null,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

// GET /adapters/:type/secrets/:name — Read a specific adapter secret value
router.get('/:type/secrets/:name', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ADAPTER_MANAGE, 'adapter:manage'), async (req: Request, res: Response) => {
  try {
    const type = String(req.params.type || '').trim().toLowerCase();
    const name = String(req.params.name || '').trim();

    if (!type) {
      res.status(400).json({ error: 'type is required' });
      return;
    }
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    if (!isUnlocked()) {
      res.status(401).json({ error: 'Wallet is locked. Unlock first.' });
      return;
    }

    const value = await readAdapterSecret(type, name);
    if (!value) {
      res.status(404).json({ error: `Secret '${name}' not configured for adapter '${type}'` });
      return;
    }

    res.json({
      success: true,
      type,
      name,
      value,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

// POST /adapters — Save adapter config
router.post('/', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ADAPTER_MANAGE, 'adapter:manage'), async (req: Request, res: Response) => {
  try {
    const { type, enabled, config, chat: chatConfig, secrets } = req.body as {
      type?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
      chat?: { enabled?: boolean };
      secrets?: Record<string, unknown>;
    };

    if (!type || typeof type !== 'string') {
      res.status(400).json({ error: 'type is required' });
      return;
    }

    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }

    let secretEntries: Array<[string, string]> = [];
    if (secrets !== undefined) {
      if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
        res.status(400).json({ error: 'secrets must be an object map of string values' });
        return;
      }
      secretEntries = Object.entries(secrets).map(([name, value]) => [name, typeof value === 'string' ? value : '']);
      for (const [name, value] of secretEntries) {
        if (!name.trim()) {
          res.status(400).json({ error: 'secret name cannot be empty' });
          return;
        }
        if (!value.trim()) {
          res.status(400).json({ error: `secret '${name}' must be a non-empty string` });
          return;
        }
      }
      if (secretEntries.length > 0 && !isUnlocked()) {
        res.status(401).json({ error: 'Wallet is locked. Unlock first.' });
        return;
      }
    }

    // Read current config
    const appConfig = await prisma.appConfig.findUnique({
      where: { id: 'global' },
    });

    let current: { enabled: boolean; chat?: { defaultApp?: string }; adapters: Array<{ type: string; enabled: boolean; config: Record<string, unknown>; chat?: { enabled?: boolean } }> } = {
      enabled: true,
      adapters: [],
    };

    if (appConfig?.adapterConfig) {
      try {
        current = JSON.parse(appConfig.adapterConfig);
      } catch {
        // Reset on invalid JSON
      }
    }

    // Upsert the adapter entry
    const idx = current.adapters.findIndex((a) => a.type === type);
    const entry: { type: string; enabled: boolean; config: Record<string, unknown>; chat?: { enabled?: boolean } } = { type, enabled, config: config || {} };
    if (chatConfig && typeof chatConfig === 'object') {
      entry.chat = chatConfig;
    }

    if (idx >= 0) {
      current.adapters[idx] = entry;
    } else {
      current.adapters.push(entry);
    }

    // If any adapter is being enabled, enable the system
    if (enabled) {
      current.enabled = true;
    }

    await prisma.appConfig.upsert({
      where: { id: 'global' },
      update: { adapterConfig: JSON.stringify(current) },
      create: { id: 'global', adapterConfig: JSON.stringify(current) },
    });

    if (secretEntries.length > 0) {
      const service = `adapter:${type}`;
      for (const [name, value] of secretEntries) {
        upsertApiKeyCredential(service, name, value, null);
        await prisma.apiKey.upsert({
          where: {
            service_name: { service, name },
          },
          update: {
            key: APIKEY_DB_PLACEHOLDER,
            metadata: null,
            isActive: true,
            updatedAt: new Date(),
          },
          create: {
            service,
            name,
            key: APIKEY_DB_PLACEHOLDER,
            metadata: null,
          },
        });
      }
    }

    const action = idx >= 0 ? 'updated' : 'created';
    logger.adapterChanged(action, type);

    res.json({
      success: true,
      adapter: entry,
      storedSecrets: secretEntries.map(([name]) => name),
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

// DELETE /adapters/:type — Remove adapter config
router.delete('/:type', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ADAPTER_MANAGE, 'adapter:manage'), async (req: Request, res: Response) => {
  try {
    const type = String(req.params.type || '').trim();
    const normalizedType = type.toLowerCase();
    if (!normalizedType) {
      res.status(400).json({ error: 'type is required' });
      return;
    }

    const appConfig = await prisma.appConfig.findUnique({
      where: { id: 'global' },
    });

    if (!appConfig?.adapterConfig) {
      if (normalizedType === 'whatsapp') {
        destroyWhatsAppSetupSession();
        await purgeWhatsAppAuthState(null);
      }
      res.json({ success: true, message: `Adapter '${normalizedType}' already absent` });
      return;
    }

    let current: { enabled: boolean; adapters: Array<{ type: string; enabled: boolean; config: Record<string, unknown> }> };
    try {
      current = JSON.parse(appConfig.adapterConfig);
    } catch {
      res.status(500).json({ error: 'Invalid adapter config in database' });
      return;
    }

    const idx = current.adapters.findIndex((a) => String(a.type || '').trim().toLowerCase() === normalizedType);
    if (idx < 0) {
      if (normalizedType === 'whatsapp') {
        destroyWhatsAppSetupSession();
        await purgeWhatsAppAuthState(null);
      }
      res.json({ success: true, message: `Adapter '${normalizedType}' already absent` });
      return;
    }

    const removedEntry = current.adapters[idx];
    current.adapters.splice(idx, 1);

    // If no adapters remain, disable the system
    if (current.adapters.length === 0) {
      current.enabled = false;
    }

    await prisma.appConfig.update({
      where: { id: 'global' },
      data: { adapterConfig: JSON.stringify(current) },
    });

    if (normalizedType === 'whatsapp') {
      destroyWhatsAppSetupSession();
      await purgeWhatsAppAuthState(isRecord(removedEntry?.config) ? removedEntry.config : null);
    }

    logger.adapterChanged('deleted', normalizedType);

    res.json({ success: true, message: `Adapter '${normalizedType}' removed` });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

// POST /adapters/test — Send a test message through a configured adapter
router.post('/test', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ADAPTER_MANAGE, 'adapter:manage'), async (req: Request, res: Response) => {
  try {
    const rawType = req.body?.type;

    if (!rawType || typeof rawType !== 'string') {
      res.status(400).json({ error: 'type is required' });
      return;
    }
    const type = rawType.trim().toLowerCase();
    if (!type) {
      res.status(400).json({ error: 'type is required' });
      return;
    }

    if (type !== 'telegram' && type !== 'webhook' && type !== 'whatsapp' && type !== 'discord') {
      res.status(400).json({ error: `Unknown adapter type: ${type}` });
      return;
    }

    const message = buildAdapterTestMessage(type as SupportedAdapterType);
    const result = await sendHumanMessageViaAdapter(type as SupportedAdapterType, message);

    if (!result.success) {
      if (result.status && result.status >= 400) {
        res.status(result.status).json({
          error: result.error || `Adapter test failed for ${type}`,
          ...(result.details || {}),
        });
        return;
      }

      res.json({
        success: false,
        error: result.error || `Adapter test failed for ${type}`,
        ...(result.details || {}),
      });
      return;
    }

    res.json({
      success: true,
      message: result.message || `${type} test sent.`,
      ...(result.details || {}),
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

// POST /adapters/chat — Update top-level chat config (defaultApp)
router.post('/chat', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ADAPTER_MANAGE, 'adapter:manage'), async (req: Request, res: Response) => {
  try {
    const { defaultApp } = req.body;

    const appConfig = await prisma.appConfig.findUnique({
      where: { id: 'global' },
    });

    let current: { enabled: boolean; chat?: { defaultApp?: string }; adapters: unknown[] } = {
      enabled: true,
      adapters: [],
    };

    if (appConfig?.adapterConfig) {
      try {
        current = JSON.parse(appConfig.adapterConfig);
      } catch {
        // Reset on invalid JSON
      }
    }

    current.chat = {
      ...current.chat,
      defaultApp: defaultApp || undefined,
    };

    await prisma.appConfig.upsert({
      where: { id: 'global' },
      update: { adapterConfig: JSON.stringify(current) },
      create: { id: 'global', adapterConfig: JSON.stringify(current) },
    });

    // Clear the app cache in the router
    if (approvalRouter) {
      approvalRouter.clearAppCache();
    }

    res.json({ success: true, chat: current.chat });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

// POST /adapters/:type/message — Inbound chat from external adapter (HMAC-authenticated)
router.post('/:type/message', async (req: Request, res: Response) => {
  try {
    const type = String(req.params.type);
    const { text, senderId } = req.body;

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    if (!senderId || typeof senderId !== 'string') {
      res.status(400).json({ error: 'senderId is required' });
      return;
    }

    // HMAC authentication: look up the adapter's secret
    const secretKey = await readAdapterSecret(type, 'secret');

    if (secretKey) {
      // Validate HMAC signature
      const signature = req.headers['x-signature-256'] as string | undefined;
      if (!signature) {
        res.status(401).json({ error: 'Missing X-Signature-256 header' });
        return;
      }

      const rawBody = JSON.stringify(req.body);
      const expected = `sha256=${createHmac('sha256', secretKey).update(rawBody).digest('hex')}`;

      try {
        const sigBuf = Buffer.from(signature);
        const expectedBuf = Buffer.from(expected);
        if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }
      } catch {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    if (!approvalRouter) {
      res.status(503).json({ error: 'Adapter router not running' });
      return;
    }

    const appId = await approvalRouter.resolveApp(req.body.targetApp);
    if (!appId) {
      res.status(400).json({ error: 'No target app configured. Set chat.defaultApp in adapter config.' });
      return;
    }

    const result = await approvalRouter.sendMessage(appId, text, undefined, type);
    res.json({
      success: !result.error,
      reply: result.reply,
      error: result.error,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

// POST /adapters/whatsapp/setup-qr — Start or reuse QR setup session
router.post('/whatsapp/setup-qr', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ADAPTER_MANAGE, 'adapter:manage'), async (_req: Request, res: Response) => {
  try {
    cleanupExpiredWhatsAppSetupSession();
    const session = await startWhatsAppSetupSession();

    const deadline = Date.now() + WHATSAPP_SETUP_CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      cleanupExpiredWhatsAppSetupSession();
      const current = whatsappSetupSession;
      if (!current || current.setupId !== session.setupId) break;
      if (current.status !== 'waiting_qr') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    cleanupExpiredWhatsAppSetupSession();
    res.json(serializeWhatsAppSetupSession(whatsappSetupSession));
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /adapters/whatsapp/setup-qr — Read current QR setup session
router.get('/whatsapp/setup-qr', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ADAPTER_MANAGE, 'adapter:manage'), async (_req: Request, res: Response) => {
  try {
    cleanupExpiredWhatsAppSetupSession();
    res.json(serializeWhatsAppSetupSession(whatsappSetupSession));
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /adapters/whatsapp/setup-qr/stop — Stop and clear setup session
router.post('/whatsapp/setup-qr/stop', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ADAPTER_MANAGE, 'adapter:manage'), async (_req: Request, res: Response) => {
  try {
    destroyWhatsAppSetupSession();
    res.json({ success: true });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /adapters/telegram/setup-link — Generate deep link for auto-detecting chat ID
router.post('/telegram/setup-link', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ADAPTER_MANAGE, 'adapter:manage'), async (req: Request, res: Response) => {
  try {
    // Accept bot token from body (pre-save flow) or read from credential store
    let botToken = req.body.botToken as string | undefined;
    if (!botToken) {
      const storedBotToken = await readAdapterSecret('telegram', 'botToken');
      if (!storedBotToken) {
        res.status(400).json({ error: 'Bot token not provided and not saved. Pass botToken in body or save it first.' });
        return;
      }
      botToken = storedBotToken;
    }

    // Validate bot token via getMe
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const meResp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
        signal: controller.signal,
      });
      const meData = await meResp.json() as { ok?: boolean; result?: { username?: string }; description?: string };
      if (!meData.ok) {
        res.status(400).json({ error: meData.description || 'Invalid bot token' });
        return;
      }

      const botUsername = meData.result?.username || '';

      // Generate nonce
      const nonce = randomBytes(12).toString('base64url');

      // Lazy cleanup of expired nonces
      const now = Date.now();
      for (const [key, val] of telegramSetupNonces) {
        if (val.expiresAt < now) telegramSetupNonces.delete(key);
      }

      // Store nonce with 120s TTL
      telegramSetupNonces.set(nonce, {
        botToken,
        botUsername,
        expiresAt: now + 120_000,
      });

      // Stop the running approval router so its Telegram polling doesn't
      // consume the /start message before detect-chat can see it.
      // It will be restarted after detection completes (via /adapters/restart).
      if (approvalRouter) {
        await approvalRouter.stop();
        approvalRouter = null;
      }

      // Delete webhook to ensure getUpdates polling works
      await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
        signal: controller.signal,
      }).catch(() => { /* non-fatal */ });

      // Flush stale updates so detect-chat only sees new messages.
      // Call getUpdates with offset=-1 to get the last update, then
      // confirm it so subsequent polls start fresh.
      let nextOffset = 0;
      try {
        const flushResp = await fetch(
          `https://api.telegram.org/bot${botToken}/getUpdates?offset=-1&timeout=0`,
          { signal: controller.signal },
        );
        const flushData = await flushResp.json() as { ok?: boolean; result?: Array<{ update_id: number }> };
        if (flushData.ok && flushData.result?.length) {
          const lastId = flushData.result[flushData.result.length - 1].update_id;
          // Confirm the last update so it's removed from the queue
          await fetch(
            `https://api.telegram.org/bot${botToken}/getUpdates?offset=${lastId + 1}&timeout=0`,
            { signal: controller.signal },
          );
          nextOffset = lastId + 1;
        }
      } catch { /* non-fatal — detect-chat will still work, just may see stale updates */ }

      // Store offset in nonce so detect-chat can skip old updates
      const nonceEntry = telegramSetupNonces.get(nonce);
      if (nonceEntry) nonceEntry.offset = nextOffset;

      res.json({
        success: true,
        link: `https://t.me/${botUsername}?start=${nonce}`,
        setupToken: nonce,
        botUsername,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

// POST /adapters/telegram/detect-chat — Poll for /start message to auto-detect chat ID
router.post('/telegram/detect-chat', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ADAPTER_MANAGE, 'adapter:manage'), async (req: Request, res: Response) => {
  try {
    const { setupToken } = req.body;
    if (!setupToken || typeof setupToken !== 'string') {
      res.status(400).json({ error: 'setupToken is required' });
      return;
    }

    const nonceEntry = telegramSetupNonces.get(setupToken);
    if (!nonceEntry) {
      res.status(400).json({ error: 'Invalid or expired setup token' });
      return;
    }

    if (nonceEntry.expiresAt < Date.now()) {
      telegramSetupNonces.delete(setupToken);
      res.status(400).json({ error: 'Setup token expired' });
      return;
    }

    const { botToken } = nonceEntry;

    // Long-poll getUpdates (25s timeout)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const offsetParam = nonceEntry.offset ? `&offset=${nonceEntry.offset}` : '';
      const updatesResp = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?timeout=25&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}${offsetParam}`,
        { signal: controller.signal },
      );
      const updatesData = await updatesResp.json() as {
        ok?: boolean;
        result?: Array<{
          update_id: number;
          message?: {
            text?: string;
            chat?: { id: number; first_name?: string; username?: string };
          };
        }>;
      };

      if (!updatesData.ok || !updatesData.result) {
        res.json({ chatId: null, timeout: true });
        return;
      }

      // Look for /start message
      let detectedUpdate: (typeof updatesData.result)[number] | null = null;
      let verified = false;

      for (const update of updatesData.result) {
        const text = update.message?.text || '';
        if (text === `/start ${setupToken}`) {
          detectedUpdate = update;
          verified = true;
          break;
        }
        if (text === '/start' || text.startsWith('/start ')) {
          detectedUpdate = update;
          verified = false;
          // Keep looking for exact nonce match
        }
      }

      if (!detectedUpdate || !detectedUpdate.message?.chat) {
        // Advance offset past any updates we just saw so the next
        // poll attempt doesn't re-process them
        if (updatesData.result.length > 0) {
          const maxId = updatesData.result[updatesData.result.length - 1].update_id;
          nonceEntry.offset = maxId + 1;
          await fetch(
            `https://api.telegram.org/bot${botToken}/getUpdates?offset=${maxId + 1}&timeout=0`,
            { signal: controller.signal },
          ).catch(() => { /* non-fatal */ });
        }
        res.json({ chatId: null, timeout: true });
        return;
      }

      const chat = detectedUpdate.message.chat;
      const chatId = String(chat.id);

      // Confirm the update by calling getUpdates with offset past it
      await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?offset=${detectedUpdate.update_id + 1}&timeout=0`,
        { signal: controller.signal },
      ).catch(() => { /* non-fatal */ });

      // Clean up nonce
      telegramSetupNonces.delete(setupToken);

      res.json({
        chatId,
        firstName: chat.first_name || null,
        username: chat.username || null,
        verified,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      res.json({ chatId: null, timeout: true });
    } else {
      const message = getErrorMessage(error);
      res.status(500).json({ error: message });
    }
  }
});

// POST /adapters/restart — Restart approval router with current DB config
router.post('/restart', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ADAPTER_MANAGE, 'adapter:manage'), async (_req: Request, res: Response) => {
  try {
    // Stop existing router
    if (approvalRouter) {
      await approvalRouter.stop();
      approvalRouter = null;
    }

    // Load adapters from DB
    const adapters = await loadAdaptersFromDb();

    if (adapters.length === 0) {
      res.json({ success: true, message: 'No adapters configured, router stopped', running: false });
      return;
    }

    const newRouter = new ApprovalRouter(`http://127.0.0.1:${SERVER_PORT}`);
    for (const adapter of adapters) {
      newRouter.registerAdapter(adapter);
    }

    await newRouter.start();
    approvalRouter = newRouter;

    res.json({
      success: true,
      message: `Approval router started with ${adapters.length} adapter(s)`,
      running: true,
      adapterCount: adapters.length,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

export default router;
