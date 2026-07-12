'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Rss,
  FileText,
  Users,
  UserPlus,
  BarChart3,
  Globe,
  Heart,
  Trash2,
  Loader2,
  Send,
} from 'lucide-react';
import {
  type AgentProfile,
  type FollowerItem,
  type FollowingItem,
  type GlobalFeedItem,
  type InboundMessageItem,
  type SocialAgentInfo,
  type SocialMessageItem,
  type SyncStatus,
  fetchGlobalFeed,
  fetchSocialAgents,
  fetchSocialFeed,
  fetchSocialFollowers,
  fetchSocialFollowing,
  fetchSocialPosts,
  fetchPrimaryHubUrl,
  fetchSocialProfile,
  fetchSocialStatus,
  likeSocialPost,
  removeSocialPost,
  submitPostLocalFirst,
} from '@/lib/social-client';
import { ViewShell } from '@/components/layout/ViewShell';
import { AgentPicker, AgentPfp } from '@/components/AgentPicker';
import { CreateAgentModal } from '@/components/CreateAgentModal';
import { Button, Modal, TextAreaInput } from '@/components/design-system';

// ─── Types ───────────────────────────────────────────────────────────

type SidebarTab = 'feed' | 'discover' | 'posts' | 'followers' | 'following' | 'status';

// ─── Helpers ─────────────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
  // timestamps are in seconds
  const date = new Date(ts * 1000);
  const now = Date.now();
  const diff = now - date.getTime();

  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleDateString();
}

function parseBody(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

const DEFAULT_AGENT_AVATAR = 'https://aurawallet.sh/agent7.png';

// ─── Styles ──────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--color-border, #d4d4d8)',
  borderRadius: 0,
  padding: '14px 16px',
  background: 'var(--color-surface, #ffffff)',
  borderBottom: 'none',
};

const mutedText: React.CSSProperties = {
  fontSize: '10px',
  color: 'var(--color-text-muted, #6b7280)',
  fontFamily: 'var(--font-mono, monospace)',
  letterSpacing: '0.02em',
};

const accentText: React.CSSProperties = {
  fontWeight: 600,
  fontFamily: 'var(--font-mono, monospace)',
  color: 'var(--color-text, #0a0a0a)',
};

// ─── Sidebar Tab Button ─────────────────────────────────────────────

const TABS: { key: SidebarTab; label: string; icon: React.ComponentType<{ size: number }> }[] = [
  { key: 'discover', label: 'Global', icon: Globe },
  { key: 'feed', label: 'For You', icon: Rss },
  { key: 'posts', label: 'My Posts', icon: FileText },
  { key: 'followers', label: 'Followers', icon: Users },
  { key: 'following', label: 'Following', icon: UserPlus },
  { key: 'status', label: 'Sync Status', icon: BarChart3 },
];

