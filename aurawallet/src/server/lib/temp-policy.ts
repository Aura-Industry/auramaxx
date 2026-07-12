import { createHash } from 'crypto';
import { AgentTokenPayload } from '../types';
import { normalizeAddress } from './address';

export const TEMP_POLICY_COMPILER_VERSION = 'v1';

export type RequestedPolicySource = 'agent' | 'derived_403';
export type ApprovalScope = 'one_shot_read' | 'session_token';

export interface TempPolicy {
  permissions: string[];
  limits?: AgentTokenPayload['limits'];
  walletAccess?: string[];
  credentialAccess?: NonNullable<AgentTokenPayload['credentialAccess']>;
  ttlSeconds?: number;
  maxUses?: number;
}

export interface TempPolicyContract {
  requiredPermissions: string[];
  allowedPermissions: string[];
  requiredReadScopes?: string[];
  allowedReadScopes?: string[];
  requiredWriteScopes?: string[];
  allowedWriteScopes?: string[];
  maxTtlSeconds: number;
  defaultTtlSeconds: number;
  maxUses: number;
  defaultMaxUses: number;
  allowLimits?: boolean;
  allowWalletAccess?: boolean;
  enforceExcludeFieldsFromDerived?: boolean;
}

export interface PolicyOperationBindingInput {
  actorId: string;
  method: string;
  routeId: string;
  resource: Record<string, unknown>;
  body?: Record<string, unknown>;
}

export interface PolicyOperationBinding {
  actorId: string;
  method: string;
  routeId: string;
  resourceHash: string;
  bodyHash: string;
  bindingHash: string;
}

export interface TokenOperationBinding extends PolicyOperationBinding {
  reqId?: string;
  approvalScope?: ApprovalScope;
  policyHash: string;
  compilerVersion: string;
}

export interface CompiledTempPolicy {
  requestedPolicySource: RequestedPolicySource;
  requestedPolicy?: TempPolicy;
  effectivePolicy: TempPolicy;
  policyHash: string;
  compilerVersion: string;
  binding: PolicyOperationBinding;
}

export interface TempPolicyCompileResult {
  ok: true;
  value: CompiledTempPolicy;
}

export interface TempPolicyCompileErrorResult {
  ok: false;
  errorCode:
    | 'client_policy_not_allowed_for_derived_source'
    | 'policy_unsatisfied_for_retry'
    | 'invalid_requested_policy';
  message: string;
}

export type TempPolicyCompileOutcome = TempPolicyCompileResult | TempPolicyCompileErrorResult;

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(input.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)));
}

function normalizeLimitValue(input: unknown): AgentTokenPayload['limits'] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const next: NonNullable<AgentTokenPayload['limits']> = {};
  for (const key of ['fund', 'send', 'swap', 'launch'] as const) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      next[key] = value;
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record: Record<string, number> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          record[k] = v;
        }
      }
      if (Object.keys(record).length > 0) {
        next[key] = record;
      }
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeCredentialAccess(input: unknown): TempPolicy['credentialAccess'] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const next: NonNullable<TempPolicy['credentialAccess']> = {};
  const read = normalizeStringArray(source.read);
  const write = normalizeStringArray(source.write);
  const excludeFields = normalizeStringArray(source.excludeFields);
  const ttl = typeof source.ttl === 'number' && Number.isFinite(source.ttl) ? Math.floor(source.ttl) : undefined;
  const maxReads = typeof source.maxReads === 'number' && Number.isFinite(source.maxReads) ? Math.floor(source.maxReads) : undefined;

  if (read.length > 0) next.read = read;
  if (write.length > 0) next.write = write;
  if (excludeFields.length > 0 || Array.isArray(source.excludeFields)) next.excludeFields = excludeFields;
  if (typeof ttl === 'number' && ttl > 0) next.ttl = ttl;
  if (typeof maxReads === 'number' && maxReads > 0) next.maxReads = maxReads;
  return Object.keys(next).length > 0 ? next : undefined;
}

export function parseRequestedPolicy(input: unknown): TempPolicy | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const permissions = normalizeStringArray(source.permissions);
  if (permissions.length === 0) return undefined;

  const limits = normalizeLimitValue(source.limits);
  const credentialAccess = normalizeCredentialAccess(source.credentialAccess);
  const walletAccess = normalizeStringArray(source.walletAccess).map((address) => normalizeAddress(address));
  const ttlSeconds = typeof source.ttlSeconds === 'number' && Number.isFinite(source.ttlSeconds)
    ? Math.max(1, Math.floor(source.ttlSeconds))
    : undefined;
  const maxUses = typeof source.maxUses === 'number' && Number.isFinite(source.maxUses)
    ? Math.max(1, Math.floor(source.maxUses))
    : undefined;

  return {
    permissions,
    ...(limits ? { limits } : {}),
    ...(walletAccess.length > 0 ? { walletAccess } : {}),
    ...(credentialAccess ? { credentialAccess } : {}),
    ...(typeof ttlSeconds === 'number' ? { ttlSeconds } : {}),
    ...(typeof maxUses === 'number' ? { maxUses } : {}),
  };
}

