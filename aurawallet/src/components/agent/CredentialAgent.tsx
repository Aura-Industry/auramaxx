'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Menu, Clock3, Search } from 'lucide-react';
import { api, Api, getWalletBaseUrl, unlockWallet } from '@/lib/api';
import { encryptPassword } from '@/lib/crypto';
import { CREDENTIAL_FIELD_SCHEMA } from '@/lib/credential-field-schema';
import { Modal, TextInput, Button, Drawer, FilterDropdown } from '@/components/design-system';
import { AgentSidebar } from './AgentSidebar';
import { CredentialList } from './CredentialList';
import { CredentialDetail } from './CredentialDetail';
import { CredentialEmpty } from './CredentialEmpty';
import { CredentialForm } from './CredentialForm';
import { ImportCredentialsModal } from './ImportCredentialsModal';
import { PasswordGenerator } from './PasswordGenerator';
import { AuditConsole } from './AuditConsole';
import { ApiKeysConsole } from './ApiKeysConsole';
import { useAgentKeyboardShortcuts } from './hooks/useAgentKeyboardShortcuts';
import { sortCredentialsForList } from './credentialListSort';
import { getCredentialDisplayName } from './credentialDisplayName';
import { HumanActionBar } from '@/components/HumanActionBar';
import { useAgentActions } from '@/hooks/useAgentActions';
import { useWebSocket } from '@/context/WebSocketContext';
import { useAuth } from '@/context/AuthContext';
import {
  WALLET_EVENTS,
  type WalletEvent,
  type CredentialAccessedData,
  type CredentialChangedData,
} from '@/lib/events';
import type {
  CredentialMeta,
  CredentialLifecycleFilter,
  CredentialWithLocation,
  AgentInfo,
  AgentFilters,
} from './types';

interface CredentialAgentProps {
  onLock: () => void;
  onSettings?: () => void;
}

type ViewportMode = 'desktop' | 'tablet' | 'mobile';
type AgentSurface = 'credentials' | 'audit' | 'apiKeys';
type CreateCredentialStart = 'api-key-form' | 'type-picker';
type CreatePrefill = {
  agentId?: string;
  tags?: string[];
  type?: 'login' | 'card' | 'sso' | 'note' | 'plain_note' | 'hot_wallet' | 'apikey' | 'oauth2' | 'ssh' | 'gpg' | 'custom';
  name?: string;
  noteContent?: string;
};

type ParsedSearchQuery = {
  terms: string[];
  tagFilters: string[];
  typeFilters: string[];
  agentFilters: string[];
  fieldFilters: Array<{ key: string; value: string }>;
  lifecycleFilters: Set<CredentialLifecycleFilter>;
  favoriteOnly: boolean;
};

const DEFAULT_FILTERS: AgentFilters = {
  agentId: null,
  category: 'all',
  tag: null,
  search: '',
  favoritesOnly: false,
  lifecycle: 'active',
};

const AGENT_MODE_OPTIONS: { value: 'linked' | 'independent'; label: string }[] = [
  { value: 'linked', label: 'Child (inherits parent unlock)' },
  { value: 'independent', label: 'Independent (separate password)' },
];

const RECENT_ACCESS_STORAGE_KEY = 'auramaxx_recently_accessed_credentials';
const LATEST_ACCESS_STORAGE_KEY = 'auramaxx_credentials_latest_access_at';
const RECENT_ACCESS_MAX = 8;
const SEARCH_FIELD_PRIORITY = [
  'username',
  'url',
  'content',
  'key',
  'value',
  'cardholder',
  'brand',
  'last4',
  'website',
  'provider',
  'identifier',
  'token_endpoint',
  'scopes',
  'fingerprint',
] as const;
const LIFECYCLE_TOKEN_MAP: Record<string, CredentialLifecycleFilter> = {
  active: 'active',
  archive: 'archive',
  archived: 'archive',
  deleted: 'recently_deleted',
  recently_deleted: 'recently_deleted',
  recentlydeleted: 'recently_deleted',
};

const FIELD_ALIAS_TO_CANONICAL = (() => {
  const lookup = new Map<string, string>();
  const schemaEntries = Object.values(CREDENTIAL_FIELD_SCHEMA);
  for (const fields of schemaEntries) {
    for (const field of fields) {
      lookup.set(field.key.toLowerCase(), field.key);
      for (const alias of field.aliases || []) {
        lookup.set(alias.toLowerCase(), field.key);
      }
    }
  }
  return lookup;
})();

const DEFAULT_SEARCH_FIELD_KEYS = (() => {
  const fromSchema = Array.from(FIELD_ALIAS_TO_CANONICAL.values());
  const ordered = [...SEARCH_FIELD_PRIORITY, ...fromSchema];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const key of ordered) {
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(key);
  }
  return unique.slice(0, 8);
})();

function getViewportMode(width: number): ViewportMode {
  if (width < 768) return 'mobile';
  if (width < 1280) return 'tablet';
  return 'desktop';
}

function getAgentParentId(agent: AgentInfo): string | undefined {
  return agent.parentAgentId || agent.linkedTo;
}

function collectAgentSubtreeIds(rootAgentId: string, agents: AgentInfo[]): string[] {
  const childrenByParent = new Map<string, AgentInfo[]>();
  for (const agent of agents) {
    const parentAgentId = getAgentParentId(agent);
    if (!parentAgentId) continue;
    const bucket = childrenByParent.get(parentAgentId) || [];
    bucket.push(agent);
    childrenByParent.set(parentAgentId, bucket);
  }

  const orderedIds: string[] = [];
  const queue: string[] = [rootAgentId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    orderedIds.push(current);
    for (const child of childrenByParent.get(current) || []) {
      queue.push(child.id);
    }
  }

  return orderedIds;
}

function deriveCredentialLifecycle(credential: { location?: CredentialLifecycleFilter; archivedAt?: string; deletedAt?: string }): CredentialLifecycleFilter {
  if (credential.location) return credential.location;
  if (credential.deletedAt) return 'recently_deleted';
  if (credential.archivedAt) return 'archive';
  return 'active';
}

function credentialCreatedAtTimestamp(credential: { createdAt?: string }): number {
  const createdAtMs = credential.createdAt ? Date.parse(credential.createdAt) : Number.NaN;
  return Number.isFinite(createdAtMs) ? createdAtMs : 0;
}

function effectiveCredentialAccessTimestamp(
  credential: { id: string; createdAt?: string },
  latestAccessById: Record<string, number>,
): number {
  const latestAccess = latestAccessById[credential.id];
  if (typeof latestAccess === 'number' && Number.isFinite(latestAccess) && latestAccess > 0) {
    return latestAccess;
  }
  return credentialCreatedAtTimestamp(credential);
}

function buildAccessMapForCredentials(
  credentials: Array<{ id: string; createdAt?: string }>,
  previous: Record<string, number>,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const credential of credentials) {
    const known = previous[credential.id];
    if (typeof known === 'number' && Number.isFinite(known) && known > 0) {
      next[credential.id] = known;
      continue;
    }
    next[credential.id] = credentialCreatedAtTimestamp(credential);
  }
  return next;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function toSearchString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).toLowerCase();
  }
  if (Array.isArray(value)) {
    return value.map(toSearchString).join(' ');
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).map(toSearchString).join(' ');
  }
  return '';
}

function normalizeFieldKeyToken(rawKey: string): string {
  const key = rawKey.trim().toLowerCase().replace(/\s+/g, '_');
  return FIELD_ALIAS_TO_CANONICAL.get(key) || key;
}

