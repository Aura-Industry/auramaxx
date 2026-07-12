import { AgentTokenPayload, TokenSession, LimitValue, SpentValue } from '../types';
import { prisma } from './db';
import { events } from './events';
import { getFundLimit } from './auth';

/**
 * WALLET TOKEN SECURITY MODEL
 * ===========================
 *
 * IN MEMORY (security-critical, resets on restart):
 * - SIGNING_KEY: Random key for HMAC signing tokens
 * - sessions Map: Active token sessions with spending tracking
 * - revokedTokens Set: Tokens revoked this session
 *
 * IN DATABASE (for UI/logs only, NOT used for auth):
 * - AgentToken table: Metadata for display (hash, agentId, limit, etc.)
 * - Synced on create/spend/revoke but DB is just a mirror
 *
 * On server restart:
 * - New SIGNING_KEY generated → ALL old tokens become invalid
 * - Old DB records show as "inactive" (not in memory = can't sign)
 * - This is a SECURITY FEATURE: restart = re-approve
 *
 * Token validation flow:
 * 1. Agent sends token in Authorization header
 * 2. Server verifies HMAC signature with in-memory SIGNING_KEY
 * 3. If valid, checks spending limit in memory sessions Map
 * 4. DB is NEVER consulted for auth decisions
 */

// Limit types for per-permission tracking
export type LimitType = 'fund' | 'send' | 'swap';

/**
 * Resolve a limit value, handling both plain numbers and address-keyed Records.
 * - Plain number: return as-is (backward compat, single-currency)
 * - Record<string, number>: look up by currency address
 * - If currency is provided but limit is a plain number, return the number (backward compat)
 */
export function resolveLimit(
  limitValue: LimitValue | undefined,
  currency?: string
): number | undefined {
  if (limitValue === undefined) return undefined;
  if (typeof limitValue === 'number') return limitValue;
  // Record<string, number> — look up by currency
  if (currency && limitValue[currency] !== undefined) {
    return limitValue[currency];
  }
  // No matching currency in record = unlimited for that currency
  return undefined;
}

/**
 * Get spent amount from a SpentValue, handling both plain numbers and address-keyed Records.
 */
function resolveSpent(spentValue: SpentValue | undefined, currency?: string): number {
  if (spentValue === undefined) return 0;
  if (typeof spentValue === 'number') return spentValue;
  if (currency) return spentValue[currency] || 0;
  // No currency specified on a Record — return aggregate spend for display
  return Object.values(spentValue).reduce((total, value) => total + value, 0);
}

/**
 * Record spent amount into a SpentValue, handling both plain numbers and address-keyed Records.
 * Mutates the session's spentByType in place.
 */
function addToSpent(
  session: TokenSession,
  limitType: LimitType,
  amount: number,
  currency?: string
): number {
  if (!session.spentByType) {
    session.spentByType = { fund: 0, send: 0, swap: 0 };
  }
  const current = session.spentByType[limitType];

  if (currency && current !== undefined && typeof current === 'object') {
    // Already a Record, add to the currency key
    current[currency] = (current[currency] || 0) + amount;
    return current[currency];
  } else if (currency && (current === undefined || typeof current === 'number')) {
    // Need to upgrade to Record if we have a currency
    // But for backward compat, if no currency was previously tracked, just use the number
    // Only upgrade if the limit is also a Record
    const limitValue = session.token.limits?.[limitType];
    if (typeof limitValue === 'object') {
      // Upgrade to Record
      const record: Record<string, number> = {};
      record[currency] = (typeof current === 'number' ? 0 : 0) + amount;
      session.spentByType[limitType] = record;
      return record[currency];
    }
    // Limit is a plain number, keep spent as plain number
    const newSpent = (typeof current === 'number' ? current : 0) + amount;
    session.spentByType[limitType] = newSpent;
    return newSpent;
  } else {
    // No currency, plain number
    const newSpent = (typeof current === 'number' ? current : 0) + amount;
    session.spentByType[limitType] = newSpent;
    return newSpent;
  }
}