function canonicalizeJson(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((value) => canonicalizeJson(value));
  }
  if (!input || typeof input !== 'object') return input;
  const source = input as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    next[key] = canonicalizeJson(source[key]);
  }
  return next;
}

function hashCanonical(value: unknown): string {
  const canonical = JSON.stringify(canonicalizeJson(value));
  return createHash('sha256').update(canonical).digest('hex');
}

function intersectScopes(candidate: string[] | undefined, allowed: string[] | undefined): string[] | undefined {
  if (!candidate || candidate.length === 0) return undefined;
  if (typeof allowed === 'undefined') return candidate;
  if (allowed.length === 0) return [];
  const allowedSet = new Set(allowed);
  const filtered = candidate.filter((scope) => allowedSet.has(scope));
  return filtered;
}

function mergePolicyCandidate(
  derived: TempPolicy,
  requestedPolicySource: RequestedPolicySource,
  requested?: TempPolicy,
): TempPolicy {
  if (requestedPolicySource === 'agent' && requested) {
    return requested;
  }
  return derived;
}

function normalizeMethod(method: string): string {
  const upper = method.trim().toUpperCase();
  return upper || 'GET';
}

function buildBinding(input: {
  binding: PolicyOperationBindingInput;
  policyHash: string;
}): PolicyOperationBinding {
  const actorId = input.binding.actorId.trim() || 'agent';
  const method = normalizeMethod(input.binding.method);
  const routeId = input.binding.routeId.trim() || 'unknown.route';
  const resourceHash = hashCanonical(input.binding.resource);
  const bodyHash = hashCanonical(input.binding.body || {});
  const bindingHash = hashCanonical({
    compilerVersion: TEMP_POLICY_COMPILER_VERSION,
    actorId,
    method,
    routeId,
    resourceHash,
    bodyHash,
    policyHash: input.policyHash,
  });
  return {
    actorId,
    method,
    routeId,
    resourceHash,
    bodyHash,
    bindingHash,
  };
}

export function buildOperationBindingHashes(input: {
  actorId: string;
  method: string;
  routeId: string;
  resource: Record<string, unknown>;
  body?: Record<string, unknown>;
  policyHash: string;
}): PolicyOperationBinding {
  return buildBinding({
    binding: {
      actorId: input.actorId,
      method: input.method,
      routeId: input.routeId,
      resource: input.resource,
      body: input.body || {},
    },
    policyHash: input.policyHash,
  });
}

export function parsePolicyOperationBinding(input: unknown): PolicyOperationBinding | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const actorId = typeof source.actorId === 'string' ? source.actorId.trim() : '';
  const method = typeof source.method === 'string' ? source.method.trim().toUpperCase() : '';
  const routeId = typeof source.routeId === 'string' ? source.routeId.trim() : '';
  const resourceHash = typeof source.resourceHash === 'string' ? source.resourceHash.trim() : '';
  const bodyHash = typeof source.bodyHash === 'string' ? source.bodyHash.trim() : '';
  const bindingHash = typeof source.bindingHash === 'string' ? source.bindingHash.trim() : '';
  if (!actorId || !method || !routeId || !resourceHash || !bodyHash || !bindingHash) return undefined;
  return {
    actorId,
    method,
    routeId,
    resourceHash,
    bodyHash,
    bindingHash,
  };
}