function parseSearchQuery(raw: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = {
    terms: [],
    tagFilters: [],
    typeFilters: [],
    agentFilters: [],
    fieldFilters: [],
    lifecycleFilters: new Set<CredentialLifecycleFilter>(),
    favoriteOnly: false,
  };

  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const normalized = normalizeToken(token);
    if (normalized === 'favorite' || normalized === 'favourite' || normalized === 'fav') {
      parsed.favoriteOnly = true;
      continue;
    }

    const lifecycleFromBareToken = LIFECYCLE_TOKEN_MAP[normalized];
    if (lifecycleFromBareToken) {
      parsed.lifecycleFilters.add(lifecycleFromBareToken);
      continue;
    }

    const separatorIndex = token.indexOf(':');
    if (separatorIndex <= 0) {
      parsed.terms.push(normalized);
      continue;
    }

    const keyToken = normalizeToken(token.slice(0, separatorIndex));
    const valueToken = token.slice(separatorIndex + 1).trim();
    const normalizedValue = normalizeToken(valueToken);
    if (!normalizedValue) continue;

    if (keyToken === 'tag') {
      parsed.tagFilters.push(normalizedValue);
      continue;
    }
    if (keyToken === 'type') {
      parsed.typeFilters.push(normalizedValue);
      continue;
    }
    if (keyToken === 'agent') {
      parsed.agentFilters.push(normalizedValue);
      continue;
    }
    if (keyToken === 'lifecycle' || keyToken === 'location') {
      const lifecycleValue = LIFECYCLE_TOKEN_MAP[normalizedValue];
      if (lifecycleValue) parsed.lifecycleFilters.add(lifecycleValue);
      continue;
    }
    if (keyToken === 'favorite' || keyToken === 'fav') {
      parsed.favoriteOnly = !['false', '0', 'no'].includes(normalizedValue);
      continue;
    }

    parsed.fieldFilters.push({
      key: normalizeFieldKeyToken(keyToken),
      value: normalizedValue,
    });
  }

  return parsed;
}

function credentialMatchesField(credential: CredentialMeta, fieldKey: string, needle: string): boolean {
  const normalizedFieldKey = normalizeFieldKeyToken(fieldKey);
  const entries = Object.entries(credential.meta || {});
  for (const [rawKey, rawValue] of entries) {
    const key = normalizeFieldKeyToken(rawKey);
    if (key !== normalizedFieldKey) continue;
    if (toSearchString(rawValue).includes(needle)) return true;
  }
  return false;
}

