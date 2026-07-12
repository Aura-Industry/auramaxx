/**
 * Strategy Runner Job
 * -------------------
 * Cron-owned runtime loop for strategy reconciliation, queued chat messages,
 * and external tick cadence.
 */

import type { CronJob, CronContext } from '../job';
import { loadStrategyManifests } from '../../lib/strategy/loader';
import {
  startEngine,
  stopEngine,
  runExternalTickCycle,
  isEngineStarted,
  reconcileWorkspaceStrategies,
  persistEngineStateSnapshot,
  processPendingAppMessages,
} from '../../lib/strategy/engine';
import { getErrorMessage } from '../../lib/error';

const STRATEGY_RUNNER_SYNC_KEY = 'strategy_runner';

let discoveredCount = 0;
let startupNoticeEmitted = false;
let startedInCron = false;
let lastPersistAt = 0;
let reprovisioningInFlight = false;

async function updateRuntimeHealth(
  ctx: CronContext,
  status: 'ok' | 'error' | 'disabled',
  error?: string,
): Promise<void> {
  await ctx.prisma.syncState.upsert({
    where: { chain: STRATEGY_RUNNER_SYNC_KEY },
    create: {
      chain: STRATEGY_RUNNER_SYNC_KEY,
      lastSyncAt: new Date(),
      lastSyncStatus: status,
      lastError: error || null,
      syncCount: 1,
    },
    update: {
      lastSyncAt: new Date(),
      lastSyncStatus: status,
      lastError: error || null,
      syncCount: { increment: 1 },
    },
  });
}

export const strategyRunnerJob: CronJob = {
  id: 'strategy-runner',
  name: 'Strategy Runner',
  intervalKey: 'strategy.tick_interval',
  defaultInterval: 1_000,

  async setup(ctx: CronContext): Promise<void> {
    const manifests = loadStrategyManifests();
    discoveredCount = manifests.length;
    ctx.log.info(
      { strategyCount: discoveredCount },
      'Strategy runner initialized',
    );
  },

  async run(ctx: CronContext): Promise<void> {
    const enabled = ctx.defaults.get<boolean>('strategy.cron_enabled', true);

    if (!enabled) {
      if (startedInCron && isEngineStarted()) {
        await stopEngine();
        startedInCron = false;
        startupNoticeEmitted = false;
        ctx.log.info('Strategy runner disabled — external engine stopped');
      }
      await updateRuntimeHealth(ctx, 'disabled');
      return;
    }

    try {
      if (!startedInCron) {
        await startEngine({ schedulerMode: 'external' });
        startedInCron = true;
        ctx.log.info('Strategy runner external engine started');
      }

      if (!startupNoticeEmitted) {
        startupNoticeEmitted = true;
        ctx.log.info(
          { strategyCount: discoveredCount },
          'Strategy runner active (cron-owned runtime)',
        );
      }

      const reconcile = await reconcileWorkspaceStrategies();
      if (reconcile.enabled.length > 0 || reconcile.disabled.length > 0) {
        ctx.log.info(
          { enabled: reconcile.enabled, disabled: reconcile.disabled, eligible: reconcile.eligible },
          'Strategy workspace reconcile applied changes',
        );
      }

      const messageBatchSize = ctx.defaults.get<number>('strategy.message_batch_size', 20);
      const queued = await processPendingAppMessages(messageBatchSize);
      if (queued.processed > 0 || queued.failed > 0) {
        ctx.log.debug(
          { processed: queued.processed, failed: queued.failed },
          'Strategy message queue cycle complete',
        );
      }

      const cycle = await runExternalTickCycle(Date.now());
      if (cycle.ticked.length > 0) {
        ctx.log.debug(
          { ticked: cycle.ticked, considered: cycle.considered },
          'Strategy runner cycle complete',
        );
      }

      if (cycle.authFailures.length > 0 && !reprovisioningInFlight) {
        reprovisioningInFlight = true;
        ctx.log.warn({ strategies: cycle.authFailures }, 'Auth failure threshold — re-provisioning tokens');
        try {
          const port = process.env.WALLET_SERVER_PORT || '4242';
          const headers: Record<string, string> = {};
          const cronSecret = process.env.STRATEGY_CRON_SHARED_SECRET;
          if (cronSecret) {
            headers['x-strategy-cron-secret'] = cronSecret;
          }
          const res = await fetch(`http://127.0.0.1:${port}/strategies/internal/provision-tokens`, {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(15_000),
          });
          if (res.ok) {
            ctx.log.info('Token re-provisioning successful');
          } else {
            ctx.log.error({ status: res.status }, 'Token re-provisioning failed');
          }
        } catch (err) {
          ctx.log.error({ err: getErrorMessage(err) }, 'Token re-provisioning failed — API server may be down');
        } finally {
          reprovisioningInFlight = false;
        }
      }

      const now = Date.now();
      const persistIntervalMs = ctx.defaults.get<number>('strategy.persist_interval', 300_000);
      if (lastPersistAt === 0 || now - lastPersistAt >= persistIntervalMs) {
        await persistEngineStateSnapshot();
        lastPersistAt = now;
      }

      await updateRuntimeHealth(ctx, 'ok');
    } catch (err) {
      const message = getErrorMessage(err);
      await updateRuntimeHealth(ctx, 'error', message).catch((err) => ctx.log.warn({ err }, 'Failed to update runtime health status'));
      throw err;
    }
  },

  async teardown(): Promise<void> {
    if (startedInCron && isEngineStarted()) {
      await persistEngineStateSnapshot().catch((err) => console.warn('[strategy] state persistence failed during teardown:', getErrorMessage(err)));
    }
    if (startedInCron && isEngineStarted()) {
      await stopEngine();
    }
    startedInCron = false;
    startupNoticeEmitted = false;
    lastPersistAt = 0;
    reprovisioningInFlight = false;
  },
};
