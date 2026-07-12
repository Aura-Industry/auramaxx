/**
 * Social Inbound Sync Job
 * =======================
 * Pulls messages from the hub into local InboundMessage cache.
 * Two modes:
 *   - snapshot: cold start or stale cursor (> 1 hour behind)
 *   - incremental: normal operation, pulls from global event log
 */

import type { CronJob, CronContext } from '../job';
import { isEnabled } from '../../lib/feature-flags';
import { getHubUrl } from '../../lib/defaults';
import { createNotification } from '../../lib/notifications';
import { getAgentMnemonic } from '../../lib/cold';
import { blake3 } from '@noble/hashes/blake3.js';
import { tryCallHubWithSessionAuth } from '../../lib/hub-auth';
import { normalizeHubPublicKey } from '../../lib/social/public-key';
const EVENT_BATCH_LIMIT = 500;
const STALENESS_THRESHOLD = 10_000; // If agent is this many events behind, fall back to snapshot
const RELEVANT_STREAMS = ['feed', 'followers', 'notifications'] as const;

// ─── Hub response types ──────────────────────────────────────────────

interface HubEvent {
  seq: number;
  hash: string;
  authorAuraId: number;
  authorPublicKey: string;
  type: string;
  body: string; // JSON-encoded
  timestamp: number;
}

interface EventsResponse {
  events: HubEvent[];
  latestSeq: number;
}

interface SnapshotMessage {
  hash: string;
  authorAuraId: number;
  authorPublicKey?: string;
  type: string;
  body: string;
  timestamp: number;
}

interface SnapshotFollowEntry {
  auraId: number;
  publicKey: string;
  timestamp: number;
}

interface SnapshotResponse {
  followers: SnapshotFollowEntry[];
  following: SnapshotFollowEntry[];
  feed: SnapshotMessage[];
  notifications: SnapshotMessage[];
  latestSeq: number;
}

