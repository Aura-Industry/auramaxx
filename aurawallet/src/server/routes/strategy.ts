/**
 * Strategy REST Routes
 * ====================
 * Endpoints for managing strategy lifecycle, config, and intent approvals.
 */

import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { requireWalletAuth } from '../middleware/auth';
import { requirePermissionForRoute, isAdmin } from '../lib/permissions';
import { prisma } from '../lib/db';
import { events } from '../lib/events';
import { logger } from '../lib/logger';
import {
  getStrategies,
  enableStrategy,
  disableStrategy,
  reloadStrategies,
  getRuntime,
  isEngineStarted,
} from '../lib/strategy/engine';
import { getState } from '../lib/strategy/state';
import type { StrategyStatus, StrategyManifest } from '../lib/strategy/types';
import { getDefaultSync } from '../lib/defaults';
import { buildTemplateStrategy, isSupportedTemplate, listStrategyTemplates } from '../lib/strategy/templates';
import {
  prepareThirdPartyStrategyFromManifest,
  prepareThirdPartyStrategyFromSource,
} from '../lib/strategy/installer';
import {
  listPersistedStrategies,
  getPersistedStrategy,
  createPersistedStrategy,
  updatePersistedStrategyConfig,
  updatePersistedStrategyEnabled,
} from '../lib/strategy/repository';
import { getErrorMessage } from '../lib/error';
import { createAppTokens, getAppToken } from '../lib/app-tokens';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';

const router = Router();

// Guard: prevent strategy mutations before cron starts the engine
router.use((req, res, next) => {
  if (req.method === 'GET') return next();                    // reads always OK (serve from DB)
  if (req.path.startsWith('/internal/')) return next();       // internal endpoints for cron itself
  if (req.path === '/' && req.method === 'POST') return next();       // creation writes to DB
  if (req.path === '/install' && req.method === 'POST') return next(); // install writes to DB
  if (req.path === '/reload') return next();                  // reload has its own guard

  const cronEnabled = getDefaultSync<boolean>('strategy.cron_enabled', true);
  if (cronEnabled && !isEngineStarted()) {
    res.status(503).json({
      success: false,
      error: 'Strategy engine not ready — waiting for cron to initialize',
    });
    return;
  }
  next();
});

const STRATEGY_RUNNER_SYNC_KEY = 'strategy_runner';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseInstallApprovalMetadata(
  metadata: string | null | undefined,
): { strategyId?: string; permissions?: string[]; limits?: Record<string, unknown> } {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as { strategyId?: string; permissions?: string[]; limits?: Record<string, unknown> };
    return parsed || {};
  } catch {
    return {};
  }
}

async function findThirdPartyInstallApproval(strategyId: string): Promise<{ id: string; status: string } | null> {
  const approvals = await prisma.humanAction.findMany({
    where: { type: 'strategy:install:approve' },
    select: { id: true, status: true, metadata: true },
    orderBy: { createdAt: 'desc' },
  });

  for (const row of approvals) {
    const parsed = parseInstallApprovalMetadata(row.metadata);
    if (parsed.strategyId === strategyId) {
      return { id: row.id, status: row.status };
    }
  }

  return null;
}

async function buildStrategyStatuses(): Promise<StrategyStatus[]> {
  const runtimeStatusById = new Map(getStrategies().map((status) => [status.id, status]));
  const persisted = await listPersistedStrategies();

  const persistedStatuses: StrategyStatus[] = persisted.map((strategy) => {
    const runtime = runtimeStatusById.get(strategy.id);
    return {
      id: strategy.id,
      name: strategy.name,
      icon: strategy.manifest.icon,
      ticker: runtime?.ticker ?? strategy.manifest.ticker,
      enabled: runtime?.enabled ?? strategy.enabled,
      running: runtime?.running ?? false,
      lastTick: runtime?.lastTick ?? strategy.lastTickAt?.getTime(),
      lastError: runtime?.lastError ?? strategy.lastError ?? undefined,
      errorCount: runtime?.errorCount ?? strategy.errorCount,
      pausedUntil: runtime?.pausedUntil,
    } satisfies StrategyStatus;
  });

  return persistedStatuses;
}

