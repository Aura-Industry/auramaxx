import { createHash } from 'crypto';
import { expandPermissions } from './permissions';
import type { AgentTokenPayload } from '../types';
import { normalizeScope } from './credential-scope';

export type AgentProfileId =
  | 'strict'
  | 'dev'
  | 'admin';

export const LOCAL_AGENT_PROFILE_MODES = ['strict', 'dev', 'admin'] as const;
export type LocalAgentProfileMode = typeof LOCAL_AGENT_PROFILE_MODES[number];

export interface AgentPolicyProfileV1 {
  id: AgentProfileId;
  version: 'v1';
  displayName: string;
  description: string;
  rationale: string;
  permissions: string[];
  credentialAccess: {
    readScopes: string[];
    writeScopes: string[];
    excludeFields: string[];
    maxReads?: number;
  };
  tokenDefaults: {
    ttlSeconds: number;
    maxReads?: number;
  };
  warnings: string[];
}

export interface ResolveProfileInput {
  profileId: string;
  profileVersion?: string;
  overrides?: {
    ttlSeconds?: number;
    maxReads?: number;
    scope?: string[];
    readScopes?: string[];
    writeScopes?: string[];
    excludeFields?: string[];
  };
}

export interface ResolvedProfilePolicy {
  profile: {
    id: AgentProfileId;
    version: 'v1';
    displayName: string;
    rationale: string;
  };
  permissions: string[];
  ttlSeconds: number;
  credentialAccess: NonNullable<AgentTokenPayload['credentialAccess']>;
  warnings: string[];
  overrideDelta: string[];
  effectivePolicyHash: string;
}

export class AgentProfileError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentProfileError';
    this.code = code;
  }
}

const BUILTIN_PROFILES: AgentPolicyProfileV1[] = [
  {
    id: 'strict',
    version: 'v1',
    displayName: 'Strict',
    description: 'Manual-approval-first baseline profile for local agents.',
    rationale: 'Use when you want every agent token request reviewed by a human.',
    permissions: ['secret:read'],
    credentialAccess: {
      // Include current primary id and legacy id to keep strict reads working across migrations.
      readScopes: ['agent:primary', 'agent:agent'],
      writeScopes: [],
      excludeFields: ['password', 'cvv', 'privateKey', 'seedPhrase', 'refresh_token'],
      maxReads: 50,
    },
    tokenDefaults: { ttlSeconds: 3600, maxReads: 50 },
    warnings: ['Pair with trust.localAutoApprove=false for strict local approval flow. Credential access is limited to the primary agent only (legacy agent id also allowed).'],
  },
  {
    id: 'dev',
    version: 'v1',
    displayName: 'Dev',
    description: 'Developer profile for local agent automation with non-financial scope.',
    rationale: 'Use for day-to-day local dev workflows without granting financial operations.',
    permissions: [
      'wallet:list',
      'secret:read',
      'secret:write',
      'action:create',
      'action:read',
      'action:resolve',
      'social:read',
      'social:write',
    ],
    credentialAccess: {
      // Keep legacy `agent` alias for migrated installs while scoping to primary-only access.
      readScopes: ['agent:primary', 'agent:agent'],
      writeScopes: ['agent:primary', 'agent:agent'],
      excludeFields: ['cvv', 'seedPhrase', 'privateKey', 'refresh_token'],
      maxReads: 500,
    },
    tokenDefaults: { ttlSeconds: 7 * 24 * 60 * 60, maxReads: 500 },
    warnings: ['Includes secret:write. Credential scope is limited to the primary agent (legacy alias included).'],
  },
  {
    id: 'admin',
    version: 'v1',
    displayName: 'Admin',
    description: 'Full-access local agent profile.',
    rationale: 'Use only when you explicitly trust the local agent process with broad access.',
    permissions: ['admin:*'],
    credentialAccess: {
      readScopes: ['*'],
      writeScopes: ['*'],
      excludeFields: [],
    },
    tokenDefaults: { ttlSeconds: 7 * 24 * 60 * 60 },
    warnings: ['Dangerous profile: grants admin:* (full access). Not recommended for primary agent workflows.'],
  },
];

