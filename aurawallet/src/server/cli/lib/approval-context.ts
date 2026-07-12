import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export type ApprovalScope = 'one_shot_read' | 'session_token';

interface ApprovalContextEntry {
  reqId: string;
  secret: string;
  privateKeyPem: string;
  approvalScope: ApprovalScope;
  createdAt: number;
  expiresAt: number;
  credentialId?: string;
  credentialName?: string;
  retryCommandTemplate?: string;
}

interface ClaimedTokenEntry {
  reqId: string;
  token: string;
  privateKeyPem?: string;
  approvalScope: ApprovalScope;
  createdAt: number;
  expiresAt: number;
  credentialId?: string;
  credentialName?: string;
}

interface ApprovalContextStore {
  contexts: Record<string, ApprovalContextEntry>;
  claimedTokens: Record<string, ClaimedTokenEntry>;
  activeSessionToken?: {
    token: string;
    privateKeyPem?: string;
    reqId?: string;
    createdAt: number;
    expiresAt: number;
  };
}

const SESSION_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function getStoreDir(): string {
  return process.env.WALLET_DATA_DIR || path.join(os.homedir(), '.auramaxx');
}

function getStoreFile(): string {
  return path.join(getStoreDir(), 'approval-context.json');
}

function getStoreKeyFile(): string {
  return path.join(getStoreDir(), 'approval-context.key');
}

function nowMs(): number {
  return Date.now();
}

function ensureStoreDir(): void {
  const dir = getStoreDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function loadOrCreateStoreKey(): Buffer | null {
  try {
    ensureStoreDir();
    const keyFile = getStoreKeyFile();
    if (fs.existsSync(keyFile)) {
      const raw = fs.readFileSync(keyFile, 'utf8').trim();
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length === 32) return decoded;
    }
    const key = randomBytes(32);
    fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
    try { fs.chmodSync(keyFile, 0o600); } catch {}
    return key;
  } catch {
    return null;
  }
}

