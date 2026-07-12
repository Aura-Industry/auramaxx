/**
 * Verified credential routes.
 * Reads are served from local cache (InboundMessage + in-memory).
 * Only POST /request and GET /request/:id hit the hub at runtime.
 */
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db';
import { requireWalletAuth } from '../middleware/auth';
import { requirePermission } from '../lib/permissions';
import { getHubUrl } from '../lib/defaults';
import { isAgentUnlocked, getAgentMnemonic } from '../lib/cold';
import { deriveSigningSeed } from '../lib/social/sign';
import { ed25519 } from '@noble/curves/ed25519.js';
import { HubRpcError } from '../lib/social/hub-rpc-client';
import { callHubWithSessionAuth, resolveHubAuthIdentity, tryCallHubWithSessionAuth } from '../lib/hub-auth';
import { normalizeHubPublicKey } from '../lib/social/public-key';

const router = Router();

// All routes require auth
router.use(requireWalletAuth);

const requireCredentialRead = requirePermission('credential:read', 'credential:write');
const requireCredentialWrite = requirePermission('credential:write');

// ─── In-memory caches ────────────────────────────────────────────────

interface CacheEntry<T> { data: T; expiresAt: number }

// Credential types — changes very rarely, 1hr TTL
let typesCache: CacheEntry<unknown[]> | null = null;
const TYPES_TTL_MS = 60 * 60 * 1000; // 1 hour

// Pending requests per agentId — 60s TTL, invalidated on POST /request
const pendingCache = new Map<string, CacheEntry<unknown[]>>();
const PENDING_TTL_MS = 60 * 1000; // 60 seconds

// Single request status — 10s TTL, permanent once terminal
const requestCache = new Map<string, CacheEntry<unknown>>();
const REQUEST_TTL_MS = 10 * 1000; // 10 seconds

const DEFAULT_CREDENTIAL_TYPES = [
  {
    slug: 'x',
    name: 'X',
    description: 'Verify ownership of an X account',
    verifierKey: 'x',
    enabled: true,
    config: {
      canonicalMessage: 'im auramaxxing',
    },
  },
];

function resolveHubSessionMnemonic(): string | null {
  return resolveHubAuthIdentity()?.mnemonic ?? null;
}

async function tryHubRpc<R>(method: string, params: Record<string, unknown> = {}): Promise<R | null> {
  const mnemonic = resolveHubSessionMnemonic();
  if (!mnemonic) return null;
  return tryCallHubWithSessionAuth<R>(getHubUrl(), method, params, mnemonic);
}

async function callHubRpc<R>(method: string, params: Record<string, unknown> = {}): Promise<R> {
  const mnemonic = resolveHubSessionMnemonic();
  if (!mnemonic) {
    throw new Error('hub_auth_unavailable');
  }
  return callHubWithSessionAuth<R>(getHubUrl(), method, params, mnemonic);
}

// ─── Read routes ─────────────────────────────────────────────────────

// GET /verified-credentials/types — cached in memory, 1hr TTL
router.get('/types', requireCredentialRead, async (_req: Request, res: Response) => {
  const now = Date.now();
  if (typesCache && now < typesCache.expiresAt) {
    const cachedTypes = Array.isArray(typesCache.data) ? typesCache.data : [];
    if (cachedTypes.length > 0) {
      res.json({ ok: true, types: cachedTypes });
      return;
    }
    // Don't stick on an empty cache entry for an hour.
    typesCache = null;
  }

  const result = await tryHubRpc<{ types: unknown[] }>('credentials.types');
  if (!result) {
    // Serve stale cache if hub is down
    if (typesCache) {
      const staleTypes = Array.isArray(typesCache.data) ? typesCache.data : [];
      if (staleTypes.length > 0) {
        res.json({ ok: true, types: staleTypes });
        return;
      }
      typesCache = null;
    }
    res.json({ ok: true, types: DEFAULT_CREDENTIAL_TYPES });
    return;
  }

  const types = Array.isArray(result.types) ? result.types : [];

  if (types.length === 0) {
    const fallback = DEFAULT_CREDENTIAL_TYPES;
    typesCache = { data: fallback, expiresAt: now + 60_000 }; // short cache for empty upstream
    res.json({ ok: true, types: fallback });
    return;
  }

  typesCache = { data: types as unknown[], expiresAt: now + TYPES_TTL_MS };
  res.json({ ok: true, types });
});

// GET /verified-credentials/mine?agentId=X — reads from local InboundMessage cache
router.get('/mine', requireCredentialRead, async (req: Request, res: Response) => {
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
  if (!agentId) {
    res.status(400).json({ error: 'agentId query param is required' });
    return;
  }

  const profile = await prisma.agentProfile.findUnique({ where: { agentId } });
  if (!profile?.publicKeyHex) {
    res.json({ ok: true, credentials: [] });
    return;
  }

  // Read from local InboundMessage cache (populated by social-inbound cron)
  const messages = await prisma.inboundMessage.findMany({
    where: { agentId, type: 'credential_add' },
    orderBy: { timestamp: 'desc' },
  });

  const credentials = messages.map((msg, idx) => {
    try {
      const body = JSON.parse(msg.body) as Record<string, unknown>;
      return {
        id: idx + 1,
        credentialType: body.credentialType ?? 'unknown',
        claimedIdentity: body.claimedIdentity ?? '',
        ownerPublicKey: profile.publicKeyHex,
        issuerAuraId: body.issuerAuraId ?? 1,
        attestationHash: msg.hash,
        verifiedAt: typeof body.verifiedAt === 'number'
          ? new Date(body.verifiedAt).toISOString()
          : new Date(msg.timestamp * 1000).toISOString(),
        revoked: false,
      };
    } catch {
      return null;
    }
  }).filter(Boolean);

  res.json({ ok: true, credentials });
});