export function listProfiles(): AgentPolicyProfileV1[] {
  return BUILTIN_PROFILES.map((p) => ({ ...p }));
}

export function getProfile(id: string, version: string = 'v1'): AgentPolicyProfileV1 {
  const anyVersion = BUILTIN_PROFILES.find((p) => p.id === id);
  if (!anyVersion) {
    throw new AgentProfileError('AGENT_PROFILE_NOT_FOUND', `Unknown profile: ${id}@${version}`);
  }
  const profile = BUILTIN_PROFILES.find((p) => p.id === id && p.version === version);
  if (!profile) {
    throw new AgentProfileError('AGENT_PROFILE_VERSION_UNSUPPORTED', `Unsupported profile version: ${id}@${version}`);
  }
  return profile;
}

function canonicalScopes(scopes: string[] | undefined): string[] {
  const normalized = (scopes || []).map(normalizeScope);
  if (normalized.some((scope) => scope.includes('**') || scope.includes('(') || scope.includes(')'))) {
    throw new AgentProfileError('AGENT_PROFILE_SCOPE_INVALID', 'Scope selectors contain unsupported wildcard/pattern syntax');
  }
  return Array.from(new Set(normalized)).sort();
}

function canonicalStringList(values: string[] | undefined): string[] {
  return Array.from(new Set((values || []).map((v) => v.trim()).filter(Boolean))).sort();
}

function hashPolicy(policy: Omit<ResolvedProfilePolicy, 'effectivePolicyHash'>): string {
  const stable = JSON.stringify({
    permissions: Array.from(new Set(policy.permissions)).sort(),
    credentialAccess: {
      read: Array.from(new Set(policy.credentialAccess.read || [])).sort(),
      write: Array.from(new Set(policy.credentialAccess.write || [])).sort(),
      excludeFields: Array.from(new Set(policy.credentialAccess.excludeFields || [])).sort(),
      maxReads: typeof policy.credentialAccess.maxReads === 'number' ? policy.credentialAccess.maxReads : null,
    },
    ttlSeconds: policy.ttlSeconds,
    maxReads: typeof policy.credentialAccess.maxReads === 'number' ? policy.credentialAccess.maxReads : null,
    rateBudget: {
      state: 'none',
      requests: null,
      windowSeconds: null,
      source: 'none',
    },
  });
  return createHash('sha256').update(stable).digest('hex');
}