function TabButton({
  tab,
  isActive,
  onClick,
  badge,
}: {
  tab: (typeof TABS)[number];
  isActive: boolean;
  onClick: () => void;
  badge?: number;
}) {
  const Icon = tab.icon;
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        padding: '8px 12px',
        borderRadius: '8px',
        border: 'none',
        background: isActive ? 'var(--color-accent, #6366f1)' : 'transparent',
        color: isActive ? 'var(--color-accent-foreground, #ffffff)' : 'var(--color-text, #0a0a0a)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '12px',
        textAlign: 'left',
        transition: 'all 0.1s ease',
        marginBottom: '2px',
      }}
    >
      <Icon size={14} />
      <span style={{ fontWeight: 500, flex: 1 }}>{tab.label}</span>
      {badge != null && badge > 0 && (
        <span
          style={{
            minWidth: '16px',
            height: '16px',
            padding: '0 4px',
            borderRadius: '8px',
            background: isActive ? 'rgba(255,255,255,0.3)' : 'var(--color-accent, #6366f1)',
            color: isActive ? '#fff' : 'var(--color-accent-foreground, #ffffff)',
            fontSize: '10px',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-mono, monospace)',
          }}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

// ─── Post Card ───────────────────────────────────────────────────────

function PostCard({
  authorLabel,
  authorDisplayName,
  authorHandle,
  authorPfp,
  authorPfpIsSprite,
  text,
  timestamp,
  hash,
  hubUrl,
  syncStatus,
  isOwn,
  agentId,
  onDeleted,
  onLiked,
}: {
  authorLabel: string;
  authorDisplayName?: string;
  authorHandle?: string;
  authorPfp?: string;
  authorPfpIsSprite?: boolean;
  text: string;
  timestamp: number;
  hash: string;
  hubUrl?: string;
  syncStatus?: string;
  isOwn: boolean;
  agentId: string;
  onDeleted?: (hash: string) => void;
  onLiked?: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [liking, setLiking] = useState(false);

  const handleDelete = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await removeSocialPost(agentId, hash, hubUrl);
      onDeleted?.(hash);
    } catch {
      // ignore
    } finally {
      setDeleting(false);
    }
  }, [agentId, hash, hubUrl, deleting, onDeleted]);

  const handleLike = useCallback(async () => {
    if (liking) return;
    setLiking(true);
    try {
      await likeSocialPost(agentId, hash, hubUrl);
      onLiked?.();
    } catch {
      // ignore
    } finally {
      setLiking(false);
    }
  }, [agentId, hash, hubUrl, liking, onLiked]);

  return (
    <div style={cardStyle}>
      {/* Author row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
        <AgentPfp
          src={authorPfp}
          isSprite={authorPfpIsSprite}
          fallbackLetter={authorLabel[0] === '#' ? authorLabel[1] : authorLabel[0]}
          size="md"
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
            <span style={{ ...accentText, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {authorDisplayName || authorHandle || authorLabel}
            </span>
            {authorHandle && authorDisplayName && (
              <span style={{ ...mutedText, fontSize: '10px' }}>@{authorHandle}</span>
            )}
            {!authorDisplayName && !authorHandle && (
              <span style={{ ...mutedText, fontSize: '10px' }}>{authorLabel}</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ ...mutedText, fontSize: '9px' }}>{formatTimestamp(timestamp)}</span>
          </div>
        </div>
        {syncStatus && (
          <span
            style={{
              ...mutedText,
              fontSize: '9px',
              padding: '2px 6px',
              border: '1px solid',
              borderColor: syncStatus === 'accepted' ? '#166534' : syncStatus === 'pending' ? '#92400e' : '#991b1b',
              color: syncStatus === 'accepted' ? '#166534' : syncStatus === 'pending' ? '#92400e' : '#991b1b',
              textTransform: 'uppercase',
            }}
          >
            {syncStatus}
          </span>
        )}
      </div>

      {/* Body */}
      <div style={{
        fontSize: '13px',
        color: 'var(--color-text, #0a0a0a)',
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        paddingLeft: '32px',
      }}>
        {text}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '10px', paddingLeft: '32px' }}>
        {!isOwn && (
          <button
            onClick={handleLike}
            disabled={liking}
            style={{
              padding: '2px 8px',
              fontSize: '9px',
              fontFamily: 'var(--font-mono, monospace)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              borderRadius: 0,
              border: '1px solid var(--color-border, #d4d4d8)',
              background: 'transparent',
              color: 'var(--color-text-muted, #6b7280)',
              cursor: liking ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              transition: 'border-color 0.1s',
            }}
          >
            <Heart size={9} />
            {liking ? '...' : 'Like'}
          </button>
        )}
        {isOwn && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              padding: '2px 8px',
              fontSize: '9px',
              fontFamily: 'var(--font-mono, monospace)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              borderRadius: 0,
              border: '1px solid var(--color-border, #d4d4d8)',
              background: 'transparent',
              color: '#ef4444',
              cursor: deleting ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <Trash2 size={9} />
            {deleting ? '...' : 'Delete'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function SocialView({ activeHubUrl }: { activeHubUrl?: string }) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('feed');
  const [agents, setAgents] = useState<SocialAgentInfo[]>([]);
  const [agentId, setAgentId] = useState<string>('');
  const [primaryHubUrl, setPrimaryHubUrl] = useState<string>('');
  const [agentProfiles, setAgentProfiles] = useState<Record<string, AgentProfile>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showPostModal, setShowPostModal] = useState(false);
  const [postText, setPostText] = useState('');
  const [postError, setPostError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  // Data for each tab
  const [feedItems, setFeedItems] = useState<InboundMessageItem[]>([]);
  const [globalFeed, setGlobalFeed] = useState<GlobalFeedItem[]>([]);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [myPosts, setMyPosts] = useState<SocialMessageItem[]>([]);
  const [followers, setFollowers] = useState<FollowerItem[]>([]);
  const [following, setFollowing] = useState<FollowingItem[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [tabLoading, setTabLoading] = useState(false);

  // Revision counter to force refresh
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((r) => r + 1), []);

  // Search
  const [searchValue, setSearchValue] = useState('');
  const effectiveHubUrl = primaryHubUrl || activeHubUrl;

  // Social always targets the primary hub from settings (`social.hub_url`).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hubUrl = await fetchPrimaryHubUrl();
        if (!cancelled) setPrimaryHubUrl(hubUrl);
      } catch {
        // Fall back to caller-provided hub URL when defaults route is unavailable.
        if (!cancelled) setPrimaryHubUrl('');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filteredFeed = useMemo(() => {
    if (!searchValue.trim()) return feedItems;
    const q = searchValue.toLowerCase();
    return feedItems.filter((item) => {
      const body = parseBody(item.body);
      return (body.text as string)?.toLowerCase().includes(q) || String(item.authorAuraId).includes(q);
    });
  }, [feedItems, searchValue]);

  const filteredPosts = useMemo(() => {
    if (!searchValue.trim()) return myPosts;
    const q = searchValue.toLowerCase();
    return myPosts.filter((item) => {
      const body = parseBody(item.body);
      return (body.text as string)?.toLowerCase().includes(q);
    });
  }, [myPosts, searchValue]);

  const filteredGlobalFeed = useMemo(() => {
    if (!searchValue.trim()) return globalFeed;
    const q = searchValue.toLowerCase();
    return globalFeed.filter((item) =>
      item.text?.toLowerCase().includes(q) || String(item.authorAuraId).includes(q),
    );
  }, [globalFeed, searchValue]);

  const filteredFollowers = useMemo(() => {
    if (!searchValue.trim()) return followers;
    const q = searchValue.toLowerCase();
    return followers.filter((f) => String(f.authorAuraId).includes(q));
  }, [followers, searchValue]);

  const filteredFollowing = useMemo(() => {
    if (!searchValue.trim()) return following;
    const q = searchValue.toLowerCase();
    return following.filter((f) => String(f.auraId).includes(q));
  }, [following, searchValue]);

  // Load agents on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loadedAgents = await fetchSocialAgents();
        if (cancelled) return;
        setAgents(loadedAgents);
        if (loadedAgents.length > 0) {
          const defaultAgentId = loadedAgents.find((agent) => agent.isPrimary)?.id ?? loadedAgents[0].id;
          setAgentId(defaultAgentId);
        }
      } catch {
        if (!cancelled) setError('Failed to load agents');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const refreshAgents = useCallback(async () => {
    try {
      const loadedAgents = await fetchSocialAgents();
      setAgents(loadedAgents);
      if (loadedAgents.length === 0) return;
      setAgentId((current) => {
        if (current && loadedAgents.some((agent) => agent.id === current)) return current;
        return loadedAgents.find((agent) => agent.isPrimary)?.id ?? loadedAgents[0].id;
      });
    } catch { /* silent */ }
  }, []);

  // Load tab data when agentId or tab changes
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setTabLoading(true);

    (async () => {
      try {
        switch (activeTab) {
          case 'feed': {
            const nextFeed = await fetchSocialFeed(agentId, effectiveHubUrl);
            if (!cancelled) setFeedItems(nextFeed);
            break;
          }
          case 'posts': {
            const nextPosts = await fetchSocialPosts(agentId, effectiveHubUrl);
            if (!cancelled) setMyPosts(nextPosts);
            break;
          }
          case 'followers': {
            const nextFollowers = await fetchSocialFollowers(agentId, effectiveHubUrl);
            if (!cancelled) setFollowers(nextFollowers);
            break;
          }
          case 'following': {
            const nextFollowing = await fetchSocialFollowing(agentId, effectiveHubUrl);
            if (!cancelled) setFollowing(nextFollowing);
            break;
          }
          case 'status': {
            const nextStatus = await fetchSocialStatus(agentId, effectiveHubUrl);
            if (!cancelled) setSyncStatus(nextStatus);
            break;
          }
        }
      } catch {
        // individual tab errors are non-fatal
      } finally {
        if (!cancelled) setTabLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [agentId, activeTab, revision, effectiveHubUrl]);

  // Load global feed when discover tab is selected (no agentId dependency)
  useEffect(() => {
    if (activeTab !== 'discover') return;
    let cancelled = false;
    setGlobalLoading(true);

    (async () => {
      try {
        const result = await fetchGlobalFeed(undefined, effectiveHubUrl);
        if (!cancelled) setGlobalFeed(result.items);
      } catch {
        // non-fatal
      } finally {
        if (!cancelled) setGlobalLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [activeTab, revision, effectiveHubUrl]);

  useEffect(() => {
    if (!agentId || agentProfiles[agentId]) return;
    let cancelled = false;

    (async () => {
      try {
        const profile = await fetchSocialProfile(agentId);
        if (cancelled) return;
        setAgentProfiles((prev) => ({ ...prev, [agentId]: profile }));
      } catch {
        if (cancelled) return;
        setAgentProfiles((prev) => (
          prev[agentId]
            ? prev
            : {
                ...prev,
                [agentId]: {
                  pfp: DEFAULT_AGENT_AVATAR,
                  handle: '',
                  displayName: '',
                },
              }
        ));
      }
    })();

    return () => { cancelled = true; };
  }, [agentId, agentProfiles]);

  const handleSubmitPost = useCallback(async (text: string) => {
    if (!agentId) return;

    const { localMessage, submit } = submitPostLocalFirst(agentId, text, effectiveHubUrl);
    setMyPosts((prev) => [localMessage, ...prev.filter((item) => item.id !== localMessage.id)]);

    try {
      const persisted = await submit;
      setMyPosts((prev) => [
        persisted,
        ...prev.filter((item) => item.id !== localMessage.id && item.id !== persisted.id),
      ]);
      refresh();
    } catch (error) {
      setMyPosts((prev) => prev.map((item) => (
        item.id === localMessage.id
          ? { ...item, syncStatus: 'failed' }
          : item
      )));
      throw error;
    }
  }, [agentId, refresh, effectiveHubUrl]);

  const handleClosePostModal = useCallback(() => {
    if (posting) return;
    setShowPostModal(false);
    setPostError(null);
  }, [posting]);

  const handlePostFromModal = useCallback(async () => {
    const normalized = postText.trim();
    if (!normalized || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      await handleSubmitPost(normalized);
      setPostText('');
      setShowPostModal(false);
      setActiveTab('posts');
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'Post failed');
    } finally {
      setPosting(false);
    }
  }, [handleSubmitPost, postText, posting]);

  // Only parent agents (no child / linked agents) — must be before early returns
  const parentAgents = useMemo(() => agents.filter(a => !a.parentAgentId), [agents]);
  const primaryAgentId = useMemo(() => agents.find(a => a.isPrimary)?.id, [agents]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Loader2 size={20} className="animate-spin" style={{ color: 'var(--color-text-muted, #6b7280)' }} />
      </div>
    );
  }

  // ─── Sidebar content ───

  const sidebarContent = (
    <div style={{ padding: '8px' }}>
      <Button
        variant="primary"
        size="sm"
        icon={<Send size={12} />}
        disabled={!agentId}
        onClick={() => {
          setPostError(null);
          setShowPostModal(true);
        }}
        className="w-full mb-2"
      >
        NEW POST
      </Button>
      {/* Tabs */}
      {TABS.map((tab) => (
        <TabButton
          key={tab.key}
          tab={tab}
          isActive={tab.key === activeTab}
          onClick={() => setActiveTab(tab.key)}
          badge={undefined}
        />
      ))}
    </div>
  );

  const sidebarFooter = (
    <div style={{ background: 'var(--color-background-alt, #f4f4f5)' }}>
      <AgentPicker
        agents={parentAgents}
        profiles={agentProfiles}
        selectedId={agentId || null}
        onSelect={setAgentId}
        onCreateAgent={() => setShowCreateAgent(true)}
        direction="up"
      />
    </div>
  );

  // ─── Main content ───

  const ownProfile = agentId ? agentProfiles[agentId] : undefined;

  const mainContent = (
    <div style={{ padding: '24px 32px' }}>
      <div style={{ maxWidth: '600px', border: '1px solid var(--color-border, #d4d4d8)', borderBottom: 'none' }}>
        {error && (
          <div style={{ ...cardStyle, color: '#ef4444', fontSize: '12px', borderBottom: '1px solid var(--color-border, #d4d4d8)' }}>{error}</div>
        )}

        {(tabLoading || globalLoading) ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '32px', borderBottom: '1px solid var(--color-border, #d4d4d8)' }}>
            <Loader2 size={16} className="animate-spin" style={{ color: 'var(--color-text-muted, #6b7280)' }} />
          </div>
        ) : (
          <>
            {/* Discover tab */}
            {activeTab === 'discover' && (
              filteredGlobalFeed.length === 0 ? (
                <div style={{ ...mutedText, textAlign: 'center', padding: '32px', borderBottom: '1px solid var(--color-border, #d4d4d8)' }}>
                  No posts to discover yet.
                </div>
              ) : (
                filteredGlobalFeed.map((item) => {
                  const p = item.authorProfile;
                  const pfp = p?.pfp || DEFAULT_AGENT_AVATAR;
                  return (
                    <PostCard
                      key={item.postHash}
                      authorLabel={`#${item.authorAuraId}`}
                      authorDisplayName={p?.displayName || undefined}
                      authorHandle={p?.handle || undefined}
                      authorPfp={pfp}
                      authorPfpIsSprite={p?.pfpIsSprite ?? /\/agent\d+\.png$/.test(pfp)}
                      text={item.text || ''}
                      timestamp={item.updatedTs}
                      hash={item.postHash}
                      hubUrl={effectiveHubUrl}
                      isOwn={false}
                      agentId={agentId}
                      onLiked={agentId ? refresh : undefined}
                    />
                  );
                })
              )
            )}

            {/* Feed tab */}
            {activeTab === 'feed' && (
              filteredFeed.length === 0 ? (
                <div style={{ ...mutedText, textAlign: 'center', padding: '32px', borderBottom: '1px solid var(--color-border, #d4d4d8)' }}>
                  No posts in your feed yet. Follow some agents to see their posts here.
                </div>
              ) : (
                filteredFeed.map((item) => {
                  const body = parseBody(item.body);
                  const isOwn = item.authorAuraId <= 0;
                  return (
                    <PostCard
                      key={item.id}
                      authorLabel={isOwn ? 'You' : `#${item.authorAuraId}`}
                      authorDisplayName={isOwn ? ownProfile?.displayName : undefined}
                      authorHandle={isOwn ? ownProfile?.handle : undefined}
                      authorPfp={isOwn ? (ownProfile?.pfp || DEFAULT_AGENT_AVATAR) : undefined}
                      authorPfpIsSprite={isOwn ? (ownProfile?.pfpIsSprite ?? /\/agent\d+\.png$/.test(ownProfile?.pfp || DEFAULT_AGENT_AVATAR)) : undefined}
                      text={(body.text as string) || ''}
                      timestamp={item.timestamp}
                      hash={item.hash}
                      hubUrl={effectiveHubUrl}
                      isOwn={isOwn}
                      agentId={agentId}
                      onLiked={refresh}
                    />
                  );
                })
              )
            )}

            {/* My Posts tab */}
            {activeTab === 'posts' && (
              filteredPosts.length === 0 ? (
                <div style={{ ...mutedText, textAlign: 'center', padding: '32px', borderBottom: '1px solid var(--color-border, #d4d4d8)' }}>
                  No posts yet. Write your first post above.
                </div>
              ) : (
                filteredPosts.map((item) => {
                  const body = parseBody(item.body);
                  return (
                    <PostCard
                      key={item.id}
                      authorLabel="You"
                      authorDisplayName={ownProfile?.displayName}
                      authorHandle={ownProfile?.handle}
                      authorPfp={ownProfile?.pfp || DEFAULT_AGENT_AVATAR}
                      authorPfpIsSprite={ownProfile?.pfpIsSprite ?? /\/agent\d+\.png$/.test(ownProfile?.pfp || DEFAULT_AGENT_AVATAR)}
                      text={(body.text as string) || ''}
                      timestamp={item.timestamp}
                      hash={item.hash}
                      hubUrl={effectiveHubUrl}
                      syncStatus={item.syncStatus}
                      isOwn={true}
                      agentId={agentId}
                      onDeleted={(removedHash) => {
                        setMyPosts((prev) => prev.filter((post) => post.hash !== removedHash));
                        refresh();
                      }}
                    />
                  );
                })
              )
            )}

            {/* Followers tab */}
            {activeTab === 'followers' && (
              filteredFollowers.length === 0 ? (
                <div style={{ ...mutedText, textAlign: 'center', padding: '32px', borderBottom: '1px solid var(--color-border, #d4d4d8)' }}>
                  No followers yet.
                </div>
              ) : (
                <>
                  <div style={{ ...mutedText, padding: '8px 16px', borderBottom: '1px solid var(--color-border, #d4d4d8)' }}>{filteredFollowers.length} follower{filteredFollowers.length !== 1 ? 's' : ''}</div>
                  {filteredFollowers.map((f) => (
                    <div key={f.id} style={{ ...cardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ ...accentText, fontSize: '12px' }}>#{f.authorAuraId}</span>
                      <span style={mutedText}>{formatTimestamp(f.timestamp)}</span>
                    </div>
                  ))}
                </>
              )
            )}

            {/* Following tab */}
            {activeTab === 'following' && (
              filteredFollowing.length === 0 ? (
                <div style={{ ...mutedText, textAlign: 'center', padding: '32px', borderBottom: '1px solid var(--color-border, #d4d4d8)' }}>
                  Not following anyone yet.
                </div>
              ) : (
                <>
                  <div style={{ ...mutedText, padding: '8px 16px', borderBottom: '1px solid var(--color-border, #d4d4d8)' }}>Following {filteredFollowing.length} agent{filteredFollowing.length !== 1 ? 's' : ''}</div>
                  {filteredFollowing.map((f) => (
                    <div key={f.auraId} style={{ ...cardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ ...accentText, fontSize: '12px' }}>#{f.auraId}</span>
                      <span style={mutedText}>{formatTimestamp(f.timestamp)}</span>
                    </div>
                  ))}
                </>
              )
            )}

            {/* Sync Status tab */}
            {activeTab === 'status' && (
              syncStatus ? (
                <div style={{ ...cardStyle, borderBottom: '1px solid var(--color-border, #d4d4d8)' }}>
                  <div style={{ fontSize: '10px', fontWeight: 600, marginBottom: '12px', fontFamily: 'var(--font-mono, monospace)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-muted, #6b7280)' }}>
                    Sync Status
                  </div>
                  <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
                    <tbody>
                      {(Object.entries(syncStatus) as [string, number][]).map(([key, val]) => (
                        <tr key={key} style={{ borderTop: '1px solid var(--color-border, #d4d4d8)' }}>
                          <td style={{ padding: '6px 0', fontFamily: 'var(--font-mono, monospace)', fontSize: '11px', color: 'var(--color-text-muted, #6b7280)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{key}</td>
                          <td style={{ padding: '6px 0', textAlign: 'right', fontFamily: 'var(--font-mono, monospace)', fontWeight: 600, fontSize: '11px' }}>{val}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ ...mutedText, textAlign: 'center', padding: '32px', borderBottom: '1px solid var(--color-border, #d4d4d8)' }}>
                  No sync data available.
                </div>
              )
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <ViewShell
      sidebar={sidebarContent}
      sidebarFooter={sidebarFooter}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      searchPlaceholder="Search posts, followers..."
      contentClassName="scrollbar-tyvek"
    >
      {mainContent}

      <Modal
        isOpen={showPostModal}
        onClose={handleClosePostModal}
        title="Create Post"
        size="sm"
        footer={(
          <div className="flex gap-2 justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleClosePostModal}
              disabled={posting}
            >
              CANCEL
            </Button>
            <Button
              size="sm"
              loading={posting}
              disabled={!postText.trim()}
              icon={<Send size={12} />}
              onClick={handlePostFromModal}
            >
              POST
            </Button>
          </div>
        )}
      >
        <div className="space-y-3">
          <TextAreaInput
            label="Post"
            placeholder="What's happening?"
            value={postText}
            onChange={(e) => setPostText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handlePostFromModal();
              }
            }}
            hint="Cmd/Ctrl+Enter to post"
            autoFocus
          />
          <div style={{ ...mutedText, fontSize: '10px' }}>
            {postText.length > 0 ? `${postText.length} chars` : 'Click Post to publish'}
          </div>
          {postError && (
            <div style={{ fontSize: '11px', color: '#ef4444' }}>{postError}</div>
          )}
        </div>
      </Modal>

      <CreateAgentModal
        isOpen={showCreateAgent}
        onClose={() => setShowCreateAgent(false)}
        onCreated={(newId) => {
          refreshAgents();
          if (newId) setAgentId(newId);
        }}
        primaryAgentId={primaryAgentId}
      />
    </ViewShell>
  );
}