/**
 * GET /strategies — List all strategies with status
 */
router.get('/', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_READ, 'strategy:read'), async (_req: Request, res: Response) => {
  try {
    const strategies = await buildStrategyStatuses();
    res.json({ success: true, strategies });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * GET /strategies/templates — List available strategy templates
 */
router.get('/templates', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_READ, 'strategy:read'), async (_req: Request, res: Response) => {
  try {
    const templates = listStrategyTemplates();
    res.json({ success: true, templates });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /strategies — Create a DB-backed strategy from a template
 */
router.post('/', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_MANAGE, 'strategy:manage'), async (req: Request, res: Response) => {
  try {
    if (!isPlainObject(req.body)) {
      res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
      return;
    }

    const { template, name, mode = 'headless', config = {}, enabled = false } = req.body as {
      template?: string;
      name?: string;
      mode?: string;
      config?: unknown;
      enabled?: boolean;
      permissions?: unknown;
      limits?: unknown;
    };

    if (!template || typeof template !== 'string') {
      res.status(400).json({ success: false, error: 'template is required' });
      return;
    }
    if (!isSupportedTemplate(template)) {
      res.status(400).json({ success: false, error: `Unsupported template "${template}"` });
      return;
    }
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ success: false, error: 'name is required' });
      return;
    }
    if (mode !== 'headless' && mode !== 'app-linked') {
      res.status(400).json({ success: false, error: 'mode must be "headless" or "app-linked"' });
      return;
    }
    if (!isPlainObject(config)) {
      res.status(400).json({ success: false, error: 'config must be an object' });
      return;
    }
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'enabled must be a boolean' });
      return;
    }
    if ('permissions' in req.body || 'limits' in req.body) {
      res.status(400).json({
        success: false,
        error: 'permissions/limits cannot be overridden for template strategies',
      });
      return;
    }

    const strategyId = randomUUID();
    let built;
    try {
      built = buildTemplateStrategy({
        templateId: template,
        strategyId,
        strategyName: name.trim(),
        mode,
        rawConfig: config,
      });
    } catch (err) {
      const message = getErrorMessage(err);
      res.status(400).json({ success: false, error: message });
      return;
    }

    const created = await createPersistedStrategy({
      id: strategyId,
      name: name.trim(),
      templateId: template,
      mode,
      manifest: built.manifest,
      config: built.config,
      state: {},
      schedule: built.schedule,
      permissions: built.permissions,
      limits: built.limits ?? null,
      enabled: Boolean(enabled),
      status: enabled ? 'enabled' : 'draft',
      createdBy: req.auth?.token?.agentId?.startsWith('admin') ? 'human' : `agent:${req.auth?.token?.agentId || 'unknown'}`,
      provenance: { source: 'template', templateId: template },
    });

    const runtime = getRuntime(created.id);
    if (runtime && enabled && !runtime.enabled) {
      await enableStrategy(created.id).catch((err) => console.warn(`[strategy:${created.id}] auto-enable after creation failed:`, getErrorMessage(err)));
    }

    res.status(201).json({
      success: true,
      strategy: {
        id: created.id,
        name: created.name,
        templateId: created.templateId,
        mode: created.mode,
        enabled: created.enabled,
        status: created.status,
        config: created.config,
        schedule: created.schedule,
      },
    });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /strategies/install — Install/register a third-party strategy source or manifest
 */
