'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, KeyRound, Loader2, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, FilterDropdown, TextInput } from '@/components/design-system';
import { api, Api } from '@/lib/api';
import { decryptCredentialPayload, getAgentPublicKeyBase64 } from '@/lib/agent-crypto';
import type { AgentToken, HumanAction } from '@/hooks/useAgentActions';
import type { AgentInfo } from '@/components/agent/types';

const BUILTIN_PROFILE_OPTIONS = [
  { id: 'strict', label: 'Strict', description: 'Agent agent only, read-only, strong field redaction. 15 min TTL.' },
  { id: 'dev', label: 'Dev (recommended)', description: 'All agents, read/write, moderate redaction. 1 hour TTL.' },
  { id: 'admin', label: 'Admin (dangerous)', description: 'Full access, no redaction. Use with caution.' },
] as const;

const TOKEN_PERMISSION_OPTIONS = [
  { value: 'wallet:list', label: 'wallet:list' },
  { value: 'wallet:create:hot', label: 'wallet:create:hot' },
  { value: 'wallet:create:temp', label: 'wallet:create:temp' },
  { value: 'wallet:rename', label: 'wallet:rename' },
  { value: 'wallet:export', label: 'wallet:export' },
  { value: 'wallet:tx:add', label: 'wallet:tx:add' },
  { value: 'wallet:asset:add', label: 'wallet:asset:add' },
  { value: 'wallet:asset:remove', label: 'wallet:asset:remove' },
  { value: 'send:hot', label: 'send:hot' },
  { value: 'send:temp', label: 'send:temp' },
  { value: 'swap', label: 'swap' },
  { value: 'fund', label: 'fund' },
  { value: 'launch', label: 'launch' },
  { value: 'apikey:get', label: 'apikey:get' },
  { value: 'apikey:set', label: 'apikey:set' },
  { value: 'workspace:modify', label: 'workspace:modify' },
  { value: 'strategy:read', label: 'strategy:read' },
  { value: 'strategy:manage', label: 'strategy:manage' },
  { value: 'app:storage', label: 'app:storage' },
  { value: 'app:storage:all', label: 'app:storage:all' },
  { value: 'app:accesskey', label: 'app:accesskey' },
  { value: 'action:create', label: 'action:create' },
  { value: 'action:read', label: 'action:read' },
  { value: 'action:resolve', label: 'action:resolve' },
  { value: 'adapter:manage', label: 'adapter:manage' },
  { value: 'addressbook:write', label: 'addressbook:write' },
  { value: 'bookmark:write', label: 'bookmark:write' },
  { value: 'secret:read', label: 'secret:read' },
  { value: 'secret:write', label: 'secret:write' },
  { value: 'totp:read', label: 'totp:read' },
  { value: 'trade:all', label: 'trade:all' },
  { value: 'wallet:write', label: 'wallet:write' },
  { value: 'extension:*', label: 'extension:*' },
  { value: 'admin:*', label: 'admin:* (dangerous)' },
] as const;

const PROFILE_DESCRIPTIONS: Record<string, string> = {
  strict: 'Read-only, agent agent only. Hidden: password, cvv, privateKey, seedPhrase, refresh_token. 15 min TTL, 50 reads max.',
  dev: 'Read/write, all agents. Hidden: cvv, seedPhrase, privateKey, refresh_token. 1 hour TTL, 500 reads max.',
  admin: 'Full access, no field redaction. 1 hour TTL, unlimited reads.',
};

function describeProfileId(id: string): string {
  return PROFILE_DESCRIPTIONS[id] || `Custom profile: ${id}`;
}

type IssueMode = 'profile' | 'permissions';

const ISSUE_MODE_OPTIONS: Array<{ value: IssueMode; label: string }> = [
  { value: 'profile', label: 'Profile' },
  { value: 'permissions', label: 'Permissions' },
];

const PROFILE_STORAGE_KEY = 'aura:api-keys:profiles:v1';

const BUILTIN_PROFILE_TEMPLATES: Record<string, { ttlSeconds: number; maxReads?: number; scope: string[]; excludeFields: string[] }> = {
  strict: { ttlSeconds: 900, maxReads: 50, scope: ['secret:read'], excludeFields: ['password', 'cvv', 'privateKey', 'seedPhrase', 'refresh_token'] },
  dev: { ttlSeconds: 3600, maxReads: 500, scope: ['wallet:list', 'secret:read', 'secret:write', 'action:create', 'action:read', 'action:resolve'], excludeFields: ['cvv', 'seedPhrase', 'privateKey', 'refresh_token'] },
  admin: { ttlSeconds: 3600, scope: ['admin:*'], excludeFields: [] },
};

interface ProfileOverrides {
  ttlSeconds?: number;
  maxReads?: number;
  scope?: string[];
  readScopes?: string[];
  writeScopes?: string[];
  excludeFields?: string[];
  agentReadScopes?: string[];
  agentWriteScopes?: string[];
}

interface LocalProfileDraft {
  id: string;
  name: string;
  profile: string;
  profileVersion: 'v1';
  overrides: ProfileOverrides | null;
  updatedAt: number;
}

interface PolicyPreviewResponse {
  version: 'v1';
  profile?: { id: string; version: string; displayName?: string };
  effectivePolicy: {
    permissions: string[];
    credentialAccess: {
      read: string[];
      write: string[];
      excludeFields: string[];
      maxReads: number | null;
    };
    ttlSeconds: number;
    maxReads: number | null;
    rateBudget: {
      state: 'none' | 'inherited' | 'explicit';
      requests: number | null;
      windowSeconds: number | null;
      source: 'none' | 'profile' | 'override';
    };
  };
  warnings: string[];
  overrideDelta: string[];
  denyExamples?: Array<{ code: string; message: string }>;
  effectivePolicyHash: string;
}