// In-memory session tracking - resets on server restart
const sessions = new Map<string, TokenSession>();

// Revoked token hashes (in memory)
const revokedTokens = new Set<string>();

/**
 * Register a new token in memory AND database
 * Called when human approves agent access
 */
export async function registerToken(
  tokenHash: string,
  token: AgentTokenPayload
): Promise<void> {
  // Store in memory (authoritative for auth)
  sessions.set(tokenHash, {
    token,
    spent: 0,
    spentByType: { fund: 0, send: 0, swap: 0 },
    credentialReads: 0,
    tokenIssuedAt: token.iat,
  });

  // Get fund limit for DB storage (backward compatibility)
  const fundLimit = getFundLimit(token);

  // Store in DB (for UI/logs only)
  try {
    await prisma.agentToken.upsert({
      where: { tokenHash },
      create: {
        tokenHash,
        agentId: token.agentId,
        limit: fundLimit,
        spent: 0,
        permissions: JSON.stringify(token.permissions),
        expiresAt: new Date(token.exp),
      },
      update: {
        agentId: token.agentId,
        limit: fundLimit,
        spent: 0,
        permissions: JSON.stringify(token.permissions),
        expiresAt: new Date(token.exp),
        isRevoked: false,
        revokedAt: null,
      },
    });
  } catch (err) {
    console.error('Failed to store token in DB (non-critical):', err);
  }
}

/**
 * Initialize or get a session for a token
 */
export function getSession(tokenHash: string, token: AgentTokenPayload): TokenSession {
  let session = sessions.get(tokenHash);
  if (!session) {
    session = { token, spent: 0, spentByType: { fund: 0, send: 0, swap: 0 }, credentialReads: 0, tokenIssuedAt: token.iat };
    sessions.set(tokenHash, session);
  }
  // Ensure spentByType exists (for backward compatibility with existing sessions)
  if (!session.spentByType) {
    session.spentByType = { fund: 0, send: 0, swap: 0 };
  }
  return session;
}

/**
 * Check if token exists in memory (is valid for current server session)
 */
export function isActiveInMemory(tokenHash: string): boolean {
  return sessions.has(tokenHash);
}

/**
 * Record spending against a token's limit (legacy - uses fund limit)
 */
export async function recordSpend(tokenHash: string, amount: number): Promise<void> {
  return recordSpendByType(tokenHash, 'fund', amount);
}

/**
 * Record spending against a specific limit type.
 * @param currency - Optional currency address for address-keyed limits (e.g., native token address)
 */
export async function recordSpendByType(
  tokenHash: string,
  limitType: LimitType,
  amount: number,
  currency?: string
): Promise<void> {
  const session = sessions.get(tokenHash);
  if (session) {
    // Update the specific limit type (handles both plain number and Record)
    addToSpent(session, limitType, amount, currency);

    // Also update legacy spent field for fund
    if (limitType === 'fund') {
      session.spent += amount;
    }

    emitSpentEvent(tokenHash, session, limitType, amount, currency);

    // NOTE: All limit tracking is memory-only, consistent with the security model.
    // On restart, SIGNING_KEY regenerates → all tokens invalid → agents re-approve with fresh limits.
  }
}

/**
 * Check if a spend would exceed the token's limit (legacy - uses fund limit)
 */
export function checkLimit(tokenHash: string, token: AgentTokenPayload, amount: number): boolean {
  return checkLimitByType(tokenHash, token, 'fund', amount);
}

/**
 * Resolve the effective limit for a given type, handling fund fallback for send.
 */
function getEffectiveLimit(token: AgentTokenPayload, limitType: LimitType, currency?: string): number | undefined {
  if (limitType === 'fund') {
    const rawLimit = token.limits?.fund;
    return rawLimit !== undefined ? resolveLimit(rawLimit, currency) : getFundLimit(token);
  }
  const rawLimit = token.limits?.[limitType];
  let limit = resolveLimit(rawLimit, currency);
  // Send defaults to fund limit if not explicitly set and fund limit exists
  if (limit === undefined && limitType === 'send') {
    const fundRaw = token.limits?.fund;
    const fundLimit = fundRaw !== undefined ? resolveLimit(fundRaw, currency) : getFundLimit(token);
    if (fundLimit !== undefined && fundLimit > 0) limit = fundLimit;
  }
  return limit;
}

