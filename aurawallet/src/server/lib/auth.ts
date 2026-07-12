import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { AgentTokenPayload, LimitValue } from '../types';
import { registerToken, revokeToken } from './sessions';
import { expandPermissions } from './permissions';
import { getDefaultSync } from './defaults';

// Random 32-byte signing key generated on startup - never persisted
const SIGNING_KEY = randomBytes(32);

// Track admin token hashes for revocation on lock
const adminTokenHashes: Set<string> = new Set();

// Re-export types for convenience
export type { AgentTokenPayload };

/**
 * Create an admin token for UI access
 * Admin tokens are regular tokens with admin:* permission
 * Multiple admin tokens can exist simultaneously
 */
export async function createAdminToken(agentPubkey: string): Promise<string> {
  const token = await createToken(
    'admin',
    0, // No spending limit for admin
    ['admin:*'],
    getDefaultSync<number>('ttl.admin', 2592000), // Default 30 day TTL (effectively until lock/restart)
    { agentPubkey }
  );

  adminTokenHashes.add(getTokenHash(token));
  return token;
}

/**
 * Revoke all admin tokens (called on lock)
 */
export function revokeAdminTokens(): void {
  for (const hash of adminTokenHashes) {
    revokeToken(hash);
  }
  adminTokenHashes.clear();
}

/**
 * Get admin token hashes (for testing/logging)
 */
export function getAdminTokenHashes(): string[] {
  return Array.from(adminTokenHashes);
}

/**
 * Create a signed approval token for an agent
 * Also registers it in memory + DB for tracking
 */
export async function createToken(
  agentId: string,
  limit: number,
  permissions: string[],
  ttlSeconds: number = 3600,
  options?: {
    limits?: AgentTokenPayload['limits'];
    walletAccess?: string[];
    credentialAccess?: AgentTokenPayload['credentialAccess'];
    agentPubkey?: string;
    oneShotBinding?: AgentTokenPayload['oneShotBinding'];
  }
): Promise<string> {
  // Expand permissions for consistency
  const expandedPermissions = expandPermissions(permissions);

  const payload: AgentTokenPayload = {
    agentId,
    permissions: expandedPermissions,
    exp: Date.now() + ttlSeconds * 1000,
    iat: Date.now(),
    // Legacy limit field for backward compatibility
    limit,
  };

  // Add per-permission limits if provided, otherwise use legacy limit for fund
  if (options?.limits) {
    payload.limits = options.limits;
  } else if (limit > 0) {
    // Map legacy limit to fund limit
    payload.limits = { fund: limit };
  }

  // Add wallet access grants if provided
  if (options?.walletAccess && options.walletAccess.length > 0) {
    payload.walletAccess = options.walletAccess.map(addr => addr.toLowerCase());
  }

  // Add credential access — use explicit value, or populate from defaults for secret:* tokens
  if (options?.credentialAccess) {
    payload.credentialAccess = options.credentialAccess;
  } else if (
    expandedPermissions.includes('secret:read' as never) ||
    expandedPermissions.includes('secret:write' as never)
  ) {
    payload.credentialAccess = {
      read: getDefaultSync<string[]>('defaults.credential.access.read', ['*']),
      write: getDefaultSync<string[]>('defaults.credential.access.write', ['*']),
      excludeFields: ['password', 'cvv'], // Exclude sensitive fields by default
    };
  }

  // Add agent public key if provided
  if (options?.agentPubkey) {
    payload.agentPubkey = options.agentPubkey;
  }

  if (options?.oneShotBinding) {
    payload.oneShotBinding = options.oneShotBinding;
  }

  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', SIGNING_KEY)
    .update(payloadStr)
    .digest('base64url');

  const token = `${payloadStr}.${signature}`;

  // Register token in memory + DB
  const tokenHash = getTokenHash(token);
  await registerToken(tokenHash, payload);

  return token;
}

/**
 * Validate a signed token and return the payload if valid
 * Works for both agent tokens and admin tokens (admin is just a permission)
 */