router.post('/install', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_MANAGE, 'strategy:manage'), async (req: Request, res: Response) => {
  try {
    if (!isPlainObject(req.body)) {
      res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
      return;
    }

    const {
      source,
      manifest,
      sourceLabel,
      name,
      mode = 'headless',
      config = {},
      enabled = false,
      approve = false,
    } = req.body as {
      source?: unknown;
      manifest?: unknown;
      sourceLabel?: unknown;
      name?: unknown;
      mode?: unknown;
      config?: unknown;
      enabled?: unknown;
      approve?: unknown;
    };

    if ((typeof source === 'string') === Boolean(manifest)) {
      res.status(400).json({
        success: false,
        error: 'Provide exactly one of "source" or "manifest"',
      });
      return;
    }
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      res.status(400).json({ success: false, error: 'name must be a non-empty string when provided' });
      return;
    }
    if (mode !== 'headless' && mode !== 'app-linked') {
      res.status(400).json({ success: false, error: 'mode must be "headless" or "app-linked"' });
      return;
    }
    if (!isPlainObject(config)) {
      res.status(400).json({ success: false, error: 'config must be an object' });
      return;
    }
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'enabled must be a boolean' });
      return;
    }
    if (typeof approve !== 'boolean') {
      res.status(400).json({ success: false, error: 'approve must be a boolean' });
      return;
    }
    if (sourceLabel !== undefined && typeof sourceLabel !== 'string') {
      res.status(400).json({ success: false, error: 'sourceLabel must be a string when provided' });
      return;
    }

    const strategyId = randomUUID();
    const prepared = typeof source === 'string'
      ? await prepareThirdPartyStrategyFromSource({
          source,
          strategyId,
          strategyName: typeof name === 'string' ? name : undefined,
        })
      : prepareThirdPartyStrategyFromManifest({
          manifest: manifest as StrategyManifest,
          strategyId,
          sourceLabel: typeof sourceLabel === 'string' ? sourceLabel : undefined,
        });

    const strategyName = typeof name === 'string' ? name.trim() : prepared.manifest.name || strategyId;
    prepared.manifest.id = strategyId;
    prepared.manifest.name = strategyName;

    const permissions = Array.isArray(prepared.manifest.permissions)
      ? prepared.manifest.permissions
      : [];
    const limits = prepared.manifest.limits || null;
    const requiresPermissionApproval = permissions.length > 0 || Boolean(limits);

    let approvalRequired = false;
    let approvalId: string | undefined;

    if (requiresPermissionApproval) {
      if (approve) {
        if (!req.auth || !isAdmin(req.auth)) {
          await respondPermissionDenied({
            req,
            res,
            routeId: ESCALATION_ROUTE_IDS.STRATEGY_INSTALL_ADMIN,
            error: 'Explicit install approval requires admin authentication',
            required: ['admin:*'],
            have: req.auth?.token.permissions,
            extraPayload: { success: false },
          });
          return;
        }
        const approval = await prisma.humanAction.create({
          data: {
            type: 'strategy:install:approve',
            fromTier: 'system',
            chain: 'base',
            status: 'approved',
            resolvedAt: new Date(),
            metadata: JSON.stringify({
              strategyId,
              permissions,
              limits,
              provenance: prepared.provenance,
            }),
          },
        });
        approvalId = approval.id;
      } else {
        const approval = await prisma.humanAction.create({
          data: {
            type: 'strategy:install:approve',
            fromTier: 'system',
            chain: 'base',
            status: 'pending',
            metadata: JSON.stringify({
              strategyId,
              permissions,
              limits,
              provenance: prepared.provenance,
            }),
          },
        });
        approvalId = approval.id;
        approvalRequired = true;
      }
    }

    const shouldEnable = enabled && !approvalRequired;
    const created = await createPersistedStrategy({
      id: strategyId,
      name: strategyName,
      mode,
      manifest: prepared.manifest,
      config: config as Record<string, unknown>,
      state: {},
      schedule: { kind: prepared.manifest.jobs?.length ? 'jobs' : prepared.manifest.ticker ? 'ticker' : 'manual' },
      permissions,
      limits,
      enabled: shouldEnable,
      status: approvalRequired ? 'awaiting_approval' : shouldEnable ? 'enabled' : 'draft',
      createdBy: req.auth?.token?.agentId?.startsWith('admin') ? 'human' : `agent:${req.auth?.token?.agentId || 'unknown'}`,
      provenance: {
        source: 'third_party',
        ...prepared.provenance,
      },
    });

    const runtime = getRuntime(created.id);
    if (runtime && shouldEnable && !runtime.enabled) {
      await enableStrategy(created.id).catch((err) => console.warn(`[strategy:${created.id}] auto-enable after install failed:`, getErrorMessage(err)));
    }

    res.status(201).json({
      success: true,
      strategy: {
        id: created.id,
        name: created.name,
        mode: created.mode,
        enabled: created.enabled,
        status: created.status,
        permissions: created.permissions,
        limits: created.limits,
        provenance: created.provenance,
      },
      approvalRequired,
      approvalId: approvalId || null,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(400).json({ success: false, error: message });
  }
});