/**
 * Check if a spend would exceed a specific limit type
 * Returns true if within limit, false if would exceed
 * If no limit is set for that type, returns true (unlimited)
 * @param currency - Optional currency address for address-keyed limits
 */
export function checkLimitByType(
  tokenHash: string,
  token: AgentTokenPayload,
  limitType: LimitType,
  amount: number,
  currency?: string
): boolean {
  const session = getSession(tokenHash, token);
  const limit = getEffectiveLimit(token, limitType, currency);

  // No limit set = unlimited
  if (limit === undefined) {
    return true;
  }

  // Check against spent
  const spent = resolveSpent(session.spentByType?.[limitType], currency);
  return spent + amount <= limit;
}

/**
 * Atomically check limit AND reserve the amount in one synchronous call.
 * Prevents TOCTOU race: two concurrent requests can't both pass the check
 * because the deduction happens immediately (Node is single-threaded for sync code).
 *
 * Returns { ok: true } if reserved, or { ok: false, remaining } if limit exceeded.
 * On tx failure, call releaseSpend() to roll back the reservation.
 */
export function reserveSpend(
  tokenHash: string,
  token: AgentTokenPayload,
  limitType: LimitType,
  amount: number,
  currency?: string
): { ok: true } | { ok: false; remaining: number } {
  const session = getSession(tokenHash, token);
  const limit = getEffectiveLimit(token, limitType, currency);

  // No limit set = unlimited, reserve (record) immediately
  if (limit === undefined) {
    addToSpent(session, limitType, amount, currency);
    if (limitType === 'fund') session.spent += amount;
    emitSpentEvent(tokenHash, session, limitType, amount, currency);
    return { ok: true };
  }

  // Check against spent
  const spent = resolveSpent(session.spentByType?.[limitType], currency);
  if (spent + amount > limit) {
    const remaining = Math.max(0, limit - spent);
    return { ok: false, remaining };
  }

  // Reserve: deduct immediately
  addToSpent(session, limitType, amount, currency);
  if (limitType === 'fund') session.spent += amount;
  emitSpentEvent(tokenHash, session, limitType, amount, currency);
  return { ok: true };
}

/**
 * Roll back a previously reserved spend (e.g., when a transaction fails).
 */
export function releaseSpend(
  tokenHash: string,
  limitType: LimitType,
  amount: number,
  currency?: string
): void {
  const session = sessions.get(tokenHash);
  if (!session) return;
  addToSpent(session, limitType, -amount, currency);
  if (limitType === 'fund') session.spent = Math.max(0, session.spent - amount);
}

/**
 * Emit WebSocket tokenSpent event (shared by reserveSpend and recordSpendByType).
 */
function emitSpentEvent(
  tokenHash: string,
  session: TokenSession,
  limitType: LimitType,
  amount: number,
  currency?: string
): void {
  const limitValue = session.token.limits?.[limitType] ?? (limitType === 'fund' ? getFundLimit(session.token) : undefined);
  const limit = resolveLimit(
    typeof limitValue === 'number' || typeof limitValue === 'object' ? limitValue : undefined,
    currency
  );
  const newSpent = resolveSpent(session.spentByType?.[limitType], currency);
  const remaining = limit !== undefined ? Math.max(0, limit - newSpent) : undefined;
  events.tokenSpent({ tokenHash, amount, newSpent, remaining: remaining ?? 0, limitType });
}

/**
 * Get remaining allowance for a token (legacy - uses fund limit)
 */
export function getRemaining(tokenHash: string, token: AgentTokenPayload): number {
  return getRemainingByType(tokenHash, token, 'fund');
}

