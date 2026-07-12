'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Key, CreditCard, FileText, Star, Tag, Lock, Unlock, Plus, RefreshCw, Terminal, ShieldCheck, Archive, Trash2, ChevronRight, Wallet, Globe, Keyboard } from 'lucide-react';
import { Button, DownloadButton } from '@/components/design-system';
import type { AgentInfo, AgentFilters, CategoryFilter, CredentialType } from './types';

type AgentSurface = 'credentials' | 'audit' | 'apiKeys';
type CredentialCreateStart = 'default' | 'type-picker';
type CredentialCreatePrefillType = Exclude<CredentialType, 'api' | 'passkey'>;

interface AgentSidebarProps {
  agents: AgentInfo[];
  filters: AgentFilters;
  categoryCounts: Record<CategoryFilter, number>;
  tags: string[];
  favoritesCount: number;
  onFilterChange: (filters: Partial<AgentFilters>) => void;
  onLock: () => void;
  onLockAgent?: (agentId: string) => void;
  onUnlockAgent?: (agent: AgentInfo) => void;
  onCreateCredential: (start?: CredentialCreateStart, prefillType?: CredentialCreatePrefillType) => void;
  onCreateAgent: (parentAgentId?: string) => void;
  mode?: 'desktop' | 'tablet' | 'mobile';
  onNavigate?: () => void;
  notifications?: unknown[];
  onDismissNotification?: (id: string) => void;
  pendingActionCount?: number;
  surface?: AgentSurface;
  onSurfaceChange?: (surface: AgentSurface) => void;
  onSettings?: () => void;
  onDeleteAgent?: (agent: AgentInfo) => void;
}

const categories: { key: CategoryFilter; label: string; icon: React.FC<{ size: number; className?: string }> }[] = [
  { key: 'all', label: 'All Credentials', icon: Layers },
  { key: 'login', label: 'Logins', icon: Key },
  { key: 'sso', label: 'SSO Logins', icon: Globe },
  { key: 'card', label: 'Cards', icon: CreditCard },
  { key: 'plain_note', label: 'Plain Notes', icon: FileText },
  { key: 'note', label: 'Secret Notes', icon: FileText },
  { key: 'hot_wallet', label: 'Hot Wallets', icon: Wallet },
  { key: 'oauth2', label: 'OAuth2', icon: RefreshCw },
  { key: 'ssh', label: 'SSH Keys', icon: Terminal },
  { key: 'gpg', label: 'GPG Keys', icon: ShieldCheck },
];

const CATEGORY_CREATE_TYPE: Partial<Record<CategoryFilter, CredentialCreatePrefillType>> = {
  login: 'login',
  sso: 'sso',
  card: 'card',
  plain_note: 'plain_note',
  note: 'note',
  hot_wallet: 'hot_wallet',
  oauth2: 'oauth2',
  ssh: 'ssh',
  gpg: 'gpg',
};

const lifecycleFilters: {
  key: AgentFilters['lifecycle'];
  label: string;
  icon: React.FC<{ size: number; className?: string }>;
}[] = [
  { key: 'archive', label: 'Archived', icon: Archive },
  { key: 'recently_deleted', label: 'Recently Deleted', icon: Trash2 },
];

const KEYBOARD_SHORTCUTS: Array<{ combo: string; action: string }> = [
  { combo: 'Cmd/Ctrl + K', action: 'Focus search' },
  { combo: '/', action: 'Focus search (while not typing)' },
  { combo: 'Cmd/Ctrl + Alt + N', action: 'Create new credential' },
  { combo: '↑ / ↓', action: 'Navigate list selection' },
  { combo: 'Enter', action: 'Open selected credential' },
];

type SidebarSectionKey = 'agents' | 'categories' | 'favorites' | 'tags' | 'lifecycle';

type SidebarSectionState = Record<SidebarSectionKey, boolean>;
type AgentNodeCollapseState = Record<string, boolean>;

const SIDEBAR_SECTION_STORAGE_KEY = 'auramaxx:agent-sidebar-collapsible-sections';
const SIDEBAR_AGENT_NODE_STORAGE_KEY = 'auramaxx:agent-sidebar-collapsed-agent-nodes';