export function validateToken(token: string): AgentTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [payloadStr, signature] = parts;

  // Verify signature
  const expectedSignature = createHmac('sha256', SIGNING_KEY)
    .update(payloadStr)
    .digest('base64url');

  const sigBuf = Buffer.from(signature, 'base64url');
  const expectedBuf = Buffer.from(expectedSignature, 'base64url');
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  // Parse and validate payload
  try {
    const payload = JSON.parse(
      Buffer.from(payloadStr, 'base64url').toString('utf-8')
    );

    // Must have agentId and exp
    if (!payload.agentId || !payload.exp) {
      return null;
    }

    // Check expiry
    if (payload.exp < Date.now()) {
      return null;
    }

    // Ensure permissions array exists
    if (!Array.isArray(payload.permissions)) {
      payload.permissions = [];
    }

    return payload as AgentTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Get a hash of the token for use as a session key
 */
export function getTokenHash(token: string): string {
  return createHmac('sha256', SIGNING_KEY)
    .update(token)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Get the fund limit from a token (supports both legacy and new format)
 */
export function getFundLimit(token: AgentTokenPayload): number {
  const fundLimit = token.limits?.fund;

  // New format: plain number (legacy/legacy-compatible single-currency)
  if (typeof fundLimit === 'number') {
    return fundLimit;
  }

  // Address-keyed fund limits are per-currency and require explicit currency context
  // for enforcement in checkLimitByType/getSessionBudget.
  // Treat missing default-currency fund limit as zero here to keep behavior fail-safe.
  if (fundLimit && typeof fundLimit === 'object') {
    return 0;
  }

  // Fall back to legacy limit
  return token.limit || 0;
}

/**
 * Get a specific limit from a token
 */
export function getLimit(token: AgentTokenPayload, limitType: 'fund' | 'send' | 'swap'): LimitValue | undefined {
  return token.limits?.[limitType];
}

/**
 * Check if a token has wallet access to a specific address
 */
export function hasWalletAccess(token: AgentTokenPayload, address: string): boolean {
  if (!token.walletAccess) return false;
  return token.walletAccess.includes(address.toLowerCase());
}

// In-memory token escrow: raw tokens never touch the DB
interface EscrowEntry { token: string; expiresAt: number; }
const tokenEscrow = new Map<string, EscrowEntry>();
const ESCROW_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function escrowToken(requestId: string, token: string): void {
  tokenEscrow.set(requestId, { token, expiresAt: Date.now() + ESCROW_TTL_MS });
}

export function claimEscrowedToken(requestId: string): string | null {
  const entry = tokenEscrow.get(requestId);
  if (!entry) return null;
  tokenEscrow.delete(requestId);
  if (entry.expiresAt < Date.now()) return null; // expired
  return entry.token;
}

// Periodic sweep of expired escrow entries
const escrowSweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of tokenEscrow) {
    if (entry.expiresAt < now) tokenEscrow.delete(id);
  }
}, 60_000);
escrowSweepInterval.unref(); // Don't keep process alive

export function clearEscrowSweep(): void {
  clearInterval(escrowSweepInterval);
}

/**
 * Regenerate the signing key (for testing)
 * WARNING: This invalidates all existing tokens
 */
export function regenerateSigningKey(): void {
  // This is a no-op since SIGNING_KEY is const
  // In production, restarting the server achieves this
  // For tests, we just note that this would invalidate tokens
}

/**
 * Create a signed token synchronously (for testing only)
 * Does NOT register in DB - use createToken() for production
 */
export function createTokenSync(payload: {
  agentId: string;
  permissions: string[];
  exp: number;
  iat?: number;
  limits?: AgentTokenPayload['limits'];
  walletAccess?: string[];
  credentialAccess?: AgentTokenPayload['credentialAccess'];
  agentPubkey?: string;
  oneShotBinding?: AgentTokenPayload['oneShotBinding'];
}): string {
  const fullPayload: AgentTokenPayload = {
    agentId: payload.agentId,
    permissions: payload.permissions,
    exp: payload.exp,
    iat: payload.iat ?? Date.now(),
  };

  if (payload.limits) {
    fullPayload.limits = payload.limits;
  }

  if (payload.walletAccess && payload.walletAccess.length > 0) {
    fullPayload.walletAccess = payload.walletAccess.map(addr => addr.toLowerCase());
  }

  if (payload.credentialAccess) {
    fullPayload.credentialAccess = payload.credentialAccess;
  } else if (
    payload.permissions.includes('secret:read') ||
    payload.permissions.includes('secret:write')
  ) {
    fullPayload.credentialAccess = {
      read: getDefaultSync<string[]>('defaults.credential.access.read', ['*']),
      write: getDefaultSync<string[]>('defaults.credential.access.write', ['*']),
      excludeFields: ['password', 'cvv'], // Exclude sensitive fields by default
    };
  }

  if (payload.agentPubkey) {
    fullPayload.agentPubkey = payload.agentPubkey;
  }

  if (payload.oneShotBinding) {
    fullPayload.oneShotBinding = payload.oneShotBinding;
  }

  const payloadStr = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const signature = createHmac('sha256', SIGNING_KEY)
    .update(payloadStr)
    .digest('base64url');

  return `${payloadStr}.${signature}`;
}