/**
 * Get remaining allowance for a specific limit type
 * Returns Infinity if no limit is set
 * @param currency - Optional currency address for address-keyed limits
 */
export function getRemainingByType(
  tokenHash: string,
  token: AgentTokenPayload,
  limitType: LimitType,
  currency?: string
): number {
  const session = getSession(tokenHash, token);
  const limit = getEffectiveLimit(token, limitType, currency);

  // No limit set = unlimited
  if (limit === undefined) {
    return Infinity;
  }

  const spent = resolveSpent(session.spentByType?.[limitType], currency);
  return Math.max(0, limit - spent);
}

/**
 * Get session info for a token
 */
export function getSessionInfo(tokenHash: string): TokenSession | null {
  return sessions.get(tokenHash) || null;
}

/** Budget summary for hook AI context */
export interface SessionBudget {
  limits: Record<string, number>;
  spent: Record<string, number>;
  remaining: Record<string, number>;
}

/**
 * Get a simplified budget summary for a token session.
 * Only includes limit types that have actual limits set.
 * Missing keys = unlimited for that permission type.
 */
export function getSessionBudget(tokenHash: string): SessionBudget {
  const session = sessions.get(tokenHash);
  if (!session) return { limits: {}, spent: {}, remaining: {} };

  const budget: SessionBudget = { limits: {}, spent: {}, remaining: {} };

  for (const type of ['fund', 'send', 'swap'] as const) {
    let limit: number | undefined;
    if (type === 'fund') {
      limit = session.token.limits?.fund !== undefined
        ? resolveLimit(session.token.limits.fund)
        : (getFundLimit(session.token) || undefined);
    } else {
      limit = session.token.limits?.[type] !== undefined
        ? resolveLimit(session.token.limits[type])
        : undefined;
    }

    if (limit !== undefined && limit > 0) {
      const spent = resolveSpent(session.spentByType?.[type]);
      budget.limits[type] = limit;
      budget.spent[type] = spent;
      budget.remaining[type] = Math.max(0, limit - spent);
    }
  }

  return budget;
}

// ─── Credential Access Tracking ─────────────────────────────────────

/**
 * Check if a token is allowed to read credentials.
 * Enforces TTL (from iat) and maxReads limits.
 */
export function checkCredentialAccess(
  tokenHash: string,
  token: AgentTokenPayload
): { ok: true } | { ok: false; reason: string } {
  const session = getSession(tokenHash, token);
  const access = token.credentialAccess;

  // Check TTL from iat
  if (access?.ttl !== undefined && session.tokenIssuedAt) {
    const elapsed = (Date.now() - session.tokenIssuedAt) / 1000;
    if (elapsed > access.ttl) {
      return { ok: false, reason: 'Credential access TTL expired' };
    }
  }

  // Check maxReads
  if (access?.maxReads !== undefined) {
    const reads = session.credentialReads ?? 0;
    if (reads >= access.maxReads) {
      return { ok: false, reason: 'Credential read limit reached' };
    }
  }

  return { ok: true };
}

/**
 * Record a successful credential read against the session.
 */
export function recordCredentialRead(tokenHash: string): void {
  const session = sessions.get(tokenHash);
  if (session) {
    session.credentialReads = (session.credentialReads ?? 0) + 1;
  }
}

/**
 * Clear all sessions (for testing)
 */
export function clearSessions(): void {
  sessions.clear();
  revokedTokens.clear();
}

/**
 * Revoke a token by its hash
 */
export async function revokeToken(tokenHash: string): Promise<boolean> {
  const existed = sessions.has(tokenHash);

  // Revoke in memory
  revokedTokens.add(tokenHash);
  sessions.delete(tokenHash);

  // Emit WebSocket event if token existed
  if (existed) {
    events.tokenRevoked({ tokenHash });
  }

  // Sync to DB (P2025 = record not found — silently ignore during cleanup)
  try {
    await prisma.agentToken.update({
      where: { tokenHash },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
      },
    });
  } catch (err: unknown) {
    const prismaError = err as { code?: string };
    if (prismaError.code !== 'P2025') {
      console.error('Failed to sync revoke to DB:', err);
    }
  }

  return existed;
}