interface IssueResponse {
  success: boolean;
  encryptedToken?: string;
  warnings?: string[];
  profile?: { id: string; version: string; displayName?: string };
}

interface ApiKeysConsoleProps {
  requests: HumanAction[];
  activeTokens: AgentToken[];
  inactiveTokens: AgentToken[];
  actionLoading: string | null;
  onResolveAction: (id: string, approved: boolean) => Promise<{ success: boolean; message?: string }>;
  onRevokeToken: (tokenHash: string) => Promise<boolean>;
  agents?: AgentInfo[];
}

function shortHash(value: string): string {
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function generateSuggestedAgentId(): string {
  const seed = Math.random().toString(36).slice(2, 8);
  return `agent:local:${seed}`;
}

function normalizePreviewPayload(raw: unknown): PolicyPreviewResponse {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const effectivePolicy = (data.effectivePolicy && typeof data.effectivePolicy === 'object'
    ? data.effectivePolicy
    : {}) as Record<string, unknown>;
  const credentialAccess = (effectivePolicy.credentialAccess && typeof effectivePolicy.credentialAccess === 'object'
    ? effectivePolicy.credentialAccess
    : {}) as Record<string, unknown>;
  const rateBudget = (effectivePolicy.rateBudget && typeof effectivePolicy.rateBudget === 'object'
    ? effectivePolicy.rateBudget
    : {}) as Record<string, unknown>;

  return {
    version: 'v1',
    profile: data.profile && typeof data.profile === 'object'
      ? data.profile as PolicyPreviewResponse['profile']
      : undefined,
    effectivePolicy: {
      permissions: Array.isArray(effectivePolicy.permissions) ? effectivePolicy.permissions.filter((v): v is string => typeof v === 'string') : [],
      credentialAccess: {
        read: Array.isArray(credentialAccess.read) ? credentialAccess.read.filter((v): v is string => typeof v === 'string') : [],
        write: Array.isArray(credentialAccess.write) ? credentialAccess.write.filter((v): v is string => typeof v === 'string') : [],
        excludeFields: Array.isArray(credentialAccess.excludeFields) ? credentialAccess.excludeFields.filter((v): v is string => typeof v === 'string') : [],
        maxReads: typeof credentialAccess.maxReads === 'number' ? credentialAccess.maxReads : null,
      },
      ttlSeconds: typeof effectivePolicy.ttlSeconds === 'number' ? effectivePolicy.ttlSeconds : 0,
      maxReads: typeof effectivePolicy.maxReads === 'number' ? effectivePolicy.maxReads : null,
      rateBudget: {
        state: rateBudget.state === 'inherited' || rateBudget.state === 'explicit' ? rateBudget.state : 'none',
        requests: typeof rateBudget.requests === 'number' ? rateBudget.requests : null,
        windowSeconds: typeof rateBudget.windowSeconds === 'number' ? rateBudget.windowSeconds : null,
        source: rateBudget.source === 'profile' || rateBudget.source === 'override' ? rateBudget.source : 'none',
      },
    },
    warnings: Array.isArray(data.warnings) ? data.warnings.filter((v): v is string => typeof v === 'string') : [],
    overrideDelta: Array.isArray(data.overrideDelta) ? data.overrideDelta.filter((v): v is string => typeof v === 'string') : [],
    denyExamples: Array.isArray(data.denyExamples)
      ? data.denyExamples
        .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
        .map((row) => ({ code: String(row.code || 'UNKNOWN'), message: String(row.message || '') }))
      : [],
    effectivePolicyHash: typeof data.effectivePolicyHash === 'string' ? data.effectivePolicyHash : 'n/a',
  };
}

function parseMetadata(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function parseCsv(value: string): string[] | undefined {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function normalizeStringList(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().normalize('NFKC').toLowerCase())
        .filter(Boolean),
    ),
  );
}

function buildOverrides(input: {
  ttlSeconds: string;
  maxReads: string;
  scope: string[];
  excludeFields: string;
}): { overrides: ProfileOverrides | null; error: string | null } {
  const next: ProfileOverrides = {};

  if (input.ttlSeconds.trim().length > 0) {
    const ttl = Number(input.ttlSeconds.trim());
    if (!Number.isFinite(ttl) || ttl <= 0) {
      return { overrides: null, error: 'TTL override must be a positive number.' };
    }
    next.ttlSeconds = ttl;
  }

  if (input.maxReads.trim().length > 0) {
    const maxReads = Number(input.maxReads.trim());
    if (!Number.isFinite(maxReads) || maxReads <= 0) {
      return { overrides: null, error: 'Max reads override must be a positive number.' };
    }
    next.maxReads = maxReads;
  }

  const scope = normalizeStringList(input.scope);
  const excludeFields = parseCsv(input.excludeFields);

  if (scope.length > 0) next.scope = scope;
  if (excludeFields) next.excludeFields = excludeFields;

  return { overrides: Object.keys(next).length > 0 ? next : null, error: null };
}

