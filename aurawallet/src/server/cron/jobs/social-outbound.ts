/**
 * Social Outbound Sync Job
 * ========================
 * Batches pending SocialMessages and POSTs them to the hub.
 * Handles 207 multi-status response: accepted, duplicate, rejected, error.
 * Exponential backoff on failures (max 5 minutes).
 */

import type { CronJob, CronContext } from '../job';
import type { SocialMessage } from '@prisma/client';
import { isEnabled } from '../../lib/feature-flags';
import { syncSocialMessagesNow } from '../../lib/social/sync';
import { getHubUrl } from '../../lib/defaults';
const BATCH_LIMIT = 200;

// --- Job Definition ---

export const socialOutboundJob: CronJob = {
  id: 'social-outbound',
  name: 'Social Outbound Sync',
  intervalKey: 'social_outbound_interval',
  defaultInterval: 2_000,

  async run(ctx: CronContext): Promise<void> {
    if (!isEnabled('SOCIAL')) return;

    // Query pending messages ready to sync
    const pending = await ctx.prisma.socialMessage.findMany({
      where: {
        syncStatus: 'pending',
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: new Date() } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_LIMIT,
    });

    if (pending.length === 0) return;

    // Group by (agentId, hubUrl) — each group syncs to its respective hub
    const groups = new Map<string, SocialMessage[]>();
    for (const msg of pending) {
      const key = `${msg.agentId}\0${msg.hubUrl}`;
      const list = groups.get(key) ?? [];
      list.push(msg);
      groups.set(key, list);
    }

    for (const [key, messages] of groups) {
      const sepIdx = key.indexOf('\0');
      const agentId = key.slice(0, sepIdx);
      const msgHubUrl = key.slice(sepIdx + 1);
      const hubUrl = msgHubUrl || getHubUrl(); // "" = default hub

      try {
        await syncSocialMessagesNow({
          messages,
          transientErrorMode: 'retry',
          prismaClient: ctx.prisma,
          hubUrl,
          log: ctx.log,
        });
      } catch (err) {
        ctx.log.error({ err, agentId, hubUrl }, 'Outbound sync failed for agent/hub');
      }
    }
  },
};