export const CredentialAgent: React.FC<CredentialAgentProps> = ({
  onLock,
  onSettings,
}) => {
  const { subscribe } = useWebSocket();

  // Core state
  const [credentials, setCredentials] = useState<CredentialWithLocation[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<AgentFilters>(DEFAULT_FILTERS);
  const [loading, setLoading] = useState(true);
  const [surface, setSurface] = useState<AgentSurface>('credentials');
  // Persisted "latest accessed" values (updated on click/read).
  const [latestAccessById, setLatestAccessById] = useState<Record<string, number>>({});
  // Snapshot used by list ordering so rows do not jump while user is interacting.
  const [latestAccessByIdForList, setLatestAccessByIdForList] = useState<Record<string, number>>({});
  const [searchDockOpen, setSearchDockOpen] = useState(false);
  const [searchDockFocused, setSearchDockFocused] = useState(false);

  // Viewport + mobile interactions
  const [viewportMode, setViewportMode] = useState<ViewportMode>(() => {
    if (typeof window === 'undefined') return 'desktop';
    return getViewportMode(window.innerWidth);
  });
  const { clearToken, setToken } = useAuth();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  // Modal flags
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createCredentialStart, setCreateCredentialStart] = useState<CreateCredentialStart>('api-key-form');
  const [createPrefill, setCreatePrefill] = useState<CreatePrefill | null>(null);
  const [editCredentialId, setEditCredentialId] = useState<string | null>(null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentMode, setNewAgentMode] = useState<'linked' | 'independent'>('independent');
  const [newAgentParentId, setNewAgentParentId] = useState('');
  const [newAgentPassword, setNewAgentPassword] = useState('');
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importTargetAgentId, setImportTargetAgentId] = useState('');
  const [pendingImportAgentAutoSelect, setPendingImportAgentAutoSelect] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [unlockAgentTarget, setUnlockAgentTarget] = useState<AgentInfo | null>(null);
  const [unlockAgentPassword, setUnlockAgentPassword] = useState('');
  const [unlockingAgent, setUnlockingAgent] = useState(false);
  const [unlockAgentError, setUnlockAgentError] = useState<string | null>(null);
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<AgentInfo | null>(null);
  const [deletingAgent, setDeletingAgent] = useState(false);
  const [deleteAgentError, setDeleteAgentError] = useState<string | null>(null);

  // Agent actions (approvals + notifications)
  const {
    requests,
    notifications,
    dismissNotification,
    resolveAction,
    revokeToken = async () => false,
    activeTokens = [],
    inactiveTokens = [],
    actionLoading,
  } = useAgentActions({ autoFetch: true });

  // Refs for keyboard navigation
  const searchRef = useRef<HTMLInputElement>(null);
  const searchDockRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchDockCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isMobile = viewportMode === 'mobile';
  const isTablet = viewportMode === 'tablet';

  // Fetch data
  const fetchData = useCallback(async () => {
    try {
      const [activeRes, archiveRes, deletedRes, agentRes] = await Promise.all([
        api.get<{ success: boolean; credentials: CredentialMeta[] }>(Api.Wallet, '/credentials', {
          location: 'active',
        }),
        api.get<{ success: boolean; credentials: CredentialMeta[] }>(Api.Wallet, '/credentials', {
          location: 'archive',
        }),
        api.get<{ success: boolean; credentials: CredentialMeta[] }>(Api.Wallet, '/credentials', {
          location: 'recently_deleted',
        }),
        api.get<{ success: boolean; agents: AgentInfo[] }>(Api.Wallet, '/agents/credential'),
      ]);

      const withLocation = (
        source: { success: boolean; credentials?: CredentialMeta[] },
        location: CredentialLifecycleFilter,
      ): CredentialWithLocation[] => (source.success ? (source.credentials || []).map((credential) => ({
        ...credential,
        location,
      })) : []);

      const mergedCredentials = [
        ...withLocation(activeRes, 'active'),
        ...withLocation(archiveRes, 'archive'),
        ...withLocation(deletedRes, 'recently_deleted'),
      ];
      setCredentials(mergedCredentials);
      setLatestAccessById((previous) => buildAccessMapForCredentials(mergedCredentials, previous));
      setLatestAccessByIdForList((previous) => buildAccessMapForCredentials(mergedCredentials, previous));
      if (agentRes.success) setAgents(agentRes.agents);
    } catch (err) {
      console.error('[CredentialAgent] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const hydrated: Record<string, number> = {};

      const rawLatestAccess = window.localStorage.getItem(LATEST_ACCESS_STORAGE_KEY);
      if (rawLatestAccess) {
        const parsedLatestAccess = JSON.parse(rawLatestAccess);
        if (parsedLatestAccess && typeof parsedLatestAccess === 'object' && !Array.isArray(parsedLatestAccess)) {
          for (const [credentialId, value] of Object.entries(parsedLatestAccess as Record<string, unknown>)) {
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
              hydrated[credentialId] = value;
            }
          }
        }
      }

      const rawLegacyRecent = window.localStorage.getItem(RECENT_ACCESS_STORAGE_KEY);
      if (rawLegacyRecent) {
        const parsedLegacyRecent = JSON.parse(rawLegacyRecent);
        if (Array.isArray(parsedLegacyRecent)) {
          const nowMs = Date.now();
          parsedLegacyRecent
            .filter((value): value is string => typeof value === 'string')
            .slice(0, RECENT_ACCESS_MAX)
            .forEach((credentialId, index) => {
              if (!hydrated[credentialId]) {
                hydrated[credentialId] = nowMs - index;
              }
            });
        }
      }

      setLatestAccessById((previous) => ({ ...previous, ...hydrated }));
      setLatestAccessByIdForList((previous) => ({ ...previous, ...hydrated }));
    } catch {
      // Ignore invalid local storage payloads.
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sanitizedEntries = Object.entries(latestAccessById).filter(([, value]) => (
      typeof value === 'number' && Number.isFinite(value) && value > 0
    ));
    const persistedLatestAccess = Object.fromEntries(sanitizedEntries);
    window.localStorage.setItem(LATEST_ACCESS_STORAGE_KEY, JSON.stringify(persistedLatestAccess));

    const orderedIds = sanitizedEntries
      .sort((a, b) => b[1] - a[1])
      .slice(0, RECENT_ACCESS_MAX)
      .map(([credentialId]) => credentialId);
    window.localStorage.setItem(RECENT_ACCESS_STORAGE_KEY, JSON.stringify(orderedIds));
  }, [latestAccessById]);

  const pushRecentCredential = useCallback((credentialId: string, accessedAtMs = Date.now()) => {
    setLatestAccessById((previous) => {
      const normalizedAccessMs = Number.isFinite(accessedAtMs) && accessedAtMs > 0 ? accessedAtMs : Date.now();
      if (previous[credentialId] === normalizedAccessMs) return previous;
      return {
        ...previous,
        [credentialId]: normalizedAccessMs,
      };
    });
  }, []);

  const scheduleRealtimeRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void fetchData();
    }, 120);
  }, [fetchData]);

  useEffect(() => {
    const unsubscribeChanged = subscribe(WALLET_EVENTS.CREDENTIAL_CHANGED, (event) => {
      const data = (event as WalletEvent).data as CredentialChangedData;
      if (!data?.credentialId) return;
      scheduleRealtimeRefresh();
    });

    const unsubscribeAccessed = subscribe(WALLET_EVENTS.CREDENTIAL_ACCESSED, (event) => {
      const data = (event as WalletEvent).data as CredentialAccessedData;
      if (!data?.credentialId || data.allowed !== true) return;
      pushRecentCredential(data.credentialId);
    });

    return () => {
      unsubscribeChanged();
      unsubscribeAccessed();
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (searchDockCloseTimerRef.current) {
        clearTimeout(searchDockCloseTimerRef.current);
        searchDockCloseTimerRef.current = null;
      }
    };
  }, [scheduleRealtimeRefresh, subscribe, pushRecentCredential]);

  useEffect(() => {
    if (selectedId && !credentials.some((credential) => credential.id === selectedId)) {
      setSelectedId(null);
      setMobileDetailOpen(false);
    }
  }, [credentials, selectedId]);

  useEffect(() => {
    const handleResize = () => setViewportMode(getViewportMode(window.innerWidth));
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!isMobile && !isTablet) {
      setMobileSidebarOpen(false);
      setMobileDetailOpen(false);
    }
  }, [isMobile, isTablet]);

  // Listen for LeftRail hamburger toggle on tablet
  useEffect(() => {
    const handler = () => setMobileSidebarOpen((v) => !v);
    window.addEventListener('leftrail:menu-toggle', handler);
    return () => window.removeEventListener('leftrail:menu-toggle', handler);
  }, []);

  useEffect(() => {
    if (!searchDockOpen) return;

    const handleOutsideClick = (event: Event) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (searchDockRef.current?.contains(target)) return;

      if (searchDockCloseTimerRef.current) {
        clearTimeout(searchDockCloseTimerRef.current);
        searchDockCloseTimerRef.current = null;
      }

      setSearchDockFocused(false);
      setSearchDockOpen(false);
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
    };
  }, [searchDockOpen]);

  const primaryAgentId = useMemo(
    () => agents.find((agent) => agent.isPrimary)?.id || '',
    [agents],
  );

  const parentAgents = useMemo(
    () => agents.filter((agent) => !getAgentParentId(agent)),
    [agents],
  );

  const parentAgentOptions = useMemo(
    () =>
      parentAgents.map((agent) => ({
        value: agent.id,
        label: agent.name || (agent.isPrimary ? 'Primary' : `Agent ${agent.id.slice(0, 6)}`),
      })),
    [parentAgents],
  );

  useEffect(() => {
    if (!showCreateAgent) return;
    setNewAgentParentId((current) => {
      if (current && parentAgentOptions.some((option) => option.value === current)) {
        return current;
      }
      const selectedFilterAgentId = filters.agentId && parentAgentOptions.some((option) => option.value === filters.agentId)
        ? filters.agentId
        : '';
      return selectedFilterAgentId || primaryAgentId || parentAgentOptions[0]?.value || '';
    });
  }, [filters.agentId, parentAgentOptions, primaryAgentId, showCreateAgent]);

  useEffect(() => {
    if (agents.length === 0) {
      setImportTargetAgentId('primary');
      return;
    }
    const defaultImportAgentId = primaryAgentId || agents[0].id || 'primary';
    setImportTargetAgentId((current) => {
      if (current && agents.some((agent) => agent.id === current)) {
        return current;
      }
      return defaultImportAgentId;
    });
  }, [primaryAgentId, agents]);

  // Derived data
  const selectedAgentGroupIds = useMemo<Set<string> | null>(() => {
    if (!filters.agentId) return null;
    const selectedAgent = agents.find((v) => v.id === filters.agentId);
    if (!selectedAgent) return new Set([filters.agentId]);
    return new Set(collectAgentSubtreeIds(selectedAgent.id, agents));
  }, [filters.agentId, agents]);

  const applyAgentGroupFilter = useCallback((items: CredentialMeta[]): CredentialMeta[] => {
    if (!selectedAgentGroupIds) return items;
    return items.filter((credential) => selectedAgentGroupIds.has(credential.agentId));
  }, [selectedAgentGroupIds]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      map.set(agent.id, (agent.name || (agent.isPrimary ? 'Primary' : `Agent ${agent.id.slice(0, 6)}`)).toLowerCase());
    }
    return map;
  }, [agents]);

  const searchState = useMemo(() => {
    const parsed = parseSearchQuery(filters.search);
    const lifecycleOverride = parsed.lifecycleFilters.size > 0;
    const queryTerms = parsed.terms;

    let base = applyAgentGroupFilter(credentials);
    base = lifecycleOverride
      ? base.filter((credential) => parsed.lifecycleFilters.has(deriveCredentialLifecycle(credential)))
      : base.filter((credential) => deriveCredentialLifecycle(credential) === filters.lifecycle);

    if (filters.category !== 'all') {
      base = base.filter((credential) => credential.type === filters.category);
    }

    if (filters.favoritesOnly || parsed.favoriteOnly) {
      base = base.filter((credential) => !!credential.meta.favorite);
    }

    if (filters.tag) {
      const sidebarTag = normalizeToken(filters.tag);
      base = base.filter((credential) => (credential.meta.tags || []).some((tag) => normalizeToken(tag).includes(sidebarTag)));
    }

    if (parsed.tagFilters.length > 0) {
      base = base.filter((credential) => {
        const tags = (credential.meta.tags || []).map((tag) => normalizeToken(tag));
        return parsed.tagFilters.every((tagFilter) => tags.some((tag) => tag.includes(tagFilter)));
      });
    }

    if (parsed.typeFilters.length > 0) {
      base = base.filter((credential) => parsed.typeFilters.some((typeFilter) => normalizeToken(credential.type).includes(typeFilter)));
    }

    if (parsed.agentFilters.length > 0) {
      base = base.filter((credential) => {
        const agentLabel = agentNameById.get(credential.agentId) || normalizeToken(credential.agentId);
        return parsed.agentFilters.every((agentFilter) => (
          agentLabel.includes(agentFilter) || normalizeToken(credential.agentId).includes(agentFilter)
        ));
      });
    }

    const preTextFiltered = base;
    let result = base;

    if (parsed.fieldFilters.length > 0) {
      result = result.filter((credential) => parsed.fieldFilters.every((filter) => (
        credentialMatchesField(credential, filter.key, filter.value)
      )));
    }

    if (queryTerms.length > 0) {
      result = result.filter((credential) => {
        const lifecycle = deriveCredentialLifecycle(credential);
        const tags = (credential.meta.tags || []).map((tag) => normalizeToken(tag)).join(' ');
        const agentLabel = agentNameById.get(credential.agentId) || normalizeToken(credential.agentId);
        const metaContent = toSearchString(credential.meta);
        const searchable = [
          normalizeToken(credential.name),
          normalizeToken(credential.id),
          normalizeToken(credential.type),
          tags,
          agentLabel,
          metaContent,
        ].join(' ');

        return queryTerms.every((term) => {
          if (term === 'favorite' || term === 'favourite' || term === 'fav') return !!credential.meta.favorite;
          const lifecycleFromTerm = LIFECYCLE_TOKEN_MAP[term];
          if (lifecycleFromTerm) return lifecycle === lifecycleFromTerm;
          return searchable.includes(term);
        });
      });
    }

    return {
      parsed,
      preTextFiltered,
      results: result,
    };
  }, [credentials, filters, applyAgentGroupFilter, agentNameById]);

  const filteredCredentials = searchState.results;
  const orderedFilteredCredentials = useMemo(
    () => sortCredentialsForList(filteredCredentials, latestAccessByIdForList, filters.search),
    [filteredCredentials, latestAccessByIdForList, filters.search],
  );

  const searchFieldSuggestions = useMemo(() => {
    const rawQuery = filters.search.trim();
    if (!rawQuery || rawQuery.includes(':')) return [] as string[];
    if (filteredCredentials.length > 0) return [] as string[];

    const normalizedQuery = normalizeToken(rawQuery);
    const hasNameMatch = searchState.preTextFiltered.some((credential) => (
      normalizeToken(credential.name).includes(normalizedQuery)
    ));
    if (hasNameMatch) return [] as string[];

    return DEFAULT_SEARCH_FIELD_KEYS.map((fieldKey) => `${fieldKey}:${rawQuery}`);
  }, [filters.search, filteredCredentials.length, searchState.preTextFiltered]);

  const categoryCounts = useMemo(() => {
    // Counts apply to agent-group filtered (not category/search filtered) credentials
    let base = applyAgentGroupFilter(credentials).filter((credential) => deriveCredentialLifecycle(credential) === filters.lifecycle);
    if (filters.tag) {
      const tag = filters.tag;
      base = base.filter((c) => c.meta.tags?.includes(tag));
    }
    if (filters.favoritesOnly) {
      base = base.filter((c) => c.meta.favorite);
    }
    return {
      all: base.length,
      login: base.filter((c) => c.type === 'login').length,
      card: base.filter((c) => c.type === 'card').length,
      sso: base.filter((c) => c.type === 'sso').length,
      note: base.filter((c) => c.type === 'note').length,
      plain_note: base.filter((c) => c.type === 'plain_note').length,
      hot_wallet: base.filter((c) => c.type === 'hot_wallet').length,
      api: base.filter((c) => c.type === 'api').length,
      apikey: base.filter((c) => c.type === 'apikey').length,
      custom: base.filter((c) => c.type === 'custom').length,
      passkey: base.filter((c) => c.type === 'passkey').length,
      oauth2: base.filter((c) => c.type === 'oauth2').length,
      ssh: base.filter((c) => c.type === 'ssh').length,
      gpg: base.filter((c) => c.type === 'gpg').length,
    };
  }, [credentials, filters.lifecycle, filters.tag, filters.favoritesOnly, applyAgentGroupFilter]);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    applyAgentGroupFilter(credentials)
      .filter((credential) => deriveCredentialLifecycle(credential) === filters.lifecycle)
      .forEach((credential) => credential.meta.tags?.forEach((tag) => tagSet.add(tag)));
    return Array.from(tagSet).sort();
  }, [credentials, filters.lifecycle, applyAgentGroupFilter]);

  const favoritesCount = useMemo(() => {
    const base = applyAgentGroupFilter(credentials).filter((credential) => deriveCredentialLifecycle(credential) === filters.lifecycle);
    return base.filter((c) => c.meta.favorite).length;
  }, [credentials, filters.lifecycle, applyAgentGroupFilter]);

  const selectedCredential = useMemo(
    () => credentials.find((c) => c.id === selectedId) || null,
    [credentials, selectedId],
  );

  const selectedAgentName = useMemo(() => {
    if (!selectedCredential) return '';
    const agent = agents.find((v) => v.id === selectedCredential.agentId);
    if (agent) return agent.name || (agent.isPrimary ? 'Primary' : agent.id.slice(0, 8));
    return selectedCredential.agentId === 'primary'
      ? 'Primary'
      : selectedCredential.agentId.slice(0, 8);
  }, [selectedCredential, agents]);
  const selectedCredentialLifecycle = useMemo<CredentialLifecycleFilter>(
    () => (selectedCredential ? deriveCredentialLifecycle(selectedCredential) : filters.lifecycle),
    [selectedCredential, filters.lifecycle],
  );

  const recentlyAccessedCredentials = useMemo(
    () => [...credentials]
      .sort((a, b) => (
        effectiveCredentialAccessTimestamp(b, latestAccessById)
        - effectiveCredentialAccessTimestamp(a, latestAccessById)
      ))
      .slice(0, RECENT_ACCESS_MAX),
    [credentials, latestAccessById],
  );

  const closeSearchDockSoon = useCallback((delayMs = 120) => {
    if (searchDockCloseTimerRef.current) clearTimeout(searchDockCloseTimerRef.current);
    searchDockCloseTimerRef.current = setTimeout(() => {
      if (!searchDockFocused) setSearchDockOpen(false);
      searchDockCloseTimerRef.current = null;
    }, delayMs);
  }, [searchDockFocused]);

  const unlockAgentDisplayName = useMemo(() => {
    if (!unlockAgentTarget) return 'Agent';
    return unlockAgentTarget.name || (unlockAgentTarget.isPrimary ? 'Primary' : `Agent ${unlockAgentTarget.id.slice(0, 6)}`);
  }, [unlockAgentTarget]);
  const deleteAgentDisplayName = useMemo(() => {
    if (!deleteAgentTarget) return 'Agent';
    return deleteAgentTarget.name || (deleteAgentTarget.isPrimary ? 'Primary' : `Agent ${deleteAgentTarget.id.slice(0, 6)}`);
  }, [deleteAgentTarget]);

  const hasActiveFilters = useMemo(
    () =>
      filters.agentId !== null ||
      filters.category !== 'all' ||
      filters.tag !== null ||
      filters.search.trim() !== '' ||
      filters.favoritesOnly,
    [filters],
  );

  // Handlers
  const handleFilterChange = useCallback((partial: Partial<AgentFilters>) => {
    setFilters((prev) => ({ ...prev, ...partial }));
  }, []);

  const clearAllFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
  }, []);

  const handleLock = useCallback(async () => {
    try {
      await api.post(Api.Wallet, '/lock', {});
    } catch (err) {
      console.error('[CredentialAgent] lock error:', err);
    }
    clearToken();
    onLock();
  }, [onLock, clearToken]);

  const handleOpenUnlockAgent = useCallback((agent: AgentInfo) => {
    setUnlockAgentTarget(agent);
    setUnlockAgentPassword('');
    setUnlockAgentError(null);
  }, []);

  const handleCloseUnlockAgent = useCallback(() => {
    setUnlockAgentTarget(null);
    setUnlockAgentPassword('');
    setUnlockAgentError(null);
  }, []);

  const handleUnlockAgent = useCallback(async () => {
    if (!unlockAgentTarget || !unlockAgentPassword) return;

    setUnlockingAgent(true);
    setUnlockAgentError(null);
    try {
      const result = await unlockWallet(unlockAgentPassword, unlockAgentTarget.id);
      if (result.token) {
        setToken(result.token);
      }
      await fetchData();
      setFilters((prev) => ({
        ...prev,
        agentId: unlockAgentTarget.id,
        lifecycle: 'active',
        tag: null,
      }));
      handleCloseUnlockAgent();
    } catch (err) {
      setUnlockAgentError((err as Error).message || 'Failed to unlock agent');
    } finally {
      setUnlockingAgent(false);
    }
  }, [unlockAgentPassword, unlockAgentTarget, setToken, fetchData, handleCloseUnlockAgent]);

  const handleLockAgent = useCallback(async (agentId: string) => {
    try {
      await api.post(Api.Wallet, `/agents/credential/${encodeURIComponent(agentId)}/lock`, {});
      await fetchData();
    } catch (err) {
      console.error('[CredentialAgent] lock agent error:', err);
    }
  }, [fetchData]);

  const handleOpenDeleteAgent = useCallback((agent: AgentInfo) => {
    setDeleteAgentTarget(agent);
    setDeleteAgentError(null);
  }, []);

  const handleCloseDeleteAgent = useCallback(() => {
    if (deletingAgent) return;
    setDeleteAgentTarget(null);
    setDeleteAgentError(null);
  }, [deletingAgent]);

  const handleDeleteAgent = useCallback(async () => {
    if (!deleteAgentTarget) return;

    setDeletingAgent(true);
    setDeleteAgentError(null);
    try {
      await api.delete(Api.Wallet, `/agents/credential/${encodeURIComponent(deleteAgentTarget.id)}`);
      setFilters((prev) => (prev.agentId === deleteAgentTarget.id ? { ...prev, agentId: null, lifecycle: 'active', tag: null } : prev));
      if (selectedCredential?.agentId === deleteAgentTarget.id) {
        setSelectedId(null);
        setMobileDetailOpen(false);
      }
      await fetchData();
      setDeleteAgentTarget(null);
    } catch (err) {
      setDeleteAgentError((err as Error).message || 'Failed to delete agent');
    } finally {
      setDeletingAgent(false);
    }
  }, [deleteAgentTarget, fetchData, selectedCredential]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    try {
      const location = encodeURIComponent(selectedCredentialLifecycle);
      await api.delete(Api.Wallet, `/credentials/${selectedId}?location=${location}`);
      setSelectedId(null);
      setMobileDetailOpen(false);
      fetchData();
    } catch (err) {
      console.error('[CredentialAgent] delete error:', err);
    }
  }, [selectedId, selectedCredentialLifecycle, fetchData]);

  const handleRestore = useCallback(async () => {
    if (!selectedId || selectedCredentialLifecycle === 'active') return;
    try {
      await api.post(Api.Wallet, `/credentials/${selectedId}/restore`, { from: selectedCredentialLifecycle });
      setSelectedId(null);
      setMobileDetailOpen(false);
      fetchData();
    } catch (err) {
      console.error('[CredentialAgent] restore error:', err);
    }
  }, [selectedId, selectedCredentialLifecycle, fetchData]);

  const handleRestoreAll = useCallback(async () => {
    const archived = filteredCredentials.filter((c) => deriveCredentialLifecycle(c) === 'archive');
    if (archived.length === 0) return;
    try {
      await Promise.all(
        archived.map((c) => api.post(Api.Wallet, `/credentials/${c.id}/restore`, { from: 'archive' })),
      );
      setSelectedId(null);
      setMobileDetailOpen(false);
      fetchData();
    } catch (err) {
      console.error('[CredentialAgent] restore-all error:', err);
    }
  }, [filteredCredentials, fetchData]);

  const handlePurgeAll = useCallback(async () => {
    const archived = filteredCredentials.filter((c) => deriveCredentialLifecycle(c) === 'archive');
    if (archived.length === 0) return;
    try {
      await Promise.all(
        archived.map((c) => api.delete(Api.Wallet, `/credentials/${c.id}?location=archive`)),
      );
      setSelectedId(null);
      setMobileDetailOpen(false);
      fetchData();
    } catch (err) {
      console.error('[CredentialAgent] purge-all error:', err);
    }
  }, [filteredCredentials, fetchData]);

  const handleDuplicate = useCallback(async () => {
    if (!selectedId) return;
    try {
      const res = await api.post<{ success: boolean; credential?: { id: string } }>(Api.Wallet, `/credentials/${selectedId}/duplicate`);
      await fetchData();
      if (res.credential) setSelectedId(res.credential.id);
    } catch (err) {
      console.error('[CredentialAgent] duplicate error:', err);
    }
  }, [selectedId, fetchData]);

  const handleFavoriteChange = useCallback((credentialId: string, favorite: boolean) => {
    setCredentials((previous) => previous.map((credential) => (
      credential.id === credentialId
        ? { ...credential, meta: { ...credential.meta, favorite } }
        : credential
    )));
  }, []);

  const resetCreateAgentDraft = useCallback(() => {
    setNewAgentName('');
    setNewAgentMode('independent');
    setNewAgentParentId('');
    setNewAgentPassword('');
  }, []);

  const handleCloseCreateAgent = useCallback(() => {
    setShowCreateAgent(false);
    setPendingImportAgentAutoSelect(false);
    resetCreateAgentDraft();
  }, [resetCreateAgentDraft]);

  const handleCreateAgent = useCallback(async () => {
    if (!newAgentName.trim()) return;
    if (newAgentMode === 'independent' && newAgentPassword.length < 8) return;
    if (newAgentMode === 'linked' && !newAgentParentId) return;

    setCreatingAgent(true);
    try {
      const payload: Record<string, unknown> = {
        name: newAgentName.trim(),
        mode: newAgentMode,
      };

      if (newAgentMode === 'linked') {
        payload.parentAgentId = newAgentParentId;
      } else {
        const connectRes = await api.get<{ publicKey: string }>(Api.Wallet, '/auth/connect');
        payload.encrypted = await encryptPassword(newAgentPassword, connectRes.publicKey);
      }

      const createResult = await api.post<{ success: boolean; agent?: { id?: string } }>(
        Api.Wallet,
        '/agents/credential',
        payload,
      );
      const createdAgentId = createResult?.agent?.id;
      if (pendingImportAgentAutoSelect && createdAgentId) {
        setImportTargetAgentId(createdAgentId);
      }
      setShowCreateAgent(false);
      setPendingImportAgentAutoSelect(false);
      resetCreateAgentDraft();
      await fetchData();
    } catch (err) {
      console.error('[CredentialAgent] create agent error:', err);
    } finally {
      setCreatingAgent(false);
    }
  }, [
    newAgentName,
    newAgentMode,
    newAgentParentId,
    newAgentPassword,
    pendingImportAgentAutoSelect,
    fetchData,
    resetCreateAgentDraft,
  ]);

  const handleOpenCreateAgent = useCallback((parentAgentId?: string) => {
    if (parentAgentId) {
      setNewAgentMode('linked');
      setNewAgentParentId(parentAgentId);
    } else {
      setNewAgentMode('independent');
      setNewAgentParentId('');
      setNewAgentPassword('');
    }
    setShowCreateAgent(true);
  }, []);

  const handleOpenImportModal = useCallback(() => {
    setImportTargetAgentId(primaryAgentId || agents[0]?.id || 'primary');
    setShowImportModal(true);
  }, [primaryAgentId, agents]);

  const handleRequestCreateAgentForImport = useCallback(() => {
    setPendingImportAgentAutoSelect(true);
    handleOpenCreateAgent();
  }, [handleOpenCreateAgent]);

  const handleOpenCreateCredential = useCallback((
    start: CreateCredentialStart = 'api-key-form',
    options?: { applyFilters?: boolean; prefillType?: CreatePrefill['type'] },
  ) => {
    const nextPrefill: CreatePrefill = {};
    const preferredAgentId = filters.agentId || primaryAgentId || agents[0]?.id;

    if (preferredAgentId) {
      nextPrefill.agentId = preferredAgentId;
    }

    if (options?.applyFilters) {
      if (filters.tag) nextPrefill.tags = [filters.tag];
      if (options.prefillType) {
        nextPrefill.type = options.prefillType;
      } else if (filters.category && filters.category !== 'all') {
        nextPrefill.type = filters.category as CreatePrefill['type'];
      }
    } else if (options?.prefillType) {
      nextPrefill.type = options.prefillType;
    }

    setEditCredentialId(null);
    setCreateCredentialStart(start);
    setCreatePrefill(Object.keys(nextPrefill).length > 0 ? nextPrefill : null);
    setShowCreateForm(true);
  }, [filters, primaryAgentId, agents]);

  const handleFormSaved = useCallback(async (credentialId?: string) => {
    setShowCreateForm(false);
    setEditCredentialId(null);
    setCreatePrefill(null);
    await fetchData();
    if (credentialId) {
      setSelectedId(credentialId);
      pushRecentCredential(credentialId);
      if (isMobile) setMobileDetailOpen(true);
    }
  }, [fetchData, isMobile, pushRecentCredential]);

  const handleSelectCredential = useCallback(
    (id: string) => {
      setSelectedId(id);
      pushRecentCredential(id);
      if (isMobile) {
        setMobileDetailOpen(true);
      }
    },
    [isMobile, pushRecentCredential],
  );

  const handleApplySearchSuggestion = useCallback((query: string) => {
    handleFilterChange({ search: query });
    setSearchDockOpen(false);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [handleFilterChange]);

  const handleSelectRecentFromDock = useCallback((credential: CredentialWithLocation) => {
    handleFilterChange({ search: credential.name });
    handleSelectCredential(credential.id);
    setSearchDockOpen(false);
  }, [handleFilterChange, handleSelectCredential]);

  const quickSearchHints = useMemo(() => {
    if (filters.search.trim()) return [] as string[];
    return ['tag:work', 'type:login', 'agent:primary', 'favorite', 'archived', 'recently_deleted'];
  }, [filters.search]);

  const showSearchDockPanel = (searchDockOpen || searchDockFocused) && filters.search.trim() === '';

  // Keyboard shortcuts
  useAgentKeyboardShortcuts({
    filteredCredentials: orderedFilteredCredentials,
    selectedId,
    isMobile,
    searchRef,
    onCreateCredential: () => handleOpenCreateCredential('api-key-form'),
    setSelectedId,
    setMobileDetailOpen,
  });

  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[var(--color-background,#f4f4f5)] relative isolate agent-surface">
        <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden">
          <div className="absolute inset-0 bg-grid-adaptive bg-[size:4rem_4rem] opacity-30" />
          <div className="absolute inset-0 tyvek-texture opacity-40 mix-blend-multiply" />
        </div>
        <div className="flex flex-col items-center relative z-10">
          <div className="w-6 h-6 border-2 border-[var(--color-border,#d4d4d8)] border-t-[var(--color-text,#0a0a0a)] animate-spin" />
          <div className="mt-4 font-mono text-[10px] text-[var(--color-text-muted,#6b7280)] tracking-widest">
            LOADING AGENT
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative isolate h-full w-full overflow-hidden flex flex-col bg-[var(--color-background,#f4f4f5)] agent-surface">
      {/* Background — sterile tyvek field (matches /app) */}
      <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute inset-0 bg-grid-adaptive bg-[size:4rem_4rem] opacity-30" />
        <div className="absolute inset-0 tyvek-texture opacity-40 mix-blend-multiply" />
        <div className="absolute bottom-[5%] right-[5%] opacity-[0.03] select-none">
          <div className="text-[12vw] font-black leading-none text-[var(--color-text,#0a0a0a)] font-mono tracking-tighter text-right">AURAWALLET</div>
        </div>
        <div className="absolute top-10 left-[200px] w-24 h-24 border-l-4 border-t-4 border-[var(--color-text,#0a0a0a)] opacity-10">
          <div className="absolute top-2 left-2 w-3 h-3 bg-[var(--color-text,#0a0a0a)]" />
        </div>
        <div className="absolute bottom-10 right-10 w-24 h-24 border-r-4 border-b-4 border-[var(--color-text,#0a0a0a)] opacity-10 flex items-end justify-end">
          <div className="absolute bottom-2 right-2 w-3 h-3 bg-[var(--color-text,#0a0a0a)]" />
        </div>
      </div>

      {/* Main content area */}
      <div className="relative z-10 flex-1 flex overflow-hidden">
        {/* Desktop sidebar */}
        {!isMobile && !isTablet && (
          <AgentSidebar
            agents={parentAgents}
            filters={filters}
            categoryCounts={categoryCounts}
            tags={allTags}
            favoritesCount={favoritesCount}
            onFilterChange={handleFilterChange}
            onLock={handleLock}
            onLockAgent={handleLockAgent}
            onCreateCredential={(start, prefillType) => handleOpenCreateCredential(
              start === 'type-picker' ? 'type-picker' : 'api-key-form',
              prefillType ? { prefillType } : undefined,
            )}
            onCreateAgent={handleOpenCreateAgent}
            mode="desktop"
            notifications={notifications}
            onDismissNotification={dismissNotification}
            pendingActionCount={notifications.filter((n) => n.status === 'pending' && n.type !== 'notify').length}
            surface={surface}
            onSurfaceChange={setSurface}
            onSettings={onSettings}
            onDeleteAgent={handleOpenDeleteAgent}
          />
        )}

        {surface === 'audit' ? (
          <div className="flex-1 h-full overflow-hidden">
            <AuditConsole />
          </div>
        ) : surface === 'apiKeys' ? (
          <div className="flex-1 h-full overflow-hidden">
            <ApiKeysConsole
              requests={requests}
              activeTokens={activeTokens}
              inactiveTokens={inactiveTokens}
              actionLoading={actionLoading}
              onResolveAction={resolveAction}
              onRevokeToken={revokeToken}
              agents={agents}
            />
          </div>
        ) : (
          <>
            {/* Credential list */}
            <CredentialList
              credentials={filteredCredentials}
              latestAccessById={latestAccessByIdForList}
              selectedId={selectedId}
              searchQuery={filters.search}
              onSearchChange={(search) => handleFilterChange({ search })}
              onSelect={handleSelectCredential}
              onAdd={() => handleOpenCreateCredential('api-key-form')}
              onCreateWithFilter={hasActiveFilters ? () => handleOpenCreateCredential('api-key-form', { applyFilters: true }) : undefined}
              canAdd={filters.lifecycle === 'active'}
              onImport={filters.lifecycle !== 'archive' ? handleOpenImportModal : undefined}
              canImport={filters.lifecycle === 'active'}
              onOpenGenerator={filters.lifecycle !== 'archive' ? () => setShowGenerator(true) : undefined}
              onRestoreAll={filters.lifecycle === 'archive' ? handleRestoreAll : undefined}
              canRestoreAll={filters.lifecycle === 'archive' && filteredCredentials.length > 0}
              onPurgeAll={filters.lifecycle === 'archive' ? handlePurgeAll : undefined}
              canPurgeAll={filters.lifecycle === 'archive' && filteredCredentials.length > 0}
              onClearFilters={clearAllFilters}
              hasActiveFilters={hasActiveFilters}
              fieldSearchSuggestions={searchFieldSuggestions}
              onApplySearchSuggestion={handleApplySearchSuggestion}
              searchInputRef={searchRef}
              showSearch={false}
              className={
                isMobile
                  ? 'flex-1 h-full flex flex-col pb-14 min-w-0'
                  : isTablet
                    ? 'w-[300px] h-full flex flex-col pb-14 border-r border-[var(--color-border,#d4d4d8)]'
                    : 'w-[300px] h-full flex flex-col pb-14 border-r border-[var(--color-border,#d4d4d8)]'
              }
              leadingAction={
                isMobile ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Menu size={12} />}
                    onClick={() => setMobileSidebarOpen(true)}
                    className="!px-1.5 !h-8 !w-8"
                    aria-label="Open sidebar"
                    title="Open sidebar"
                  />
                ) : undefined
              }
            />

              {/* Detail panel (desktop + tablet) */}
              {!isMobile && (
                <div className="flex-1 h-full overflow-hidden pb-14">
                  {selectedCredential ? (
                    <CredentialDetail
                      credential={selectedCredential}
                      agentName={selectedAgentName}
                      lifecycle={selectedCredentialLifecycle}
                      onEdit={() => setEditCredentialId(selectedCredential.id)}
                      onDelete={handleDelete}
                      onRestore={handleRestore}
                      onDuplicate={handleDuplicate}
                      onFavoriteChange={handleFavoriteChange}
                    />
                  ) : (
                    <CredentialEmpty
                      variant={
                        filters.lifecycle !== 'active'
                          ? 'empty-lifecycle'
                          : credentials.filter((credential) => deriveCredentialLifecycle(credential) === 'active').length === 0
                            ? 'empty-agent'
                            : 'no-selection'
                      }
                      onAdd={filters.lifecycle === 'active' ? () => handleOpenCreateCredential('api-key-form') : undefined}
                    />
                  )}
                </div>
              )}
          </>
        )}

        {surface === 'credentials' && (
          <div
            className={`absolute bottom-0 z-30 border-t border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#ffffff)]/95 backdrop-blur-sm ${
              isMobile
                ? 'left-0 right-0 w-full'
                : `${isTablet ? 'left-0' : 'left-[200px]'} right-0`
            }`}
          >
            <div className="w-full px-3 py-2.5">
              <div ref={searchDockRef} className="relative w-full">
                {showSearchDockPanel && (
                  <div
                    data-testid="search-dock-panel"
                    className="absolute bottom-full left-0 w-full mb-1 bg-[var(--color-surface,#ffffff)] border border-[var(--color-border-focus,#0a0a0a)] shadow-mech max-h-56 overflow-y-auto z-20"
                  >
                    {recentlyAccessedCredentials.length > 0 && (
                      <>
                        <div className="px-3 py-2 font-mono text-[9px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] border-b border-[var(--color-border-muted,#e5e7eb)] flex items-center gap-1.5">
                          <Clock3 size={11} />
                          Recently Accessed
                        </div>
                        {recentlyAccessedCredentials.map((credential) => (
                          <button
                            key={credential.id}
                            type="button"
                            className="w-full text-left px-4 py-2.5 text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] font-mono text-xs border-b border-[var(--color-border-muted,#e5e5e5)] last:border-0"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              handleSelectRecentFromDock(credential);
                            }}
                          >
                            <div className="text-[var(--color-text,#0a0a0a)] truncate">{getCredentialDisplayName(credential)}</div>
                            <div className="text-[9px] uppercase tracking-wider truncate">
                              {agentNameById.get(credential.agentId) || credential.agentId} · {deriveCredentialLifecycle(credential)}
                            </div>
                          </button>
                        ))}
                      </>
                    )}

                    {recentlyAccessedCredentials.length === 0 && (
                      <div>
                        <div className="px-3 py-2 font-mono text-[9px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] border-b border-[var(--color-border-muted,#e5e7eb)]">
                          Try Structured Search
                        </div>
                        {quickSearchHints.map((hint) => (
                          <button
                            key={hint}
                            type="button"
                            className="w-full text-left px-4 py-2.5 text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)] font-mono text-xs border-b border-[var(--color-border-muted,#e5e5e5)] last:border-0 flex items-center gap-2 group/item"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              handleApplySearchSuggestion(hint);
                            }}
                          >
                            <div className="w-1.5 h-1.5 flex-shrink-0 bg-[var(--color-border,#d4d4d8)] group-hover/item:bg-[var(--color-text,#0a0a0a)]" />
                            <span className="min-w-0 flex-1 truncate">{hint}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <TextInput
                  compact
                  leftElement={<Search size={12} />}
                  placeholder="Search..."
                  value={filters.search}
                  onChange={(event) => handleFilterChange({ search: event.target.value })}
                  inputRef={searchRef}
                  onFocus={() => {
                    setSearchDockFocused(true);
                  }}
                  onClick={() => {
                    if (searchDockCloseTimerRef.current) {
                      clearTimeout(searchDockCloseTimerRef.current);
                      searchDockCloseTimerRef.current = null;
                    }
                    setSearchDockOpen(true);
                  }}
                  onBlur={() => {
                    setSearchDockFocused(false);
                    closeSearchDockSoon();
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Agent action approval footer */}
      <HumanActionBar requests={requests} resolveAction={resolveAction} actionLoading={actionLoading} />

      {/* Mobile detail drawer */}
      {isMobile && (
        <Drawer
          isOpen={mobileDetailOpen && selectedCredential != null}
          onClose={() => setMobileDetailOpen(false)}
          title={selectedCredential?.name || 'Credential'}
          subtitle={selectedAgentName || 'Credential_Detail'}
          width="full"
        >
          {selectedCredential ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMobileDetailOpen(false)}
                className="mb-3"
              >
                BACK
              </Button>
              <CredentialDetail
                credential={selectedCredential}
                agentName={selectedAgentName}
                lifecycle={selectedCredentialLifecycle}
                onEdit={() => setEditCredentialId(selectedCredential.id)}
                onDelete={handleDelete}
                onRestore={handleRestore}
                onDuplicate={handleDuplicate}
                onFavoriteChange={handleFavoriteChange}
              />
            </>
          ) : (
            <CredentialEmpty
              variant={
                filters.lifecycle !== 'active'
                  ? 'empty-lifecycle'
                  : credentials.length === 0
                    ? 'empty-agent'
                    : 'no-selection'
              }
              onAdd={filters.lifecycle === 'active' ? () => handleOpenCreateCredential('api-key-form') : undefined}
            />
          )}
        </Drawer>
      )}

      {/* Mobile / tablet sidebar overlay */}
      {(isMobile || isTablet) && mobileSidebarOpen && (
        <div className="absolute inset-0 z-40">
          <button
            type="button"
            aria-label="Close sidebar"
            onClick={() => setMobileSidebarOpen(false)}
            className="absolute inset-0 bg-[var(--color-text,#0a0a0a)]/20"
          />
          <div className="absolute left-0 top-0 h-full">
            <AgentSidebar
              agents={parentAgents}
              filters={filters}
              categoryCounts={categoryCounts}
              tags={allTags}
              favoritesCount={favoritesCount}
              onFilterChange={handleFilterChange}
              onLock={handleLock}
              onLockAgent={handleLockAgent}
              onCreateCredential={(start, prefillType) => handleOpenCreateCredential(
                start === 'type-picker' ? 'type-picker' : 'api-key-form',
                prefillType ? { prefillType } : undefined,
              )}
              onCreateAgent={handleOpenCreateAgent}
              mode="mobile"
              onNavigate={() => setMobileSidebarOpen(false)}
              notifications={notifications}
              onDismissNotification={dismissNotification}
              pendingActionCount={notifications.filter((n) => n.status === 'pending' && n.type !== 'notify').length}
              surface={surface}
              onSurfaceChange={setSurface}
              onSettings={onSettings}
              onDeleteAgent={handleOpenDeleteAgent}
            />
          </div>
        </div>
      )}

      {/* Delete agent modal */}
      <Modal
        isOpen={deleteAgentTarget != null}
        onClose={handleCloseDeleteAgent}
        title={`Delete ${deleteAgentDisplayName}?`}
        size="sm"
        footer={(
          <div className="flex gap-2 justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCloseDeleteAgent}
              disabled={deletingAgent}
            >
              CANCEL
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleDeleteAgent}
              loading={deletingAgent}
            >
              DELETE
            </Button>
          </div>
        )}
      >
        <div className="space-y-3">
          <div className="text-[10px] text-[var(--color-text-muted,#6b7280)]">
            This will permanently delete the agent and its credentials.
          </div>
          {deleteAgentError && (
            <div className="text-[10px] text-[var(--color-danger,#ef4444)] border border-[var(--color-danger,#ef4444)]/30 bg-[var(--color-danger,#ef4444)]/10 px-3 py-2">
              {deleteAgentError}
            </div>
          )}
        </div>
      </Modal>

      {/* Unlock agent modal */}
      <Modal
        isOpen={unlockAgentTarget != null}
        onClose={handleCloseUnlockAgent}
        title={`Unlock ${unlockAgentDisplayName}`}
        size="sm"
        footer={(
          <div className="flex gap-2 justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCloseUnlockAgent}
            >
              CANCEL
            </Button>
            <Button
              size="sm"
              onClick={handleUnlockAgent}
              loading={unlockingAgent}
              disabled={!unlockAgentPassword}
            >
              UNLOCK
            </Button>
          </div>
        )}
      >
        <div className="space-y-4">
          <TextInput
            label="Agent Password"
            type="password"
            placeholder="Enter agent password"
            value={unlockAgentPassword}
            onChange={(e) => setUnlockAgentPassword(e.target.value)}
            autoFocus
          />
          {unlockAgentError && (
            <div className="text-[10px] text-[var(--color-danger,#ef4444)] border border-[var(--color-danger,#ef4444)]/30 bg-[var(--color-danger,#ef4444)]/10 px-3 py-2">
              {unlockAgentError}
            </div>
          )}
        </div>
      </Modal>

      {/* Create / Edit credential modal */}
      <CredentialForm
        isOpen={showCreateForm || !!editCredentialId}
        onClose={() => {
          setShowCreateForm(false);
          setEditCredentialId(null);
          setCreatePrefill(null);
        }}
        onSaved={handleFormSaved}
        editCredentialId={editCredentialId ?? undefined}
        agents={agents}
        createStartStep={createCredentialStart === 'type-picker' ? 'type' : 'form'}
        createStartType={createCredentialStart === 'type-picker' ? undefined : 'apikey'}
        createPrefill={createPrefill ?? undefined}
      />

      {/* Import credentials modal */}
      <ImportCredentialsModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onComplete={fetchData}
        agents={agents}
        selectedAgentId={importTargetAgentId}
        onSelectedAgentIdChange={setImportTargetAgentId}
        onAddAgent={handleRequestCreateAgentForImport}
        walletBaseUrl={getWalletBaseUrl()}
      />

      {/* Password generator modal */}
      <PasswordGenerator
        isOpen={showGenerator}
        onClose={() => setShowGenerator(false)}
        onUse={(password) => {
          setShowGenerator(false);
          navigator.clipboard.writeText(password).catch(() => {});
        }}
      />

      {/* Create agent modal */}
      <Modal
        isOpen={showCreateAgent}
        onClose={handleCloseCreateAgent}
        title="New Agent"
        size="md"
        footer={(
          <div className="flex gap-2 justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCloseCreateAgent}
            >
              CANCEL
            </Button>
            <Button
              size="sm"
              onClick={handleCreateAgent}
              loading={creatingAgent}
              disabled={
                !newAgentName.trim()
                || (newAgentMode === 'linked' && !newAgentParentId)
                || (newAgentMode === 'independent' && newAgentPassword.length < 8)
              }
            >
              CREATE
            </Button>
          </div>
        )}
      >
        <div className="space-y-4">
          <TextInput
            label="Agent Name"
            placeholder="e.g. Work, Personal"
            value={newAgentName}
            onChange={(e) => setNewAgentName(e.target.value)}
            autoFocus
          />
          {/* Agent Type — commented out for now
          <FilterDropdown
            label="Agent Type"
            options={AGENT_MODE_OPTIONS}
            value={newAgentMode}
            onChange={(value) => {
              const mode = value as 'linked' | 'independent';
              setNewAgentMode(mode);
              if (mode !== 'independent') {
                setNewAgentPassword('');
              }
            }}
            compact
          />
          {newAgentMode === 'linked' && (
            <FilterDropdown
              label="Parent Agent"
              options={parentAgentOptions}
              value={newAgentParentId}
              onChange={setNewAgentParentId}
              disabled={parentAgentOptions.length === 0}
              compact
            />
          )}
          */}
          <TextInput
            label="Agent Password"
            type="password"
            placeholder="At least 8 characters"
            value={newAgentPassword}
            onChange={(e) => setNewAgentPassword(e.target.value)}
          />
        </div>
      </Modal>
    </div>
  );
};
