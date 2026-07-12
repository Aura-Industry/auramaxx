import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/db';
import { requireWalletAuth } from '../middleware/auth';
import { requirePermission } from '../lib/permissions';
import { isEnabled } from '../lib/feature-flags';
import { getDefaultSync, getHubUrl } from '../lib/defaults';
import { getErrorMessage } from '../lib/error';
import { getAgentMnemonic, isAgentUnlocked } from '../lib/cold';
import { blake3 } from '@noble/hashes/blake3.js';
import { resolveHubAuthIdentity, tryCallHubWithSessionAuth } from '../lib/hub-auth';
import { normalizeHubPublicKey } from '../lib/social/public-key';
import {
  createPost,
  createPostRemove,
  createReaction,
  createReactionRemove,
  createFollow,
  createUnfollow,
  createProfileUpdate,
} from '../lib/social/create';
import { submitSocialMessagesAsync } from '../lib/social/sync';

const router = Router();

// ─── Credential gate for social writes ──────────────────────────────
// Configurable via `social.required_credentials` default (array of credential
// type slugs). Empty array = no requirement. Checks locally synced
// credential_add messages in InboundMessage.

/**
 * Middleware: reject social writes if agent lacks required verified credentials.
 * Reads `social.required_credentials` from defaults — empty = no gate.
 * Checks locally synced credential_add messages (via inbound sync).
 */
async function requireVerifiedCredentials(req: Request, res: Response, next: NextFunction): Promise<void> {
  const required = getDefaultSync<string[]>('social.required_credentials', []);
  if (required.length === 0) {
    next();
    return;
  }

  const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : '';
  if (!agentId) {
    // Let the route handler deal with missing agentId
    next();
    return;
  }

  // Find all credential_add messages synced for this agent
  const credentials = await prisma.inboundMessage.findMany({
    where: { agentId, type: 'credential_add' },
    select: { body: true },
  });

  // Extract credential type slugs from synced messages
  const verified = new Set<string>();
  for (const cred of credentials) {
    try {
      const parsed = JSON.parse(cred.body) as { credentialType?: string };
      if (parsed.credentialType) verified.add(parsed.credentialType);
    } catch { /* skip malformed */ }
  }

  const missing = required.filter(slug => !verified.has(slug));

  if (missing.length > 0) {
    res.status(403).json({
      error: 'credential_required',
      detail: `Agent must have verified credentials before posting: ${missing.join(', ')}`,
      required,
      missing,
    });
    return;
  }

  next();
}

// All social routes require auth + SOCIAL flag
router.use(requireWalletAuth);
router.use((_req: Request, res: Response, next) => {
  if (!isEnabled('SOCIAL')) {
    res.status(404).json({ error: 'social_not_enabled' });
    return;
  }
  next();
});

// Permission middleware — reads vs writes
const requireSocialRead = requirePermission('social:read', 'social:write');
const requireSocialWrite = requirePermission('social:write');

// ─── Helpers ─────────────────────────────────────────────────────────

function parseIntParam(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // no-op
  }
  return {};
}

function extractFolloweePublicKey(body: string): string | null {
  const parsed = parseJsonObject(body);
  const key = parsed.followeePublicKey;
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  return trimmed || null;
}

