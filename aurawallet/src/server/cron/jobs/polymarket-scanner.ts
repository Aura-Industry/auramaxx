/**
 * Polymarket Scanner Job
 * ----------------------
 * Read-only scan for binary complete-set opportunities where buying both
 * outcomes at the current best asks costs materially less than $1.00.
 */

import { createHash } from 'crypto';
import type { CronContext, CronJob } from '../job';
import {
  scanPolymarketCompleteSets,
  type PolymarketScannerCandidate,
} from '../../lib/polymarket';
import { createNotification } from '../../lib/notifications';

const STORAGE_APP_ID = 'polymarket-scanner';
const STORAGE_KEY = 'latest-scan';
const SYNC_KEY = 'polymarket_scanner';

async function updateScanHealth(
  ctx: CronContext,
  status: 'ok' | 'error' | 'disabled',
  error?: string,
): Promise<void> {
  await ctx.prisma.syncState.upsert({
    where: { chain: SYNC_KEY },
    create: {
      chain: SYNC_KEY,
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

async function persistLatestScan(ctx: CronContext, value: unknown): Promise<void> {
  await ctx.prisma.appStorage.upsert({
    where: {
      appId_key: {
        appId: STORAGE_APP_ID,
        key: STORAGE_KEY,
      },
    },
    create: {
      appId: STORAGE_APP_ID,
      key: STORAGE_KEY,
      value: JSON.stringify(value),
    },
    update: {
      value: JSON.stringify(value),
    },
  });
}

function candidateHash(candidate: PolymarketScannerCandidate): string {
  const digest = [
    candidate.slug,
    candidate.completeSetCost.toFixed(4),
    candidate.grossEdgePct.toFixed(4),
    candidate.maxPairShares.toFixed(4),
  ].join(':');
  return createHash('sha256').update(digest).digest('hex');
}

async function notifyCandidate(
  ctx: CronContext,
  candidate: PolymarketScannerCandidate,
): Promise<void> {
  const message =
    `${candidate.legs[0].outcome} @ ${candidate.legs[0].bestAskPrice.toFixed(4)} + ` +
    `${candidate.legs[1].outcome} @ ${candidate.legs[1].bestAskPrice.toFixed(4)} = ` +
    `${candidate.completeSetCost.toFixed(4)} total. ` +
    `${candidate.grossEdgePct.toFixed(2)}% gross edge across ` +
    `${candidate.maxPairShares.toFixed(2)} top-of-book share pairs.`;

  const notification = await createNotification({
    type: 'info',
    category: 'general',
    title: 'Polymarket complete-set candidate',
    message: `${candidate.question} — ${message}`,
    metadata: { candidate },
    hash: candidateHash(candidate),
    source: 'system',
  });

  if (!notification) return;

  await ctx.emit('notification:created', {
    notificationId: notification.id,
    title: notification.title,
    category: notification.category,
  });
}

export const polymarketScannerJob: CronJob = {
  id: 'polymarket-scanner',
  name: 'Polymarket Scanner',
  intervalKey: 'polymarket.scan_interval',
  defaultInterval: 5 * 60_000,

  async run(ctx: CronContext): Promise<void> {
    const enabled = ctx.defaults.get<boolean>('polymarket.scan_enabled', false);
    if (!enabled) {
      await updateScanHealth(ctx, 'disabled');
      return;
    }

    const options = {
      marketLimit: ctx.defaults.get<number>('polymarket.market_limit', 200),
      bookScanLimit: ctx.defaults.get<number>('polymarket.book_scan_limit', 40),
      minLiquidityUsd: ctx.defaults.get<number>('polymarket.min_liquidity_usd', 10_000),
      maxDaysToExpiry: ctx.defaults.get<number>('polymarket.max_days_to_expiry', 30),
      minGrossEdgePct: ctx.defaults.get<number>('polymarket.min_gross_edge_pct', 2),
      minTopBookShares: ctx.defaults.get<number>('polymarket.min_top_book_shares', 25),
      maxCandidates: ctx.defaults.get<number>('polymarket.max_candidates', 10),
    };

    try {
      const result = await scanPolymarketCompleteSets(options);
      const notifyTopN = ctx.defaults.get<number>('polymarket.notify_top_n', 3);

      await persistLatestScan(ctx, {
        ...result,
        config: options,
      });

      for (const candidate of result.candidates.slice(0, notifyTopN)) {
        await notifyCandidate(ctx, candidate);
      }

      await ctx.emit('polymarket:scan', {
        scannedAt: result.scannedAt,
        marketCount: result.marketCount,
        evaluatedCount: result.evaluatedCount,
        candidateCount: result.candidateCount,
        candidates: result.candidates,
      });

      await updateScanHealth(ctx, 'ok');

      if (result.candidates.length > 0) {
        ctx.log.info(
          {
            candidateCount: result.candidateCount,
            evaluatedCount: result.evaluatedCount,
            bestEdgePct: result.candidates[0].grossEdgePct,
          },
          'Polymarket scan found complete-set candidates',
        );
      } else {
        ctx.log.debug(
          {
            marketCount: result.marketCount,
            evaluatedCount: result.evaluatedCount,
          },
          'Polymarket scan completed with no candidates',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updateScanHealth(ctx, 'error', message).catch((upsertErr) => {
        ctx.log.warn({ err: upsertErr }, 'Failed to write Polymarket scan health');
      });
      throw err;
    }
  },
};