/**
 * GET /strategies/health — Cron-owned strategy runtime health
 */
router.get('/health', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_READ, 'strategy:read'), async (_req: Request, res: Response) => {
  try {
    const cronEnabled = getDefaultSync<boolean>('strategy.cron_enabled', true);
    const staleAfterMs = getDefaultSync<number>('strategy.health_stale_ms', 30_000);

    const syncState = await prisma.syncState.findUnique({
      where: { chain: STRATEGY_RUNNER_SYNC_KEY },
    });

    const now = Date.now();
    const lastSyncAtMs = syncState?.lastSyncAt?.getTime() ?? null;
    const isStale = cronEnabled
      ? !lastSyncAtMs || now - lastSyncAtMs > staleAfterMs
      : false;
    const isErrored = syncState?.lastSyncStatus === 'error';
    const healthy = cronEnabled ? !isStale && !isErrored : true;

    res.status(healthy ? 200 : 503).json({
      success: healthy,
      strategyRuntime: {
        owner: 'cron',
        cronEnabled,
        apiEngineStarted: isEngineStarted(),
        healthy,
        staleAfterMs,
        isStale,
        lastSyncAt: syncState?.lastSyncAt?.toISOString() ?? null,
        lastStatus: syncState?.lastSyncStatus ?? 'unknown',
        lastError: syncState?.lastError ?? null,
        syncCount: syncState?.syncCount ?? 0,
      },
    });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

async function setStrategyEnabledState(id: string, nextEnabled: boolean): Promise<{
  success: boolean;
  status?: number;
  error?: string;
  enabled?: boolean;
  owner?: 'api-runtime' | 'cron-runtime';
}> {
  const persisted = await getPersistedStrategy(id);
  if (!persisted) {
    return { success: false, status: 404, error: `Strategy "${id}" not found` };
  }

  if (nextEnabled) {
    const isThirdParty = persisted.provenance?.source === 'third_party';
    const needsInstallApproval = isThirdParty && (persisted.permissions.length > 0 || Boolean(persisted.limits));
    if (needsInstallApproval) {
      const approval = await findThirdPartyInstallApproval(id);
      if (!approval || approval.status !== 'approved') {
        return {
          success: false,
          status: 409,
          error: `Strategy "${id}" requires explicit install approval before enabling`,
        };
      }
    }
  }

  const updated = await updatePersistedStrategyEnabled(id, nextEnabled);
  if (!updated) {
    return { success: false, status: 500, error: `Failed to update strategy "${id}"` };
  }

  const runtime = getRuntime(id);
  if (runtime) {
    if (nextEnabled && !runtime.enabled) {
      await enableStrategy(id);
    } else if (!nextEnabled && runtime.enabled) {
      await disableStrategy(id);
    }
  }

  logger.strategyToggled(id, nextEnabled);
  return {
    success: true,
    enabled: nextEnabled,
    owner: runtime ? 'api-runtime' : 'cron-runtime',
  };
}

/**
 * POST /strategies/:id/toggle — Enable/disable a strategy
 */
router.post('/:id/toggle', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_MANAGE, 'strategy:manage'), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const statuses = await buildStrategyStatuses();
    const current = statuses.find((status) => status.id === id);
    if (!current) {
      res.status(404).json({ success: false, error: `Strategy "${id}" not found` });
      return;
    }
    const currentEnabled = current.enabled;
    const nextEnabled = !currentEnabled;

    const result = await setStrategyEnabledState(id, nextEnabled);
    if (!result.success) {
      res.status(result.status || 500).json({ success: false, error: result.error || 'Unknown error' });
      return;
    }

    res.json({ success: true, enabled: result.enabled, owner: result.owner });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /strategies/:id/enable — Explicit enable endpoint
 */
router.post('/:id/enable', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_MANAGE, 'strategy:manage'), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const result = await setStrategyEnabledState(id, true);
    if (!result.success) {
      res.status(result.status || 500).json({ success: false, error: result.error || 'Unknown error' });
      return;
    }
    res.json({ success: true, enabled: true, owner: result.owner });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /strategies/:id/disable — Explicit disable endpoint
 */
router.post('/:id/disable', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_MANAGE, 'strategy:manage'), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const result = await setStrategyEnabledState(id, false);
    if (!result.success) {
      res.status(result.status || 500).json({ success: false, error: result.error || 'Unknown error' });
      return;
    }
    res.json({ success: true, enabled: false, owner: result.owner });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * GET /strategies/:id/config — Get effective config (manifest + overrides)
 */
router.get('/:id/config', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_READ, 'strategy:read'), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const persisted = await getPersistedStrategy(id);
    if (!persisted) {
      res.status(404).json({ success: false, error: `Strategy "${id}" not found` });
      return;
    }

    const manifestConfig = isPlainObject(persisted.manifest.config)
      ? persisted.manifest.config as Record<string, unknown>
      : {};
    const overrides = persisted.config;
    const effective = { ...manifestConfig, ...overrides };

    res.json({
      success: true,
      config: effective,
      manifest: manifestConfig,
      overrides,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * PUT /strategies/:id/config — Update config overrides
 */
router.put('/:id/config', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_MANAGE, 'strategy:manage'), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const overrides = req.body;
    if (!overrides || typeof overrides !== 'object') {
      res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
      return;
    }

    const persisted = await getPersistedStrategy(id);
    if (!persisted) {
      res.status(404).json({ success: false, error: `Strategy "${id}" not found` });
      return;
    }

    const updated = await updatePersistedStrategyConfig(id, overrides as Record<string, unknown>);
    if (!updated) {
      res.status(500).json({ success: false, error: `Failed to update config for strategy "${id}"` });
      return;
    }
    const manifestConfig = isPlainObject(updated.manifest.config)
      ? updated.manifest.config as Record<string, unknown>
      : {};
    const effective = { ...manifestConfig, ...updated.config };

    res.json({ success: true, config: effective });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /strategies/:id/approve — Approve/reject pending intents
 */
router.post('/:id/approve', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_MANAGE, 'strategy:manage'), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { approvalId, approved } = req.body;

    if (!approvalId) {
      res.status(400).json({ success: false, error: 'Missing approvalId' });
      return;
    }

    const approval = await prisma.humanAction.findUnique({
      where: { id: approvalId },
    });
    const supportedTypes = new Set(['strategy:approve', 'strategy:install:approve']);
    if (!approval || !supportedTypes.has(approval.type) || approval.status !== 'pending') {
      res.status(404).json({ success: false, error: 'Approval not found or already resolved' });
      return;
    }

    let strategyId: string | undefined;
    try {
      const meta = JSON.parse(approval.metadata || '{}') as { strategyId?: string };
      strategyId = meta.strategyId;
    } catch {
      strategyId = undefined;
    }

    if (strategyId && strategyId !== id) {
      res.status(400).json({ success: false, error: 'Approval does not belong to this strategy' });
      return;
    }

    await prisma.humanAction.update({
      where: { id: approvalId },
      data: {
        status: approved === false ? 'rejected' : 'approved',
        resolvedAt: new Date(),
      },
    });

    if (approval.type === 'strategy:install:approve' && strategyId) {
      await prisma.strategy.updateMany({
        where: { id: strategyId },
        data: {
          status: approved === false ? 'disabled' : 'draft',
          enabled: false,
        },
      });
    }

    events.actionResolved({
      id: approvalId,
      type: approval.type,
      approved: approved !== false,
      resolvedBy: 'dashboard',
    });

    res.json({
      success: true,
      approved: approved !== false,
      type: approval.type,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * GET /strategies/:id/state — Get strategy state (for debugging)
 */
router.get('/:id/state', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_READ, 'strategy:read'), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const persisted = await getPersistedStrategy(id);
    if (!persisted) {
      res.status(404).json({ success: false, error: `Strategy "${id}" not found` });
      return;
    }

    const runtime = getRuntime(id);
    const state = runtime ? getState(id) : persisted.state;

    const pendingRows = await prisma.humanAction.findMany({
      where: {
        status: 'pending',
        OR: [
          { type: 'strategy:approve' },
          { type: 'strategy:install:approve' },
          { type: 'action' },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    const pendingApprovalsList = pendingRows
      .map((row) => {
        let metadata: { strategyId?: string; intents?: unknown[] } = {};
        try {
          metadata = JSON.parse(row.metadata || '{}');
        } catch {
          metadata = {};
        }
        return {
          id: row.id,
          strategyId: metadata.strategyId,
          intents: Array.isArray(metadata.intents) ? metadata.intents : [],
          createdAt: row.createdAt.getTime(),
        };
      })
      .filter((row) => row.strategyId === id);

    res.json({
      success: true,
      state,
      pendingApprovals: pendingApprovalsList,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * GET /history — Strategy action history (from Event table)
 */
router.get('/history', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_READ, 'strategy:read'), async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 250);
    const offset = parseInt(req.query.offset as string) || 0;
    const strategyId = req.query.strategyId as string | undefined;

    const where: Record<string, unknown> = {
      type: { startsWith: 'strategy:' },
    };

    // Filter by strategyId in data if provided
    const events = await prisma.event.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
      skip: offset,
    });

    // Filter by strategyId in JSON data if needed
    let filtered = events;
    if (strategyId) {
      filtered = events.filter(e => {
        try {
          const data = JSON.parse(e.data as string);
          return data.strategyId === strategyId;
        } catch {
          return false;
        }
      });
    }

    res.json({
      success: true,
      history: filtered.map(e => ({
        id: e.id,
        type: e.type,
        data: JSON.parse(e.data as string),
        timestamp: e.timestamp,
      })),
      count: filtered.length,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /strategies/reload — Hot-reload strategies from disk
 */
router.post('/reload', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.STRATEGY_MANAGE, 'strategy:manage'), async (_req: Request, res: Response) => {
  try {
    const persisted = await listPersistedStrategies();
    if (!isEngineStarted()) {
      res.json({
        success: true,
        added: [],
        removed: [],
        total: persisted.length,
        handledBy: 'cron:strategy-runner',
      });
      return;
    }

    const result = await reloadStrategies();
    res.json({ success: true, ...result, total: persisted.length });
  } catch (err) {
    const message = getErrorMessage(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ─── Internal routes (localhost only, no auth) ─────────────────────

function isLocalhost(req: Request): boolean {
  const ip = req.ip || req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function hasValidCronSecret(req: Request): boolean {
  const required = process.env.STRATEGY_CRON_SHARED_SECRET;
  if (!required) return false;
  return req.header('x-strategy-cron-secret') === required;
}

/**
 * POST /strategies/internal/provision-tokens
 * Re-provision app tokens after SIGNING_KEY rotation.
 * Localhost-only, no auth token required.
 */
router.post('/internal/provision-tokens', async (req: Request, res: Response) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ success: false, error: 'Internal only' });
    return;
  }
  if (!hasValidCronSecret(req)) {
    res.status(403).json({ success: false, error: 'Invalid cron secret' });
    return;
  }
  try {
    await createAppTokens();
    const tokenMap: Record<string, string> = {};
    const persisted = await listPersistedStrategies();
    for (const s of persisted) {
      const t = getAppToken(s.id);
      if (t) tokenMap[s.id] = t;
    }
    res.json({ success: true, tokens: tokenMap });
  } catch (err) {
    res.status(500).json({ success: false, error: getErrorMessage(err) });
  }
});

export default router;