export function resolveProfileToEffectivePolicy(input: ResolveProfileInput): ResolvedProfilePolicy {
  const profile = getProfile(input.profileId, input.profileVersion || 'v1');
  const overrides = input.overrides || {};

  const profileReadScopes = canonicalScopes(profile.credentialAccess.readScopes);
  const profileWriteScopes = canonicalScopes(profile.credentialAccess.writeScopes);
  const profileExclude = canonicalStringList(profile.credentialAccess.excludeFields);

  const overrideDelta: string[] = [];

  let ttlSeconds = profile.tokenDefaults.ttlSeconds;
  if (overrides.ttlSeconds !== undefined) {
    if (overrides.ttlSeconds <= 0 || overrides.ttlSeconds > ttlSeconds) {
      throw new AgentProfileError('AGENT_PROFILE_OVERRIDE_NOT_ALLOWED', 'ttlSeconds override must be positive and tighten-only');
    }
    ttlSeconds = overrides.ttlSeconds;
    overrideDelta.push('ttlSeconds');
  }

  let maxReads = profile.credentialAccess.maxReads ?? profile.tokenDefaults.maxReads;
  if (overrides.maxReads !== undefined) {
    if (overrides.maxReads <= 0 || (typeof maxReads === 'number' && overrides.maxReads > maxReads)) {
      throw new AgentProfileError('AGENT_PROFILE_OVERRIDE_NOT_ALLOWED', 'maxReads override must be positive and tighten-only');
    }
    maxReads = overrides.maxReads;
    overrideDelta.push('maxReads');
  }

  const profilePermissions = Array.from(new Set(expandPermissions(profile.permissions))).sort();
  const scopePermissions = overrides.scope ? Array.from(new Set(expandPermissions(overrides.scope))).sort() : profilePermissions;
  if (overrides.scope) {
    if (!scopePermissions.every((permission) => profilePermissions.includes(permission))) {
      throw new AgentProfileError('AGENT_PROFILE_OVERRIDE_NOT_ALLOWED', 'scope override cannot broaden profile permissions');
    }
    overrideDelta.push('scope');
  }

  const readScopes = overrides.readScopes ? canonicalScopes(overrides.readScopes) : profileReadScopes;
  const writeScopes = overrides.writeScopes ? canonicalScopes(overrides.writeScopes) : profileWriteScopes;

  if (overrides.readScopes) {
    if (!readScopes.every((scope) => profileReadScopes.includes(scope))) {
      throw new AgentProfileError('AGENT_PROFILE_OVERRIDE_NOT_ALLOWED', 'readScopes override cannot broaden profile scope');
    }
    overrideDelta.push('readScopes');
  }

  if (overrides.writeScopes) {
    if (!writeScopes.every((scope) => profileWriteScopes.includes(scope))) {
      throw new AgentProfileError('AGENT_PROFILE_OVERRIDE_NOT_ALLOWED', 'writeScopes override cannot broaden profile scope');
    }
    overrideDelta.push('writeScopes');
  }

  if (readScopes.length === 0 && writeScopes.length === 0) {
    throw new AgentProfileError('AGENT_PROFILE_SCOPE_EMPTY', 'Resolved profile selectors are empty');
  }

  const excludeFields = overrides.excludeFields ? canonicalStringList(overrides.excludeFields) : profileExclude;
  if (overrides.excludeFields) {
    const attemptedRemoval = profileExclude.some((field) => !excludeFields.includes(field));
    if (attemptedRemoval) {
      throw new AgentProfileError('AGENT_PROFILE_OVERRIDE_NOT_ALLOWED', 'excludeFields override cannot remove profile-required exclusions');
    }
    overrideDelta.push('excludeFields');
  }

  const resolvedBase: Omit<ResolvedProfilePolicy, 'effectivePolicyHash'> = {
    profile: {
      id: profile.id,
      version: profile.version,
      displayName: profile.displayName,
      rationale: profile.rationale,
    },
    permissions: scopePermissions,
    ttlSeconds,
    credentialAccess: {
      read: readScopes,
      write: writeScopes,
      excludeFields,
      ...(typeof maxReads === 'number' ? { maxReads } : {}),
    },
    warnings: [...profile.warnings],
    overrideDelta: Array.from(new Set(overrideDelta)).sort(),
  };

  return {
    ...resolvedBase,
    effectivePolicyHash: hashPolicy(resolvedBase),
  };
}

export function summarizeEffectivePolicy(policy: ResolvedProfilePolicy): string {
  return [
    `${policy.profile.id}@${policy.profile.version}`,
    `permissions=${policy.permissions.join(',')}`,
    `ttl=${policy.ttlSeconds}s`,
    `read=${(policy.credentialAccess.read || []).join(',') || 'none'}`,
    `write=${(policy.credentialAccess.write || []).join(',') || 'none'}`,
  ].join(' | ');
}

// ---------------------------------------------------------------------------
// Human-readable profile/policy descriptions
// ---------------------------------------------------------------------------

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'swap': 'Swap tokens via DEX',
  'send:hot': 'Send from hot wallets',
  'send:temp': 'Send from temp wallets',
  'fund': 'Transfer cold → hot',
  'launch': 'Launch tokens',
  'wallet:create:hot': 'Create hot wallets',
  'wallet:create:temp': 'Create temp wallets',
  'wallet:export': 'Export private keys',
  'wallet:list': 'List wallets',
  'wallet:rename': 'Rename wallets',
  'wallet:write': 'Modify wallets',
  'wallet:tx:add': 'Add transactions',
  'wallet:asset:add': 'Add assets',
  'wallet:asset:remove': 'Remove assets',
  'secret:read': 'Read credentials',
  'secret:write': 'Write credentials',
  'totp:read': 'Read TOTP codes',
  'action:create': 'Create action requests',
  'action:read': 'View action requests',
  'action:resolve': 'Approve/reject requests',
  'apikey:get': 'Read API keys',
  'apikey:set': 'Manage API keys',
  'workspace:modify': 'Modify workspace',
  'strategy:read': 'View strategies',
  'strategy:manage': 'Manage strategies',
  'app:storage': 'App storage',
  'app:storage:all': 'Full app storage',
  'app:accesskey': 'App access keys',
  'adapter:manage': 'Manage adapters',
  'addressbook:write': 'Modify address book',
  'bookmark:write': 'Modify bookmarks',
  'trade:all': 'All trading operations',
  'extension:*': 'All extensions',
  'admin:*': 'Full admin access',
};

