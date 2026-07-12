/**
 * Strategy Engine Orchestrator
 * ============================
 * Manages strategy lifecycle: load manifests, create intervals, orchestrate ticks.
 * Lives inside the Express server (port 4242).
 */

import { randomBytes, createHash } from 'crypto';
import { StrategyManifest, StrategyRuntime, StrategyStatus, TickTier, TICK_INTERVALS, Intent } from './types';
import { loadStrategyManifests } from './loader';
import { getState, restoreState, persistState, persistAllStates, getConfigOverrides, updateState, setToken, clearToken } from './state';
import { runTick, clearContextHash, clearAllContextHashes } from './tick';
import { callHook, clearCliSession, clearAllCliSessions, cacheModelTier } from './hooks';
import { processMessage, clearMessageQueue, clearAllMessageQueues } from './message';

import { createAppTokens, getAppToken, getAppTokenHash } from '../app-tokens';
import { emitWalletEvent, events } from '../events';
import { prisma } from '../db';
import { buildPollUrl } from '../approval-flow';
import { listPersistedStrategies, type PersistedStrategy } from './repository';
import { getErrorMessage } from '../error';

type SchedulerMode = 'internal' | 'external';

export interface StartEngineOptions {
  schedulerMode?: SchedulerMode;
}

/** All loaded strategy runtimes */
const runtimes = new Map<string, StrategyRuntime>();

/** Active intervals */
const intervals: NodeJS.Timeout[] = [];

/** Strategies currently running a tick */
const running = new Set<string>();

/** Enabled strategy IDs */
const enabled = new Set<string>();

/** Pending approvals for REST API */
const pendingApprovals = new Map<string, {
  strategyId: string;
  intents: Intent[];
  createdAt: number;
  resolve: (approved: boolean, token?: string) => void;
  timer: NodeJS.Timeout;
  resolvedBy?: string;
}>();

let engineStarted = false;
let schedulerMode: SchedulerMode = 'internal';

/** Strategy ID -> unique tick tiers declared by ticker/jobs */
const strategyTiers = new Map<string, TickTier[]>();

/** Strategy ID -> last tick timestamp per tier (used in external scheduler mode) */
const externalLastTickByTier = new Map<string, Map<TickTier, number>>();

/** Strategy IDs sourced from DB-backed FEAT-011 resources */
const dbBackedStrategyIds = new Set<string>();

const APPROVAL_POLL_INTERVAL_MS = 1500;
const MESSAGE_QUEUE_TYPE = 'strategy:message';
const MESSAGE_POLL_INTERVAL_MS = 200;
const MESSAGE_BATCH_LIMIT = 20;
export const STRATEGY_ENABLED_STORAGE_KEY = '_strategy_enabled';

type MessageProcessingStatus = 'ok' | 'error' | 'timeout';

interface QueuedMessageMetadata {
  appId: string;
  message: string;
  adapter?: string;
  reply?: string | null;
  error?: string;
  queuedAt?: number;
  resolvedAt?: number;
}

