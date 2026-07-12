/**
 * Orphan Cleanup Job
 * ------------------
 * Rejects stale pending HumanAction records (strategy approvals, action tokens)
 * that were left behind after crashes or restarts.
 */

import type { CronJob, CronContext } from '../job';

const STALE_THRESHOLD_MS = 15 * 60_000; // 15 minutes

async function cleanOrphanedActions(ctx: CronContext): Promise<number> {
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
  const cleaned = await ctx.prisma.humanAction.updateMany({
    where: {
      status: 'pending',
      type: { in: ['strategy:approve', 'action'] },
      createdAt: { lt: staleThreshold },
    },
    data: { status: 'rejected', resolvedAt: new Date() },
  });
  return cleaned.count;
}

export const orphanCleanupJob: CronJob = {
  id: 'orphan-cleanup',
  name: 'Orphan Cleanup',
  intervalKey: 'cron.orphan_cleanup_interval',
  defaultInterval: 5 * 60_000,

  async setup(ctx) {
    const count = await cleanOrphanedActions(ctx);
    if (count > 0) ctx.log.warn({ count }, 'Cleaned orphaned pending actions on startup');
  },

  async run(ctx) {
    const count = await cleanOrphanedActions(ctx);
    if (count > 0) ctx.log.warn({ count }, 'Cleaned orphaned pending actions');
  },
};