function formatTtlReadable(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes`;
  const hours = Math.floor(seconds / 3600);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

function describeScopes(scopes: string[]): string {
  if (scopes.length === 0) return 'None';
  if (scopes.includes('*')) return 'All credentials';
  if (scopes.length === 1 && scopes[0] === 'agent:*') return 'All agents';
  return scopes.map((s) => {
    if (s.startsWith('agent:')) return `Agent "${s.slice(6)}"`;
    if (s.startsWith('tag:')) return `Tag "${s.slice(4)}"`;
    return s;
  }).join(', ');
}

export interface ProfileDescription {
  name: string;
  summary: string;
  permissions: string[];
  agentAccess: string;
  canWrite: boolean;
  hiddenFields: string[];
  ttl: string;
  maxReads: string;
  warnings: string[];
}

export function describeProfile(profileId: string, version: string = 'v1'): ProfileDescription {
  const profile = getProfile(profileId, version);
  return describeProfilePolicy(profile);
}

export function describeProfilePolicy(profile: AgentPolicyProfileV1): ProfileDescription {
  const permissions = profile.permissions.map((p) => PERMISSION_DESCRIPTIONS[p] || p);
  const readScopes = profile.credentialAccess.readScopes;
  const writeScopes = profile.credentialAccess.writeScopes;
  const canWrite = writeScopes.length > 0;
  const agentAccess = describeScopes(readScopes);
  const hiddenFields = profile.credentialAccess.excludeFields;
  const ttl = formatTtlReadable(profile.tokenDefaults.ttlSeconds);
  const maxReads = profile.credentialAccess.maxReads
    ? `${profile.credentialAccess.maxReads} reads`
    : 'Unlimited';

  const parts: string[] = [];
  parts.push(profile.description);
  if (canWrite) {
    parts.push(`Read/write access to ${agentAccess.toLowerCase()}.`);
  } else {
    parts.push(`Read-only access to ${agentAccess.toLowerCase()}.`);
  }
  if (hiddenFields.length > 0) {
    parts.push(`Hidden fields: ${hiddenFields.join(', ')}.`);
  }
  parts.push(`Expires after ${ttl}.`);

  return {
    name: profile.displayName,
    summary: parts.join(' '),
    permissions,
    agentAccess,
    canWrite,
    hiddenFields,
    ttl,
    maxReads,
    warnings: profile.warnings,
  };
}

export function describeResolvedPolicy(policy: ResolvedProfilePolicy): ProfileDescription {
  const permissions = policy.permissions.map((p) => PERMISSION_DESCRIPTIONS[p] || p);
  const readScopes = policy.credentialAccess.read || [];
  const writeScopes = policy.credentialAccess.write || [];
  const canWrite = writeScopes.length > 0;
  const agentAccess = describeScopes(readScopes);
  const hiddenFields = policy.credentialAccess.excludeFields || [];
  const ttl = formatTtlReadable(policy.ttlSeconds);
  const maxReads = typeof policy.credentialAccess.maxReads === 'number'
    ? `${policy.credentialAccess.maxReads} reads`
    : 'Unlimited';

  const parts: string[] = [];
  if (canWrite) {
    parts.push(`Read/write access to ${agentAccess.toLowerCase()}.`);
  } else {
    parts.push(`Read-only access to ${agentAccess.toLowerCase()}.`);
  }
  if (hiddenFields.length > 0) {
    parts.push(`Hidden fields: ${hiddenFields.join(', ')}.`);
  }
  parts.push(`Expires after ${ttl}.`);

  return {
    name: policy.profile.displayName,
    summary: parts.join(' '),
    permissions,
    agentAccess,
    canWrite,
    hiddenFields,
    ttl,
    maxReads,
    warnings: policy.warnings,
  };
}