function encryptSensitiveValue(value: string): string {
  const key = loadOrCreateStoreKey();
  if (!key) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptSensitiveValue(value: string): string {
  if (!value.startsWith('enc:v1:')) return value;
  const key = loadOrCreateStoreKey();
  if (!key) return '';
  const parts = value.split(':');
  if (parts.length !== 5) return '';
  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const ciphertext = Buffer.from(parts[4], 'base64');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function encryptStoreSensitiveValues(store: ApprovalContextStore): ApprovalContextStore {
  const contexts = Object.fromEntries(
    Object.entries(store.contexts).map(([reqId, ctx]) => [reqId, {
      ...ctx,
      secret: encryptSensitiveValue(ctx.secret),
      privateKeyPem: encryptSensitiveValue(ctx.privateKeyPem),
    }]),
  );
  const claimedTokens = Object.fromEntries(
    Object.entries(store.claimedTokens).map(([reqId, tok]) => [reqId, {
      ...tok,
      token: encryptSensitiveValue(tok.token),
      ...(tok.privateKeyPem ? { privateKeyPem: encryptSensitiveValue(tok.privateKeyPem) } : {}),
    }]),
  );
  const activeSessionToken = store.activeSessionToken
    ? {
        ...store.activeSessionToken,
        token: encryptSensitiveValue(store.activeSessionToken.token),
        ...(store.activeSessionToken.privateKeyPem
          ? { privateKeyPem: encryptSensitiveValue(store.activeSessionToken.privateKeyPem) }
          : {}),
      }
    : undefined;
  return { contexts, claimedTokens, ...(activeSessionToken ? { activeSessionToken } : {}) };
}

function decryptStoreSensitiveValues(store: ApprovalContextStore): ApprovalContextStore {
  const contexts = Object.fromEntries(
    Object.entries(store.contexts).map(([reqId, ctx]) => [reqId, {
      ...ctx,
      secret: decryptSensitiveValue(ctx.secret),
      privateKeyPem: decryptSensitiveValue(ctx.privateKeyPem),
    }]),
  );
  const claimedTokens = Object.fromEntries(
    Object.entries(store.claimedTokens).map(([reqId, tok]) => [reqId, {
      ...tok,
      token: decryptSensitiveValue(tok.token),
      ...(tok.privateKeyPem ? { privateKeyPem: decryptSensitiveValue(tok.privateKeyPem) } : {}),
    }]),
  );
  const activeSessionToken = store.activeSessionToken
    ? {
        ...store.activeSessionToken,
        token: decryptSensitiveValue(store.activeSessionToken.token),
        ...(store.activeSessionToken.privateKeyPem
          ? { privateKeyPem: decryptSensitiveValue(store.activeSessionToken.privateKeyPem) }
          : {}),
      }
    : undefined;
  return { contexts, claimedTokens, ...(activeSessionToken ? { activeSessionToken } : {}) };
}

function emptyStore(): ApprovalContextStore {
  return { contexts: {}, claimedTokens: {} };
}

function pruneStore(store: ApprovalContextStore): ApprovalContextStore {
  const now = nowMs();
  for (const [reqId, ctx] of Object.entries(store.contexts)) {
    if (
      !ctx
      || typeof ctx.expiresAt !== 'number'
      || ctx.expiresAt <= now
      || typeof ctx.secret !== 'string'
      || !ctx.secret
      || typeof ctx.privateKeyPem !== 'string'
      || !ctx.privateKeyPem
    ) {
      delete store.contexts[reqId];
    }
  }
  for (const [reqId, tok] of Object.entries(store.claimedTokens)) {
    if (!tok || typeof tok.expiresAt !== 'number' || tok.expiresAt <= now || typeof tok.token !== 'string' || !tok.token) {
      delete store.claimedTokens[reqId];
    }
  }
  if (store.activeSessionToken) {
    if (
      typeof store.activeSessionToken.expiresAt !== 'number'
      || store.activeSessionToken.expiresAt <= now
      || typeof store.activeSessionToken.token !== 'string'
      || !store.activeSessionToken.token
    ) {
      delete store.activeSessionToken;
    }
  }
  return store;
}

function readStore(): ApprovalContextStore {
  try {
    const raw = fs.readFileSync(getStoreFile(), 'utf8');
    const parsed = JSON.parse(raw) as ApprovalContextStore;
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    const contexts = parsed.contexts && typeof parsed.contexts === 'object' ? parsed.contexts : {};
    const claimedTokens = parsed.claimedTokens && typeof parsed.claimedTokens === 'object' ? parsed.claimedTokens : {};
    const activeSessionToken = parsed.activeSessionToken && typeof parsed.activeSessionToken === 'object'
      ? parsed.activeSessionToken
      : undefined;
    return pruneStore(decryptStoreSensitiveValues({ contexts, claimedTokens, activeSessionToken }));
  } catch {
    return emptyStore();
  }
}

function writeStore(store: ApprovalContextStore): void {
  ensureStoreDir();
  const storeFile = getStoreFile();
  const tmpFile = `${storeFile}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmpFile, 'w', 0o600);
  fs.writeSync(fd, JSON.stringify(encryptStoreSensitiveValues(pruneStore(store)), null, 2));
  fs.closeSync(fd);
  fs.renameSync(tmpFile, storeFile);
  try { fs.chmodSync(storeFile, 0o600); } catch {}
}

export function putApprovalContext(input: {
  reqId: string;
  secret: string;
  privateKeyPem: string;
  approvalScope: ApprovalScope;
  ttlSeconds?: number;
  credentialId?: string;
  credentialName?: string;
  retryCommandTemplate?: string;
}): void {
  const reqId = String(input.reqId || '').trim();
  const secret = String(input.secret || '').trim();
  const privateKeyPem = String(input.privateKeyPem || '').trim();
  if (!reqId || !secret || !privateKeyPem) return;

  const store = readStore();
  const ttlMs = Math.max(30_000, (input.ttlSeconds ?? 300) * 1000);
  store.contexts[reqId] = {
    reqId,
    secret,
    privateKeyPem,
    approvalScope: input.approvalScope,
    createdAt: nowMs(),
    expiresAt: nowMs() + ttlMs,
    ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    ...(input.credentialName ? { credentialName: input.credentialName } : {}),
    ...(input.retryCommandTemplate ? { retryCommandTemplate: input.retryCommandTemplate } : {}),
  };
  writeStore(store);
}

export function getApprovalContext(reqId: string): ApprovalContextEntry | null {
  const key = String(reqId || '').trim();
  if (!key) return null;
  const store = readStore();
  const entry = store.contexts[key];
  return entry || null;
}

export function deleteApprovalContext(reqId: string): void {
  const key = String(reqId || '').trim();
  if (!key) return;
  const store = readStore();
  delete store.contexts[key];
  writeStore(store);
}

export function putClaimedToken(input: {
  reqId: string;
  token: string;
  privateKeyPem?: string;
  approvalScope: ApprovalScope;
  ttlSeconds?: number;
  credentialId?: string;
  credentialName?: string;
}): void {
  const reqId = String(input.reqId || '').trim();
  const token = String(input.token || '').trim();
  if (!reqId || !token) return;
  const store = readStore();
  const ttlMs = Math.max(15_000, (input.ttlSeconds ?? 120) * 1000);
  store.claimedTokens[reqId] = {
    reqId,
    token,
    ...(input.privateKeyPem ? { privateKeyPem: String(input.privateKeyPem).trim() } : {}),
    approvalScope: input.approvalScope,
    createdAt: nowMs(),
    expiresAt: nowMs() + ttlMs,
    ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    ...(input.credentialName ? { credentialName: input.credentialName } : {}),
  };
  writeStore(store);
}

export function getClaimedToken(reqId: string): ClaimedTokenEntry | null {
  const key = String(reqId || '').trim();
  if (!key) return null;
  const store = readStore();
  const entry = store.claimedTokens[key];
  return entry || null;
}

export function consumeClaimedToken(reqId: string): ClaimedTokenEntry | null {
  const key = String(reqId || '').trim();
  if (!key) return null;
  const store = readStore();
  const entry = store.claimedTokens[key];
  if (!entry) return null;
  delete store.claimedTokens[key];
  writeStore(store);
  return entry;
}

export function putActiveSessionToken(input: {
  token: string;
  privateKeyPem?: string;
  ttlSeconds?: number;
  reqId?: string;
}): void {
  const token = String(input.token || '').trim();
  if (!token) return;
  const store = readStore();
  const ttlMs = Math.max(30_000, (input.ttlSeconds ?? SESSION_TOKEN_TTL_SECONDS) * 1000);
  store.activeSessionToken = {
    token,
    ...(input.privateKeyPem ? { privateKeyPem: String(input.privateKeyPem).trim() } : {}),
    ...(input.reqId ? { reqId: String(input.reqId).trim() } : {}),
    createdAt: nowMs(),
    expiresAt: nowMs() + ttlMs,
  };
  writeStore(store);
}

export function getActiveSessionToken(): { token: string; privateKeyPem?: string; reqId?: string; expiresAt: number } | null {
  const store = readStore();
  if (!store.activeSessionToken) return null;
  return {
    token: store.activeSessionToken.token,
    ...(store.activeSessionToken.privateKeyPem ? { privateKeyPem: store.activeSessionToken.privateKeyPem } : {}),
    ...(store.activeSessionToken.reqId ? { reqId: store.activeSessionToken.reqId } : {}),
    expiresAt: store.activeSessionToken.expiresAt,
  };
}

export function clearActiveSessionToken(): void {
  const store = readStore();
  delete store.activeSessionToken;
  writeStore(store);
}