interface SnapshotCursorResponse {
  since: number;
  seq: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Check if an authorPublicKey is someone this agent follows. */
async function isFollowing(
  agentId: string,
  authorPublicKey: string,
  ctx: CronContext,
): Promise<boolean> {
  if (!authorPublicKey) return false;

  // Fast path: check inbound cache (populated by snapshot sync)
  const inbound = await ctx.prisma.inboundMessage.findFirst({
    where: {
      agentId,
      type: 'link_add',
      body: { contains: `"followeePublicKey":"${authorPublicKey}"` },
    },
    select: { id: true },
  });
  if (inbound) return true;

  // Fallback: check our own outbound follows in SocialMessage
  const outboundFollow = await ctx.prisma.socialMessage.findFirst({
    where: {
      agentId,
      type: 'link_add',
      body: { contains: `"followeePublicKey":"${authorPublicKey}"` },
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (!outboundFollow) return false;

  // Ensure no subsequent unfollow
  const outboundUnfollow = await ctx.prisma.socialMessage.findFirst({
    where: {
      agentId,
      type: 'link_remove',
      body: { contains: `"followeePublicKey":"${authorPublicKey}"` },
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (outboundUnfollow && outboundUnfollow.createdAt > outboundFollow.createdAt) return false;

  return true;
}

/** Check if a message references one of this agent's outbound post hashes. */
async function referencesMyPost(
  agentId: string,
  body: string,
  ctx: CronContext,
): Promise<boolean> {
  // Look for postHash or targetPostHash in the body
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const refHash = (parsed.postHash ?? parsed.targetPostHash ?? parsed.parentPostHash) as string | undefined;
  if (!refHash) return false;

  const myMsg = await ctx.prisma.socialMessage.findFirst({
    where: { agentId, hash: refHash },
    select: { id: true },
  });
  return myMsg !== null;
}

/** Check if this is a credential_add for me (by publicKey). */
function isCredentialForMe(body: string, myPublicKeyHex: string): boolean {
  try {
    const parsed = JSON.parse(body);
    return parsed.ownerPublicKey === myPublicKeyHex;
  } catch {
    return false;
  }
}

/** Check if this is a link_add targeting us (by publicKey). */
function isFollowingMe(body: string, myPublicKeyHex: string): boolean {
  try {
    const parsed = JSON.parse(body);
    return parsed.followeePublicKey === myPublicKeyHex;
  } catch {
    return false;
  }
}

/** Handle remove types: delete matching InboundMessage by target hash. */
async function handleRemove(
  agentId: string,
  type: string,
  body: string,
  ctx: CronContext,
): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }

  let targetHash: string | undefined;
  let targetType: string | undefined;

  if (type === 'post_remove') {
    targetHash = parsed.targetPostHash as string;
    targetType = 'post_add';
  } else if (type === 'reaction_remove') {
    targetHash = parsed.postHash as string;
    targetType = 'reaction_add';
  } else if (type === 'link_remove') {
    // For link_remove, find the matching link_add by followeePublicKey in body
    const followeePublicKey = parsed.followeePublicKey as string;
    if (followeePublicKey) {
      await ctx.prisma.inboundMessage.deleteMany({
        where: {
          agentId,
          type: 'link_add',
          body: { contains: `"followeePublicKey":"${followeePublicKey}"` },
        },
      });
    }
    return;
  }

  if (targetHash && targetType) {
    await ctx.prisma.inboundMessage.deleteMany({
      where: { agentId, type: targetType, hash: targetHash },
    });
  }
}

// ─── Notification generation ─────────────────────────────────────────

async function createSocialNotification(
  agentId: string,
  publicKeyHex: string,
  event: HubEvent,
  ctx: CronContext,
): Promise<void> {
  let title: string | undefined;
  let message: string | undefined;
  let socialType: string | undefined;

  // Reaction on my post
  if (event.type === 'reaction_add' && await referencesMyPost(agentId, event.body, ctx)) {
    socialType = 'reaction';
    const actorLabel = event.authorAuraId ? `#${event.authorAuraId}` : 'Someone';
    title = 'Reaction on your post';
    message = `${actorLabel} reacted to your post`;
  }
  // Reply to my post
  else if (event.type === 'post_add') {
    let parsed: Record<string, unknown> | undefined;
    try { parsed = JSON.parse(event.body); } catch { /* skip */ }
    if (parsed?.parentPostHash && await referencesMyPost(agentId, event.body, ctx)) {
      socialType = 'reply';
      const actorLabel = event.authorAuraId ? `#${event.authorAuraId}` : 'Someone';
      title = 'Reply to your post';
      message = `${actorLabel} replied to your post`;
    }
  }
  // New follower
  else if (event.type === 'link_add' && isFollowingMe(event.body, publicKeyHex)) {
    socialType = 'follow';
    const actorLabel = event.authorAuraId ? `#${event.authorAuraId}` : 'Someone';
    title = 'New follower';
    message = `${actorLabel} started following you`;
  }

  if (!title || !message || !socialType) return;

  const notification = await createNotification({
    type: 'info',
    category: 'social',
    title,
    message,
    hash: event.hash,
    source: 'system',
    agentId,
    metadata: {
      socialType,
      actorAuraId: event.authorAuraId,
      actorPublicKey: event.authorPublicKey,
      eventHash: event.hash,
    },
  });

  if (notification) {
    await ctx.emit('notification:created', {
      agentId,
      notificationId: notification.id,
      category: 'social',
      title,
    });
    ctx.log.debug({ agentId, socialType, hash: event.hash }, 'Social notification created');
  }
}

// ─── Snapshot mode ───────────────────────────────────────────────────

/** Generate a deterministic hash for synthetic follow/follower messages. */
function syntheticHash(prefix: string, agentId: string, publicKey: string): string {
  const input = `${prefix}:${agentId}:${publicKey}`;
  return Buffer.from(blake3(new TextEncoder().encode(input))).toString('hex');
}

async function runSnapshot(
  agentId: string,
  hubUrl: string,
  mnemonic: string,
  subscriptionId: string,
  ctx: CronContext,
): Promise<void> {
  const cursor = await tryCallHubWithSessionAuth<SnapshotCursorResponse>(
    hubUrl,
    'sync.snapshotCursor',
    {},
    mnemonic,
    { log: ctx.log },
  );

  // Get personalized snapshot by publicKey
  const identity = await ctx.prisma.agentProfile.findUnique({ where: { agentId } });
  const pubKey = identity?.publicKeyHex ? normalizeHubPublicKey(identity.publicKeyHex) : '';
  const snapshot = await tryCallHubWithSessionAuth<SnapshotResponse>(
    hubUrl,
    'sync.snapshot',
    { publicKey: pubKey },
    mnemonic,
    { log: ctx.log },
  );

  if (!snapshot) {
    ctx.log.warn({ agentId, hubUrl }, 'Snapshot fetch failed, will retry');
    return;
  }

  let upsertCount = 0;

  const upsert = async (hash: string, authorAuraId: number, authorPublicKey: string, type: string, body: string, timestamp: number) => {
    await ctx.prisma.inboundMessage.upsert({
      where: { hash_hubUrl: { hash, hubUrl } },
      create: { agentId, hash, hubUrl, authorAuraId, authorPublicKey, type, body, timestamp },
      update: {},
    }).catch((err: unknown) => {
      ctx.log.debug({ err, hash }, 'Snapshot upsert failed (likely race)');
    });
    upsertCount++;
  };

  // following → synthetic link_add (we follow them)
  for (const entry of snapshot.following ?? []) {
    const hash = syntheticHash('following', agentId, entry.publicKey);
    const body = JSON.stringify({ followeePublicKey: entry.publicKey, followeeAuraId: entry.auraId });
    await upsert(hash, entry.auraId, pubKey, 'link_add', body, entry.timestamp);
  }

  // followers → synthetic link_add with followeePublicKey = our key
  for (const entry of snapshot.followers ?? []) {
    const hash = syntheticHash('follower', agentId, entry.publicKey);
    const body = JSON.stringify({ followeePublicKey: pubKey, followerPublicKey: entry.publicKey });
    await upsert(hash, entry.auraId, entry.publicKey, 'link_add', body, entry.timestamp);
  }

  // feed → direct upsert
  for (const msg of snapshot.feed ?? []) {
    await upsert(msg.hash, msg.authorAuraId, msg.authorPublicKey ?? '', msg.type, msg.body, msg.timestamp);
  }

  // notifications → direct upsert
  for (const msg of snapshot.notifications ?? []) {
    await upsert(msg.hash, msg.authorAuraId, msg.authorPublicKey ?? '', msg.type, msg.body, msg.timestamp);
  }

  // Set cursor to latest global seq and switch to incremental
  const latestSeq = snapshot.latestSeq ?? cursor?.seq ?? 0;
  await ctx.prisma.hubSubscription.update({
    where: { id: subscriptionId },
    data: {
      inboundSeq: latestSeq,
      inboundMode: 'incremental',
    },
  });

  ctx.log.info(
    { agentId, hubUrl, upsertCount, seq: latestSeq },
    'Snapshot sync complete, switching to incremental',
  );
}

// ─── Incremental mode ────────────────────────────────────────────────

/** Pull events once from the hub starting at the lowest agent cursor. */
async function fetchEventBatch(
  sinceSeq: number,
  hubUrl: string,
  publicKey: string,
  mnemonic: string,
  ctx: CronContext,
): Promise<{ events: HubEvent[]; latestSeq: number } | null> {
  const params: Record<string, unknown> = {
    sinceSeq,
    limit: EVENT_BATCH_LIMIT,
    publicKey: normalizeHubPublicKey(publicKey),
    streams: RELEVANT_STREAMS,
  };
  return tryCallHubWithSessionAuth<EventsResponse>(
    hubUrl,
    'sync.events.relevant',
    params,
    mnemonic,
    { log: ctx.log },
  );
}

/** Fan-out: filter a batch of events for a single agent and persist relevant ones. */
async function processEventsForAgent(
  agentId: string,
  publicKeyHex: string,
  events: HubEvent[],
  hubUrl: string,
  ctx: CronContext,
): Promise<number> {
  let maxSeq = 0;

  for (const event of events) {
    const isRemove = event.type.endsWith('_remove');

    if (isRemove) {
      await handleRemove(agentId, event.type, event.body, ctx);
    } else {
      // Filter: should we cache this message?
      let shouldCache = false;

      // Is this a credential_add for my publicKey?
      if (event.type === 'credential_add' && isCredentialForMe(event.body, publicKeyHex)) {
        shouldCache = true;
      }
      // Is this a link_add targeting my publicKey? (new follower)
      else if (event.type === 'link_add' && isFollowingMe(event.body, publicKeyHex)) {
        shouldCache = true;
      }
      // Is authorPublicKey someone I follow? (feed content)
      else if (await isFollowing(agentId, event.authorPublicKey, ctx)) {
        shouldCache = true;
      }
      // Is this a reaction/reply to one of my posts? (notification)
      else if (await referencesMyPost(agentId, event.body, ctx)) {
        shouldCache = true;
      }

      if (shouldCache) {
        await ctx.prisma.inboundMessage.upsert({
          where: { hash_hubUrl: { hash: event.hash, hubUrl } },
          create: {
            agentId,
            hash: event.hash,
            hubUrl,
            authorAuraId: event.authorAuraId,
            authorPublicKey: event.authorPublicKey ?? '',
            type: event.type,
            body: event.body,
            timestamp: event.timestamp,
          },
          update: {},
        }).catch((err: unknown) => {
          ctx.log.debug({ err, hash: event.hash }, 'Incremental upsert failed (likely race)');
        });

        // Generate social notifications for notification-worthy events
        await createSocialNotification(agentId, publicKeyHex, event, ctx);
      }
    }

    if (event.seq > maxSeq) maxSeq = event.seq;
  }

  return maxSeq;
}

/**
 * Incremental sync for a single agent against a single hub.
 * Pull events from the hub and filter/cache locally.
 */
async function runIncremental(
  agentId: string,
  publicKeyHex: string,
  currentSeq: number,
  hubUrl: string,
  mnemonic: string,
  subscriptionId: string,
  ctx: CronContext,
): Promise<void> {
  let seq = currentSeq;
  let batchCount = 0;

  do {
    const data = await fetchEventBatch(seq, hubUrl, publicKeyHex, mnemonic, ctx);
    if (!data) break;
    if (!data.events || data.events.length === 0) {
      if (data.latestSeq > seq) {
        seq = data.latestSeq;
      }
      break;
    }

    batchCount = data.events.length;

    const maxSeq = await processEventsForAgent(agentId, publicKeyHex, data.events, hubUrl, ctx);
    if (maxSeq > seq) seq = maxSeq;
    if (batchCount < EVENT_BATCH_LIMIT && data.latestSeq > seq) {
      seq = data.latestSeq;
    }
  } while (batchCount === EVENT_BATCH_LIMIT);

  if (seq > currentSeq) {
    await ctx.prisma.hubSubscription.update({
      where: { id: subscriptionId },
      data: { inboundSeq: seq },
    });
    ctx.log.debug({ agentId, hubUrl, oldSeq: currentSeq, newSeq: seq }, 'Incremental sync advanced cursor');
  }
}

// ─── Job Definition ──────────────────────────────────────────────────

export const socialInboundJob: CronJob = {
  id: 'social-inbound',
  name: 'Social Inbound Sync',
  intervalKey: 'social_inbound_interval',
  defaultInterval: 5_000,

  async run(ctx: CronContext): Promise<void> {
    if (!isEnabled('SOCIAL')) return;

    // Sync inbound cache for every local agent with a social identity.
    const agents = await ctx.prisma.agentProfile.findMany({
      where: { publicKeyHex: { not: null } },
      orderBy: { createdAt: 'asc' },
    });

    if (agents.length === 0) return;

    for (const agent of agents) {
      const agentId = agent.agentId;
      const publicKeyHex = agent.publicKeyHex;
      if (!publicKeyHex) continue;

      const mnemonic = getAgentMnemonic(agentId);
      if (!mnemonic) {
        ctx.log.warn({ agentId }, 'Skipping social inbound sync because agent is locked');
        continue;
      }

      // Iterate over all subscribed hubs for this agent.
      const subscriptions = await ctx.prisma.hubSubscription.findMany({
        where: { agentId },
      });

      // Fallback: if no subscriptions exist yet (pre-migration), create one
      // from the legacy single-hub config so existing users aren't broken.
      if (subscriptions.length === 0) {
        const defaultHubUrl = getHubUrl();
        const sub = await ctx.prisma.hubSubscription.upsert({
          where: { agentId_hubUrl: { agentId, hubUrl: defaultHubUrl } },
          create: {
            agentId,
            hubUrl: defaultHubUrl,
            label: 'AuraMaxx',
            auraId: null,
            inboundSeq: agent.inboundSeq,
            inboundMode: agent.inboundMode,
          },
          update: {},
        });
        subscriptions.push(sub);
      }

      for (const sub of subscriptions) {
        const hubUrl = sub.hubUrl;
        const currentSeq = sub.inboundSeq ?? 0;
        const mode = sub.inboundMode;

        // Fetch snapshot-cursor for this (agent, hub) pair.
        // Do not share cursor responses across agents because auth/whitelist
        // can differ by caller key.
        const snapshotCursor = await tryCallHubWithSessionAuth<SnapshotCursorResponse>(
          hubUrl,
          'sync.snapshotCursor',
          {},
          mnemonic,
          { log: ctx.log },
        );

        const isStale =
          snapshotCursor !== null &&
          currentSeq > 0 &&
          mode === 'incremental' &&
          (snapshotCursor.seq - currentSeq) > STALENESS_THRESHOLD;

        const needsSnapshot =
          mode !== 'incremental' ||
          currentSeq === 0 ||
          isStale;

        if (isStale) {
          ctx.log.info(
            { agentId, hubUrl, currentSeq, hubSeq: snapshotCursor!.seq, threshold: STALENESS_THRESHOLD },
            'Stale cursor, falling back to snapshot mode',
          );
        }

        try {
          if (needsSnapshot) {
            await runSnapshot(agentId, hubUrl, mnemonic, sub.id, ctx);
          } else {
            await runIncremental(agentId, publicKeyHex, currentSeq, hubUrl, mnemonic, sub.id, ctx);
          }
        } catch (err) {
          ctx.log.error({ err, agentId, hubUrl }, 'Inbound sync failed for hub');
        }
      }
    }
  },
};