// GET /verified-credentials/pending?agentId=X — cached 60s, invalidated on POST /request
router.get('/pending', requireCredentialRead, async (req: Request, res: Response) => {
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
  if (!agentId) {
    res.status(400).json({ error: 'agentId query param is required' });
    return;
  }

  const profile = await prisma.agentProfile.findUnique({ where: { agentId } });
  if (!profile?.publicKeyHex) {
    res.json({ ok: true, requests: [] });
    return;
  }

  const now = Date.now();
  const cached = pendingCache.get(agentId);
  if (cached && now < cached.expiresAt) {
    res.json({ ok: true, requests: cached.data });
    return;
  }

  const result = await tryHubRpc<{ requests: unknown[] }>(
    'credentials.requestsByPublicKey',
    { publicKey: normalizeHubPublicKey(profile.publicKeyHex) },
  );
  if (!result) {
    if (cached) {
      res.json({ ok: true, requests: cached.data });
      return;
    }
    res.status(502).json({ error: 'hub_unreachable' });
    return;
  }

  const requests = Array.isArray(result.requests) ? result.requests : [];
  pendingCache.set(agentId, { data: requests as unknown[], expiresAt: now + PENDING_TTL_MS });
  res.json({ ok: true, requests });
});

// GET /verified-credentials/request/:requestId — cached 10s, permanent once terminal
router.get('/request/:requestId', requireCredentialRead, async (req: Request, res: Response) => {
  const requestId = String(req.params.requestId);
  const now = Date.now();

  const cached = requestCache.get(requestId);
  if (cached && now < cached.expiresAt) {
    res.json(cached.data);
    return;
  }

  const result = await tryHubRpc<{ request: Record<string, unknown> }>(
    'credentials.getRequest',
    { requestId },
  );
  if (!result) {
    if (cached) {
      res.json(cached.data);
      return;
    }
    res.status(502).json({ error: 'hub_unreachable' });
    return;
  }

  // Terminal states get cached for a long time
  const request = result.request;
  const status = request?.status;
  const isTerminal = status === 'verified' || status === 'rejected' || status === 'failed';
  const ttl = isTerminal ? 24 * 60 * 60 * 1000 : REQUEST_TTL_MS; // 24h for terminal, 10s otherwise

  const payload = { ok: true, request };
  requestCache.set(requestId, { data: payload, expiresAt: now + ttl });
  res.json(payload);
});

// ─── Write routes ────────────────────────────────────────────────────

// POST /verified-credentials/request — must hit hub (initiates verification)
router.post('/request', requireCredentialWrite, async (req: Request, res: Response) => {
  try {
    const { agentId, credentialTypeSlug, claimedIdentity, proofUrl } = req.body ?? {};

    if (!agentId || typeof agentId !== 'string') {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    if (!credentialTypeSlug || typeof credentialTypeSlug !== 'string') {
      res.status(400).json({ error: 'credentialTypeSlug is required' });
      return;
    }
    if (!claimedIdentity || typeof claimedIdentity !== 'string') {
      res.status(400).json({ error: 'claimedIdentity is required' });
      return;
    }

    const profile = await prisma.agentProfile.findUnique({ where: { agentId } });
    if (!profile?.publicKeyHex) {
      res.status(400).json({ error: `Agent "${agentId}" has no derived public key — unlock the agent first` });
      return;
    }

    const data = await callHubRpc('credentials.request', {
      publicKey: normalizeHubPublicKey(profile.publicKeyHex),
      credentialTypeSlug,
      claimedIdentity: claimedIdentity.trim(),
      proofUrl: typeof proofUrl === 'string' ? proofUrl.trim() : undefined,
    });

    // Invalidate pending cache for this agent
    pendingCache.delete(agentId);

    res.json({ ok: true, ...data as Record<string, unknown> });
  } catch (err) {
    if (err instanceof Error && err.message === 'hub_auth_unavailable') {
      res.status(503).json({ error: 'hub_auth_unavailable', detail: 'Unlock primary agent to authenticate to hub' });
      return;
    }
    if (err instanceof HubRpcError) {
      res.status(err.statusCode).json({ error: err.code, detail: err.detail });
      return;
    }
    res.status(502).json({ error: 'hub_unreachable', detail: err instanceof Error ? err.message : String(err) });
  }
});

// POST /verified-credentials/sign-proof — sign the canonical verification message
router.post('/sign-proof', requireCredentialWrite, async (req: Request, res: Response) => {
  try {
    const { agentId } = req.body ?? {};
    if (!agentId || typeof agentId !== 'string') {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }

    if (!isAgentUnlocked(agentId)) {
      res.status(400).json({ error: 'Agent must be unlocked' });
      return;
    }
    const mnemonic = getAgentMnemonic(agentId);
    if (!mnemonic) {
      res.status(400).json({ error: 'Cannot access agent mnemonic' });
      return;
    }

    const seed = deriveSigningSeed(mnemonic);
    const messageBytes = new TextEncoder().encode('im auramaxxing');
    const sigBytes = ed25519.sign(messageBytes, seed);

    res.json({ ok: true, signature: Buffer.from(sigBytes).toString('base64url') });
  } catch (err) {
    res.status(500).json({ error: 'signing_failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