export const ApiKeysConsole: React.FC<ApiKeysConsoleProps> = ({
  requests,
  activeTokens,
  inactiveTokens,
  actionLoading,
  onResolveAction,
  onRevokeToken,
  agents = [],
}) => {
  const [profiles, setProfiles] = useState<LocalProfileDraft[]>([]);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);

  const [profileName, setProfileName] = useState('');
  const [profileBase, setProfileBase] = useState<string>('dev');
  const [profileTtlSeconds, setProfileTtlSeconds] = useState('');
  const [profileMaxReads, setProfileMaxReads] = useState('');
  const [profileScopes, setProfileScopes] = useState<string[]>([]);
  const [profileScopeCandidate, setProfileScopeCandidate] = useState<string>('secret:read');
  const [profileExcludeFields, setProfileExcludeFields] = useState('');
  const [profileAgentScopes, setProfileAgentScopes] = useState<string[]>([]);

  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);

  const [issueAgentId, setIssueAgentId] = useState<string>(() => generateSuggestedAgentId());
  const [issueMode, setIssueMode] = useState<IssueMode>('profile');
  const [issueProfileSource, setIssueProfileSource] = useState<string>('builtin:dev');
  const [issuePermissionCandidate, setIssuePermissionCandidate] = useState<string>('secret:read');
  const [issuePermissions, setIssuePermissions] = useState<string[]>(['secret:read', 'secret:write']);
  const [issueAgentScopes, setIssueAgentScopes] = useState<string[]>([]);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [issuedMeta, setIssuedMeta] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PolicyPreviewResponse | null>(null);

  const [requestNotice, setRequestNotice] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as LocalProfileDraft[];
      if (!Array.isArray(parsed)) return;
      const safe = parsed
        .filter((entry) =>
          entry
          && typeof entry.id === 'string'
          && typeof entry.name === 'string'
          && typeof entry.profile === 'string'
          && entry.profileVersion === 'v1'
          && typeof entry.updatedAt === 'number'
        )
        .map((entry) => {
          const scope = normalizeStringList([
            ...(entry.overrides?.scope || []),
            ...(entry.overrides?.readScopes || []),
            ...(entry.overrides?.writeScopes || []),
          ]);
          const overrides = entry.overrides
            ? {
              ...entry.overrides,
              ...(scope.length > 0 ? { scope } : {}),
              readScopes: undefined,
              writeScopes: undefined,
            }
            : null;
          return {
            ...entry,
            overrides,
          };
        });
      setProfiles(safe);
    } catch {
      setProfiles([]);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profiles));
  }, [profiles]);

  const resetProfileForm = useCallback(() => {
    setEditingProfileId(null);
    setProfileName('');
    setProfileBase('dev');
    setProfileTtlSeconds('');
    setProfileMaxReads('');
    setProfileScopes([]);
    setProfileScopeCandidate('secret:read');
    setProfileExcludeFields('');
    setProfileAgentScopes([]);
    setProfileError(null);
    setProfileNotice(null);
  }, []);

  const applyBaseTemplate = useCallback((baseProfile: string) => {
    const template = BUILTIN_PROFILE_TEMPLATES[baseProfile];
    if (!template) return;
    setProfileTtlSeconds(String(template.ttlSeconds));
    setProfileMaxReads(typeof template.maxReads === 'number' ? String(template.maxReads) : '');
    setProfileScopes(template.scope);
    setProfileScopeCandidate(template.scope[0] || 'secret:read');
    setProfileExcludeFields(template.excludeFields.join(', '));
  }, []);

  const agentScopeOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [
      { value: 'agent:*', label: 'All Agents (agent:*)' },
    ];
    for (const agent of agents) {
      const name = agent.name || agent.id;
      options.push({ value: `agent:${agent.id}`, label: `agent:${name}` });
    }
    return options;
  }, [agents]);

  const pendingAuthRequests = useMemo(
    () => requests.filter((request) => request.status === 'pending' && (request.type === 'auth' || request.type === 'permission_update')),
    [requests],
  );

  const selectableProfileSources = useMemo(() => {
    const builtin = BUILTIN_PROFILE_OPTIONS.map((option) => ({
      value: `builtin:${option.id}`,
      label: `${option.label} — ${option.description}`,
    }));
    const custom = profiles.map((profile) => ({
      value: `draft:${profile.id}`,
      label: `Custom · ${profile.name}`,
    }));
    return [...builtin, ...custom];
  }, [profiles]);

  useEffect(() => {
    if (!selectableProfileSources.some((option) => option.value === issueProfileSource)) {
      setIssueProfileSource('builtin:dev');
    }
  }, [issueProfileSource, selectableProfileSources]);

  const resolveIssueProfile = useCallback((): { profile: string; profileVersion: string; profileOverrides?: ProfileOverrides } => {
    if (issueProfileSource.startsWith('draft:')) {
      const profileId = issueProfileSource.slice(6);
      const draft = profiles.find((entry) => entry.id === profileId);
      if (draft) {
        const scope = normalizeStringList([
          ...(draft.overrides?.scope || []),
          ...(draft.overrides?.readScopes || []),
          ...(draft.overrides?.writeScopes || []),
        ]);
        const profileOverrides = draft.overrides
          ? {
            ...draft.overrides,
            ...(scope.length > 0 ? { scope } : {}),
          }
          : undefined;
        return {
          profile: draft.profile,
          profileVersion: draft.profileVersion,
          ...(profileOverrides ? { profileOverrides } : {}),
        };
      }
    }
    const profile = issueProfileSource.startsWith('builtin:') ? issueProfileSource.slice(8) : 'dev';
    return { profile, profileVersion: 'v1' };
  }, [issueProfileSource, profiles]);

  const addIssuePermission = useCallback((permission: string) => {
    const normalized = normalizeStringList([permission])[0];
    if (!normalized) return;
    setIssuePermissions((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
  }, []);

  const removeIssuePermission = useCallback((permission: string) => {
    setIssuePermissions((prev) => prev.filter((entry) => entry !== permission));
  }, []);

  const handleSaveProfile = useCallback(() => {
    setProfileError(null);
    setProfileNotice(null);
    const trimmedName = profileName.trim();
    if (!trimmedName) {
      setProfileError('Profile name is required.');
      return;
    }

    const { overrides: baseOverrides, error } = buildOverrides({
      ttlSeconds: profileTtlSeconds,
      maxReads: profileMaxReads,
      scope: profileScopes,
      excludeFields: profileExcludeFields,
    });

    if (error) {
      setProfileError(error);
      return;
    }

    const overrides: ProfileOverrides | null = profileAgentScopes.length > 0
      ? { ...(baseOverrides || {}), readScopes: profileAgentScopes, writeScopes: profileAgentScopes }
      : baseOverrides;

    const existingNameConflict = profiles.some((profile) =>
      profile.name.toLowerCase() === trimmedName.toLowerCase()
      && profile.id !== editingProfileId
    );
    if (existingNameConflict) {
      setProfileError('A profile with this name already exists.');
      return;
    }

    const payload: LocalProfileDraft = {
      id: editingProfileId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: trimmedName,
      profile: profileBase,
      profileVersion: 'v1',
      overrides,
      updatedAt: Date.now(),
    };

    setProfiles((prev) => {
      if (editingProfileId) {
        return prev.map((entry) => (entry.id === editingProfileId ? payload : entry));
      }
      return [payload, ...prev];
    });
    setProfileNotice(editingProfileId ? 'Profile updated.' : 'Profile created.');
    if (!editingProfileId) {
      setIssueProfileSource(`draft:${payload.id}`);
    }
    setEditingProfileId(payload.id);
  }, [
    editingProfileId,
    profileBase,
    profileExcludeFields,
    profileMaxReads,
    profileName,
    profileScopes,
    profileTtlSeconds,
    profileAgentScopes,
    profiles,
  ]);

  const handleEditProfile = useCallback((profile: LocalProfileDraft) => {
    setEditingProfileId(profile.id);
    setProfileName(profile.name);
    setProfileBase(profile.profile);
    setProfileTtlSeconds(profile.overrides?.ttlSeconds ? String(profile.overrides.ttlSeconds) : '');
    setProfileMaxReads(profile.overrides?.maxReads ? String(profile.overrides.maxReads) : '');
    const legacyScopes = [
      ...(profile.overrides?.scope || []),
      ...(profile.overrides?.readScopes || []),
      ...(profile.overrides?.writeScopes || []),
    ];
    const normalizedScopes = normalizeStringList(legacyScopes);
    setProfileScopes(normalizedScopes);
    setProfileScopeCandidate(normalizedScopes[0] || 'secret:read');
    setProfileExcludeFields((profile.overrides?.excludeFields || []).join(', '));
    setProfileAgentScopes(profile.overrides?.readScopes || profile.overrides?.agentReadScopes || []);
    setProfileError(null);
    setProfileNotice(null);
  }, []);

  const addProfileScope = useCallback((scope: string) => {
    const normalized = normalizeStringList([scope])[0];
    if (!normalized) return;
    setProfileScopes((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
  }, []);

  const removeProfileScope = useCallback((scope: string) => {
    setProfileScopes((prev) => prev.filter((entry) => entry !== scope));
  }, []);

  const handleDeleteProfile = useCallback((id: string) => {
    setProfiles((prev) => prev.filter((profile) => profile.id !== id));
    if (editingProfileId === id) {
      resetProfileForm();
    }
    if (issueProfileSource === `draft:${id}`) {
      setIssueProfileSource('builtin:dev');
    }
  }, [editingProfileId, issueProfileSource, resetProfileForm]);

  const handlePreview = useCallback(async () => {
    setPreviewError(null);
    setPreview(null);
    if (issueMode === 'permissions') {
      setPreviewError('Policy preview is currently available for profile-based issuance only.');
      return;
    }
    setPreviewLoading(true);
    try {
      const selection = resolveIssueProfile();
      const data = await api.post<PolicyPreviewResponse>(Api.Wallet, '/actions/token/preview', selection);
      setPreview(normalizePreviewPayload(data));
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Failed to preview profile policy.');
    } finally {
      setPreviewLoading(false);
    }
  }, [issueMode, resolveIssueProfile]);

  const handleIssueApiKey = useCallback(async () => {
    setIssueError(null);
    setIssuedToken(null);
    setIssuedMeta(null);
    if (!issueAgentId.trim()) {
      setIssueError('Agent ID is required.');
      return;
    }
    if (issueMode === 'permissions' && issuePermissions.length === 0) {
      setIssueError('Select at least one permission for manual issuance.');
      return;
    }
    const pubkey = getAgentPublicKeyBase64();
    if (!pubkey) {
      setIssueError('Agent keypair is unavailable. Re-unlock and retry.');
      return;
    }

    setIssuing(true);
    try {
      let result: IssueResponse;
      if (issueMode === 'permissions') {
        const credentialAccess = issueAgentScopes.length > 0
          ? { read: issueAgentScopes, write: issueAgentScopes }
          : undefined;
        result = await api.post<IssueResponse>(Api.Wallet, '/actions/token', {
          agentId: issueAgentId.trim(),
          pubkey,
          permissions: issuePermissions,
          ...(credentialAccess ? { credentialAccess } : {}),
        });
      } else {
        const profilePayload = resolveIssueProfile();
        if (issueAgentScopes.length > 0) {
          profilePayload.profileOverrides = {
            ...(profilePayload.profileOverrides || {}),
            readScopes: issueAgentScopes,
            writeScopes: issueAgentScopes,
          };
        }
        result = await api.post<IssueResponse>(Api.Wallet, '/actions/token', {
          agentId: issueAgentId.trim(),
          pubkey,
          ...profilePayload,
        });
      }
      if (!result.success || !result.encryptedToken) {
        throw new Error('Token issuance failed.');
      }
      const token = await decryptCredentialPayload(result.encryptedToken);
      setIssuedToken(token);
      if (issueMode === 'permissions') {
        setIssuedMeta(
          `${issueAgentId.trim()} · permissions:${issuePermissions.join(',')}${result.warnings?.length ? ' · warnings present' : ''}`,
        );
      } else {
        const selection = resolveIssueProfile();
        setIssuedMeta(
          `${issueAgentId.trim()} · ${selection.profile}@${selection.profileVersion}${result.warnings?.length ? ' · warnings present' : ''}`,
        );
      }
    } catch (error) {
      setIssueError(error instanceof Error ? error.message : 'Token issuance failed.');
    } finally {
      setIssuing(false);
    }
  }, [issueAgentId, issueMode, issuePermissions, issueAgentScopes, resolveIssueProfile]);

  const handleCopyToken = useCallback(async () => {
    if (!issuedToken || !navigator.clipboard) return;
    await navigator.clipboard.writeText(issuedToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [issuedToken]);

  const handleResolveRequest = useCallback(async (id: string, approved: boolean) => {
    const result = await onResolveAction(id, approved);
    if (result.success) {
      setRequestNotice(approved ? `Approved request ${id.slice(0, 8)}.` : `Rejected request ${id.slice(0, 8)}.`);
      return;
    }
    setRequestNotice(result.message || 'Failed to resolve request.');
  }, [onResolveAction]);

  const managedActiveTokens = useMemo(
    () => activeTokens.filter((token) => !token.isAdmin),
    [activeTokens],
  );

  return (
    <div className="h-full overflow-y-auto px-5 py-4 font-mono">
      <div className="mb-4 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] p-3">
        <div className="text-[10px] font-bold tracking-widest text-[var(--color-text,#0a0a0a)]">API KEYS</div>
        <div className="mt-1 text-[9px] text-[var(--color-text-muted,#6b7280)] leading-relaxed">
          Auth management surface for profile templates + permissions-based issuance + pending auth approvals.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="order-1 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] p-3">
          <div className="mb-2 text-[10px] font-bold tracking-widest text-[var(--color-text,#0a0a0a)]">ISSUE API KEY</div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-1.5">
              <TextInput
                label="Agent ID"
                value={issueAgentId}
                onChange={(event) => setIssueAgentId(event.target.value)}
                placeholder="agent:local:dev"
                compact
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIssueAgentId(generateSuggestedAgentId())}
                icon={<RefreshCw size={10} />}
                title="Regenerate Agent ID"
                className="mb-[1px]"
              >
                NEW ID
              </Button>
            </div>

            <FilterDropdown
              label="Issuance Mode"
              options={ISSUE_MODE_OPTIONS}
              value={issueMode}
              onChange={(value) => setIssueMode(value as IssueMode)}
              compact
            />
          </div>

          {issueMode === 'profile' ? (
            <div className="mt-2">
              <FilterDropdown
                label="Profile Source"
                options={selectableProfileSources}
                value={issueProfileSource}
                onChange={setIssueProfileSource}
                compact
              />
              {(() => {
                const builtinId = issueProfileSource.startsWith('builtin:') ? issueProfileSource.slice(8) : null;
                const desc = builtinId ? PROFILE_DESCRIPTIONS[builtinId] : null;
                return desc ? (
                  <div className="mt-1 px-1 text-[8px] text-[var(--color-text-muted,#6b7280)]">{desc}</div>
                ) : (
                  <div className="mt-1 px-1 text-[8px] text-[var(--color-text-faint,#9ca3af)]">
                    Profile mode resolves permissions/scopes/ttl from the selected profile.
                  </div>
                );
              })()}
            </div>
          ) : (
            <div className="mt-2 space-y-1">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-1.5">
                <FilterDropdown
                  label="Permissions"
                  options={TOKEN_PERMISSION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                  value={issuePermissionCandidate}
                  onChange={setIssuePermissionCandidate}
                  compact
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => addIssuePermission(issuePermissionCandidate)}
                >
                  ADD
                </Button>
              </div>
              {issuePermissions.length === 0 ? (
                <div className="px-1 text-[8px] text-[var(--color-danger,#ef4444)]">
                  No permissions selected.
                </div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {issuePermissions.map((permission) => (
                    <span
                      key={`perm-${permission}`}
                      className="inline-flex items-center gap-1 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background,#f4f4f5)] px-1.5 py-0.5 text-[8px] text-[var(--color-text,#0a0a0a)]"
                    >
                      {permission}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeIssuePermission(permission)}
                        className="h-4 px-1 text-[8px]"
                      >
                        X
                      </Button>
                    </span>
                  ))}
                </div>
              )}
              <div className="px-1 text-[8px] text-[var(--color-text-faint,#9ca3af)]">
                Permissions mode issues exactly the selected permissions.
              </div>
            </div>
          )}

          {agentScopeOptions.length > 1 && (
            <div className="mt-2 space-y-1">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-1.5">
                <FilterDropdown
                  label="Agent Scope"
                  options={agentScopeOptions}
                  value={agentScopeOptions[0]?.value || 'agent:*'}
                  onChange={(value) => {
                    if (!issueAgentScopes.includes(value)) {
                      setIssueAgentScopes((prev) => [...prev, value]);
                    }
                  }}
                  compact
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setIssueAgentScopes([])}
                >
                  CLEAR
                </Button>
              </div>
              {issueAgentScopes.length === 0 ? (
                <div className="px-1 text-[8px] text-[var(--color-text-faint,#9ca3af)]">
                  No agent restriction — uses profile/system defaults.
                </div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {issueAgentScopes.map((scope) => (
                    <span
                      key={`vs-${scope}`}
                      className="inline-flex items-center gap-1 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background,#f4f4f5)] px-1.5 py-0.5 text-[8px] text-[var(--color-text,#0a0a0a)]"
                    >
                      {scope}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setIssueAgentScopes((prev) => prev.filter((s) => s !== scope))}
                        className="h-4 px-1 text-[8px]"
                      >
                        X
                      </Button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mt-2 rounded border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background,#f4f4f5)] px-2 py-2 text-[9px] text-[var(--color-text-muted,#6b7280)]">
            Generate a key in one click. Preview is optional and only shows what permissions/scopes will be issued.
          </div>

          {issueError && (
            <div className="mt-2 text-[9px] text-[var(--color-danger,#ef4444)]">{issueError}</div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => { void handleIssueApiKey(); }}
              loading={issuing}
              icon={!issuing ? <KeyRound size={11} /> : undefined}
            >
              ISSUE API KEY
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { void handlePreview(); }}
              loading={previewLoading}
              disabled={issueMode === 'permissions'}
              icon={!previewLoading ? <RefreshCw size={11} /> : undefined}
            >
              PREVIEW POLICY
            </Button>
          </div>

          {previewError && (
            <div className="mt-2 text-[9px] text-[var(--color-danger,#ef4444)]">{previewError}</div>
          )}

          {preview && (
            <div className="mt-3 rounded border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background,#f4f4f5)] p-2">
              <div className="text-[8px] tracking-widest text-[var(--color-text-faint,#9ca3af)]">
                HASH {shortHash(preview.effectivePolicyHash)}
              </div>
              {preview.profile && (
                <div className="mt-1 text-[8px] text-[var(--color-text-faint,#9ca3af)]">
                  profile: {preview.profile.id}@{preview.profile.version}
                </div>
              )}
              <div className="mt-1 text-[9px] text-[var(--color-text-muted,#6b7280)]">
                permissions: {preview.effectivePolicy.permissions.length} · ttl: {preview.effectivePolicy.ttlSeconds}s · max reads: {preview.effectivePolicy.maxReads ?? 'unlimited'}
              </div>
              <div className="mt-2 grid grid-cols-1 gap-1 text-[8px] text-[var(--color-text-muted,#6b7280)]">
                <div>perms: {preview.effectivePolicy.permissions.join(', ') || '(none)'}</div>
                <div>read scope: {preview.effectivePolicy.credentialAccess.read.join(', ') || '(none)'}</div>
                <div>write scope: {preview.effectivePolicy.credentialAccess.write.join(', ') || '(none)'}</div>
                <div>excluded fields: {preview.effectivePolicy.credentialAccess.excludeFields.join(', ') || '(none)'}</div>
                <div>
                  rate budget: {preview.effectivePolicy.rateBudget.state} ({preview.effectivePolicy.rateBudget.requests ?? 'n/a'} / {preview.effectivePolicy.rateBudget.windowSeconds ?? 'n/a'}s, source={preview.effectivePolicy.rateBudget.source})
                </div>
              </div>

              {preview.overrideDelta.length > 0 && (
                <div className="mt-2 rounded border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] p-1.5 text-[8px] text-[var(--color-text-muted,#6b7280)]">
                  <div className="mb-1 tracking-widest text-[var(--color-text-faint,#9ca3af)]">OVERRIDE DELTA</div>
                  {preview.overrideDelta.join(' · ')}
                </div>
              )}

              {preview.denyExamples && preview.denyExamples.length > 0 && (
                <div className="mt-2 rounded border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] p-1.5 text-[8px] text-[var(--color-text-muted,#6b7280)]">
                  <div className="mb-1 tracking-widest text-[var(--color-text-faint,#9ca3af)]">EXPECTED DENY EXAMPLES</div>
                  <ul className="space-y-0.5">
                    {preview.denyExamples.map((deny) => (
                      <li key={`${deny.code}-${deny.message.slice(0, 12)}`}>• {deny.code}: {deny.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.warnings.length > 0 && (
                <div className="mt-2 flex items-start gap-1.5 text-[8px] text-[var(--color-warning,#ff4d00)]">
                  <ShieldAlert size={10} className="mt-[1px]" />
                  <span>{preview.warnings.join(' | ')}</span>
                </div>
              )}
            </div>
          )}

          {issuedToken && (
            <div className="mt-3 rounded border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] p-2">
              <div className="mb-1 flex items-center justify-between">
                <div className="text-[8px] tracking-widest text-[var(--color-success,#16a34a)]">API KEY ISSUED</div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { void handleCopyToken(); }}
                  icon={<Copy size={10} />}
                >
                  {copied ? 'COPIED' : 'COPY'}
                </Button>
              </div>
              {issuedMeta && (
                <div className="mb-1 text-[8px] text-[var(--color-text-faint,#9ca3af)]">{issuedMeta}</div>
              )}
              <code className="block max-h-20 overflow-y-auto break-all bg-[var(--color-background,#f4f4f5)] px-2 py-1 text-[9px] text-[var(--color-text,#0a0a0a)]">
                {issuedToken}
              </code>
            </div>
          )}
        </section>

        <section className="order-2 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[10px] font-bold tracking-widest text-[var(--color-text,#0a0a0a)]">PROFILE BUILDER</div>
            {editingProfileId && (
              <Button variant="ghost" size="sm" onClick={resetProfileForm}>
                NEW
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2">
            <TextInput
              label="Profile Name"
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
              placeholder="e.g. CI deploy scoped"
              compact
            />

            <FilterDropdown
              label="Load from template"
              options={BUILTIN_PROFILE_OPTIONS.map((profile) => ({ value: profile.id, label: `${profile.label} — ${profile.description}` }))}
              value={profileBase}
              onChange={(next) => {
                setProfileBase(next);
                applyBaseTemplate(next);
              }}
              compact
            />
            {profileBase && PROFILE_DESCRIPTIONS[profileBase] && (
              <div className="px-1 text-[8px] text-[var(--color-text-muted,#6b7280)]">
                {PROFILE_DESCRIPTIONS[profileBase]}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <TextInput
                label="TTL Override"
                value={profileTtlSeconds}
                onChange={(event) => setProfileTtlSeconds(event.target.value)}
                placeholder="seconds"
                compact
              />
              <TextInput
                label="Max Reads"
                value={profileMaxReads}
                onChange={(event) => setProfileMaxReads(event.target.value)}
                placeholder="count"
                compact
              />
            </div>

            <div className="space-y-1">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-1.5">
                <FilterDropdown
                  label="Scope"
                  options={TOKEN_PERMISSION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                  value={profileScopeCandidate}
                  onChange={setProfileScopeCandidate}
                  compact
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => addProfileScope(profileScopeCandidate)}
                >
                  ADD
                </Button>
              </div>
              {profileScopes.length === 0 ? (
                <div className="px-1 text-[8px] text-[var(--color-text-faint,#9ca3af)]">
                  Using base profile scope defaults.
                </div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {profileScopes.map((scope) => (
                    <span
                      key={`scope-${scope}`}
                      className="inline-flex items-center gap-1 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background,#f4f4f5)] px-1.5 py-0.5 text-[8px] text-[var(--color-text,#0a0a0a)]"
                    >
                      {scope}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeProfileScope(scope)}
                        className="h-4 px-1 text-[8px]"
                      >
                        X
                      </Button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="px-1 text-[8px] text-[var(--color-text-faint,#9ca3af)]">
              Scope uses the same permission vocabulary as Issue API Key (for example: <code>secret:read</code>, <code>secret:write</code>, <code>wallet:create:hot</code>, <code>send:hot</code>).
            </div>

            <TextInput
              label="Exclude Fields (CSV)"
              value={profileExcludeFields}
              onChange={(event) => setProfileExcludeFields(event.target.value)}
              placeholder="password, seedPhrase"
              compact
            />

            {agentScopeOptions.length > 1 && (
              <div className="space-y-1">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-1.5">
                  <FilterDropdown
                    label="Agent Read/Write Scope"
                    options={agentScopeOptions}
                    value={agentScopeOptions[0]?.value || 'agent:*'}
                    onChange={(value) => {
                      if (!profileAgentScopes.includes(value)) {
                        setProfileAgentScopes((prev) => [...prev, value]);
                      }
                    }}
                    compact
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setProfileAgentScopes([])}
                  >
                    CLEAR
                  </Button>
                </div>
                {profileAgentScopes.length === 0 ? (
                  <div className="px-1 text-[8px] text-[var(--color-text-faint,#9ca3af)]">
                    Using base profile agent defaults.
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {profileAgentScopes.map((scope) => (
                      <span
                        key={`pvs-${scope}`}
                        className="inline-flex items-center gap-1 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background,#f4f4f5)] px-1.5 py-0.5 text-[8px] text-[var(--color-text,#0a0a0a)]"
                      >
                        {scope}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setProfileAgentScopes((prev) => prev.filter((s) => s !== scope))}
                          className="h-4 px-1 text-[8px]"
                        >
                          X
                        </Button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="px-1 text-[8px] text-[var(--color-text-faint,#9ca3af)]">
                  Restricts which agents this profile can read/write credentials from. Select specific agents or leave empty for profile defaults.
                </div>
              </div>
            )}
          </div>

          {profileError && (
            <div className="mt-2 text-[9px] text-[var(--color-danger,#ef4444)]">{profileError}</div>
          )}
          {profileNotice && (
            <div className="mt-2 text-[9px] text-[var(--color-success,#16a34a)]">{profileNotice}</div>
          )}

          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={handleSaveProfile} icon={<ShieldCheck size={11} />}>
              {editingProfileId ? 'UPDATE PROFILE' : 'CREATE PROFILE'}
            </Button>
            {editingProfileId && (
              <Button variant="secondary" size="sm" onClick={resetProfileForm}>
                CANCEL
              </Button>
            )}
          </div>

          <div className="mt-4 border-t border-[var(--color-border,#d4d4d8)] pt-3">
            <div className="mb-2 text-[9px] font-bold tracking-widest text-[var(--color-text-muted,#6b7280)]">
              SAVED PROFILES ({profiles.length})
            </div>
            {profiles.length === 0 ? (
              <div className="text-[9px] text-[var(--color-text-faint,#9ca3af)]">No custom profiles saved yet.</div>
            ) : (
              <div className="space-y-2">
                {profiles.map((profile) => (
                  <div key={profile.id} className="flex items-center justify-between border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background,#f4f4f5)] px-2 py-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEditProfile(profile)}
                      className="h-auto min-h-0 w-full justify-start px-0 py-0 text-left hover:bg-transparent"
                    >
                      <span className="block">
                        <span className="block text-[10px] text-[var(--color-text,#0a0a0a)]">{profile.name}</span>
                        <span className="block text-[8px] text-[var(--color-text-faint,#9ca3af)]">{profile.profile}@{profile.profileVersion}</span>
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteProfile(profile.id)}
                      icon={<Trash2 size={10} />}
                    >
                      {''}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] p-3">
          <div className="mb-2 text-[10px] font-bold tracking-widest text-[var(--color-text,#0a0a0a)]">PENDING AUTH REQUESTS</div>
          {requestNotice && (
            <div className="mb-2 text-[9px] text-[var(--color-text-muted,#6b7280)]">{requestNotice}</div>
          )}
          {pendingAuthRequests.length === 0 ? (
            <div className="text-[9px] text-[var(--color-text-faint,#9ca3af)]">No pending auth requests.</div>
          ) : (
            <div className="space-y-2">
              {pendingAuthRequests.map((request) => {
                const metadata = parseMetadata(request.metadata);
                const agentId = typeof metadata.agentId === 'string' ? metadata.agentId : 'unknown-agent';
                const profileObj = typeof metadata.profile === 'object' && metadata.profile && 'id' in metadata.profile
                  ? metadata.profile as Record<string, unknown>
                  : null;
                const profileLabel = profileObj
                  ? `${String(profileObj.id)}@${String(profileObj.version || 'v1')}`
                  : 'n/a';
                const profileDesc = profileObj ? describeProfileId(String(profileObj.id)) : null;
                const perms = Array.isArray(metadata.permissions) ? metadata.permissions as string[] : [];
                const resolving = actionLoading === `resolve-${request.id}`;
                return (
                  <div key={request.id} className="rounded border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background,#f4f4f5)] p-2">
                    <div className="text-[9px] text-[var(--color-text,#0a0a0a)]">
                      {agentId} · {request.type}
                    </div>
                    <div className="mt-1 text-[8px] text-[var(--color-text-faint,#9ca3af)]">
                      {profileLabel} · {new Date(request.createdAt).toLocaleString()}
                    </div>
                    {profileDesc && (
                      <div className="mt-1 text-[8px] text-[var(--color-text-muted,#6b7280)]">
                        {profileDesc}
                      </div>
                    )}
                    {perms.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {perms.slice(0, 6).map((p) => (
                          <span key={p} className="border border-[var(--color-border,#d4d4d8)] px-1 py-0.5 text-[7px] text-[var(--color-text-muted,#6b7280)]">
                            {String(p)}
                          </span>
                        ))}
                        {perms.length > 6 && (
                          <span className="px-1 py-0.5 text-[7px] text-[var(--color-text-faint,#9ca3af)]">
                            +{perms.length - 6} more
                          </span>
                        )}
                      </div>
                    )}
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => { void handleResolveRequest(request.id, true); }}
                        loading={resolving}
                        icon={!resolving ? <Check size={10} /> : undefined}
                      >
                        APPROVE
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => { void handleResolveRequest(request.id, false); }}
                        disabled={resolving}
                        icon={<AlertTriangle size={10} />}
                      >
                        REJECT
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] p-3">
          <div className="mb-2 text-[10px] font-bold tracking-widest text-[var(--color-text,#0a0a0a)]">ISSUED API KEYS</div>

          <div className="mb-2 text-[8px] tracking-widest text-[var(--color-text-faint,#9ca3af)]">
            ACTIVE ({managedActiveTokens.length})
          </div>
          {managedActiveTokens.length === 0 ? (
            <div className="mb-3 text-[9px] text-[var(--color-text-faint,#9ca3af)]">No active non-admin tokens.</div>
          ) : (
            <div className="mb-3 space-y-2">
              {managedActiveTokens.map((token) => {
                const revoking = actionLoading === `revoke-${token.tokenHash}`;
                return (
                  <div key={token.tokenHash} className="rounded border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background,#f4f4f5)] p-2">
                    <div className="flex items-center justify-between">
                      <div className="text-[9px] text-[var(--color-text,#0a0a0a)]">{token.agentId}</div>
                      <div className="text-[8px] text-[var(--color-text-faint,#9ca3af)]">{shortHash(token.tokenHash)}</div>
                    </div>
                    <div className="mt-1 text-[8px] text-[var(--color-text-faint,#9ca3af)]">
                      perms: {token.permissions.length} · expires: {new Date(token.expiresAt).toLocaleString()}
                    </div>
                    <div className="mt-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => { void onRevokeToken(token.tokenHash); }}
                        disabled={revoking}
                        icon={revoking ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                      >
                        REVOKE
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mb-2 text-[8px] tracking-widest text-[var(--color-text-faint,#9ca3af)]">
            INACTIVE ({inactiveTokens.length})
          </div>
          {inactiveTokens.length === 0 ? (
            <div className="text-[9px] text-[var(--color-text-faint,#9ca3af)]">No inactive tokens.</div>
          ) : (
            <div className="space-y-1.5">
              {inactiveTokens.slice(0, 8).map((token) => (
                <div key={`${token.agentId}-${token.tokenHash}`} className="flex items-center justify-between rounded border border-[var(--color-border,#d4d4d8)] px-2 py-1 text-[8px] text-[var(--color-text-muted,#6b7280)]">
                  <span>{token.agentId}</span>
                  <span>{shortHash(token.tokenHash)}</span>
                </div>
              ))}
              {inactiveTokens.length > 8 && (
                <div className="text-[8px] text-[var(--color-text-faint,#9ca3af)]">
                  +{inactiveTokens.length - 8} more inactive tokens
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
