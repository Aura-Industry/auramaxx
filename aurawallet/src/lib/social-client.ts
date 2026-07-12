import { api, Api } from './api';

export interface SocialAgentInfo {
  id: string;
  name?: string;
  isPrimary: boolean;
  parentAgentId?: string;
}

export interface SocialMessageItem {
  id: string;
  agentId: string;
  hash: string;
  type: string;
  body: string;
  timestamp: number;
  syncStatus?: string;
  createdAt?: string;
}

export interface InboundMessageItem {
  id: string;
  agentId: string;
  hash: string;
  authorAuraId: number;
  type: string;
  body: string;
  timestamp: number;
}

export interface FollowerItem {
  id: string;
  authorAuraId: number;
  timestamp: number;
  body: string;
}

export interface FollowingItem {
  auraId: number;
  timestamp: number;
}

export interface SyncStatus {
  pending: number;
  accepted: number;
  rejected: number;
  failed: number;
  total: number;
}

export interface AgentProfile {
  pfp: string;
  handle: string;
  displayName: string;
  pfpIsSprite?: boolean;
}

export interface HubSubscriptionInfo {
  id: string;
  agentId: string;
  hubUrl: string;
  frontendUrl: string | null;
  label: string | null;
  auraId: number | null;
  inboundSeq: number | null;
  inboundMode: string | null;
  joinedAt: string;
}

interface ProfileMessageItem {
  body: string;
  createdAt?: string;
  timestamp?: number;
}

const DEFAULT_AGENT_AVATAR = 'https://aurawallet.sh/agent7.png';

function parseLatestProfile(messages: ProfileMessageItem[]): AgentProfile {
  const latest: Record<string, { value: string; rank: number }> = {};
  for (const msg of messages) {
    try {
      const parsed = JSON.parse(msg.body) as { type?: string; value?: string };
      if (!parsed.type) continue;
      const rank = msg.createdAt
        ? Date.parse(msg.createdAt)
        : typeof msg.timestamp === 'number'
          ? msg.timestamp * 1000
          : 0;
      const existing = latest[parsed.type];
      if (!existing || rank >= existing.rank) {
        latest[parsed.type] = { value: parsed.value ?? '', rank };
      }
    } catch {
      // ignore malformed profile rows
    }
  }

  const pfpVal = latest.pfp?.value || DEFAULT_AGENT_AVATAR;
  return {
    pfp: pfpVal,
    handle: latest.handle?.value || '',
    displayName: latest.display_name?.value || '',
    pfpIsSprite: latest.pfp_is_sprite?.value === 'true'
      || (!latest.pfp_is_sprite && /\/agent\d+\.png$/.test(pfpVal)),
  };
}

