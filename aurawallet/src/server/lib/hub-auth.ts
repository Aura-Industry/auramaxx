import { ed25519 } from '@noble/curves/ed25519.js';
import { deriveSigningSeed } from './social/sign';
import { HubRpcClient, HubRpcError } from './social/hub-rpc-client';
import { getAgentMnemonic, getPrimaryAgentId } from './cold';

const REFRESH_SKEW_MS = 30_000;

interface HubSessionCacheEntry {
  token: string;
  publicKeyB64: string;
  expiresAtMs: number;
}

interface HubTokenResponse {
  token: string;
  expiresAt: string;
  publicKey: string;
}

export interface HubAuthIdentity {
  agentId: string;
  mnemonic: string;
}

type HubSessionLogger = {
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

const sessionCache = new Map<string, HubSessionCacheEntry>();

function toCacheKey(hubUrl: string, publicKeyB64: string): string {
  return `${hubUrl}::${publicKeyB64}`;
}

function derivePublicKeyB64(mnemonic: string): string {
  const seed = deriveSigningSeed(mnemonic);
  const pubKeyBytes = ed25519.getPublicKey(seed);
  return Buffer.from(pubKeyBytes).toString('base64');
}

function parseExpiry(expiresAt: string): number {
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : (Date.now() + 5 * 60_000);
}

/**
 * Resolve which unlocked local agent should authenticate to a hub.
 * Primary agent is preferred, then optional caller-provided fallback.
 */
export function resolveHubAuthIdentity(
  preferredAgentId?: string,
): HubAuthIdentity | null {
  const primaryAgentId = getPrimaryAgentId() ?? 'primary';
  const candidates = [primaryAgentId];

  const preferred = typeof preferredAgentId === 'string' ? preferredAgentId.trim() : '';
  if (preferred && !candidates.includes(preferred)) {
    candidates.push(preferred);
  }

  for (const agentId of candidates) {
    const mnemonic = getAgentMnemonic(agentId);
    if (mnemonic) {
      return { agentId, mnemonic };
    }
  }

  return null;
}

async function mintSessionToken(
  hubUrl: string,
  mnemonic: string,
  publicKeyB64: string,
): Promise<HubSessionCacheEntry> {
  const seed = deriveSigningSeed(mnemonic);
  const rpc = new HubRpcClient(hubUrl);

  const challengeRes = await rpc.call<{ challenge: string }>('auth.challenge', { publicKey: publicKeyB64 });
  const challenge = challengeRes.challenge;
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(challenge), seed)).toString('base64');

  const tokenRes = await rpc.call<HubTokenResponse>('auth.token', {
    publicKey: publicKeyB64,
    challenge,
    signature,
  });

  return {
    token: tokenRes.token,
    publicKeyB64,
    expiresAtMs: parseExpiry(tokenRes.expiresAt),
  };
}

export function invalidateHubSessionToken(hubUrl: string, publicKeyB64: string): void {
  sessionCache.delete(toCacheKey(hubUrl, publicKeyB64));
}

export async function getHubSessionToken(
  hubUrl: string,
  mnemonic: string,
  opts?: { forceRefresh?: boolean; log?: HubSessionLogger },
): Promise<HubSessionCacheEntry> {
  const publicKeyB64 = derivePublicKeyB64(mnemonic);
  const key = toCacheKey(hubUrl, publicKeyB64);

  if (!opts?.forceRefresh) {
    const cached = sessionCache.get(key);
    if (cached && (cached.expiresAtMs - REFRESH_SKEW_MS) > Date.now()) {
      return cached;
    }
  }

  const fresh = await mintSessionToken(hubUrl, mnemonic, publicKeyB64);
  sessionCache.set(key, fresh);
  opts?.log?.debug?.({ hubUrl, expiresAtMs: fresh.expiresAtMs }, 'Minted hub session token');
  return fresh;
}

export async function callHubWithSessionAuth<R>(
  hubUrl: string,
  method: string,
  params: Record<string, unknown>,
  mnemonic: string,
  opts?: { log?: HubSessionLogger; timeoutMs?: number },
): Promise<R> {
  const rpc = new HubRpcClient(hubUrl);
  let session = await getHubSessionToken(hubUrl, mnemonic, { log: opts?.log });
  rpc.setBearerToken(session.token);

  try {
    return await rpc.call<R>(method, params, { timeoutMs: opts?.timeoutMs });
  } catch (error) {
    if (error instanceof HubRpcError && error.statusCode === 401) {
      opts?.log?.warn?.({ hubUrl, method }, 'Hub session token expired/invalid; refreshing and retrying once');
      invalidateHubSessionToken(hubUrl, session.publicKeyB64);
      session = await getHubSessionToken(hubUrl, mnemonic, { forceRefresh: true, log: opts?.log });
      rpc.setBearerToken(session.token);
      return rpc.call<R>(method, params, { timeoutMs: opts?.timeoutMs });
    }
    throw error;
  }
}

export async function tryCallHubWithSessionAuth<R>(
  hubUrl: string,
  method: string,
  params: Record<string, unknown>,
  mnemonic: string,
  opts?: { log?: HubSessionLogger; timeoutMs?: number },
): Promise<R | null> {
  try {
    return await callHubWithSessionAuth<R>(hubUrl, method, params, mnemonic, opts);
  } catch {
    return null;
  }
}
