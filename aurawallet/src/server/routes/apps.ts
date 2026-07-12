/**
 * App REST Routes
 * ==================
 * All app endpoints consolidated under /apps:
 * - Storage (gated by app:storage)
 * - Token retrieval (admin only, for iframe injection)
 * - API Keys (gated by app:accesskey)
 * - App Approval (gated by strategy:manage)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireWalletAuth } from '../middleware/auth';
import { requirePermissionForRoute, isAdmin } from '../lib/permissions';
import { prisma } from '../lib/db';
import {
  getRuntime,
  enableStrategy,
  disableStrategy,
  handleAppMessage,
  enqueueAppMessage,
  waitForQueuedAppMessage,
  STRATEGY_ENABLED_STORAGE_KEY,
} from '../lib/strategy/engine';
import { loadStrategyManifests } from '../lib/strategy/loader';
import { createAppToken, revokeAppToken, getAppToken } from '../lib/app-tokens';
import { validateExternalUrl } from '../lib/network';
import { onDefaultChanged, parseRateLimit, getDefaultSync } from '../lib/defaults';
import { logger } from '../lib/logger';
import { getErrorMessage } from '../lib/error';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';

const router = Router();

const bypassRateLimit = process.env.BYPASS_RATE_LIMIT === 'true';

function buildLimiterKey(req: Request, prefix: string): string {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return prefix + createHash('sha256').update(authHeader.slice(7)).digest('hex').slice(0, 16);
  }
  return prefix + ipKeyGenerator(req.ip || req.socket.remoteAddress || '127.0.0.1');
}

// Hot-reloadable rate limiter for app endpoints
function createAppHotLimiter(
  defaultKey: string,
  fallback: string,
  prefix: string,
  errorMsg: string,
): (req: Request, res: Response, next: NextFunction) => void {
  if (bypassRateLimit) return (_req, _res, next) => next();

  const { max, windowMs } = parseRateLimit(getDefaultSync(defaultKey, fallback));
  let inner = rateLimit({
    windowMs, max, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => buildLimiterKey(req, prefix),
    handler: (_req, res) => { res.status(429).json({ success: false, error: errorMsg }); },
  });

  onDefaultChanged(defaultKey, (_key, value) => {
    const updated = parseRateLimit(value);
    inner = rateLimit({
      windowMs: updated.windowMs, max: updated.max, standardHeaders: true, legacyHeaders: false,
      keyGenerator: (req) => buildLimiterKey(req, prefix),
      handler: (_req, res) => { res.status(429).json({ success: false, error: errorMsg }); },
    });
  });

  return (req, res, next) => inner(req, res, next);
}

// Rate limit for /message endpoint (LLM calls are expensive)
const messageLimit = createAppHotLimiter('rate.app_message', '10,60000', '', 'Message rate limit exceeded');

// Rate limit for /fetch proxy
const fetchRateLimit = createAppHotLimiter('rate.app_fetch', '60,60000', 'fetch:', 'Fetch rate limit exceeded');

// ─── Storage scope enforcement ──────────────────────────────────────
// Ensures a app:storage token can only access its own storage.
// Admin tokens and app:storage:all bypass the scope check.

function getCallerAppId(agentId: string): string {
  if (agentId.startsWith('strategy:')) return agentId.slice('strategy:'.length);
  if (agentId.startsWith('app:')) return agentId.slice('app:'.length);
  return agentId;
}

function enforceStorageScope(req: Request, res: Response, next: NextFunction): void {
  const auth = req.auth!;
  // Admin tokens and app:storage:all bypass scope
  if (isAdmin(auth) || auth.token.permissions.includes('app:storage:all')) {
    return next();
  }
  // Derive the caller's appId from the token's agentId
  // Strategy tokens use "strategy:<appId>", app tokens use "app:<appId>"
  const callerAppId = getCallerAppId(auth.token.agentId);
  if (String(req.params.appId) !== callerAppId) {
    res.status(403).json({ success: false, error: "Cannot access another app's storage" });
    return;
  }
  next();
}

// ─── Authenticated Storage (app:storage) ───────────────────────

/**
 * GET /apps/:appId/storage — List all keys for a app
 */
