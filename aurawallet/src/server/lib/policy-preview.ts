import type { ResolveProfileInput, ResolvedProfilePolicy } from './agent-profiles';

export type DenyCode =
  | 'DENY_PERMISSION_MISSING'
  | 'DENY_CREDENTIAL_READ_SCOPE'
  | 'DENY_CREDENTIAL_WRITE_SCOPE'
  | 'DENY_EXCLUDED_FIELD'
  | 'DENY_MAX_READS_EXCEEDED'
  | 'DENY_RATE_LIMIT';

export interface PolicyPreviewV1 {
  version: 'v1';
  request: {
    profile: string;
    profileVersion: string;
    overrides?: ResolveProfileInput['overrides'];
  };
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
  effectivePolicyHash: string;
  overrideDelta: string[];
  warnings: string[];
  denyExamples: Array<{ code: DenyCode; message: string }>;
}

export function canonicalizeEffectivePolicy(policy: ResolvedProfilePolicy): PolicyPreviewV1['effectivePolicy'] {
  return {
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
  };
}

const DENY_ORDER: DenyCode[] = [
  'DENY_PERMISSION_MISSING',
  'DENY_CREDENTIAL_READ_SCOPE',
  'DENY_CREDENTIAL_WRITE_SCOPE',
  'DENY_EXCLUDED_FIELD',
  'DENY_MAX_READS_EXCEEDED',
  'DENY_RATE_LIMIT',
];

const DENY_MESSAGES: Record<DenyCode, string> = {
  DENY_PERMISSION_MISSING: 'Operation denied: required permission is not granted by this policy.',
  DENY_CREDENTIAL_READ_SCOPE: 'Credential read denied: target credential is outside allowed read scopes.',
  DENY_CREDENTIAL_WRITE_SCOPE: 'Credential write denied: target credential is outside allowed write scopes.',
  DENY_EXCLUDED_FIELD: 'Field access denied: requested field is explicitly excluded by policy.',
  DENY_MAX_READS_EXCEEDED: 'Read denied: token maxReads budget would be exceeded.',
  DENY_RATE_LIMIT: 'Rate limit denied: request would exceed configured token rate budget.',
};

export function buildDenyExamples(): Array<{ code: DenyCode; message: string }> {
  return DENY_ORDER.map((code) => ({ code, message: DENY_MESSAGES[code] }));
}

export function buildPolicyPreviewV1(
  input: ResolveProfileInput,
  resolved: ResolvedProfilePolicy,
): PolicyPreviewV1 {
  const profileVersion = input.profileVersion || resolved.profile.version;
  return {
    version: 'v1',
    request: {
      profile: input.profileId,
      profileVersion,
      ...(input.overrides ? { overrides: input.overrides } : {}),
    },
    effectivePolicy: canonicalizeEffectivePolicy(resolved),
    effectivePolicyHash: resolved.effectivePolicyHash,
    overrideDelta: [...resolved.overrideDelta],
    warnings: [...resolved.warnings],
    denyExamples: buildDenyExamples(),
  };
}

export interface PreviewErrorV1 {
  version: 'v1';
  code:
    | 'ERR_UNAUTHORIZED'
    | 'ERR_FORBIDDEN'
    | 'ERR_PROFILE_NOT_FOUND'
    | 'ERR_PROFILE_VERSION_UNSUPPORTED'
    | 'ERR_OVERRIDE_INVALID'
    | 'ERR_RESOLUTION_FAILED';
  error: string;
}

export function mapPreviewError(code: string): { status: number; error: PreviewErrorV1 } {
  if (code === 'AGENT_PROFILE_NOT_FOUND') {
    return {
      status: 404,
      error: { version: 'v1', code: 'ERR_PROFILE_NOT_FOUND', error: 'Requested profile does not exist.' },
    };
  }
  if (code === 'AGENT_PROFILE_VERSION_UNSUPPORTED') {
    return {
      status: 409,
      error: { version: 'v1', code: 'ERR_PROFILE_VERSION_UNSUPPORTED', error: 'Requested profile version is unsupported.' },
    };
  }
  if (code.startsWith('AGENT_PROFILE_')) {
    return {
      status: 422,
      error: { version: 'v1', code: 'ERR_OVERRIDE_INVALID', error: 'Profile overrides are invalid for the selected profile.' },
    };
  }
  return {
    status: 500,
    error: { version: 'v1', code: 'ERR_RESOLUTION_FAILED', error: 'Failed to resolve policy preview.' },
  };
}