function tryParseBody(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function shouldApplyPostRemove(syncStatus?: string): boolean {
  return syncStatus !== 'failed' && syncStatus !== 'rejected';
}

function extractRemovedPostHash(message: SocialMessageItem): string | null {
  const parsed = tryParseBody(message.body);
  const raw = parsed.targetPostHash ?? parsed.postHash ?? parsed.targetHash;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

export async function fetchSocialAgents(): Promise<SocialAgentInfo[]> {
  const res = await api.get<{ agents: SocialAgentInfo[] }>(Api.Wallet, '/agents/credential');
  return res.agents || [];
}

export interface GlobalFeedAuthorProfile {
  handle: string | null;
  displayName: string | null;
  pfp: string | null;
  pfpIsSprite: boolean;
}

export interface GlobalFeedItem {
  postHash: string;
  authorAuraId: number;
  text: string;
  updatedTs: number;
  authorScore: number;
  authorProfile: GlobalFeedAuthorProfile | null;
}

export async function fetchGlobalFeed(cursor?: string, hubUrl?: string): Promise<{ items: GlobalFeedItem[]; nextCursor: string | null }> {
  const params: Record<string, string | number> = { limit: 50 };
  if (cursor) params.cursor = cursor;
  if (hubUrl) params.hubUrl = hubUrl;
  const res = await api.get<{ ok: boolean; items: GlobalFeedItem[]; nextCursor: string | null }>(
    Api.Wallet,
    '/social/global-feed',
    params,
  );
  return { items: res.items || [], nextCursor: res.nextCursor ?? null };
}

export async function fetchSocialFeed(agentId: string, hubUrl?: string): Promise<InboundMessageItem[]> {
  const params: Record<string, string | number> = { agentId, type: 'post_add', limit: 50 };
  if (hubUrl) params.hubUrl = hubUrl;

  const [feedRes, ownPosts] = await Promise.all([
    api.get<{ messages: InboundMessageItem[] }>(
      Api.Wallet,
      '/social/feed',
      params,
    ),
    fetchSocialPosts(agentId, hubUrl),
  ]);

  const byHash = new Map<string, InboundMessageItem>();
  for (const message of feedRes.messages || []) {
    byHash.set(message.hash, message);
  }
  for (const post of ownPosts) {
    if (byHash.has(post.hash)) continue;
    byHash.set(post.hash, {
      id: post.id,
      agentId: post.agentId,
      hash: post.hash,
      authorAuraId: 0,
      type: post.type,
      body: post.body,
      timestamp: post.timestamp,
    });
  }

  return Array.from(byHash.values()).sort((a, b) => b.timestamp - a.timestamp);
}

export async function fetchSocialPosts(agentId: string, hubUrl?: string): Promise<SocialMessageItem[]> {
  const params: Record<string, string | number> = { agentId, type: 'post_add', limit: 200 };
  if (hubUrl) params.hubUrl = hubUrl;
  const removeParams: Record<string, string | number> = { agentId, type: 'post_remove', limit: 200 };
  if (hubUrl) removeParams.hubUrl = hubUrl;

  const [addsRes, removesRes] = await Promise.all([
    api.get<{ messages: SocialMessageItem[] }>(Api.Wallet, '/social/messages', params),
    api.get<{ messages: SocialMessageItem[] }>(Api.Wallet, '/social/messages', removeParams),
  ]);

  const posts = addsRes.messages || [];
  const removals = removesRes.messages || [];
  if (removals.length === 0) return posts;

  const removedHashes = new Set<string>();
  for (const removeMessage of removals) {
    if (!shouldApplyPostRemove(removeMessage.syncStatus)) continue;
    const targetHash = extractRemovedPostHash(removeMessage);
    if (targetHash) removedHashes.add(targetHash);
  }

  if (removedHashes.size === 0) return posts;
  return posts.filter((post) => !removedHashes.has(post.hash));
}

export async function fetchSocialFollowers(agentId: string, hubUrl?: string): Promise<FollowerItem[]> {
  const params: Record<string, string> = { agentId };
  if (hubUrl) params.hubUrl = hubUrl;
  const res = await api.get<{ followers: FollowerItem[] }>(Api.Wallet, '/social/followers', params);
  return res.followers || [];
}

export async function fetchSocialFollowing(agentId: string, hubUrl?: string): Promise<FollowingItem[]> {
  const params: Record<string, string> = { agentId };
  if (hubUrl) params.hubUrl = hubUrl;
  const res = await api.get<{ following: FollowingItem[] }>(Api.Wallet, '/social/following', params);
  return res.following || [];
}

export async function fetchSocialStatus(agentId: string, hubUrl?: string): Promise<SyncStatus | null> {
  const params: Record<string, string> = { agentId };
  if (hubUrl) params.hubUrl = hubUrl;
  const res = await api.get<{ status: SyncStatus | null }>(Api.Wallet, '/social/status', params);
  return res.status || null;
}

export async function fetchSocialProfile(agentId: string): Promise<AgentProfile> {
  const res = await api.get<{ messages: ProfileMessageItem[] }>(
    Api.Wallet,
    '/social/messages',
    { agentId, type: 'user_data_add', limit: 200 },
  );
  return parseLatestProfile(res.messages || []);
}

export function buildLocalPendingPost(agentId: string, text: string): SocialMessageItem {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const localId = `local:${agentId}:${nowMs}:${Math.random().toString(16).slice(2, 8)}`;
  return {
    id: localId,
    agentId,
    hash: localId,
    type: 'post_add',
    body: JSON.stringify({ text }),
    timestamp: Math.floor(nowMs / 1000),
    syncStatus: 'pending',
    createdAt: nowIso,
  };
}

export function submitPostLocalFirst(agentId: string, text: string, hubUrl?: string): {
  localMessage: SocialMessageItem;
  submit: Promise<SocialMessageItem>;
} {
  const normalizedText = text.trim();
  if (!normalizedText) {
    throw new Error('text is required and must be a non-empty string');
  }
  const localMessage = buildLocalPendingPost(agentId, normalizedText);
  const postBody: Record<string, string> = { agentId, text: normalizedText };
  if (hubUrl) postBody.hubUrl = hubUrl;

  const submit = api
    .post<{ success: boolean; message: SocialMessageItem }>(Api.Wallet, '/social/post', postBody)
    .then((res) => res.message);

  return { localMessage, submit };
}

export async function removeSocialPost(agentId: string, targetPostHash: string, hubUrl?: string): Promise<void> {
  const body: Record<string, string> = { agentId, targetPostHash };
  if (hubUrl) body.hubUrl = hubUrl;
  await api.post(Api.Wallet, '/social/post/remove', body);
}

export async function likeSocialPost(agentId: string, postHash: string, hubUrl?: string): Promise<void> {
  const body: Record<string, string> = { agentId, postHash, reactionType: 'like' };
  if (hubUrl) body.hubUrl = hubUrl;
  await api.post(Api.Wallet, '/social/react', body);
}

// ─── Hub management ──────────────────────────────────────────────────

export async function fetchPrimaryHubUrl(): Promise<string> {
  const res = await api.get<{ hubUrl?: string }>(Api.Wallet, '/agent-hub/default');
  const hubUrl = typeof res.hubUrl === 'string' ? res.hubUrl.trim() : '';
  return hubUrl;
}

export async function fetchHubSubscriptions(agentId: string): Promise<HubSubscriptionInfo[]> {
  const res = await api.get<{ hubs: HubSubscriptionInfo[] }>(Api.Wallet, `/agent-hub/${agentId}/hubs`);
  return res.hubs || [];
}

export async function joinHub(agentId: string, hubUrl: string, label?: string): Promise<HubSubscriptionInfo> {
  const body: Record<string, string> = { hubUrl };
  if (label) body.label = label;
  const res = await api.post<{ hub: HubSubscriptionInfo }>(Api.Wallet, `/agent-hub/${agentId}/join`, body);
  return res.hub;
}

export async function leaveHub(agentId: string, hubUrl: string): Promise<void> {
  await api.post(Api.Wallet, `/agent-hub/${agentId}/leave`, { hubUrl });
}