const DEFAULT_SECTION_STATE: SidebarSectionState = {
  agents: false,
  categories: true,
  favorites: true,
  tags: true,
  lifecycle: true,
};

function normalizeSectionState(input: unknown): SidebarSectionState | null {
  if (!input || typeof input !== 'object') return null;

  return {
    agents: Boolean((input as Partial<SidebarSectionState>).agents),
    categories: Boolean((input as Partial<SidebarSectionState>).categories),
    favorites: Boolean((input as Partial<SidebarSectionState>).favorites),
    tags: Boolean((input as Partial<SidebarSectionState>).tags),
    lifecycle: Boolean((input as Partial<SidebarSectionState>).lifecycle),
  };
}

function normalizeAgentNodeState(input: unknown): AgentNodeCollapseState | null {
  if (!input || typeof input !== 'object') return null;
  const next: AgentNodeCollapseState = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!key) continue;
    next[key] = Boolean(value);
  }
  return next;
}

type RenderedAgentEntry = {
  agent: AgentInfo;
  depth: number;
};

function getParentAgentId(agent: AgentInfo): string | undefined {
  return agent.parentAgentId || agent.linkedTo;
}

function buildRenderedAgentEntries(agents: AgentInfo[]): RenderedAgentEntry[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const byOrder = new Map(agents.map((agent, index) => [agent.id, index]));
  const childrenByParent = new Map<string, AgentInfo[]>();

  for (const agent of agents) {
    const parentAgentId = getParentAgentId(agent);
    if (!parentAgentId || !byId.has(parentAgentId) || parentAgentId === agent.id) continue;
    const bucket = childrenByParent.get(parentAgentId) || [];
    bucket.push(agent);
    childrenByParent.set(parentAgentId, bucket);
  }

  const sortByInputOrder = (a: AgentInfo, b: AgentInfo) => {
    return (byOrder.get(a.id) || 0) - (byOrder.get(b.id) || 0);
  };
  for (const children of childrenByParent.values()) {
    children.sort(sortByInputOrder);
  }

  const roots = agents
    .filter((agent) => {
      const parentAgentId = getParentAgentId(agent);
      return !parentAgentId || !byId.has(parentAgentId) || parentAgentId === agent.id;
    })
    .sort(sortByInputOrder);

  const ordered: RenderedAgentEntry[] = [];
  const visited = new Set<string>();
  const walk = (agent: AgentInfo, depth: number) => {
    if (visited.has(agent.id)) return;
    visited.add(agent.id);
    ordered.push({ agent, depth });
    for (const child of childrenByParent.get(agent.id) || []) {
      walk(child, depth + 1);
    }
  };

  for (const root of roots) {
    walk(root, 0);
  }
  for (const agent of [...agents].sort(sortByInputOrder)) {
    walk(agent, 0);
  }
  return ordered;
}

function buildTreeMaps(agents: AgentInfo[]) {
  const parentByChild = new Map<string, string>();
  const childCountByParent = new Map<string, number>();

  for (const agent of agents) {
    const parent = getParentAgentId(agent);
    if (!parent || parent === agent.id) continue;
    parentByChild.set(agent.id, parent);
    childCountByParent.set(parent, (childCountByParent.get(parent) || 0) + 1);
  }

  return { parentByChild, childCountByParent };
}

