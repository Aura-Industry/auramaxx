import { ed25519 } from '@noble/curves/ed25519.js';
import { prisma } from '../db';
import { log } from '../pino';
import { deriveSigningSeed } from './sign';

const DEFAULT_GLOBAL_HUB_URL = 'https://hub.auramaxx.now';
const IDENTITY_MAP_PATH = '/api/identity-map';
const LOOKUP_TIMEOUT_MS = 2_500;

interface IdentityMapResponse {
  auraId?: unknown;
  found?: unknown;
}

function getGlobalHubUrl(): string {
  const raw = process.env.GLOBAL_AURA_HUB_URL;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim().replace(/\/+$/, '');
  }
  return DEFAULT_GLOBAL_HUB_URL;
}

function parseAuraId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function derivePublicKeys(mnemonic: string): { publicKeyHex: string; publicKeyBase64: string } {
  const seed = deriveSigningSeed(mnemonic);
  const pubKeyBytes = ed25519.getPublicKey(seed);
  return {
    publicKeyHex: Buffer.from(pubKeyBytes).toString('hex'),
    publicKeyBase64: Buffer.from(pubKeyBytes).toString('base64'),
  };
}

async function cachePublicKey(agentId: string, publicKeyHex: string): Promise<void> {
  await prisma.agentProfile.upsert({
    where: { agentId },
    create: { agentId, publicKeyHex },
    update: { publicKeyHex },
  });
}

async function fetchGlobalAuraId(publicKeyBase64: string): Promise<number | null> {
  const endpoint = new URL(IDENTITY_MAP_PATH, `${getGlobalHubUrl()}/`);
  endpoint.searchParams.set('address', publicKeyBase64);

  const response = await fetch(endpoint.toString(), {
    method: 'GET',
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });

  if (!response.ok) return null;

  const payload = await response.json() as IdentityMapResponse;
  const found = payload.found;
  if (found === false) return null;
  return parseAuraId(payload.auraId);
}

/**
 * Best-effort sync of the global auraId from hub.auramaxx.now.
 * - Caches pubkey locally always
 * - Caches auraId locally only when remote lookup succeeds
 * - Never throws (safe to call during login / register flows)
 */
export async function syncGlobalAuraIdForAgent(agentId: string, mnemonic: string): Promise<number | null> {
  const { publicKeyHex, publicKeyBase64 } = derivePublicKeys(mnemonic);

  try {
    await cachePublicKey(agentId, publicKeyHex);
  } catch (error) {
    log.debug({ agentId, error }, 'Failed to cache agent public key while syncing global auraId');
    return null;
  }

  // Keep tests deterministic and offline.
  if (process.env.NODE_ENV === 'test') {
    return null;
  }

  let auraId: number | null = null;
  try {
    auraId = await fetchGlobalAuraId(publicKeyBase64);
  } catch (error) {
    log.debug({ agentId, error }, 'Global auraId lookup failed');
    return null;
  }

  if (!auraId) {
    return null;
  }

  try {
    await prisma.agentProfile.upsert({
      where: { agentId },
      create: { agentId, publicKeyHex, auraId },
      update: { publicKeyHex, auraId },
    });
    return auraId;
  } catch (error) {
    // auraId has a unique constraint; ignore conflicts across agents.
    log.warn({ agentId, auraId, error }, 'Failed to cache global auraId locally');
    return null;
  }
}