export function compileTempPolicy(input: {
  requestedPolicySource: RequestedPolicySource;
  requestedPolicy?: TempPolicy;
  hasRequestedPolicyInput?: boolean;
  derivedPolicy: TempPolicy;
  contract: TempPolicyContract;
  binding: PolicyOperationBindingInput;
}): TempPolicyCompileOutcome {
  const hasRequestedPolicyInput = input.hasRequestedPolicyInput ?? Boolean(input.requestedPolicy);
  if (input.requestedPolicySource === 'derived_403' && hasRequestedPolicyInput) {
    return {
      ok: false,
      errorCode: 'client_policy_not_allowed_for_derived_source',
      message: 'requestedPolicy is not allowed when requestedPolicySource=derived_403',
    };
  }
  if (input.requestedPolicySource === 'agent' && !input.requestedPolicy) {
    return {
      ok: false,
      errorCode: 'invalid_requested_policy',
      message: 'requestedPolicy is required when requestedPolicySource=agent',
    };
  }

  const candidate = mergePolicyCandidate(input.derivedPolicy, input.requestedPolicySource, input.requestedPolicy);
  if (!candidate.permissions || candidate.permissions.length === 0) {
    return {
      ok: false,
      errorCode: 'invalid_requested_policy',
      message: 'requestedPolicy.permissions must be a non-empty array',
    };
  }

  const requiredPermissions = new Set(input.contract.requiredPermissions);
  const allowedPermissions = new Set(input.contract.allowedPermissions);
  const candidatePermissions = Array.from(new Set(candidate.permissions));
  const effectivePermissions = candidatePermissions.filter((permission) => allowedPermissions.has(permission));
  const hasAllRequiredPermissions = Array.from(requiredPermissions).every((permission) => effectivePermissions.includes(permission));
  if (!hasAllRequiredPermissions) {
    return {
      ok: false,
      errorCode: 'policy_unsatisfied_for_retry',
      message: 'effective policy does not satisfy required permissions for retry',
    };
  }

  const candidateCredentialAccess = candidate.credentialAccess || input.derivedPolicy.credentialAccess || {};
  const derivedCredentialAccess = input.derivedPolicy.credentialAccess || {};
  const readScopes = intersectScopes(candidateCredentialAccess.read, input.contract.allowedReadScopes) || [];
  const writeScopes = intersectScopes(candidateCredentialAccess.write, input.contract.allowedWriteScopes) || [];

  if (input.contract.requiredReadScopes && input.contract.requiredReadScopes.some((scope) => !readScopes.includes(scope))) {
    return {
      ok: false,
      errorCode: 'policy_unsatisfied_for_retry',
      message: 'effective policy does not satisfy required read scopes for retry',
    };
  }
  if (input.contract.requiredWriteScopes && input.contract.requiredWriteScopes.some((scope) => !writeScopes.includes(scope))) {
    return {
      ok: false,
      errorCode: 'policy_unsatisfied_for_retry',
      message: 'effective policy does not satisfy required write scopes for retry',
    };
  }

  const ttlSecondsRaw = candidate.ttlSeconds
    ?? candidateCredentialAccess.ttl
    ?? input.derivedPolicy.ttlSeconds
    ?? derivedCredentialAccess.ttl
    ?? input.contract.defaultTtlSeconds;
  const ttlSeconds = Math.max(1, Math.min(Math.floor(ttlSecondsRaw), input.contract.maxTtlSeconds));

  const maxUsesRaw = candidate.maxUses
    ?? candidateCredentialAccess.maxReads
    ?? input.derivedPolicy.maxUses
    ?? derivedCredentialAccess.maxReads
    ?? input.contract.defaultMaxUses;
  const maxUses = Math.max(1, Math.min(Math.floor(maxUsesRaw), input.contract.maxUses));

  const excludeFields = input.contract.enforceExcludeFieldsFromDerived
    ? (derivedCredentialAccess.excludeFields || [])
    : (candidateCredentialAccess.excludeFields ?? derivedCredentialAccess.excludeFields ?? []);

  const walletAccess = input.contract.allowWalletAccess
    ? (candidate.walletAccess || input.derivedPolicy.walletAccess)
    : undefined;

  const effectivePolicy: TempPolicy = {
    permissions: effectivePermissions,
    ...(input.contract.allowLimits ? (candidate.limits || input.derivedPolicy.limits ? { limits: candidate.limits || input.derivedPolicy.limits } : {}) : {}),
    ...(walletAccess && walletAccess.length > 0 ? { walletAccess } : {}),
    credentialAccess: {
      read: readScopes,
      write: writeScopes,
      excludeFields,
      ttl: ttlSeconds,
      maxReads: maxUses,
    },
    ttlSeconds,
    maxUses,
  };

  const policyHash = hashCanonical({
    compilerVersion: TEMP_POLICY_COMPILER_VERSION,
    policy: effectivePolicy,
  });

  const binding = buildBinding({
    binding: input.binding,
    policyHash,
  });

  return {
    ok: true,
    value: {
      requestedPolicySource: input.requestedPolicySource,
      ...(input.requestedPolicy ? { requestedPolicy: input.requestedPolicy } : {}),
      effectivePolicy,
      policyHash,
      compilerVersion: TEMP_POLICY_COMPILER_VERSION,
      binding,
    },
  };
}

export function operationBindingMatches(input: {
  binding: Pick<PolicyOperationBinding, 'actorId' | 'method' | 'routeId' | 'resourceHash' | 'bodyHash'>;
  actorId: string;
  method: string;
  routeId: string;
  resource: Record<string, unknown>;
  body?: Record<string, unknown>;
}): boolean {
  const expectedMethod = normalizeMethod(input.method);
  const expectedResourceHash = hashCanonical(input.resource);
  const expectedBodyHash = hashCanonical(input.body || {});
  return (
    input.binding.actorId === input.actorId
    && input.binding.method === expectedMethod
    && input.binding.routeId === input.routeId
    && input.binding.resourceHash === expectedResourceHash
    && input.binding.bodyHash === expectedBodyHash
  );
}