function getWalletServerBaseUrl(): string {
  return `http://127.0.0.1:${process.env.WALLET_SERVER_PORT || '4242'}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type ApprovalStatus = 'approved' | 'rejected' | 'timeout';

async function waitForHumanActionStatus(actionId: string, timeoutMs: number): Promise<ApprovalStatus> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const action = await prisma.humanAction.findUnique({
      where: { id: actionId },
      select: { status: true },
    });

    if (!action) return 'rejected';
    if (action.status === 'approved') return 'approved';
    if (action.status === 'rejected') return 'rejected';

    await sleep(APPROVAL_POLL_INTERVAL_MS);
  }

  // Timeout: mark still-pending actions as rejected
  await prisma.humanAction.updateMany({
    where: { id: actionId, status: 'pending' },
    data: { status: 'rejected', resolvedAt: new Date() },
  }).catch((err) => console.warn('[strategy] approval timeout cleanup failed:', getErrorMessage(err)));

  return 'timeout';
}

async function claimApprovalToken(requestId: string, secret: string): Promise<string | null> {
  try {
    const url = buildPollUrl(getWalletServerBaseUrl(), requestId, secret);
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;

    const body = await res.json() as { success?: boolean; status?: string; token?: string };
    if (!body?.success || body.status !== 'approved' || !body.token) return null;
    return body.token;
  } catch {
    return null;
  }
}

function parseMessageMetadata(raw: string | null | undefined): QueuedMessageMetadata {
  if (!raw) return { appId: '', message: '' };
  try {
    const parsed = JSON.parse(raw) as QueuedMessageMetadata;
    return typeof parsed === 'object' && parsed ? parsed : { appId: '', message: '' };
  } catch {
    return { appId: '', message: '' };
  }
}

function getManifestTiers(manifest: StrategyManifest): TickTier[] {
  const tiers = new Set<TickTier>();
  if (manifest.ticker) tiers.add(manifest.ticker);
  if (manifest.jobs) {
    for (const job of manifest.jobs) tiers.add(job.ticker);
  }
  return Array.from(tiers);
}

function initializeTickMetadata(manifests: StrategyManifest[]): Map<TickTier, StrategyManifest[]> {
  strategyTiers.clear();
  externalLastTickByTier.clear();

  const byTier = new Map<TickTier, StrategyManifest[]>();

  for (const manifest of manifests) {
    const tiers = getManifestTiers(manifest);
    if (tiers.length === 0) continue;

    strategyTiers.set(manifest.id, tiers);
    externalLastTickByTier.set(manifest.id, new Map<TickTier, number>());

    for (const tier of tiers) {
      if (!byTier.has(tier)) byTier.set(tier, []);
      byTier.get(tier)!.push(manifest);
    }
  }

  return byTier;
}

function setRuntimeTickMetadata(strategyId: string, manifest: StrategyManifest): void {
  const tiers = getManifestTiers(manifest);
  if (tiers.length > 0) {
    strategyTiers.set(strategyId, tiers);
    externalLastTickByTier.set(strategyId, new Map<TickTier, number>());
  } else {
    strategyTiers.delete(strategyId);
    externalLastTickByTier.delete(strategyId);
  }
}

function buildDbBackedManifest(row: {
  id: string;
  name: string;
  manifest: StrategyManifest;
  config: Record<string, unknown>;
  permissions: string[];
  limits: { fund?: number; send?: number } | null;
}): StrategyManifest {
  const manifest = { ...row.manifest } as StrategyManifest;
  const baseConfig = manifest.config && typeof manifest.config === 'object'
    ? manifest.config
    : {};
  manifest.id = row.id;
  manifest.name = row.name || manifest.name || row.id;
  manifest.config = { ...baseConfig, ...row.config };
  manifest.permissions = row.permissions.length > 0
    ? row.permissions
    : Array.isArray(manifest.permissions)
    ? manifest.permissions
    : [];
  manifest.limits = row.limits || manifest.limits;
  if (!manifest.hooks) manifest.hooks = {};
  if (!manifest.sources) manifest.sources = [];
  return manifest;
}

function isLegacyMessageOnlyManifest(manifest: StrategyManifest): boolean {
  // agent-chat now runs through direct widget/adapters flow, not cron-owned runtime.
  if (manifest.id === 'agent-chat') return false;
  return Boolean(manifest.hooks.message) && !manifest.ticker && !manifest.jobs;
}

/**
 * Start the strategy engine.
 * Loads manifests, restores states, creates tick intervals.
 */
export async function startEngine(options: StartEngineOptions = {}): Promise<void> {
  const requestedMode = options.schedulerMode ?? 'internal';

  if (engineStarted) {
    if (schedulerMode !== requestedMode) {
      console.warn(`[strategy] Engine already started in ${schedulerMode} mode (requested ${requestedMode})`);
    }
    return;
  }

  schedulerMode = requestedMode;

  // Legacy app.md strategy execution is removed.
  // Only message-only app hooks are loaded from disk; scheduled strategies are DB-backed.
  const manifests = loadStrategyManifests().filter(isLegacyMessageOnlyManifest);

  // Initialize runtime entries for legacy message-only app hooks.
  // DB-backed scheduled strategies are registered during reconcileWorkspaceStrategies().
  for (const manifest of manifests) {
    const runtime: StrategyRuntime = {
      manifest,
      enabled: false,
      running: false,
      errorCount: 0,
    };
    runtimes.set(manifest.id, runtime);
    console.log(`[strategy] loaded: ${manifest.id} (${manifest.name}, ticker=${manifest.ticker || 'jobs'}, sources=${manifest.sources.length})`);
  }

  // Group by tick tier and either create internal intervals or prepare external cadence metadata
  const byTier = initializeTickMetadata(manifests);

  if (schedulerMode === 'internal') {
    for (const [tier, group] of byTier) {
      const ms = TICK_INTERVALS[tier];
      const ids = group.map(m => m.id).join(', ');
      console.log(`[strategy] interval: ${tier} (${ms / 1000}s) → [${ids}]`);
      const interval = setInterval(() => {
        // Deduplicate — a manifest may appear in multiple tiers via jobs
        const seen = new Set<string>();
        for (const manifest of group) {
          if (seen.has(manifest.id)) continue;
          seen.add(manifest.id);
          if (!enabled.has(manifest.id)) continue;
          tickStrategy(manifest.id);
        }
      }, ms);
      intervals.push(interval);
    }

    // State persistence every 5 minutes
    intervals.push(setInterval(() => {
      console.log('[strategy] persisting all states...');
      persistAllStates().catch(err => {
        console.error('[strategy] state persistence error:', err);
      });
    }, 300_000));
  } else {
    console.log('[strategy] External scheduler mode active (cron-owned tick cadence)');
  }

  // Create tokens only in internal mode.
  // External (cron-owned) mode must not mint local tokens because signing keys are process-local.
  if (schedulerMode === 'internal') {
    await createAppTokens();
  } else {
    console.log('[strategy] External mode: skipping local app token creation (token bridge pending)');
  }

  engineStarted = true;
  console.log(`[strategy] Engine started: ${manifests.length} strategy(s) loaded, ${byTier.size} tick tier(s), mode=${schedulerMode}`);

  // Auto-enable strategies that have autoStart and their app is on a workspace
  await autoEnableStrategies();
}

/**
 * Stop the strategy engine gracefully.
 * Clears intervals, waits for running ticks (max 30s), persists all state.
 */
export async function stopEngine(): Promise<void> {
  if (!engineStarted) return;

  // Clear all intervals
  for (const interval of intervals) clearInterval(interval);
  intervals.length = 0;

  // Wait for running ticks to finish (max 30s)
  const deadline = Date.now() + 30_000;
  while (running.size > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }

  if (running.size > 0) {
    console.warn(`[strategy] ${running.size} ticks still running at shutdown`);
  }

  // Persist all state
  await persistAllStates();

  // Clear CLI sessions, context hashes, and message queues
  clearAllCliSessions();
  clearAllContextHashes();
  clearAllMessageQueues();

  // Clear pending approvals (in-memory)
  for (const [id, pending] of pendingApprovals) {
    clearTimeout(pending.timer);
    pending.resolve(false);
  }
  pendingApprovals.clear();
  strategyTiers.clear();
  externalLastTickByTier.clear();

  // Reject any remaining strategy approval requests in DB
  await prisma.humanAction.updateMany({
    where: { type: 'strategy:approve', status: 'pending' },
    data: { status: 'rejected', resolvedAt: new Date() },
  }).catch(err => {
    console.error('[strategy] Failed to clean up pending approval DB records:', err);
  });

  engineStarted = false;
  schedulerMode = 'internal';
  console.log('[strategy] Engine stopped');
}

/**
 * Run one external scheduler cycle.
 * Used by cron job integration when schedulerMode='external'.
 */
export async function runExternalTickCycle(nowMs: number = Date.now()): Promise<{ ticked: string[]; considered: number; authFailures: string[] }> {
  if (!engineStarted || schedulerMode !== 'external') {
    return { ticked: [], considered: 0, authFailures: [] };
  }

  const ticked: string[] = [];
  const authFailures: string[] = [];
  let considered = 0;

  for (const [strategyId] of runtimes) {
    if (!enabled.has(strategyId)) continue;
    considered++;

    const tiers = strategyTiers.get(strategyId);
    if (!tiers || tiers.length === 0) continue;

    const tierState = externalLastTickByTier.get(strategyId) || new Map<TickTier, number>();
    const dueTiers = tiers.filter((tier) => {
      const last = tierState.get(tier) || 0;
      return nowMs - last >= TICK_INTERVALS[tier];
    });

    if (dueTiers.length === 0) continue;

    // Mark all due tiers before the run to avoid duplicate bursts from overlapping tiers.
    for (const tier of dueTiers) tierState.set(tier, nowMs);
    externalLastTickByTier.set(strategyId, tierState);

    await tickStrategy(strategyId);
    ticked.push(strategyId);

    const rt = runtimes.get(strategyId);
    if (rt && (rt.authFailureCount || 0) >= 2) {
      authFailures.push(strategyId);
    }
  }

  return { ticked, considered, authFailures };
}

/**
 * Run a tick for a strategy (skip-on-busy).
 */
async function tickStrategy(strategyId: string): Promise<void> {
  if (running.has(strategyId)) {
    console.log(`[strategy:${strategyId}] skip — previous tick still running`);
    return;
  }

  const runtime = runtimes.get(strategyId);
  if (!runtime) return;

  // Check pause
  if (runtime.pausedUntil && Date.now() < runtime.pausedUntil) {
    const remaining = Math.round((runtime.pausedUntil - Date.now()) / 1000);
    console.log(`[strategy:${strategyId}] skip — paused for ${remaining}s more`);
    return;
  }

  running.add(strategyId);
  runtime.running = true;

  try {
    await runTick(runtime.manifest, runtime.token);
    runtime.lastTick = Date.now();
    runtime.errorCount = 0;
    runtime.authFailureCount = 0;
    runtime.lastError = undefined;
  } catch (err) {
    const errMsg = getErrorMessage(err);
    runtime.lastError = errMsg;
    runtime.errorCount++;

    // Track auth failures separately for token re-provisioning
    if (errMsg.includes('AUTH_FAILURE')) {
      runtime.authFailureCount = (runtime.authFailureCount || 0) + 1;
    } else {
      runtime.authFailureCount = 0;
    }

    console.error(`[strategy:${strategyId}] tick error (${runtime.errorCount}x): ${errMsg}`);

    // Handle error policy
    const errorConfig = runtime.manifest.config.errors;
    if (errorConfig) {
      const maxRetries = errorConfig.maxRetries || 3;
      if (runtime.errorCount >= maxRetries) {
        const cooldownMs = parseCooldown(errorConfig.cooldown || '60s');
        runtime.pausedUntil = Date.now() + cooldownMs;
        console.warn(`[strategy:${strategyId}] PAUSED — ${runtime.errorCount} consecutive errors, cooldown ${cooldownMs}ms`);
        emitStrategyEvent('strategy:paused', strategyId, {
          reason: 'error_limit',
          errorCount: runtime.errorCount,
          pausedUntil: runtime.pausedUntil,
        });
      }
    }

    // Persist state on error
    await persistState(strategyId).catch((err) => {
      console.warn(`[strategy:${strategyId}] state persistence failed after tick error:`, err);
    });
  } finally {
    running.delete(strategyId);
    runtime.running = false;
  }
}

/**
 * Enable a strategy: call init hook, look up token from registry, start ticking.
 * If the strategy declares permissions or limits, requires a HumanAction approval record.
 */
export async function enableStrategy(id: string): Promise<void> {
  const runtime = runtimes.get(id);
  if (!runtime) throw new Error(`Strategy "${id}" not found`);
  if (enabled.has(id)) return;

  const hasPermissionsOrLimits = runtime.manifest.permissions.length > 0 || runtime.manifest.limits;

  console.log(`[strategy:${id}] enabling... (permissions=${runtime.manifest.permissions.join(',') || 'none'}, ticker=${runtime.manifest.ticker || 'jobs'})`);

  // Look up token from local registry.
  const token = getAppToken(id);
  const tokenHash = getAppTokenHash(id);
  if (token) {
    console.log(`[strategy:${id}] token from registry (hash=${tokenHash?.slice(0, 8)}...)`);
  }

  if (token) {
    runtime.token = token;
    runtime.tokenHash = tokenHash;
    setToken(id, token);
  } else if (hasPermissionsOrLimits) {
    // No token and needs permissions — can't enable
    console.warn(`[strategy:${id}] cannot enable — no strategy token available (requires POST /apps/${id}/approve)`);
    return;
  } else {
    console.warn(`[strategy:${id}] no strategy token available, continuing without token`);
  }

  // Pre-resolve model tier from token permissions (avoids per-hook token decode)
  cacheModelTier(id, token);

  // Restore state from DB (now goes through REST with the token)
  try {
    await restoreState(id);
  } catch (err) {
    console.error(`[strategy:${id}] state restore failed:`, err);
  }

  // Call init hook
  if (runtime.manifest.hooks.init) {
    console.log(`[strategy:${id}] calling init hook...`);
    try {
      const result = await callHook(runtime.manifest, 'init', {
        config: { ...runtime.manifest.config, ...(await getConfigOverrides(id)) },
        state: getState(id),
      });
      if (result.state && Object.keys(result.state).length > 0) {
        updateState(id, result.state);
        console.log(`[strategy:${id}] init hook set state: ${JSON.stringify(result.state).slice(0, 200)}`);
      }
      if (result.log) {
        console.log(`[strategy:${id}] init log: ${result.log}`);
      }
    } catch (err) {
      console.error(`[strategy:${id}] init hook failed:`, err);
    }
  }

  enabled.add(id);
  runtime.enabled = true;
  runtime.errorCount = 0;
  runtime.pausedUntil = undefined;

  emitStrategyEvent('strategy:enabled', id, {});
  console.log(`[strategy:${id}] ENABLED`);
}

/**
 * Disable a strategy: call shutdown hook, revoke token, stop ticking.
 */
export async function disableStrategy(id: string): Promise<void> {
  const runtime = runtimes.get(id);
  if (!runtime) throw new Error(`Strategy "${id}" not found`);
  if (!enabled.has(id)) return;

  console.log(`[strategy:${id}] disabling...`);

  // Call shutdown hook
  if (runtime.manifest.hooks.shutdown) {
    console.log(`[strategy:${id}] calling shutdown hook...`);
    try {
      const result = await callHook(runtime.manifest, 'shutdown', {
        positions: getState(id).positions || [],
        state: getState(id),
      });
      if (result.state && Object.keys(result.state).length > 0) {
        updateState(id, result.state);
      }
      if (result.log) {
        console.log(`[strategy:${id}] shutdown log: ${result.log}`);
      }
    } catch (err) {
      console.error(`[strategy:${id}] shutdown hook failed:`, err);
    }
  }

  // Persist state (while token is still valid)
  await persistState(id).catch((err) => console.warn(`[strategy:${id}] state persistence failed during disable:`, getErrorMessage(err)));

  // Clear runtime token reference (don't revoke — centrally managed by app-tokens)
  runtime.token = undefined;
  runtime.tokenHash = undefined;
  clearToken(id);

  // Clear CLI session, context hash, and message queue
  clearCliSession(id);
  clearContextHash(id);
  clearMessageQueue(id);

  enabled.delete(id);
  runtime.enabled = false;

  emitStrategyEvent('strategy:paused', id, { reason: 'disabled' });
  console.log(`[strategy:${id}] DISABLED`);
}

/**
 * Reload strategies from disk (hot-reload).
 */
export async function reloadStrategies(): Promise<{ added: string[]; removed: string[] }> {
  const newManifests = loadStrategyManifests().filter(isLegacyMessageOnlyManifest);
  const newIds = new Set(newManifests.map(m => m.id));
  const oldIds = new Set(runtimes.keys());

  const added: string[] = [];
  const removed: string[] = [];

  // Remove strategies that no longer exist
  for (const id of oldIds) {
    if (dbBackedStrategyIds.has(id)) {
      continue;
    }
    if (!newIds.has(id)) {
      if (enabled.has(id)) {
        await disableStrategy(id);
      }
      runtimes.delete(id);
      strategyTiers.delete(id);
      externalLastTickByTier.delete(id);
      removed.push(id);
    }
  }

  // Add/update strategies
  for (const manifest of newManifests) {
    if (!oldIds.has(manifest.id)) {
      const runtime: StrategyRuntime = {
        manifest,
        enabled: false,
        running: false,
        errorCount: 0,
      };
      runtimes.set(manifest.id, runtime);
      setRuntimeTickMetadata(manifest.id, manifest);
      added.push(manifest.id);
    } else {
      // Update manifest for existing strategies
      const runtime = runtimes.get(manifest.id)!;
      runtime.manifest = manifest;
      setRuntimeTickMetadata(manifest.id, manifest);
    }
  }

  if (added.length > 0 || removed.length > 0) {
    console.log(`[strategy] Reloaded: +${added.length} -${removed.length}`);
  }

  return { added, removed };
}

/**
 * Get all strategy statuses for the REST API.
 */
export function getStrategies(): StrategyStatus[] {
  const statuses: StrategyStatus[] = [];

  for (const [id, runtime] of runtimes) {
    statuses.push({
      id,
      name: runtime.manifest.name,
      icon: runtime.manifest.icon,
      ticker: runtime.manifest.ticker,
      enabled: runtime.enabled,
      running: runtime.running,
      lastTick: runtime.lastTick,
      lastError: runtime.lastError,
      errorCount: runtime.errorCount,
      pausedUntil: runtime.pausedUntil,
    });
  }

  return statuses;
}

/**
 * Get a specific strategy runtime.
 */
export function getRuntime(id: string): StrategyRuntime | undefined {
  return runtimes.get(id);
}

/**
 * Check if the engine is started.
 */
export function isEngineStarted(): boolean {
  return engineStarted;
}

/**
 * Handle a human message sent to a app's AI.
 * Returns { reply, error } — the REST endpoint awaits this.
 */
export async function handleAppMessage(
  appId: string,
  message: string,
  onProgress?: (status: string) => void,
  adapter?: string,
  tokenOverride?: string,
): Promise<{ reply: string | null; error?: string }> {
  if (appId === '__system__') {
    // Use the __system_chat__ app token from the registry (requires human approval like any other app)
    const token = getAppToken('__system_chat__');
    if (!token) {
      return { reply: null, error: 'System chat not approved. Approve it in the dashboard via POST /apps/__system_chat__/approve.' };
    }

    const systemManifest = {
      id: '__system_chat__',
      name: 'System Chat',
      sources: [],
      hooks: {
        message: 'You are AuraMaxx\'s built-in chat assistant. Help the user manage their crypto wallets. Use wallet_api to look up information and execute operations. Use request_human_action when you need elevated permissions. For token ticker/name queries without a contract address, ALWAYS call wallet_api GET /token/search first (for the requested chain) before asking the user for an address. Never claim token search is unavailable. Be concise.',
      },
      config: {},
      permissions: ['admin:*'],
      allowedHosts: [],
    } as StrategyManifest;

    return processMessage(
      { appId: '__system_chat__', message, onProgress, adapter: adapter || 'system' },
      { manifest: systemManifest, token },
    );
  }

  if (appId === 'agent-chat') {
    const manifest = loadStrategyManifests().find((m) => m.id === appId);
    if (!manifest) return { reply: null, error: 'App not found' };
    if (!manifest.hooks.message) return { reply: null, error: 'No message hook' };

    const token = tokenOverride || getAppToken(appId);
    if (!token) {
      return { reply: null, error: 'Agent chat not approved. Approve it in the dashboard via POST /apps/agent-chat/approve.' };
    }

    return processMessage(
      { appId, message, onProgress, adapter },
      { manifest, token },
    );
  }

  const runtime = runtimes.get(appId);
  if (!runtime) return { reply: null, error: 'App not found' };
  if (!runtime.manifest.hooks.message) return { reply: null, error: 'No message hook' };
  if (!runtime.enabled) return { reply: null, error: 'App not enabled' };

  return processMessage(
    { appId, message, onProgress, adapter },
    { manifest: runtime.manifest, token: runtime.token },
  );
}

export async function enqueueAppMessage(
  appId: string,
  message: string,
  adapter: string = 'dashboard',
): Promise<string> {
  const request = await prisma.humanAction.create({
    data: {
      type: MESSAGE_QUEUE_TYPE,
      fromTier: 'system',
      chain: 'base',
      status: 'pending',
      metadata: JSON.stringify({
        appId,
        message,
        adapter,
        queuedAt: Date.now(),
      } satisfies QueuedMessageMetadata),
    },
  });

  return request.id;
}

export async function waitForQueuedAppMessage(
  requestId: string,
  timeoutMs: number = 120_000,
): Promise<{ status: MessageProcessingStatus; reply: string | null; error?: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const row = await prisma.humanAction.findUnique({
      where: { id: requestId },
      select: { status: true, metadata: true },
    });
    if (!row) {
      return { status: 'error', reply: null, error: 'Message request not found' };
    }

    if (row.status === 'pending') {
      await sleep(MESSAGE_POLL_INTERVAL_MS);
      continue;
    }

    const metadata = parseMessageMetadata(row.metadata);
    if (row.status === 'approved') {
      return {
        status: 'ok',
        reply: metadata.reply ?? null,
      };
    }

    return {
      status: 'error',
      reply: null,
      error: metadata.error || 'Message processing failed',
    };
  }

  await prisma.humanAction.updateMany({
    where: { id: requestId, status: 'pending' },
    data: { status: 'rejected', resolvedAt: new Date() },
  }).catch((err) => console.warn('[strategy] queued message timeout cleanup failed:', getErrorMessage(err)));

  return {
    status: 'timeout',
    reply: null,
    error: 'Timed out waiting for message processing',
  };
}

export async function processPendingAppMessages(
  limit: number = MESSAGE_BATCH_LIMIT,
): Promise<{ processed: number; failed: number }> {
  const pending = await prisma.humanAction.findMany({
    where: { type: MESSAGE_QUEUE_TYPE, status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: Math.max(1, limit),
  });

  let processed = 0;
  let failed = 0;

  for (const row of pending) {
    const metadata = parseMessageMetadata(row.metadata);
    const appId = metadata.appId;
    const message = metadata.message;
    const adapter = metadata.adapter || 'dashboard';

    if (!appId || !message) {
      failed++;
      await prisma.humanAction.update({
        where: { id: row.id },
        data: {
          status: 'rejected',
          resolvedAt: new Date(),
          metadata: JSON.stringify({
            ...metadata,
            error: 'Invalid queued message metadata',
            resolvedAt: Date.now(),
          } satisfies QueuedMessageMetadata),
        },
      }).catch((err) => console.warn(`[strategy] failed to reject invalid queued message ${row.id}:`, getErrorMessage(err)));
      continue;
    }

    try {
      const result = await handleAppMessage(appId, message, undefined, adapter);
      const ok = !result.error;
      if (!ok) failed++;

      await prisma.humanAction.update({
        where: { id: row.id },
        data: {
          status: ok ? 'approved' : 'rejected',
          resolvedAt: new Date(),
          metadata: JSON.stringify({
            ...metadata,
            reply: result.reply ?? null,
            error: result.error,
            resolvedAt: Date.now(),
          } satisfies QueuedMessageMetadata),
        },
      });
      processed++;
    } catch (err) {
      failed++;
      const msg = getErrorMessage(err);
      await prisma.humanAction.update({
        where: { id: row.id },
        data: {
          status: 'rejected',
          resolvedAt: new Date(),
          metadata: JSON.stringify({
            ...metadata,
            error: msg,
            resolvedAt: Date.now(),
          } satisfies QueuedMessageMetadata),
        },
      }).catch((err) => console.warn(`[strategy] failed to update errored message ${row.id}:`, getErrorMessage(err)));
    }
  }

  return { processed, failed };
}

/**
 * Register a pending approval (for REST API approval endpoint).
 */
export function registerApproval(
  id: string,
  strategyId: string,
  intents: Intent[],
  resolve: (approved: boolean, token?: string) => void,
  timeoutMs: number,
): void {
  const timer = setTimeout(() => {
    pendingApprovals.delete(id);
    resolve(false);
  }, timeoutMs);

  pendingApprovals.set(id, { strategyId, intents, createdAt: Date.now(), resolve, timer });
}

/**
 * Resolve a pending approval. Optional token is passed through for per-action approvals.
 */
export function resolveApproval(id: string, approved: boolean, token?: string): boolean {
  const pending = pendingApprovals.get(id);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pending.resolvedBy = 'dashboard';
  pendingApprovals.delete(id);
  pending.resolve(approved, token);
  return true;
}

/**
 * Get pending approvals for a strategy.
 */
export function getPendingApprovals(strategyId?: string) {
  const result: Array<{ id: string; strategyId: string; intents: Intent[]; createdAt: number }> = [];
  for (const [id, pending] of pendingApprovals) {
    if (!strategyId || pending.strategyId === strategyId) {
      result.push({ id, strategyId: pending.strategyId, intents: pending.intents, createdAt: pending.createdAt });
    }
  }
  return result;
}

/**
 * Request human approval for strategy intents via the dashboard.
 * Creates a HumanAction in DB, emits action:created, and waits for resolution.
 * Returns true if approved, false if rejected or timed out.
 */
export async function requestHumanApproval(
  strategyId: string,
  intents: Intent[],
  timeoutMs: number = 600_000,
): Promise<boolean> {
  const request = await prisma.humanAction.create({
    data: {
      type: 'strategy:approve',
      fromTier: 'system',
      chain: 'base',
      status: 'pending',
      metadata: JSON.stringify({ strategyId, intents }),
    },
  });

  const summary = intents
    .map(i => `${i.type || 'action'}: ${JSON.stringify(i).slice(0, 80)}`)
    .join(', ');

  events.actionCreated({
    id: request.id,
    type: 'strategy:approve',
    source: `strategy:${strategyId}`,
    summary: `${strategyId}: ${summary}`,
    expiresAt: Date.now() + timeoutMs,
    metadata: { strategyId, intents: intents as unknown as Record<string, unknown>[] },
  });

  emitStrategyEvent('strategy:approve', strategyId, {
    intents,
    approvalId: request.id,
  });

  // Durable DB wait path for all modes.
  // This avoids in-memory callback coupling across process boundaries.
  const status = await waitForHumanActionStatus(request.id, timeoutMs);
  if (status === 'timeout') {
    events.actionResolved({
      id: request.id,
      type: 'strategy:approve',
      approved: false,
      resolvedBy: 'timeout',
    });
  }
  return status === 'approved';
}

/**
 * Request a per-action scoped token for a strategy intent.
 * Creates a HumanAction with type='action', emits for HumanActionBar,
 * and waits for resolution. On approval, returns the temp token created
 * by the resolve route.
 */
export async function requestActionToken(
  strategyId: string,
  intent: Intent,
): Promise<{ approved: boolean; token?: string }> {
  const permissions = intent.permissions as string[];
  const limits = intent.limits as Record<string, number> | undefined;
  const summary = (intent.summary as string) || `${strategyId}: ${intent.type}`;
  const ttl = (intent.ttl as number) || 600;

  const secret = randomBytes(32).toString('hex');
  const secretHash = createHash('sha256').update(secret).digest('hex');

  const request = await prisma.humanAction.create({
    data: {
      type: 'action',
      fromTier: 'system',
      chain: 'base',
      status: 'pending',
      metadata: JSON.stringify({
        approvalScope: 'session_token',
        agentId: `strategy:${strategyId}`,
        permissions,
        limits,
        ttl,
        secretHash,
        summary,
        strategyId,
      }),
    },
  });

  events.actionCreated({
    id: request.id,
    type: 'action',
    source: `strategy:${strategyId}`,
    summary,
    expiresAt: Date.now() + 600_000,
    metadata: {
      approvalScope: 'session_token',
      strategyId,
      permissions,
      limits,
      summary,
    },
  });

  emitStrategyEvent('strategy:approve', strategyId, {
    intents: [intent],
    approvalId: request.id,
    actionToken: true,
  });

  // Durable DB wait path + token claim via /auth/:id polling for all modes.
  // requestActionToken stores secretHash in metadata; /auth validates and releases escrowed token.
  const status = await waitForHumanActionStatus(request.id, 600_000);
  if (status !== 'approved') {
    if (status === 'timeout') {
      events.actionResolved({
        id: request.id,
        type: 'action',
        approved: false,
        resolvedBy: 'timeout',
      });
    }
    return { approved: false };
  }

  const token = await claimApprovalToken(request.id, secret);
  if (!token) {
    console.warn(`[strategy:${strategyId}] action token approved but could not be claimed for request ${request.id}`);
    return { approved: false };
  }
  return { approved: true, token };
}

/**
 * Emit a strategy event via the existing event system.
 */
export function emitStrategyEvent(type: string, strategyId: string, data: Record<string, unknown>): void {
  emitWalletEvent(type, { strategyId, ...data });
}

/**
 * Auto-enable strategies that have autoStart: true OR a message hook, and their app is on a workspace.
 * Checks the WorkspaceApp table for installed:* app types.
 * Strategies with permissions/limits also require a HumanAction approval record.
 */
export interface WorkspaceReconcileResult {
  enabled: string[];
  disabled: string[];
  eligible: number;
}

async function getStrategyEnabledOverrides(): Promise<Map<string, boolean>> {
  const rows = await prisma.appStorage.findMany({
    where: { key: STRATEGY_ENABLED_STORAGE_KEY },
    select: { appId: true, value: true },
  });

  const overrides = new Map<string, boolean>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value);
      if (typeof parsed === 'boolean') {
        overrides.set(row.appId, parsed);
      }
    } catch {
      // Ignore malformed override entries
    }
  }
  return overrides;
}

/**
 * Reconcile DB-backed strategies against persisted Strategy rows.
 * Registers/updates runtimes, removes stale entries, applies DB enabled flag.
 */
export async function reconcileDbBackedStrategies(
  persisted: PersistedStrategy[],
  enabledOverrides: Map<string, boolean>,
): Promise<{ enabled: string[]; disabled: string[] }> {
  const enabledIds: string[] = [];
  const disabledIds: string[] = [];

  // 1) Register/update runtimes from persisted rows.
  const persistedIds = new Set<string>();
  for (const row of persisted) {
    persistedIds.add(row.id);
    dbBackedStrategyIds.add(row.id);

    const manifest = buildDbBackedManifest({
      id: row.id,
      name: row.name,
      manifest: row.manifest,
      config: row.config,
      permissions: row.permissions,
      limits: row.limits,
    });

    const existing = runtimes.get(row.id);
    if (!existing) {
      const runtime: StrategyRuntime = {
        manifest,
        enabled: false,
        running: false,
        errorCount: row.errorCount || 0,
        lastError: row.lastError || undefined,
        lastTick: row.lastTickAt ? row.lastTickAt.getTime() : undefined,
      };
      runtimes.set(row.id, runtime);
      setRuntimeTickMetadata(row.id, manifest);
    } else {
      existing.manifest = manifest;
      if (!existing.lastTick && row.lastTickAt) {
        existing.lastTick = row.lastTickAt.getTime();
      }
      if (!existing.lastError && row.lastError) {
        existing.lastError = row.lastError;
      }
      setRuntimeTickMetadata(row.id, manifest);
    }
  }

  // Remove stale DB-backed runtimes when strategy rows are deleted.
  for (const strategyId of Array.from(dbBackedStrategyIds)) {
    if (persistedIds.has(strategyId)) continue;
    const runtime = runtimes.get(strategyId);
    if (runtime?.enabled) {
      try {
        await disableStrategy(strategyId);
      } catch (err) {
        console.error(`[strategy:${strategyId}] db reconcile disable failed:`, err);
      }
    }
    runtimes.delete(strategyId);
    strategyTiers.delete(strategyId);
    externalLastTickByTier.delete(strategyId);
    dbBackedStrategyIds.delete(strategyId);
  }

  // Apply DB enabled flag directly (app/workspace lifecycle does not control DB-backed strategies).
  for (const row of persisted) {
    const runtime = runtimes.get(row.id);
    if (!runtime) continue;

    if (row.enabled && !runtime.enabled) {
      try {
        await enableStrategy(row.id);
        enabledIds.push(row.id);
      } catch (err) {
        console.error(`[strategy:${row.id}] db reconcile enable failed:`, err);
      }
      continue;
    }

    if (!row.enabled && runtime.enabled) {
      try {
        await disableStrategy(row.id);
        disabledIds.push(row.id);
      } catch (err) {
        console.error(`[strategy:${row.id}] db reconcile disable failed:`, err);
      }
    }
  }

  return { enabled: enabledIds, disabled: disabledIds };
}

/**
 * Reconcile legacy message-only app hooks against workspace + approval state.
 * These remain workspace-driven for chat UX; scheduled execution is DB-backed only.
 */
export async function reconcileLegacyAppStrategies(
  activeAppIds: Set<string>,
  approvedIds: Set<string>,
  enabledOverrides: Map<string, boolean>,
): Promise<{ enabled: string[]; disabled: string[]; eligible: number }> {
  const enabledIds: string[] = [];
  const disabledIds: string[] = [];
  let eligible = 0;

  for (const runtime of runtimes.values()) {
    const strategyId = runtime.manifest.id;
    if (dbBackedStrategyIds.has(strategyId)) {
      continue;
    }
    const managedByWorkspace = Boolean(runtime.manifest.autoStart || runtime.manifest.hooks.message);
    if (!managedByWorkspace) continue;

    eligible++;
    const inWorkspace = activeAppIds.has(strategyId);
    const needsApproval = runtime.manifest.permissions.length > 0 || runtime.manifest.limits;
    const hasApproval = !needsApproval || approvedIds.has(strategyId);
    const explicitEnabled = enabledOverrides.get(strategyId);
    const defaultEnabled = managedByWorkspace ? inWorkspace : false;
    const shouldBeEnabled = (explicitEnabled ?? defaultEnabled) && hasApproval;

    if (shouldBeEnabled && !runtime.enabled) {
      try {
        await enableStrategy(strategyId);
        enabledIds.push(strategyId);
      } catch (err) {
        console.error(`[strategy:${strategyId}] workspace reconcile enable failed:`, err);
      }
      continue;
    }

    if (!shouldBeEnabled && runtime.enabled) {
      try {
        await disableStrategy(strategyId);
        disabledIds.push(strategyId);
      } catch (err) {
        console.error(`[strategy:${strategyId}] workspace reconcile disable failed:`, err);
      }
    }
  }

  return { enabled: enabledIds, disabled: disabledIds, eligible };
}

/**
 * Reconcile strategy runtime state against workspace + approval state in DB.
 * This replaces direct app lifecycle event coupling.
 */
export async function reconcileWorkspaceStrategies(): Promise<WorkspaceReconcileResult> {
  if (!engineStarted) {
    return { enabled: [], disabled: [], eligible: 0 };
  }

  const [persisted, onWorkspace, approvals, enabledOverrides] = await Promise.all([
    listPersistedStrategies(),
    prisma.workspaceApp.findMany({
      where: { appType: { startsWith: 'installed:' } },
      select: { appType: true },
      distinct: ['appType'],
    }),
    prisma.humanAction.findMany({
      where: { type: 'app:approve', status: 'approved' },
      select: { metadata: true },
    }),
    getStrategyEnabledOverrides(),
  ]);

  const activeAppIds = new Set(
    onWorkspace.map(w => w.appType.replace('installed:', ''))
  );

  const approvedIds = new Set<string>();
  for (const approval of approvals) {
    try {
      const parsed = JSON.parse(approval.metadata || '{}') as { appId?: string };
      if (parsed.appId) approvedIds.add(parsed.appId);
    } catch {
      // ignore invalid metadata rows
    }
  }

  const dbResult = await reconcileDbBackedStrategies(persisted, enabledOverrides);
  const legacyResult = await reconcileLegacyAppStrategies(activeAppIds, approvedIds, enabledOverrides);

  return {
    enabled: [...dbResult.enabled, ...legacyResult.enabled],
    disabled: [...dbResult.disabled, ...legacyResult.disabled],
    eligible: legacyResult.eligible,
  };
}

/**
 * Persist all in-memory strategy states.
 */
export async function persistEngineStateSnapshot(): Promise<void> {
  if (!engineStarted) return;
  await persistAllStates();
}

async function autoEnableStrategies(): Promise<void> {
  await reconcileWorkspaceStrategies();
}

/**
 * Parse a cooldown string (e.g., "60s", "5m", "1h") to milliseconds.
 */
function parseCooldown(cooldown: string): number {
  const match = cooldown.match(/^(\d+)(s|m|h)$/);
  if (!match) return 60_000; // default 60s

  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    default: return 60_000;
  }
}