router.get('/:appId/storage', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APPS_STORAGE, 'app:storage'), enforceStorageScope, async (req: Request, res: Response) => {
  try {
    const appId = String(req.params.appId);

    const entries = await prisma.appStorage.findMany({
      where: { appId },
      select: { key: true, value: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });

    res.json({
      success: true,
      appId,
      entries: entries.map(e => ({
        key: e.key,
        value: JSON.parse(e.value),
        updatedAt: e.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * GET /apps/:appId/storage/:key — Get a single value
 */
router.get('/:appId/storage/:key', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APPS_STORAGE, 'app:storage'), enforceStorageScope, async (req: Request, res: Response) => {
  try {
    const appId = String(req.params.appId);
    const key = String(req.params.key);

    const entry = await prisma.appStorage.findUnique({
      where: { appId_key: { appId, key } },
    });

    if (!entry) {
      res.status(404).json({ success: false, error: 'Key not found' });
      return;
    }

    res.json({
      success: true,
      appId,
      key,
      value: JSON.parse(entry.value),
      updatedAt: entry.updatedAt.toISOString(),
    });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * PUT /apps/:appId/storage/:key — Set a value (upsert)
 */
router.put('/:appId/storage/:key', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APPS_STORAGE, 'app:storage'), enforceStorageScope, async (req: Request, res: Response) => {
  try {
    const appId = String(req.params.appId);
    const key = String(req.params.key);
    const { value } = req.body;

    if (value === undefined) {
      res.status(400).json({ success: false, error: 'value is required' });
      return;
    }

    const serialized = JSON.stringify(value);

    const entry = await prisma.appStorage.upsert({
      where: { appId_key: { appId, key } },
      update: { value: serialized },
      create: { appId, key, value: serialized },
    });

    res.json({
      success: true,
      appId,
      key,
      value: JSON.parse(entry.value),
      updatedAt: entry.updatedAt.toISOString(),
    });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * DELETE /apps/:appId/storage/:key — Delete a key
 */
router.delete('/:appId/storage/:key', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APPS_STORAGE, 'app:storage'), enforceStorageScope, async (req: Request, res: Response) => {
  try {
    const appId = String(req.params.appId);
    const key = String(req.params.key);

    const existing = await prisma.appStorage.findUnique({
      where: { appId_key: { appId, key } },
    });

    if (!existing) {
      res.status(404).json({ success: false, error: 'Key not found' });
      return;
    }

    await prisma.appStorage.delete({
      where: { appId_key: { appId, key } },
    });

    res.json({ success: true, appId, key });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ─── App Messaging ──────────────────────────────────────────────

/**
 * POST /apps/:appId/message — Send a message to the app's AI
 * Body: { message: string }
 * Requires: app:storage permission (same as storage ops), scoped to own app
 */
router.post('/:appId/message', messageLimit, requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APPS_STORAGE, 'app:storage'), enforceStorageScope, async (req: Request, res: Response) => {
  const appId = String(req.params.appId);
  const { message, adapter } = req.body;

  if (!message || typeof message !== 'string') {
    res.status(400).json({ success: false, error: 'message is required' });
    return;
  }

  try {
    const adapterName = typeof adapter === 'string' ? adapter : 'dashboard';

    // Fast path for built-in system chat: avoid queue + cron poll latency.
    if (appId === '__system__') {
      const direct = await handleAppMessage(appId, message, undefined, adapterName);
      if (direct.error) {
        res.status(400).json({ success: false, error: direct.error });
        return;
      }
      res.json({ success: true, reply: direct.reply });
      return;
    }

    // agent-chat widget flow: process directly with the caller's scoped app token.
    const auth = req.auth!;
    const callerAppId = getCallerAppId(auth.token.agentId);
    const isScopedWidgetCaller = !isAdmin(auth)
      && !auth.token.permissions.includes('app:storage:all')
      && callerAppId === appId;

    if (appId === 'agent-chat' && isScopedWidgetCaller) {
      const authHeader = req.header('authorization') || '';
      const callerToken = authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : '';

      if (!callerToken) {
        res.status(401).json({ success: false, error: 'Missing bearer token' });
        return;
      }

      const direct = await handleAppMessage(appId, message, undefined, adapterName, callerToken);
      if (direct.error) {
        res.status(400).json({ success: false, error: direct.error });
        return;
      }
      res.json({ success: true, reply: direct.reply });
      return;
    }

    const requestId = await enqueueAppMessage(appId, message, adapterName);
    const timeoutMs = getDefaultSync<number>('strategy.message_timeout_ms', 120_000);
    const result = await waitForQueuedAppMessage(requestId, timeoutMs);

    if (result.status === 'timeout') {
      res.status(504).json({ success: false, error: result.error || 'Timed out waiting for message processing' });
      return;
    }

    if (result.status === 'error') {
      res.status(400).json({ success: false, error: result.error || 'Message processing failed' });
      return;
    }

    res.json({ success: true, reply: result.reply });
  } catch (err) {
    const msg = getErrorMessage(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ─── Fetch Proxy ─────────────────────────────────────────────────────

const ALLOWED_FETCH_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

/**
 * POST /apps/:appId/fetch — Proxy an external HTTP request on behalf of a app
 * Body: { url: string, method?: string, headers?: object, body?: string }
 * Requires: app:storage permission (same as storage ops), scoped to own app
 */
router.post('/:appId/fetch', fetchRateLimit, requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APPS_STORAGE, 'app:storage'), enforceStorageScope, async (req: Request, res: Response) => {
  const { url, method = 'GET', headers, body } = req.body;

  // Validate URL
  if (!url || typeof url !== 'string') {
    res.status(400).json({ success: false, error: 'url is required' });
    return;
  }

  // SSRF protection: validate protocol, resolve DNS, check for private IPs
  try {
    await validateExternalUrl(url);
  } catch (err) {
    const msg = getErrorMessage(err);
    res.status(403).json({ success: false, error: msg });
    return;
  }

  // Validate method
  const upperMethod = (typeof method === 'string' ? method : 'GET').toUpperCase();
  if (!ALLOWED_FETCH_METHODS.includes(upperMethod)) {
    res.status(400).json({ success: false, error: `Method must be one of: ${ALLOWED_FETCH_METHODS.join(', ')}` });
    return;
  }

  try {
    const fetchOpts: RequestInit = {
      method: upperMethod,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    };

    if (headers && typeof headers === 'object') {
      fetchOpts.headers = headers;
    }

    if (body !== undefined && upperMethod !== 'GET') {
      fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await fetch(url, fetchOpts);

    // Try to parse as JSON, fall back to text
    const contentType = response.headers.get('content-type') || '';
    let data: unknown;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    res.json({ success: true, status: response.status, data });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      res.status(504).json({ success: false, error: 'Request timed out (10s)' });
      return;
    }
    const msg = getErrorMessage(err);
    res.status(502).json({ success: false, error: msg });
  }
});

/**
 * GET /apps/:appId/token — Get the pre-created token for a app
 * Used by ThirdPartyApp to inject token into iframe blob.
 */
router.get('/:appId/token', requireWalletAuth, async (req: Request, res: Response, next: NextFunction) => {
  if (!isAdmin(req.auth!)) {
    await respondPermissionDenied({
      req,
      res,
      routeId: ESCALATION_ROUTE_IDS.APPS_ADMIN_STORAGE,
      error: 'Admin access required',
      required: ['admin:*'],
      have: req.auth?.token.permissions,
      extraPayload: { success: false },
    });
    return;
  }
  next();
}, (req: Request, res: Response) => {
  const appId = String(req.params.appId);
  const token = getAppToken(appId);

  if (!token) {
    res.status(404).json({ success: false, error: `No token for app "${appId}"` });
    return;
  }

  res.json({ success: true, token });
});

// ─── API Key Access (app:accesskey) ────────────────────────────

/**
 * GET /apps/:appId/apikey/:keyName — Get API key value from app storage
 */
router.get('/:appId/apikey/:keyName', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APPS_ACCESSKEY, 'app:accesskey'), async (req: Request, res: Response) => {
  try {
    const appId = String(req.params.appId);
    const keyName = String(req.params.keyName);

    const entry = await prisma.appStorage.findUnique({
      where: { appId_key: { appId, key: keyName } },
    });

    if (!entry) {
      res.status(404).json({ success: false, error: 'API key not found' });
      return;
    }

    res.json({
      success: true,
      appId,
      keyName,
      value: JSON.parse(entry.value),
    });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ─── App Hot Reload (admin only) ───────────────────────────────

/**
 * POST /apps/:appId/reload — Create token for a newly installed app
 * without requiring a full server restart.
 */
router.post('/:appId/reload', requireWalletAuth, async (req: Request, res: Response, next: NextFunction) => {
  if (!isAdmin(req.auth!)) {
    await respondPermissionDenied({
      req,
      res,
      routeId: ESCALATION_ROUTE_IDS.APPS_ADMIN_ACCESSKEY,
      error: 'Admin access required',
      required: ['admin:*'],
      have: req.auth?.token.permissions,
      extraPayload: { success: false },
    });
    return;
  }
  next();
}, async (req: Request, res: Response) => {
  const appId = String(req.params.appId);

  try {
    const token = await createAppToken(appId);
    if (!token) {
      res.status(500).json({ success: false, error: 'Failed to create app token' });
      return;
    }

    logger.appOperation('reload', appId);
    res.json({ success: true, appId, reloaded: true });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ─── App Approval (strategy:manage) ────────────────────────────

/**
 * POST /apps/:appId/approve — Approve app permissions
 * Reads the app's manifest, creates a HumanAction record, enables strategy if loaded.
 */
router.post('/:appId/approve', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APPS_STRATEGY_MANAGE, 'strategy:manage'), async (req: Request, res: Response) => {
  try {
    const appId = String(req.params.appId);

    // Find the app's manifest
    const manifests = loadStrategyManifests();
    const manifest = manifests.find(m => m.id === appId);

    if (!manifest) {
      res.status(404).json({ success: false, error: `App "${appId}" not found or has no strategy manifest` });
      return;
    }

    // Create or update approval record
    // Find existing approval for this app
    const existingApprovals = await prisma.humanAction.findMany({
      where: { type: 'app:approve', status: 'approved' },
    });
    const existing = existingApprovals.find(a => {
      try { return JSON.parse(a.metadata || '{}').appId === appId; } catch { return false; }
    });

    const metadata = JSON.stringify({
      appId,
      permissions: manifest.permissions,
      limits: manifest.limits || null,
    });

    const approval = existing
      ? await prisma.humanAction.update({
          where: { id: existing.id },
          data: { metadata, resolvedAt: new Date() },
        })
      : await prisma.humanAction.create({
          data: {
            type: 'app:approve',
            fromTier: 'system',
            chain: 'base',
            status: 'approved',
            resolvedAt: new Date(),
            metadata,
          },
        });

    // Create/replace app token in central registry
    await createAppToken(appId);

    // Keep explicit enable override aligned with approval flow.
    await prisma.appStorage.upsert({
      where: { appId_key: { appId, key: STRATEGY_ENABLED_STORAGE_KEY } },
      create: {
        appId,
        key: STRATEGY_ENABLED_STORAGE_KEY,
        value: JSON.stringify(true),
      },
      update: { value: JSON.stringify(true) },
    });

    // Enable the strategy if it's loaded and not already enabled
    const runtime = getRuntime(appId);
    if (runtime && !runtime.enabled) {
      try {
        await enableStrategy(appId);
      } catch (err) {
        console.error(`[apps] Failed to enable strategy ${appId} after approval:`, err);
      }
    }

    logger.appOperation('install', appId);

    res.json({
      success: true,
      appId,
      permissions: manifest.permissions,
      limits: manifest.limits || null,
      approvedAt: approval.resolvedAt?.toISOString() || approval.createdAt.toISOString(),
    });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * DELETE /apps/:appId/approve — Revoke app approval
 * Disables the strategy and deletes the approval record.
 */
router.delete('/:appId/approve', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.APPS_STRATEGY_MANAGE, 'strategy:manage'), async (req: Request, res: Response) => {
  try {
    const appId = String(req.params.appId);

    // Disable the strategy if running
    const runtime = getRuntime(appId);
    if (runtime && runtime.enabled) {
      try {
        await disableStrategy(appId);
      } catch (err) {
        console.error(`[apps] Failed to disable strategy ${appId} on revoke:`, err);
      }
    }

    // Revoke app token from central registry + add to revokedTokens set
    await revokeAppToken(appId);

    // Explicitly disable strategy runtime reconciliation for this app.
    await prisma.appStorage.upsert({
      where: { appId_key: { appId, key: STRATEGY_ENABLED_STORAGE_KEY } },
      create: {
        appId,
        key: STRATEGY_ENABLED_STORAGE_KEY,
        value: JSON.stringify(false),
      },
      update: { value: JSON.stringify(false) },
    });

    // Delete the approval record
    try {
      const approvalRecords = await prisma.humanAction.findMany({
        where: { type: 'app:approve', status: 'approved' },
      });
      const existing = approvalRecords.find(a => {
        try { return JSON.parse(a.metadata || '{}').appId === appId; } catch { return false; }
      });
      if (existing) {
        await prisma.humanAction.delete({ where: { id: existing.id } });
      }
    } catch {
      // Record may not exist — that's fine
    }

    logger.appOperation('uninstall', appId);

    res.json({ success: true, appId, revoked: true });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