export const AgentSidebar: React.FC<AgentSidebarProps> = ({
  agents,
  filters,
  categoryCounts,
  tags,
  favoritesCount,
  onFilterChange,
  onLock,
  onLockAgent,
  onUnlockAgent,
  onCreateCredential,
  onCreateAgent,
  mode = 'desktop',
  onNavigate,
  notifications = [],
  onDismissNotification,
  pendingActionCount = 0,
  surface = 'credentials',
  onSurfaceChange,
  onSettings,
  onDeleteAgent,
}) => {
  const isCompact = mode === 'tablet';
  const sidebarWidth = mode === 'tablet'
    ? 'calc(48px * var(--ui-scale-factor, 1))'
    : mode === 'mobile'
      ? 'calc(220px * var(--ui-scale-factor, 1))'
      : 'calc(200px * var(--ui-scale-factor, 1))';
  const createDisabled = filters.lifecycle !== 'active';
  const renderedAgents = useMemo(() => buildRenderedAgentEntries(agents), [agents]);
  const { parentByChild, childCountByParent } = useMemo(() => buildTreeMaps(agents), [agents]);
  const [collapsedSections, setCollapsedSections] = useState<SidebarSectionState>(DEFAULT_SECTION_STATE);
  const [sectionStateHydrated, setSectionStateHydrated] = useState(false);
  const [collapsedAgentNodes, setCollapsedAgentNodes] = useState<AgentNodeCollapseState>({});
  const [nodeStateHydrated, setNodeStateHydrated] = useState(false);
  const [shortcutPopoverOpen, setShortcutPopoverOpen] = useState(false);
  const [installedVersion, setInstalledVersion] = useState<string>('unknown');
  const shortcutPopoverRef = useRef<HTMLDivElement | null>(null);
  const versionLabel = installedVersion && installedVersion !== 'unknown'
    ? `v${installedVersion.replace(/^v/i, '')}`
    : 'vunknown';

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_SECTION_STORAGE_KEY);
      if (!raw) return;
      const parsed = normalizeSectionState(JSON.parse(raw));
      if (!parsed) return;
      setCollapsedSections(parsed);
    } catch {
      // Ignore malformed localStorage payloads and use defaults.
    } finally {
      setSectionStateHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!sectionStateHydrated) return;
    try {
      window.localStorage.setItem(SIDEBAR_SECTION_STORAGE_KEY, JSON.stringify(collapsedSections));
    } catch {
      // Ignore localStorage failures (private mode / quota).
    }
  }, [collapsedSections, sectionStateHydrated]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_AGENT_NODE_STORAGE_KEY);
      if (!raw) return;
      const parsed = normalizeAgentNodeState(JSON.parse(raw));
      if (!parsed) return;
      setCollapsedAgentNodes(parsed);
    } catch {
      // Ignore malformed localStorage payloads and use defaults.
    } finally {
      setNodeStateHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!nodeStateHydrated) return;
    try {
      window.localStorage.setItem(SIDEBAR_AGENT_NODE_STORAGE_KEY, JSON.stringify(collapsedAgentNodes));
    } catch {
      // Ignore localStorage failures.
    }
  }, [collapsedAgentNodes, nodeStateHydrated]);

  useEffect(() => {
    const selectedAgentId = filters.agentId;
    if (!selectedAgentId) return;
    const ancestors: string[] = [];
    let cursor = parentByChild.get(selectedAgentId);
    while (cursor) {
      ancestors.push(cursor);
      cursor = parentByChild.get(cursor);
    }
    if (ancestors.length === 0) return;
    setCollapsedAgentNodes((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of ancestors) {
        if (next[id]) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [filters.agentId, parentByChild]);

  useEffect(() => {
    let cancelled = false;

    const loadVersion = async () => {
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json() as { success?: boolean; current?: string };
        if (!data.success) return;
        const current = typeof data.current === 'string' ? data.current.trim() : '';
        if (!current) return;
        if (!cancelled) setInstalledVersion(current);
      } catch {
        // Ignore version fetch errors and keep unknown fallback.
      }
    };

    void loadVersion();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!shortcutPopoverOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (shortcutPopoverRef.current && !shortcutPopoverRef.current.contains(target)) {
        setShortcutPopoverOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShortcutPopoverOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [shortcutPopoverOpen]);

  const visibleRenderedAgents = useMemo(() => {
    const hiddenAncestorStack: string[] = [];
    const visible: RenderedAgentEntry[] = [];

    for (const entry of renderedAgents) {
      while (hiddenAncestorStack.length > entry.depth) hiddenAncestorStack.pop();
      if (hiddenAncestorStack.length > 0) continue;
      visible.push(entry);
      if (collapsedAgentNodes[entry.agent.id]) hiddenAncestorStack.push(entry.agent.id);
    }
    return visible;
  }, [renderedAgents, collapsedAgentNodes]);

  const toggleSection = (section: SidebarSectionKey) => {
    setCollapsedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const toggleAgentNode = (agentId: string) => {
    setCollapsedAgentNodes((prev) => ({ ...prev, [agentId]: !prev[agentId] }));
  };

  const handleSectionToggleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    section: SidebarSectionKey,
  ) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleSection(section);
  };

  const handleFilterAction = (partial: Partial<AgentFilters>) => {
    onSurfaceChange?.('credentials');
    onFilterChange(partial);
    onNavigate?.();
  };

  const handleCreateCredential = (
    start: CredentialCreateStart = 'default',
    prefillType?: CredentialCreatePrefillType,
  ) => {
    onSurfaceChange?.('credentials');
    if (prefillType) {
      onCreateCredential(start, prefillType);
    } else {
      onCreateCredential(start);
    }
    onNavigate?.();
  };

  const handleCreateAgent = (parentAgentId?: string) => {
    onSurfaceChange?.('credentials');
    onCreateAgent(parentAgentId);
    onNavigate?.();
  };

  const handleLock = () => {
    onLock();
    onNavigate?.();
  };

  const handleOpenAudit = () => {
    onSurfaceChange?.('audit');
    onNavigate?.();
  };

  const handleOpenApiKeys = () => {
    onSurfaceChange?.('apiKeys');
    onNavigate?.();
  };

  const renderSectionToggle = (section: SidebarSectionKey, label: string, className = '') => (
    <button
      type="button"
      onClick={() => toggleSection(section)}
      onKeyDown={(event) => handleSectionToggleKeyDown(event, section)}
      aria-expanded={!collapsedSections[section]}
      aria-controls={`agent-sidebar-section-${section}`}
      aria-label={`${label} section`}
      className={`w-full flex items-center transition-colors hover:bg-[var(--color-background-alt,#f4f4f5)] ${isCompact ? 'justify-center py-1' : 'justify-between px-2 py-1'} ${className}`}
      title={`${label} section`}
    >
      {!isCompact && (
        <span className="text-[8px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] font-bold">
          {label}
        </span>
      )}
      <ChevronRight
        size={10}
        className={`text-[var(--color-text-faint,#9ca3af)] transition-transform ${collapsedSections[section] ? '' : 'rotate-90'}`}
      />
    </button>
  );

  return (
    <div
      className="h-full flex flex-col border-r border-[var(--color-border,#d4d4d8)] font-mono relative overflow-hidden shrink-0"
      style={{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        background: 'var(--color-surface, #f4f4f2)',
        fontSize: 'var(--font-size-sm)',
      }}
    >
      {/* Subtle dot texture (matches WalletSidebar) */}
      <div className="absolute inset-0 opacity-[0.02] pointer-events-none bg-[radial-gradient(var(--color-text,#000)_1px,transparent_1px)] bg-[size:4px_4px]" />

      {/* Header */}
      <div className={`flex items-center justify-between border-b border-[var(--color-border,#d4d4d8)] relative z-10 ${isCompact ? 'px-2 py-2' : 'px-3 py-3'}`}>
        <div className={`flex items-center ${isCompact ? 'justify-center w-full' : 'gap-2'}`}>
          {!isCompact && (
            <div className="leading-tight">
              <div className="flex items-baseline gap-1">
                <span
                  data-testid="agent-sidebar-header-brand"
                  className="text-[10px] font-bold tracking-tight lowercase text-[var(--color-text,#0a0a0a)]"
                >
                  auramaxx
                </span>
                <span className="text-[8px] text-[var(--color-text-muted,#6b7280)] uppercase tracking-widest">from</span>
              </div>
              <a
                href="https://x.com/nicoletteduclar"
                target="_blank"
                rel="noopener noreferrer"
                className="block text-[8px] text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
              >
                @nicoletteduclar, with love
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden relative z-10">
      {/* Agent list */}
      <div className="border-b border-[var(--color-border,#d4d4d8)]">
        {renderSectionToggle('agents', 'Agents')}
        {!collapsedSections.agents && (
          <div
            id="agent-sidebar-section-agents"
            className={`${isCompact ? 'px-1 pb-2' : 'px-2 pb-2'} overflow-x-hidden`}
          >
            <div
              className={`flex items-center ${isCompact ? 'gap-1' : 'gap-1.5'}`}
              style={{
                borderLeft: filters.agentId === null ? '2px solid var(--color-accent, #ccff00)' : '2px solid transparent',
              }}
            >
              <button
                onClick={() => handleFilterAction({ agentId: null, lifecycle: 'active', tag: null })}
                className={`flex-1 flex items-center transition-colors hover:bg-[var(--color-background-alt,#f4f4f5)] ${isCompact ? 'justify-center px-1 py-1.5' : 'gap-2 px-2 py-1.5 text-left'}`}
                title="All Agents (Active)"
              >
                {isCompact ? (
                  <Layers size={11} className="text-[var(--color-text-muted,#6b7280)]" />
                ) : (
                  <span className="text-[9px] tracking-widest uppercase text-[var(--color-text,#0a0a0a)] font-bold">
                    All Agents
                  </span>
                )}
              </button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLock}
                className={isCompact ? '!px-0 !h-6 !w-6' : '!px-1.5 !h-6'}
                title="Lock all agents"
              >
                <Lock size={10} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleCreateAgent()}
                className={isCompact ? '!px-0 !h-6 !w-6' : '!px-1.5 !h-6'}
                title="Create agent"
              >
                <Plus size={10} />
              </Button>
            </div>
            {visibleRenderedAgents.map(({ agent, depth }) => {
              const displayName = agent.name || (agent.isPrimary ? 'Primary' : `Agent ${agent.id.slice(0, 6)}`);
              const isTopLevel = !getParentAgentId(agent);
              const canLockTopLevel = isTopLevel && !agent.isPrimary && agent.isUnlocked && Boolean(onLockAgent);
              const hasChildren = (childCountByParent.get(agent.id) || 0) > 0;
              const parentId = parentByChild.get(agent.id);
              const parentName = parentId ? (agents.find((v) => v.id === parentId)?.name || parentId.slice(0, 6)) : null;
              const isAgentActive = filters.agentId === agent.id;

              return (
                <div
                  key={agent.id}
                  className="w-full min-w-0 flex items-center group"
                  style={{
                    borderLeft: isAgentActive ? '2px solid var(--color-accent, #ccff00)' : '2px solid transparent',
                  }}
                >
                  <div className="ml-0.5 flex items-center">
                    {hasChildren ? (
                      <button
                        type="button"
                        data-testid={`agent-toggle-${agent.id}`}
                        aria-label={`Toggle children for ${displayName}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleAgentNode(agent.id);
                        }}
                        className="w-5 h-5 flex items-center justify-center text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)]"
                      >
                        <ChevronRight size={9} className={`transition-transform ${collapsedAgentNodes[agent.id] ? '' : 'rotate-90'}`} />
                      </button>
                    ) : (
                      <span className="w-5" />
                    )}
                  </div>
                  <button
                    data-testid={`agent-item-${agent.id}`}
                    data-agent-depth={depth}
                    onClick={() => {
                      if (!agent.isUnlocked) {
                        onUnlockAgent?.(agent);
                        return;
                      }
                      handleFilterAction({ agentId: agent.id });
                    }}
                    className={`flex-1 min-w-0 flex items-center transition-colors hover:bg-[var(--color-background-alt,#f4f4f5)] ${isCompact ? 'justify-center py-1.5 pr-1' : 'gap-2 py-1.5 pr-2 text-left'}`}
                    style={{
                      paddingLeft: isCompact
                        ? `${Math.max(2, 2 + depth * 4)}px`
                        : `${8 + depth * 12}px`,
                    }}
                    title={displayName}
                  >
                    {isCompact ? (
                      <div className="flex items-center gap-1">
                        <div className="w-4 h-4 border border-[var(--color-border,#d4d4d8)] rounded-full flex items-center justify-center text-[7px] uppercase text-[var(--color-text-muted,#6b7280)]">
                          {(agent.name || 'V').slice(0, 1)}
                        </div>
                        {agent.isUnlocked ? (
                          <Unlock size={8} className="text-[var(--color-text-muted,#6b7280)]" />
                        ) : (
                          <Lock size={8} className="text-[var(--color-text-faint,#9ca3af)]" />
                        )}
                      </div>
                    ) : (
                      <>
                        {depth > 0 && (
                          <span data-testid={`agent-lineage-${agent.id}`} className="text-[8px] text-[var(--color-text-faint,#9ca3af)]" title={parentName ? `Child of ${parentName}` : 'Child agent'}>
                            ↳
                          </span>
                        )}
                        <span className="min-w-0 flex-1 text-[9px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] truncate">
                          {displayName}
                        </span>
                        <span
                          className="shrink-0 text-[8px] text-[var(--color-text-faint,#9ca3af)] tabular-nums"
                          title={`${agent.credentialCount ?? 0} credentials`}
                        >
                          {agent.credentialCount ?? 0}
                        </span>
                      </>
                    )}
                  </button>
                  {!isCompact && (
                    <div className="mr-1 flex items-center gap-0.5">
                      {canLockTopLevel && (
                        <button
                          type="button"
                          data-testid={`agent-status-lock-${agent.id}`}
                          title={agent.isPrimary ? 'Lock all agents' : `Lock agent ${displayName}`}
                          aria-label={agent.isPrimary ? 'Lock all agents' : `Lock agent ${displayName}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (agent.isPrimary) {
                              handleLock();
                              return;
                            }
                            onLockAgent?.(agent.id);
                          }}
                          className="w-5 h-5 flex items-center justify-center text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Lock size={9} />
                        </button>
                      )}
                      {onDeleteAgent && (
                        <button
                          type="button"
                          title={`Delete agent ${displayName}`}
                          aria-label={`Delete agent ${displayName}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onDeleteAgent(agent);
                          }}
                          className="w-5 h-5 flex items-center justify-center text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                        >
                          <Trash2 size={9} />
                        </button>
                      )}
                      {/* Vault row + button intentionally disabled; keep create agent on All Agents row only. */}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Categories */}
      <div className="border-b border-[var(--color-border,#d4d4d8)]">
        {renderSectionToggle('categories', 'Categories')}
        {!collapsedSections.categories && (
          <div
            id="agent-sidebar-section-categories"
            className={isCompact ? 'px-1 pb-2' : 'px-2 pb-2'}
          >
            {categories.map(({ key, label, icon: Icon }) => {
              const showCreateCredential = true;
              return (
                <div key={key} className="w-full flex items-center gap-1 group">
                  <button
                    onClick={() => handleFilterAction({ category: key })}
                    className={`${showCreateCredential ? 'flex-1 min-w-0' : 'w-full'} flex items-center transition-colors hover:bg-[var(--color-background-alt,#f4f4f5)] ${isCompact ? 'justify-center px-1 py-1.5' : 'gap-2 px-2 py-1.5 text-left'}`}
                    style={{
                      borderLeft: filters.category === key ? '2px solid var(--color-accent, #ccff00)' : '2px solid transparent',
                    }}
                    title={label}
                  >
                    <Icon size={11} className={filters.category === key ? 'text-[var(--color-text,#0a0a0a)]' : 'text-[var(--color-text-muted,#6b7280)]'} />
                    {!isCompact && (
                      <>
                        <span className={`text-[9px] tracking-widest uppercase flex-1 ${filters.category === key ? 'text-[var(--color-text,#0a0a0a)] font-bold' : 'text-[var(--color-text-muted,#6b7280)]'}`}>
                          {label}
                        </span>
                        <span className="text-[8px] text-[var(--color-text-faint,#9ca3af)]">
                          {categoryCounts[key]}
                        </span>
                      </>
                    )}
                  </button>
                  {showCreateCredential && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const createType = CATEGORY_CREATE_TYPE[key];
                        if (createType) {
                          handleCreateCredential('default', createType);
                          return;
                        }
                        handleCreateCredential('type-picker');
                      }}
                      className={`${isCompact ? '!px-0 !h-6 !w-6' : '!px-1.5 !h-6'} opacity-100`}
                      title={createDisabled ? `Click All Credentials to return to Active and create ${label}` : `Create ${label}`}
                      disabled={createDisabled}
                    >
                      <Plus size={10} />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Favorites */}
      <div className="border-b border-[var(--color-border,#d4d4d8)]">
        {renderSectionToggle('favorites', 'Favorites')}
        {!collapsedSections.favorites && (
          <div
            id="agent-sidebar-section-favorites"
            className={isCompact ? 'px-1 pb-2' : 'px-2 pb-2'}
          >
            <button
              onClick={() => handleFilterAction({ favoritesOnly: !filters.favoritesOnly })}
              className={`w-full flex items-center transition-colors hover:bg-[var(--color-background-alt,#f4f4f5)] ${isCompact ? 'justify-center px-1 py-1.5' : 'gap-2 px-2 py-1.5 text-left'}`}
              style={{
                borderLeft: filters.favoritesOnly ? '2px solid var(--color-accent, #ccff00)' : '2px solid transparent',
              }}
              title="Favorites"
            >
              <Star
                size={11}
                className={filters.favoritesOnly ? 'text-[var(--color-favorite,#ff4d00)]' : 'text-[var(--color-text-muted,#6b7280)]'}
                style={filters.favoritesOnly ? { fill: 'var(--color-favorite,#ff4d00)', color: 'var(--color-favorite,#ff4d00)' } : undefined}
              />
              {!isCompact && (
                <>
                  <span className={`text-[9px] tracking-widest uppercase flex-1 ${filters.favoritesOnly ? 'text-[var(--color-text,#0a0a0a)] font-bold' : 'text-[var(--color-text-muted,#6b7280)]'}`}>
                    Favorites
                  </span>
                  <span className="text-[8px] text-[var(--color-text-faint,#9ca3af)]">
                    {favoritesCount}
                  </span>
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Tags */}
      {!isCompact && tags.length > 0 && (
        <div className="border-b border-[var(--color-border,#d4d4d8)]">
          {renderSectionToggle('tags', 'Tags')}
          {!collapsedSections.tags && (
            <div id="agent-sidebar-section-tags" className="px-2 pb-2 overflow-y-auto">
              {tags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => handleFilterAction({ tag: filters.tag === tag ? null : tag })}
                  className="w-full flex items-center gap-2 px-2 py-1 text-left transition-colors hover:bg-[var(--color-background-alt,#f4f4f5)]"
                  style={{
                    borderLeft: filters.tag === tag ? '2px solid var(--color-accent, #ccff00)' : '2px solid transparent',
                  }}
                >
                  <Tag size={9} className={filters.tag === tag ? 'text-[var(--color-text,#0a0a0a)]' : 'text-[var(--color-text-faint,#9ca3af)]'} />
                  <span className={`text-[9px] tracking-widest uppercase truncate ${filters.tag === tag ? 'text-[var(--color-text,#0a0a0a)] font-bold' : 'text-[var(--color-text-muted,#6b7280)]'}`}>
                    {tag}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Lifecycle */}
      {!isCompact && (
        <div className="border-b border-[var(--color-border,#d4d4d8)]">
          {renderSectionToggle('lifecycle', 'Lifecycle')}
          {!collapsedSections.lifecycle && (
            <div id="agent-sidebar-section-lifecycle" className="px-2 pb-2">
              {lifecycleFilters.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => handleFilterAction({ lifecycle: key, tag: null })}
                  className="w-full flex items-center gap-2 px-2 py-1 text-left transition-colors hover:bg-[var(--color-background-alt,#f4f4f5)]"
                  style={{
                    borderLeft: filters.lifecycle === key ? '2px solid var(--color-accent, #ccff00)' : '2px solid transparent',
                  }}
                >
                  <Icon size={9} className={filters.lifecycle === key ? 'text-[var(--color-text,#0a0a0a)]' : 'text-[var(--color-text-faint,#9ca3af)]'} />
                  <span className={`text-[9px] tracking-widest uppercase truncate ${filters.lifecycle === key ? 'text-[var(--color-text,#0a0a0a)] font-bold' : 'text-[var(--color-text-muted,#6b7280)]'}`}>
                    {label}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      </div>{/* end scrollable content */}

      {/* Bottom */}
      <div className={`border-t border-[var(--color-border,#d4d4d8)] ${isCompact ? 'px-1 py-2' : 'px-3 py-3'}`}>
        {pendingActionCount > 0 && (
          <div className={`flex items-center gap-1.5 mb-2 ${isCompact ? 'justify-center' : 'px-1'}`}>
            <span
              className="min-w-[16px] h-[16px] flex items-center justify-center px-1 font-mono text-[8px] font-bold"
              style={{
                background: 'var(--color-danger, #ef4444)',
                color: 'var(--color-danger-foreground, #ffffff)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {pendingActionCount > 9 ? '9+' : pendingActionCount}
            </span>
            {!isCompact && (
              <span className="font-mono text-[8px] font-bold tracking-widest uppercase text-[var(--color-danger,#ef4444)]">
                PENDING
              </span>
            )}
          </div>
        )}
        {isCompact && (
          <div className="mb-2 flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleOpenApiKeys}
              icon={<Key size={10} />}
              className="flex-1 !px-0"
              title="API Keys"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLock}
              icon={<Lock size={10} />}
              className="flex-1 !px-0"
              title="Lock"
            />
          </div>
        )}
        {!isCompact && (
          <div className="flex items-center gap-2 mt-2 justify-center">
            <button
              type="button"
              onClick={handleOpenAudit}
              className={`text-[8px] tracking-widest uppercase transition-colors ${
                surface === 'audit'
                  ? 'text-[var(--color-text,#0a0a0a)] font-bold'
                  : 'text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)]'
              }`}
              aria-current={surface === 'audit' ? 'page' : undefined}
            >
              AUDIT
            </button>
            <button
              type="button"
              onClick={handleOpenApiKeys}
              className={`text-[8px] tracking-widest uppercase transition-colors ${
                surface === 'apiKeys'
                  ? 'text-[var(--color-text,#0a0a0a)] font-bold'
                  : 'text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)]'
              }`}
              aria-current={surface === 'apiKeys' ? 'page' : undefined}
            >
              API KEYS
            </button>
            <button
              type="button"
              onClick={handleLock}
              className="text-[8px] tracking-widest uppercase transition-colors text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)]"
            >
              LOCK
            </button>
          </div>
        )}
        <div
          className={`flex items-center gap-2 ${isCompact ? 'mt-2' : 'mt-3'}`}
          data-testid="agent-sidebar-footer-barcode"
        >
          <div className="h-4 flex-1 bg-[repeating-linear-gradient(90deg,var(--color-text,#000),var(--color-text,#000)_1px,transparent_1px,transparent_3px)] opacity-30" />
          {!isCompact && (
            <span
              data-testid="sidebar-version-label"
              className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest"
              title={`AuraMaxx ${versionLabel}`}
            >
              {versionLabel}
            </span>
          )}
          {!isCompact && (
            <div className="relative" ref={shortcutPopoverRef}>
              <button
                type="button"
                data-testid="shortcut-hint-trigger"
                onClick={() => setShortcutPopoverOpen((prev) => !prev)}
                className="inline-flex h-5 w-5 items-center justify-center border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#ffffff)] text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
                aria-expanded={shortcutPopoverOpen ? 'true' : 'false'}
                aria-label="Keyboard shortcuts"
                title="Keyboard shortcuts"
              >
                <Keyboard size={10} />
              </button>
              {shortcutPopoverOpen && (
                <div
                  data-testid="shortcut-hint-popover"
                  className="absolute bottom-full right-0 mb-1 border border-[var(--color-border-focus,#0a0a0a)] bg-[var(--color-surface,#ffffff)] shadow-mech z-30 p-2 w-[170px]"
                >
                  <div className="text-[8px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)] mb-1">Keyboard Shortcuts</div>
                  <div className="space-y-1">
                    {KEYBOARD_SHORTCUTS.map((shortcut) => (
                      <div key={shortcut.combo} className="flex items-center justify-between gap-2">
                        <span className="text-[8px] tracking-widest uppercase text-[var(--color-text,#0a0a0a)]">{shortcut.combo}</span>
                        <span className="text-[8px] text-[var(--color-text-muted,#6b7280)]">{shortcut.action}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