function extractRemovedPostHash(body: string): string | null {
  const parsed = parseJsonObject(body);
  const raw = parsed.targetPostHash ?? parsed.postHash ?? parsed.targetHash;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function syntheticFollowerHash(agentId: string, followerPublicKey: string): string {
  const input = `follower:${agentId}:${followerPublicKey}`;
  return Buffer.from(blake3(new TextEncoder().encode(input))).toString('hex');
}

interface SnapshotFollowEntry {
  auraId: number;
  publicKey: string;
  timestamp: number;
}

interface FollowersSnapshotResponse {
  followers?: SnapshotFollowEntry[];
}

function requireAgentId(body: Record<string, unknown>, res: Response): string | null {
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  if (!agentId) {
    res.status(400).json({ error: 'agentId is required' });
    return null;
  }
  return agentId;
}

function requireMnemonic(agentId: string, res: Response): string | null {
  if (!isAgentUnlocked(agentId)) {
    res.status(400).json({ error: `Agent '${agentId}' is not unlocked` });
    return null;
  }
  const mnemonic = getAgentMnemonic(agentId);
  if (!mnemonic) {
    res.status(400).json({ error: `No mnemonic available for agent '${agentId}'` });
    return null;
  }
  return mnemonic;
}

// ─── POST /social/post ───────────────────────────────────────────────

router.post('/post', requireSocialWrite, requireVerifiedCredentials, async (req: Request, res: Response) => {
  try {
    const agentId = requireAgentId(req.body, res);
    if (!agentId) return;

    const mnemonic = requireMnemonic(agentId, res);
    if (!mnemonic) return;

    const { text, embeds, parentPostHash, mentions } = req.body;

    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text is required and must be a non-empty string' });
      return;
    }

    if (embeds !== undefined && !Array.isArray(embeds)) {
      res.status(400).json({ error: 'embeds must be an array of strings' });
      return;
    }

    if (parentPostHash !== undefined && typeof parentPostHash !== 'string') {
      res.status(400).json({ error: 'parentPostHash must be a string' });
      return;
    }

    if (mentions !== undefined && !Array.isArray(mentions)) {
      res.status(400).json({ error: 'mentions must be an array of numbers' });
      return;
    }

    const hubUrl = typeof req.body.hubUrl === 'string' ? req.body.hubUrl.trim() : '';

    const message = await createPost(agentId, mnemonic, text.trim(), {
      embeds,
      parentPostHash,
      mentions,
      hubUrl,
    });

    submitSocialMessagesAsync({
      messages: [message],
      transientErrorMode: 'retry',
      hubUrl: hubUrl || undefined,
    });

    res.json({ success: true, message });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── POST /social/react ──────────────────────────────────────────────

router.post('/react', requireSocialWrite, requireVerifiedCredentials, async (req: Request, res: Response) => {
  try {
    const agentId = requireAgentId(req.body, res);
    if (!agentId) return;

    const mnemonic = requireMnemonic(agentId, res);
    if (!mnemonic) return;

    const { postHash, reactionType } = req.body;

    if (typeof postHash !== 'string' || !postHash.trim()) {
      res.status(400).json({ error: 'postHash is required' });
      return;
    }

    if (typeof reactionType !== 'string' || !reactionType.trim()) {
      res.status(400).json({ error: 'reactionType is required' });
      return;
    }

    const reactHubUrl = typeof req.body.hubUrl === 'string' ? req.body.hubUrl.trim() : '';
    const message = await createReaction(agentId, mnemonic, postHash.trim(), reactionType.trim(), reactHubUrl);

    submitSocialMessagesAsync({
      messages: [message],
      transientErrorMode: 'retry',
      hubUrl: reactHubUrl || undefined,
    });

    res.json({ success: true, message });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── POST /social/follow ─────────────────────────────────────────────

router.post('/follow', requireSocialWrite, requireVerifiedCredentials, async (req: Request, res: Response) => {
  try {
    const agentId = requireAgentId(req.body, res);
    if (!agentId) return;

    const mnemonic = requireMnemonic(agentId, res);
    if (!mnemonic) return;

    const { targetPublicKey } = req.body;

    if (typeof targetPublicKey !== 'string' || !targetPublicKey.trim()) {
      res.status(400).json({ error: 'targetPublicKey is required' });
      return;
    }

    const followHubUrl = typeof req.body.hubUrl === 'string' ? req.body.hubUrl.trim() : '';
    const message = await createFollow(agentId, mnemonic, targetPublicKey.trim(), followHubUrl);

    submitSocialMessagesAsync({
      messages: [message],
      transientErrorMode: 'retry',
      hubUrl: followHubUrl || undefined,
    });

    res.json({ success: true, message });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── POST /social/unfollow ───────────────────────────────────────────

router.post('/unfollow', requireSocialWrite, requireVerifiedCredentials, async (req: Request, res: Response) => {
  try {
    const agentId = requireAgentId(req.body, res);
    if (!agentId) return;

    const mnemonic = requireMnemonic(agentId, res);
    if (!mnemonic) return;

    const { targetPublicKey } = req.body;

    if (typeof targetPublicKey !== 'string' || !targetPublicKey.trim()) {
      res.status(400).json({ error: 'targetPublicKey is required' });
      return;
    }

    const unfollowHubUrl = typeof req.body.hubUrl === 'string' ? req.body.hubUrl.trim() : '';
    const message = await createUnfollow(agentId, mnemonic, targetPublicKey.trim(), unfollowHubUrl);

    submitSocialMessagesAsync({
      messages: [message],
      transientErrorMode: 'retry',
      hubUrl: unfollowHubUrl || undefined,
    });

    res.json({ success: true, message });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── POST /social/profile ────────────────────────────────────────────

router.post('/profile', requireSocialWrite, requireVerifiedCredentials, async (req: Request, res: Response) => {
  try {
    const agentId = requireAgentId(req.body, res);
    if (!agentId) return;

    const mnemonic = requireMnemonic(agentId, res);
    if (!mnemonic) return;

    const { field, value } = req.body;

    if (typeof field !== 'string' || !field.trim()) {
      res.status(400).json({ error: 'field is required' });
      return;
    }

    if (typeof value !== 'string') {
      res.status(400).json({ error: 'value must be a string' });
      return;
    }

    const profileHubUrl = typeof req.body.hubUrl === 'string' ? req.body.hubUrl.trim() : '';
    const message = await createProfileUpdate(agentId, mnemonic, field.trim(), value, profileHubUrl);

    submitSocialMessagesAsync({
      messages: [message],
      transientErrorMode: 'retry',
      hubUrl: profileHubUrl || undefined,
    });

    res.json({ success: true, message });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── POST /social/post/remove ────────────────────────────────────────

router.post('/post/remove', requireSocialWrite, requireVerifiedCredentials, async (req: Request, res: Response) => {
  try {
    const agentId = requireAgentId(req.body, res);
    if (!agentId) return;

    const mnemonic = requireMnemonic(agentId, res);
    if (!mnemonic) return;

    const { targetPostHash } = req.body;

    if (typeof targetPostHash !== 'string' || !targetPostHash.trim()) {
      res.status(400).json({ error: 'targetPostHash is required' });
      return;
    }

    const removeHubUrl = typeof req.body.hubUrl === 'string' ? req.body.hubUrl.trim() : '';
    const message = await createPostRemove(agentId, mnemonic, targetPostHash.trim(), removeHubUrl);

    submitSocialMessagesAsync({
      messages: [message],
      transientErrorMode: 'retry',
      hubUrl: removeHubUrl || undefined,
    });

    res.json({ success: true, message });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── POST /social/react/remove ──────────────────────────────────────

router.post('/react/remove', requireSocialWrite, requireVerifiedCredentials, async (req: Request, res: Response) => {
  try {
    const agentId = requireAgentId(req.body, res);
    if (!agentId) return;

    const mnemonic = requireMnemonic(agentId, res);
    if (!mnemonic) return;

    const { postHash, reactionType } = req.body;

    if (typeof postHash !== 'string' || !postHash.trim()) {
      res.status(400).json({ error: 'postHash is required' });
      return;
    }

    if (typeof reactionType !== 'string' || !reactionType.trim()) {
      res.status(400).json({ error: 'reactionType is required' });
      return;
    }

    const reactRemoveHubUrl = typeof req.body.hubUrl === 'string' ? req.body.hubUrl.trim() : '';
    const message = await createReactionRemove(agentId, mnemonic, postHash.trim(), reactionType.trim(), reactRemoveHubUrl);

    submitSocialMessagesAsync({
      messages: [message],
      transientErrorMode: 'retry',
      hubUrl: reactRemoveHubUrl || undefined,
    });

    res.json({ success: true, message });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── GET /social/following ──────────────────────────────────────────

router.get('/following', requireSocialRead, async (req: Request, res: Response) => {
  try {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId query param is required' });
      return;
    }

    const hubUrl = typeof req.query.hubUrl === 'string' ? req.query.hubUrl.trim() : '';

    // Get all link_add and link_remove messages for this agent (optionally filtered by hub)
    const linkWhere: Record<string, unknown> = { agentId, type: { in: ['link_add', 'link_remove'] } };
    if (hubUrl) linkWhere.hubUrl = hubUrl;
    const links = await prisma.socialMessage.findMany({
      where: linkWhere,
      orderBy: { createdAt: 'asc' },
    });

    // Build net following set: add on link_add, remove on link_remove
    const followingMap = new Map<string, { publicKey: string; timestamp: number }>();
    for (const link of links) {
      const body = JSON.parse(link.body) as { followeePublicKey?: string; followeeAuraId?: number };
      const targetKey = body.followeePublicKey ?? String(body.followeeAuraId ?? '');
      if (!targetKey) continue;

      if (link.type === 'link_add') {
        followingMap.set(targetKey, { publicKey: targetKey, timestamp: link.timestamp });
      } else {
        followingMap.delete(targetKey);
      }
    }

    const following = Array.from(followingMap.values());

    res.json({ success: true, following, count: following.length });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── GET /social/messages ────────────────────────────────────────────

router.get('/messages', requireSocialRead, async (req: Request, res: Response) => {
  try {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId query param is required' });
      return;
    }

    const type = typeof req.query.type === 'string' ? req.query.type.trim() : undefined;
    const hubUrl = typeof req.query.hubUrl === 'string' ? req.query.hubUrl.trim() : '';
    const limit = parseIntParam(req.query.limit, 50);
    const offset = parseIntParam(req.query.offset, 0);

    const where: Record<string, unknown> = { agentId };
    if (type) where.type = type;
    if (hubUrl) where.hubUrl = hubUrl;

    const [messages, total] = await Promise.all([
      prisma.socialMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 200),
        skip: offset,
      }),
      prisma.socialMessage.count({ where }),
    ]);

    res.json({ success: true, messages, total });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── GET /social/feed ────────────────────────────────────────────────

router.get('/feed', requireSocialRead, async (req: Request, res: Response) => {
  try {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId query param is required' });
      return;
    }

    const type = typeof req.query.type === 'string' ? req.query.type.trim() : undefined;
    const hubUrl = typeof req.query.hubUrl === 'string' ? req.query.hubUrl.trim() : '';
    const limit = parseIntParam(req.query.limit, 50);
    const offset = parseIntParam(req.query.offset, 0);

    if (type && type !== 'post_add') {
      res.json({ success: true, messages: [], total: 0 });
      return;
    }

    // Build hub-aware where clauses for outbound messages
    const outboundHubWhere: Record<string, unknown> = hubUrl ? { hubUrl } : {};
    const effectiveHubUrl = hubUrl || getHubUrl();

    const [
      selectedHubSubscription,
      inboundOwnerProfile,
      outboundLinks,
      ownPostAdds,
      ownPostRemoves,
    ] = await Promise.all([
      prisma.hubSubscription.findUnique({
        where: {
          agentId_hubUrl: {
            agentId,
            hubUrl: effectiveHubUrl,
          },
        },
        select: { auraId: true },
      }),
      prisma.agentProfile.findFirst({
        where: { publicKeyHex: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: { agentId: true },
      }),
      prisma.socialMessage.findMany({
        where: {
          agentId,
          type: { in: ['link_add', 'link_remove'] },
          syncStatus: { notIn: ['failed', 'rejected'] },
          ...outboundHubWhere,
        },
        orderBy: { createdAt: 'asc' },
        select: { type: true, body: true },
      }),
      prisma.socialMessage.findMany({
        where: {
          agentId,
          type: 'post_add',
          syncStatus: { notIn: ['failed', 'rejected'] },
          ...outboundHubWhere,
        },
        orderBy: { timestamp: 'desc' },
        select: {
          id: true,
          hash: true,
          type: true,
          body: true,
          timestamp: true,
        },
      }),
      prisma.socialMessage.findMany({
        where: {
          agentId,
          type: 'post_remove',
          syncStatus: { notIn: ['failed', 'rejected'] },
          ...outboundHubWhere,
        },
        select: { body: true },
      }),
    ]);

    const followingPublicKeys = new Set<string>();
    for (const link of outboundLinks) {
      const key = extractFolloweePublicKey(link.body);
      if (!key) continue;
      if (link.type === 'link_add') {
        followingPublicKeys.add(key);
      } else {
        followingPublicKeys.delete(key);
      }
    }

    const removedPostHashes = new Set<string>();
    for (const removeMessage of ownPostRemoves) {
      const targetHash = extractRemovedPostHash(removeMessage.body);
      if (targetHash) removedPostHashes.add(targetHash);
    }

    const ownPosts = ownPostAdds
      .filter((post) => !removedPostHashes.has(post.hash))
      .map((post) => ({
        id: post.id,
        agentId,
        hash: post.hash,
        authorAuraId: selectedHubSubscription?.auraId ?? 0,
        type: post.type,
        body: post.body,
        timestamp: post.timestamp,
      }));

    const inboundAgentId = inboundOwnerProfile?.agentId ?? agentId;
    const inboundHubWhere: Record<string, unknown> = hubUrl ? { hubUrl } : {};
    const followedPosts = followingPublicKeys.size > 0
      ? await prisma.inboundMessage.findMany({
          where: {
            agentId: inboundAgentId,
            type: 'post_add',
            authorPublicKey: { in: Array.from(followingPublicKeys) },
            ...inboundHubWhere,
          },
          orderBy: { timestamp: 'desc' },
          select: {
            id: true,
            agentId: true,
            hash: true,
            authorAuraId: true,
            type: true,
            body: true,
            timestamp: true,
          },
        })
      : [];

    const byHash = new Map<string, {
      id: string;
      agentId: string;
      hash: string;
      authorAuraId: number;
      type: string;
      body: string;
      timestamp: number;
    }>();

    for (const msg of followedPosts) {
      byHash.set(msg.hash, msg);
    }
    for (const msg of ownPosts) {
      byHash.set(msg.hash, msg);
    }

    const merged = Array.from(byHash.values()).sort((a, b) => b.timestamp - a.timestamp);
    const cappedLimit = Math.min(limit, 200);
    const messages = merged.slice(offset, offset + cappedLimit);

    res.json({ success: true, messages, total: merged.length });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── GET /social/followers ───────────────────────────────────────────

router.get('/followers', requireSocialRead, async (req: Request, res: Response) => {
  try {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId query param is required' });
      return;
    }

    const hubUrl = typeof req.query.hubUrl === 'string' ? req.query.hubUrl.trim() : '';
    const followerWhere: Record<string, unknown> = { agentId, type: 'link_add' };
    if (hubUrl) followerWhere.hubUrl = hubUrl;

    const [cachedFollowers, cachedCount] = await Promise.all([
      prisma.inboundMessage.findMany({
        where: followerWhere,
        orderBy: { timestamp: 'desc' },
      }),
      prisma.inboundMessage.count({
        where: followerWhere,
      }),
    ]);

    if (cachedCount > 0) {
      res.json({ success: true, followers: cachedFollowers, count: cachedCount });
      return;
    }

    // Fallback: if cron cache is empty, read a fresh snapshot from hub.
    // This keeps followers usable even when inbound cron has not populated yet.
    const effectiveHubUrl = hubUrl || getHubUrl();
    const profile = await prisma.agentProfile.findUnique({
      where: { agentId },
      select: { publicKeyHex: true },
    });

    if (!profile?.publicKeyHex) {
      res.json({ success: true, followers: cachedFollowers, count: cachedCount });
      return;
    }

    const authIdentity = resolveHubAuthIdentity(agentId);
    if (!authIdentity) {
      res.json({ success: true, followers: cachedFollowers, count: cachedCount });
      return;
    }

    const snapshot = await tryCallHubWithSessionAuth<FollowersSnapshotResponse>(
      effectiveHubUrl,
      'sync.snapshot',
      { publicKey: normalizeHubPublicKey(profile.publicKeyHex) },
      authIdentity.mnemonic,
    );

    const snapshotFollowers = (snapshot?.followers ?? [])
      .filter((entry) => typeof entry?.publicKey === 'string' && entry.publicKey.trim().length > 0)
      .map((entry) => {
        const followerPublicKey = entry.publicKey.trim();
        return {
          id: `snapshot:${agentId}:${followerPublicKey}`,
          agentId,
          hash: syntheticFollowerHash(agentId, followerPublicKey),
          hubUrl: effectiveHubUrl,
          authorAuraId: Number.isFinite(entry.auraId) ? entry.auraId : 0,
          authorPublicKey: followerPublicKey,
          type: 'link_add',
          body: JSON.stringify({
            followeePublicKey: profile.publicKeyHex,
            followerPublicKey,
          }),
          timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
        };
      });

    res.json({ success: true, followers: snapshotFollowers, count: snapshotFollowers.length });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── GET /social/notifications ───────────────────────────────────────

router.get('/notifications', requireSocialRead, async (req: Request, res: Response) => {
  try {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';

    const limit = parseIntParam(req.query.limit, 50);
    const unreadOnly = req.query.unreadOnly === 'true';

    const where: Record<string, unknown> = { category: 'social' };
    if (agentId) where.agentId = agentId;
    if (unreadOnly) {
      where.read = false;
      where.dismissed = false;
    }

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 200),
      }),
      prisma.notification.count({ where }),
    ]);

    res.json({ success: true, notifications, total });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── POST /social/notifications/read ────────────────────────────────

router.post('/notifications/read', requireSocialWrite, async (req: Request, res: Response) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'ids array is required' });
      return;
    }

    const updated = await prisma.notification.updateMany({
      where: { id: { in: ids }, category: 'social' },
      data: { read: true },
    });

    res.json({ success: true, updated: updated.count });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── POST /social/notifications/dismiss ─────────────────────────────

router.post('/notifications/dismiss', requireSocialWrite, async (req: Request, res: Response) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'ids array is required' });
      return;
    }

    const updated = await prisma.notification.updateMany({
      where: { id: { in: ids }, category: 'social' },
      data: { dismissed: true, read: true },
    });

    res.json({ success: true, updated: updated.count });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// ─── GET /social/global-feed ─────────────────────────────────────────

router.get('/global-feed', requireSocialRead, async (req: Request, res: Response) => {
  try {
    const limit = parseIntParam(req.query.limit, 50);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const hubUrl = typeof req.query.hubUrl === 'string' && req.query.hubUrl.trim()
      ? req.query.hubUrl.trim()
      : getHubUrl();

    const url = new URL(`${hubUrl}/v1/social/global`);
    url.searchParams.set('limit', String(Math.min(limit, 200)));
    if (cursor) url.searchParams.set('cursor', cursor);

    const hubRes = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
    const data = await hubRes.json();
    res.status(hubRes.status).json(data);
  } catch (error) {
    res.status(502).json({ error: 'hub_unreachable', detail: getErrorMessage(error) });
  }
});

// ─── GET /social/status ──────────────────────────────────────────────

router.get('/status', requireSocialRead, async (req: Request, res: Response) => {
  try {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId query param is required' });
      return;
    }

    const hubUrl = typeof req.query.hubUrl === 'string' ? req.query.hubUrl.trim() : '';
    const statusHubWhere: Record<string, unknown> = hubUrl ? { hubUrl } : {};

    const [pending, accepted, rejected, failed, total] = await Promise.all([
      prisma.socialMessage.count({ where: { agentId, syncStatus: 'pending', ...statusHubWhere } }),
      prisma.socialMessage.count({ where: { agentId, syncStatus: 'accepted', ...statusHubWhere } }),
      prisma.socialMessage.count({ where: { agentId, syncStatus: 'rejected', ...statusHubWhere } }),
      prisma.socialMessage.count({ where: { agentId, syncStatus: 'failed', ...statusHubWhere } }),
      prisma.socialMessage.count({ where: { agentId, ...statusHubWhere } }),
    ]);

    res.json({
      success: true,
      status: { pending, accepted, rejected, failed, total },
    });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

export default router;