/**
 * Revoke all active token sessions.
 * Used by global lock flows to force full re-authentication.
 */
export async function revokeAllTokens(): Promise<number> {
  const activeTokenHashes = Array.from(sessions.keys());
  await Promise.all(activeTokenHashes.map((tokenHash) => revokeToken(tokenHash)));
  return activeTokenHashes.length;
}

/**
 * Check if a token is revoked
 */
export function isRevoked(tokenHash: string): boolean {
  return revokedTokens.has(tokenHash);
}

/**
 * List all tokens from DB, marking which are active in memory
 * Active = exists in memory with valid signing key
 * Inactive = in DB but not in memory (server restarted, expired, revoked)
 */
export async function listTokensFromDb(): Promise<Array<{
  tokenHash: string;
  agentId: string;
  createdAt: number;
  limit: number;
  spent: number;
  remaining: number;
  permissions: string[];
  expiresAt: number;
  isExpired: boolean;
  isRevoked: boolean;
  isActive: boolean; // true = valid in memory, false = DB record only
  limits?: AgentTokenPayload['limits'];
  spentByType?: TokenSession['spentByType'];
}>> {
  const now = Date.now();

  try {
    const dbTokens = await prisma.agentToken.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return dbTokens.map(t => {
      const isExpired = t.expiresAt.getTime() < now;
      const isActiveInMem = sessions.has(t.tokenHash) && !revokedTokens.has(t.tokenHash);
      const memSession = sessions.get(t.tokenHash);
      const fundSpent = memSession ? resolveSpent(memSession.spentByType?.fund) : undefined;

      // Use memory values if active, otherwise DB values
      const spent = memSession && fundSpent !== undefined ? fundSpent : t.spent;
      const limit = memSession ? getFundLimit(memSession.token) : t.limit;

      return {
        tokenHash: t.tokenHash,
        agentId: t.agentId,
        createdAt: t.createdAt.getTime(),
        limit,
        spent,
        remaining: Math.max(0, limit - spent),
        permissions: JSON.parse(t.permissions),
        expiresAt: t.expiresAt.getTime(),
        isExpired,
        isRevoked: t.isRevoked || revokedTokens.has(t.tokenHash),
        isActive: isActiveInMem && !isExpired,
        limits: memSession?.token.limits,
        spentByType: memSession?.spentByType,
      };
    });
  } catch (err) {
    console.error('Failed to list tokens from DB:', err);
    return [];
  }
}

/**
 * List only in-memory sessions (legacy function for compatibility)
 */
export function listSessions(): Array<{
  tokenHash: string;
  agentId: string;
  limit: number;
  spent: number;
  remaining: number;
  permissions: string[];
  expiresAt: number;
  isExpired: boolean;
  isRevoked: boolean;
  limits?: AgentTokenPayload['limits'];
  spentByType?: TokenSession['spentByType'];
}> {
  const now = Date.now();
  const result: Array<{
    tokenHash: string;
    agentId: string;
    limit: number;
    spent: number;
    remaining: number;
    permissions: string[];
    expiresAt: number;
    isExpired: boolean;
    isRevoked: boolean;
    limits?: AgentTokenPayload['limits'];
    spentByType?: TokenSession['spentByType'];
  }> = [];

  sessions.forEach((session, tokenHash) => {
    const isExpired = session.token.exp < now;
    const fundLimit = getFundLimit(session.token);
    const fundSpent = resolveSpent(session.spentByType?.fund);
    result.push({
      tokenHash,
      agentId: session.token.agentId,
      limit: fundLimit,
      spent: fundSpent,
      remaining: Math.max(0, fundLimit - fundSpent),
      permissions: session.token.permissions,
      expiresAt: session.token.exp,
      isExpired,
      isRevoked: revokedTokens.has(tokenHash),
      limits: session.token.limits,
      spentByType: session.spentByType,
    });
  });

  return result;
}
