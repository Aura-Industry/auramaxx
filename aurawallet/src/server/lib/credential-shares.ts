import fs from 'fs';
import path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { DATA_PATHS } from './config';

export type ShareExpiresAfter = '15m' | '1h' | '24h' | '7d' | '30d';
export type ShareAccessMode = 'anyone' | 'password';

export interface CredentialShareFile {
  token: string;
  credentialId: string;
  createdAt: string;
  createdBy: string;
  expiresAt: number;
  accessMode: ShareAccessMode;
  passwordSalt?: string;
  passwordHash?: string;
  oneTimeOnly: boolean;
  viewCount: number;
  lastViewedAt: string | null;
}

export interface CreateCredentialShareInput {
  credentialId: string;
  createdBy: string;
  expiresAfter: ShareExpiresAfter;
  accessMode: ShareAccessMode;
  password?: string;
  oneTimeOnly: boolean;
}

type ShareAccessFailureReason =
  | 'not_found'
  | 'expired'
  | 'already_viewed'
  | 'password_required'
  | 'invalid_password';

type ShareConsumeResult =
  | { ok: true; share: CredentialShareFile }
  | { ok: false; reason: ShareAccessFailureReason };

const SHARE_TOKEN_PATTERN = /^[a-f0-9]{32}$/i;
const EXPIRY_MS: Record<ShareExpiresAfter, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function ensureShareDir(): void {
  const dir = DATA_PATHS.credentialShares;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function isValidToken(token: string): boolean {
  return SHARE_TOKEN_PATTERN.test(token);
}

function getSharePath(token: string): string {
  return path.join(DATA_PATHS.credentialShares, `${token}.json`);
}

function readShare(token: string): CredentialShareFile | null {
  if (!isValidToken(token)) return null;
  const filePath = getSharePath(token);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as CredentialShareFile;
  } catch {
    return null;
  }
}

function writeShare(share: CredentialShareFile): void {
  ensureShareDir();
  fs.writeFileSync(getSharePath(share.token), JSON.stringify(share, null, 2));
}

function resolveExpiresAt(expiresAfter: ShareExpiresAfter): number {
  return Date.now() + EXPIRY_MS[expiresAfter];
}

function hashSharePassword(password: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${password}`, 'utf8').digest('hex');
}

function verifySharePassword(password: string, share: CredentialShareFile): boolean {
  if (!share.passwordSalt || !share.passwordHash) return false;
  const expected = Buffer.from(share.passwordHash, 'hex');
  const actual = Buffer.from(hashSharePassword(password, share.passwordSalt), 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function isExpired(share: CredentialShareFile): boolean {
  return Date.now() > share.expiresAt;
}

function isAlreadyViewed(share: CredentialShareFile): boolean {
  return share.oneTimeOnly && share.viewCount >= 1;
}

function generateShareToken(): string {
  ensureShareDir();
  while (true) {
    const token = randomBytes(16).toString('hex');
    if (!fs.existsSync(getSharePath(token))) return token;
  }
}

export function createCredentialShare(input: CreateCredentialShareInput): CredentialShareFile {
  if (!(input.expiresAfter in EXPIRY_MS)) {
    throw new Error('Invalid expiresAfter value');
  }
  if (input.accessMode !== 'anyone' && input.accessMode !== 'password') {
    throw new Error('Invalid accessMode value');
  }
  if (input.accessMode === 'password' && (!input.password || input.password.length === 0)) {
    throw new Error('Password is required when accessMode is password');
  }

  const token = generateShareToken();
  const createdAt = new Date().toISOString();

  let passwordSalt: string | undefined;
  let passwordHash: string | undefined;
  if (input.accessMode === 'password' && input.password) {
    passwordSalt = randomBytes(16).toString('hex');
    passwordHash = hashSharePassword(input.password, passwordSalt);
  }

  const share: CredentialShareFile = {
    token,
    credentialId: input.credentialId,
    createdAt,
    createdBy: input.createdBy,
    expiresAt: resolveExpiresAt(input.expiresAfter),
    accessMode: input.accessMode,
    ...(passwordSalt ? { passwordSalt } : {}),
    ...(passwordHash ? { passwordHash } : {}),
    oneTimeOnly: input.oneTimeOnly,
    viewCount: 0,
    lastViewedAt: null,
  };

  writeShare(share);
  return share;
}

export function getCredentialShare(token: string): CredentialShareFile | null {
  return readShare(token);
}

export function getCredentialShareStatus(share: CredentialShareFile): {
  isExpired: boolean;
  isAlreadyViewed: boolean;
} {
  return {
    isExpired: isExpired(share),
    isAlreadyViewed: isAlreadyViewed(share),
  };
}

export function consumeCredentialShare(token: string, password?: string): ShareConsumeResult {
  const share = readShare(token);
  if (!share) return { ok: false, reason: 'not_found' };
  if (isExpired(share)) return { ok: false, reason: 'expired' };
  if (isAlreadyViewed(share)) return { ok: false, reason: 'already_viewed' };

  if (share.accessMode === 'password') {
    if (!password || password.length === 0) {
      return { ok: false, reason: 'password_required' };
    }
    if (!verifySharePassword(password, share)) {
      return { ok: false, reason: 'invalid_password' };
    }
  }

  const updated: CredentialShareFile = {
    ...share,
    viewCount: share.viewCount + 1,
    lastViewedAt: new Date().toISOString(),
  };
  writeShare(updated);
  return { ok: true, share: updated };
}
