import { randomBytes } from 'crypto';

export type RuntimeMode = 'interactive_local' | 'headless_local' | 'remote';
export type AuthProvider = 'in_memory' | 'unix_socket' | 'keychain' | 'env' | 'interactive_auth' | 'pairing';

export const PROVIDER_ORDER: Record<RuntimeMode, AuthProvider[]> = {
  interactive_local: ['in_memory', 'unix_socket', 'keychain', 'env', 'interactive_auth', 'pairing'],
  headless_local: ['in_memory', 'unix_socket', 'keychain', 'env', 'pairing'],
  remote: ['in_memory', 'keychain', 'env', 'pairing'],
};

export function resolveProviderOrder(mode: RuntimeMode): AuthProvider[] {
  return [...PROVIDER_ORDER[mode]];
}

const KEY_PART = /^[a-z0-9._-]+$/;
const SCOPE_VALUES = new Set(['default', 'read', 'write', 'admin']);

export function normalizeKeyPart(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

export function toCanonicalKeychainKey(profile: string, agentId: string, scope: string): string {
  const normalizedProfile = normalizeKeyPart(profile);
  const normalizedAgentId = normalizeKeyPart(agentId);
  const normalizedScope = normalizeKeyPart(scope);

  if (!KEY_PART.test(normalizedProfile) || normalizedProfile.length < 1 || normalizedProfile.length > 32) {
    throw new Error('CONFIG: invalid profile');
  }
  if (!KEY_PART.test(normalizedAgentId) || normalizedAgentId.length < 1 || normalizedAgentId.length > 64) {
    throw new Error('CONFIG: invalid agentId');
  }
  if (!SCOPE_VALUES.has(normalizedScope)) {
    throw new Error('CONFIG: invalid scope');
  }

  const key = `auramaxx:${normalizedProfile}:${normalizedAgentId}:${normalizedScope}`;
  if (key.length > 160) {
    throw new Error('CONFIG: keychain identifier too long');
  }
  return key;
}

export function legacyKeychainAliases(profile: string, agentId: string): string[] {
  const normalizedProfile = normalizeKeyPart(profile);
  const normalizedAgentId = normalizeKeyPart(agentId);
  return [
    `aura:${normalizedProfile}:${normalizedAgentId}`,
    `auramaxx:${normalizedProfile}:${normalizedAgentId}`,
  ];
}

export const REFRESH_BACKOFF_SECONDS = [2, 4, 8, 16, 32, 60, 120] as const;

export type RefreshFailure = 'INVALID' | 'DENIED' | 'REVOKED' | 'NETWORK' | 'UNAVAILABLE' | 'UNKNOWN';
export type RefreshState = 'active' | 'needs_reauth';

export function refreshAtMs(expMs: number, nowMs: number, jitterMs = 0): number {
  const scheduled = expMs - 60_000 + jitterMs;
  return Math.max(scheduled, nowMs);
}

export function nextBackoffSeconds(attempt: number): number {
  const boundedIndex = Math.max(0, Math.min(attempt, REFRESH_BACKOFF_SECONDS.length - 1));
  return REFRESH_BACKOFF_SECONDS[boundedIndex];
}

export function isPermanentRefreshFailure(reason: RefreshFailure): boolean {
  return reason === 'INVALID' || reason === 'DENIED' || reason === 'REVOKED';
}

export function resolveRefreshState(reason: RefreshFailure, nowMs: number, expMs: number): RefreshState {
  if (isPermanentRefreshFailure(reason)) return 'needs_reauth';
  if (nowMs >= expMs) return 'needs_reauth';
  return 'active';
}

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 16;
const CODE_BITS = CODE_LENGTH * 5; // base32 chars => 5 bits each

export type PairingErrorCode =
  | 'PAIRING_EXPIRED'
  | 'PAIRING_CONSUMED'
  | 'PAIRING_ATTEMPTS_EXCEEDED'
  | 'PAIRING_LOCKED'
  | 'PAIRING_INVALID';

export interface PairingRecord {
  pairingId: string;
  issuedAt: number;
  consumedAt?: number;
  consumerFingerprint?: string;
  nonce: string;
  ttlMs: number;
  failedAttempts: number;
  sourceFailedAttempts: number;
  sourceLockUntil?: number;
}

export function generatePairingCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  }
  return out;
}

export function validatePairingCodeShape(code: string): boolean {
  return new RegExp(`^[${PAIRING_ALPHABET}]{${CODE_LENGTH}}$`).test(code);
}

export function assertPairingUsable(record: PairingRecord, nowMs: number): PairingErrorCode | null {
  if (record.sourceLockUntil && nowMs < record.sourceLockUntil) return 'PAIRING_LOCKED';
  if (nowMs > record.issuedAt + Math.min(record.ttlMs, 5 * 60_000)) return 'PAIRING_EXPIRED';
  if (record.consumedAt) return 'PAIRING_CONSUMED';
  if (record.failedAttempts >= 5 || record.sourceFailedAttempts >= 20) return 'PAIRING_ATTEMPTS_EXCEEDED';
  return null;
}

export type RevocationScope = 'pairing' | 'agent_identity' | 'fingerprint';

export interface RevocationIndexRow {
  tokenId: string;
  pairingId: string;
  agentId: string;
  pubkeyFingerprint: string;
  issuedAt: number;
  revokedAt?: number;
  revocationScope?: RevocationScope;
}

export function matchesRevocationScope(row: RevocationIndexRow, scope: RevocationScope, value: string): boolean {
  if (scope === 'pairing') return row.pairingId === value;
  if (scope === 'agent_identity') return row.agentId === value;
  return row.pubkeyFingerprint === value;
}

const JWT_LIKE = /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const LONG_HEX = /\b(?:[A-Fa-f0-9]{24,}|[A-Za-z0-9+/]{24,}={0,2})\b/g;
const LONG_BLOB = /\b[A-Za-z0-9+/=]{96,}\b/g;

export type RedactionBucket = 'short' | 'medium' | 'long';

function bucketForLength(len: number): RedactionBucket {
  if (len < 64) return 'short';
  if (len < 256) return 'medium';
  return 'long';
}

export function redactSensitiveText(input: string): { redacted: string; buckets: RedactionBucket[] } {
  const buckets: RedactionBucket[] = [];

  const redact = (source: string, pattern: RegExp, label: string): string => source.replace(pattern, (match) => {
    buckets.push(bucketForLength(match.length));
    return `[REDACTED:${label}]`;
  });

  let output = input;
  output = redact(output, JWT_LIKE, 'jwt');
  output = redact(output, LONG_BLOB, 'blob');
  output = redact(output, LONG_HEX, 'token');

  return { redacted: output, buckets };
}

// Loop 3 frozen contracts: agent identity, remote policy, reset controls, error envelope, telemetry schema.
export interface AgentIdentityMeta {
  createdAt: string;
  fingerprintPrefix: string;
}

export interface CanonicalAgentIdentity {
  serviceSlug: string;
  profileSlug: string;
  agentId: string;
}

const REMOTE_PRIVATE_NETWORK = /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.|::1$|fc|fd)/i;

function normalizeIdentitySegment(raw: string): string {
  const normalized = raw
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  if (!normalized) throw new Error('CONFIG_INVALID: empty normalized identity segment');
  return normalized;
}

export function canonicalizeAgentIdentity(serviceName: string, profile: string): CanonicalAgentIdentity {
  const serviceSlug = normalizeIdentitySegment(serviceName);
  const profileSlug = normalizeIdentitySegment(profile);
  const agentId = `agent:${serviceSlug}:${profileSlug}`;
  if (agentId.length > 120) throw new Error('CONFIG_INVALID: canonical agentId too long');
  return { serviceSlug, profileSlug, agentId };
}

export function assertNoAgentIdCollision(
  candidate: CanonicalAgentIdentity,
  existing: AgentIdentityMeta | null,
): void {
  if (!existing) return;
  throw new Error(
    `ID_COLLISION: ${candidate.agentId} conflicts with createdAt=${existing.createdAt} fingerprint=${existing.fingerprintPrefix}`,
  );
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function toOrigin(url: URL): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
  return `${url.protocol}//${url.hostname}:${port}`;
}

export function validateRemoteBootstrapEndpoint(
  endpoint: string,
  opts: { allowInsecureLocalHttp?: boolean; allowlistOrigins?: string[] } = {},
): { origin: string } {
  const parsed = new URL(endpoint);
  const isHttps = parsed.protocol === 'https:';
  const loopback = isLoopbackHost(parsed.hostname);

  if (!isHttps && !(parsed.protocol === 'http:' && loopback && opts.allowInsecureLocalHttp)) {
    throw new Error('NETWORK_TLS');
  }

  const origin = toOrigin(parsed);
  const normalizedAllowlist = new Set((opts.allowlistOrigins ?? []).map((item) => toOrigin(new URL(item))));
  if (normalizedAllowlist.size > 0 && !normalizedAllowlist.has(origin)) {
    throw new Error('REMOTE_ALLOWLIST_DENY');
  }

  if (!loopback && REMOTE_PRIVATE_NETWORK.test(parsed.hostname) && !normalizedAllowlist.has(origin)) {
    throw new Error('REMOTE_ALLOWLIST_DENY');
  }

  return { origin };
}

export function assertNoRedirectStatus(statusCode: number): void {
  if (statusCode >= 300 && statusCode < 400) {
    throw new Error('REMOTE_REDIRECT_BLOCKED');
  }
}

export function assertResetConfirmation(input: {
  interactive: boolean;
  resetIdentity: boolean;
  agentId: string;
  typedConfirmation?: string;
  confirmResetAgentId?: string;
}): void {
  if (!input.resetIdentity) return;
  if (input.interactive) {
    if (input.typedConfirmation !== `RESET ${input.agentId}`) throw new Error('RESET_CONFIRM_REQUIRED');
    return;
  }
  if (input.confirmResetAgentId !== input.agentId) throw new Error('RESET_CONFIRM_REQUIRED');
}

export function isResetRateLimited(resetTimestampsMs: number[], nowMs: number): boolean {
  const windowMs = 10 * 60_000;
  const recent = resetTimestampsMs.filter((ts) => nowMs - ts <= windowMs);
  return recent.length > 2;
}

export const AUTH_ERROR_SCHEMA_VERSION = 'v1' as const;

export const AUTH_EXIT_CODES: Record<string, number> = {
  CONFIG_INVALID: 31,
  PAIRING_TIMEOUT: 41,
  PAIRING_DENIED: 42,
  PAIRING_REPLAY: 43,
  PAIRING_EXPIRED: 44,
  NETWORK_TLS: 51,
  NETWORK_UNREACHABLE: 52,
  REMOTE_ALLOWLIST_DENY: 53,
  REMOTE_REDIRECT_BLOCKED: 54,
  ID_COLLISION: 61,
  FINGERPRINT_MISMATCH: 62,
  RESET_CONFIRM_REQUIRED: 71,
  RESET_RATE_LIMIT: 72,
};

export interface AuthErrorEnvelope {
  authErrorSchemaVersion: typeof AUTH_ERROR_SCHEMA_VERSION;
  family: string;
  subcode: string;
  exitCode: number;
  message: string;
  hint?: string;
}

export function toAuthErrorEnvelope(params: {
  family: string;
  subcode: string;
  message: string;
  hint?: string;
}): AuthErrorEnvelope {
  const exitCode = AUTH_EXIT_CODES[params.subcode] ?? 1;
  return {
    authErrorSchemaVersion: AUTH_ERROR_SCHEMA_VERSION,
    family: params.family,
    subcode: params.subcode,
    exitCode,
    message: params.message,
    ...(params.hint ? { hint: params.hint } : {}),
  };
}

export interface RegisterTelemetryEvent {
  event: string;
  timestamp: string;
  agentId: string;
  profile: string;
  scope: string;
  authMode: RuntimeMode;
  attempt: number;
  durationMs: number;
  result: 'success' | 'failure' | 'pending';
  failureFamily: string | null;
  failureSubcode: string | null;
  persistenceBackend: 'keychain' | 'memory' | 'none';
  providerPath: string[];
  correlationId: string;
  fingerprintPrefix?: string;
  endpointOrigin?: string;
}

export function sanitizeRegisterTelemetryEvent(event: RegisterTelemetryEvent): RegisterTelemetryEvent {
  if (!event.event || !event.agentId || !event.profile || !event.scope || !event.correlationId) {
    throw new Error('CONFIG_INVALID: missing required telemetry fields');
  }

  return {
    ...event,
    fingerprintPrefix: event.fingerprintPrefix?.slice(0, 8),
    endpointOrigin: event.endpointOrigin ? new URL(event.endpointOrigin).origin : undefined,
  };
}

export const PAIRING_MIN_BITS = CODE_BITS;
export const PAIRING_MAX_TTL_MS = 5 * 60_000;

// Loop 4 frozen contracts: lifecycle/rotation outcomes, headless cooldown, lease contention,
// remediation compatibility, and TOCTOU-safe local trust-proof sequencing.
export type AuthLifecycleState = 'ACTIVE' | 'ROTATING' | 'DEGRADED' | 'NEEDS_REAUTH' | 'REVOKED';

export const DEFAULT_ROTATION_GRACE_SECONDS = 30;
export const MAX_ROTATION_GRACE_SECONDS = 120;

export function applyRotationGraceSeconds(requested?: number): number {
  const value = requested ?? DEFAULT_ROTATION_GRACE_SECONDS;
  if (!Number.isFinite(value) || value < 0 || value > MAX_ROTATION_GRACE_SECONDS) {
    throw new Error('CONFIG: invalid rotation grace seconds');
  }
  return Math.trunc(value);
}

export function enforceRotationOverlapInvariant(params: {
  cutoverStartedAtMs: number;
  nowMs: number;
  graceSeconds: number;
}): { overlapWindowMs: number; overlapInvariantSatisfied: boolean; forceExpireOldToken: boolean } {
  const graceSeconds = applyRotationGraceSeconds(params.graceSeconds);
  const overlapWindowMs = Math.max(0, params.nowMs - params.cutoverStartedAtMs);
  const capMs = graceSeconds * 1000;
  const overlapInvariantSatisfied = overlapWindowMs <= capMs;
  return {
    overlapWindowMs,
    overlapInvariantSatisfied,
    forceExpireOldToken: !overlapInvariantSatisfied,
  };
}

export type RotationOutcomeKey =
  | 'PREFLIGHT_FAIL'
  | 'CANDIDATE_MINT_FAIL'
  | 'PROBE_RETRYABLE'
  | 'PROBE_CEILING'
  | 'COMMIT_PERSIST_FAIL'
  | 'ACTIVATE_OK_REVOKE_PENDING'
  | 'REVOKE_SUCCESS'
  | 'REVOKE_FAIL_WITHIN_GRACE'
  | 'REVOKE_UNRESOLVED_AT_DEADLINE'
  | 'ROLLBACK_SUCCESS'
  | 'ROLLBACK_FAIL'
  | 'TIMEOUT_REVOKE_UNKNOWN';

export interface RotationOutcome {
  oldValid: boolean;
  newValid: boolean;
  terminalState: AuthLifecycleState;
  subcode: string;
}

export const ROTATION_OUTCOME_TABLE: Record<RotationOutcomeKey, RotationOutcome> = {
  PREFLIGHT_FAIL: { oldValid: true, newValid: false, terminalState: 'ACTIVE', subcode: 'ROTATE_PREFLIGHT_FAILED' },
  CANDIDATE_MINT_FAIL: { oldValid: true, newValid: false, terminalState: 'ACTIVE', subcode: 'ROTATE_ISSUE_FAILED' },
  PROBE_RETRYABLE: { oldValid: true, newValid: false, terminalState: 'ROTATING', subcode: 'ROTATE_PROBE_RETRYABLE' },
  PROBE_CEILING: { oldValid: true, newValid: false, terminalState: 'DEGRADED', subcode: 'ROTATE_PROBE_CEILING' },
  COMMIT_PERSIST_FAIL: { oldValid: true, newValid: false, terminalState: 'DEGRADED', subcode: 'ROTATE_COMMIT_PERSIST_FAILED' },
  ACTIVATE_OK_REVOKE_PENDING: { oldValid: true, newValid: true, terminalState: 'ROTATING', subcode: 'ROTATE_REVOKE_PENDING' },
  REVOKE_SUCCESS: { oldValid: false, newValid: true, terminalState: 'ACTIVE', subcode: 'ROTATE_SUCCESS' },
  REVOKE_FAIL_WITHIN_GRACE: { oldValid: true, newValid: true, terminalState: 'DEGRADED', subcode: 'ROTATE_REVOKE_FAILED' },
  REVOKE_UNRESOLVED_AT_DEADLINE: { oldValid: false, newValid: true, terminalState: 'DEGRADED', subcode: 'ROTATE_OVERLAP_CAP_ENFORCED' },
  ROLLBACK_SUCCESS: { oldValid: true, newValid: false, terminalState: 'ACTIVE', subcode: 'ROTATE_ROLLBACK_SUCCESS' },
  ROLLBACK_FAIL: { oldValid: false, newValid: false, terminalState: 'NEEDS_REAUTH', subcode: 'ROTATE_ROLLBACK_FAILED' },
  TIMEOUT_REVOKE_UNKNOWN: { oldValid: false, newValid: true, terminalState: 'DEGRADED', subcode: 'ROTATE_TIMEOUT_REVOKE_UNKNOWN' },
};

export function resolveRotationOutcome(key: RotationOutcomeKey): RotationOutcome {
  return ROTATION_OUTCOME_TABLE[key];
}

const HEADLESS_COOLDOWN_SECONDS = [60, 120, 300, 600] as const;
export const MAX_FAILED_EPISODES_PER_HOUR = 4;

export function cooldownSecondsForFailedEpisodes(failedEpisodes: number): number {
  const idx = Math.max(0, Math.min(Math.max(1, failedEpisodes) - 1, HEADLESS_COOLDOWN_SECONDS.length - 1));
  return HEADLESS_COOLDOWN_SECONDS[idx];
}

function stableJitterRatio(agentId: string): number {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) hash = (hash * 31 + agentId.charCodeAt(i)) | 0;
  return (Math.abs(hash) % 401) / 1000 - 0.2; // [-0.2, +0.2]
}

export function cooldownWithDeterministicJitterSeconds(agentId: string, baseSeconds: number): number {
  const adjusted = baseSeconds * (1 + stableJitterRatio(agentId));
  return Math.max(1, Math.round(adjusted));
}

export function nextHeadlessRenewalWindow(params: {
  agentId: string;
  nowMs: number;
  failedEpisodesLastHour: number;
  consecutiveFailedEpisodes: number;
}): { state: AuthLifecycleState; subcode: string; nextAllowedAttemptAt: string | null } {
  if (params.failedEpisodesLastHour > MAX_FAILED_EPISODES_PER_HOUR) {
    return {
      state: 'NEEDS_REAUTH',
      subcode: 'REAUTH_EPISODE_LIMIT_EXCEEDED',
      nextAllowedAttemptAt: new Date(params.nowMs + 60 * 60_000).toISOString(),
    };
  }

  const base = cooldownSecondsForFailedEpisodes(params.consecutiveFailedEpisodes);
  const cooldownSeconds = cooldownWithDeterministicJitterSeconds(params.agentId, base);
  return {
    state: 'DEGRADED',
    subcode: 'RENEWAL_COOLDOWN',
    nextAllowedAttemptAt: new Date(params.nowMs + cooldownSeconds * 1000).toISOString(),
  };
}

export interface AuthLeaseRecord {
  ownerId: string;
  leaseVersion: number;
  acquiredAtMs: number;
  lastRenewedAtMs: number;
  heartbeatMisses: number;
  ownerProofFailures: number;
}

export type LeaseStaleReason = 'HEARTBEAT_TIMEOUT' | 'OWNER_PROOF_FAILED';

export function leaseStaleReason(lease: AuthLeaseRecord, nowMs: number): LeaseStaleReason | null {
  if (nowMs - lease.lastRenewedAtMs > 45_000 || lease.heartbeatMisses >= 2) return 'HEARTBEAT_TIMEOUT';
  if (lease.ownerProofFailures >= 2) return 'OWNER_PROOF_FAILED';
  return null;
}

export function attemptLeaseTakeover(params: {
  currentLease: AuthLeaseRecord;
  expectedLeaseVersion: number;
  contenderOwnerId: string;
  nowMs: number;
}): { takeoverSucceeded: boolean; newLease?: AuthLeaseRecord } {
  if (params.currentLease.leaseVersion !== params.expectedLeaseVersion) {
    return { takeoverSucceeded: false };
  }
  return {
    takeoverSucceeded: true,
    newLease: {
      ownerId: params.contenderOwnerId,
      leaseVersion: params.currentLease.leaseVersion + 1,
      acquiredAtMs: params.nowMs,
      lastRenewedAtMs: params.nowMs,
      heartbeatMisses: 0,
      ownerProofFailures: 0,
    },
  };
}

export const AUTH_REMEDIATION_SCHEMA_VERSION = 'v1' as const;

export interface AuthRemediationPayload {
  authRemediationSchemaVersion: string;
  subcode: string;
  recommendedAction: string;
  humanHint: string;
  nextAllowedAttemptAt: string | null;
}

const KNOWN_REMEDIATION_SUBCODES: Record<string, { action: string; hint: string }> = {
  NETWORK_TLS: { action: 'verify_tls_configuration', hint: 'TLS required for remote auth endpoint.' },
  REMOTE_ALLOWLIST_DENY: { action: 'update_allowlist', hint: 'Endpoint origin denied by remote allowlist.' },
  RESET_CONFIRM_REQUIRED: { action: 'confirm_reset_identity', hint: 'Provide explicit reset confirmation to continue.' },
};

export function toAuthRemediationPayload(subcode: string, nextAllowedAttemptAt: string | null): AuthRemediationPayload {
  const known = KNOWN_REMEDIATION_SUBCODES[subcode];
  if (!known) {
    return {
      authRemediationSchemaVersion: AUTH_REMEDIATION_SCHEMA_VERSION,
      subcode,
      recommendedAction: 'inspect_auth_logs',
      humanHint: 'Unknown auth failure; inspect logs and re-run registration if needed.',
      nextAllowedAttemptAt,
    };
  }
  return {
    authRemediationSchemaVersion: AUTH_REMEDIATION_SCHEMA_VERSION,
    subcode,
    recommendedAction: known.action,
    humanHint: known.hint,
    nextAllowedAttemptAt,
  };
}

export function assertSupportedRemediationSchema(version: string): void {
  const major = version.match(/^v(\d+)/)?.[1];
  if (!major || major !== '1') throw new Error('REMEDIATION_SCHEMA_UNSUPPORTED');
}

export type TrustPolicyMode = 'strict' | 'compatible';
export type TrustDecision = 'allow' | 'deny' | 'allow_with_warning';
export type TrustPolicyResult = 'pass' | 'fail' | 'warn' | 'not_checked';

export interface LocalTrustEvidence {
  uid: number;
  pid: number;
  exePathPolicy: TrustPolicyResult;
  exeHashPolicy: TrustPolicyResult;
}

export interface LocalTrustDecision {
  trustDecision: TrustDecision;
  uidMatch: boolean;
  exePathPolicy: TrustPolicyResult;
  exeHashPolicy: TrustPolicyResult;
  policyMode: TrustPolicyMode;
  decisionReasonCodes: string[];
  evidenceStable: boolean;
}

export function evaluateLocalTrustProofSequence(params: {
  policyMode: TrustPolicyMode;
  accepted: LocalTrustEvidence;
  issueCheck: LocalTrustEvidence;
}): LocalTrustDecision {
  const evidenceStable =
    params.accepted.uid === params.issueCheck.uid
    && params.accepted.pid === params.issueCheck.pid
    && params.accepted.exePathPolicy === params.issueCheck.exePathPolicy
    && params.accepted.exeHashPolicy === params.issueCheck.exeHashPolicy;

  if (!evidenceStable) throw new Error('LOCAL_TRUST_PROOF_CHANGED');

  const uidMatch = params.accepted.uid === params.issueCheck.uid;
  if (!uidMatch) {
    return {
      trustDecision: 'deny',
      uidMatch: false,
      exePathPolicy: params.issueCheck.exePathPolicy,
      exeHashPolicy: params.issueCheck.exeHashPolicy,
      policyMode: params.policyMode,
      decisionReasonCodes: ['UID_MISMATCH'],
      evidenceStable,
    };
  }

  const strictFail = params.issueCheck.exePathPolicy === 'fail' || params.issueCheck.exeHashPolicy === 'fail';
  if (params.policyMode === 'strict') {
    return {
      trustDecision: strictFail ? 'deny' : 'allow',
      uidMatch: true,
      exePathPolicy: params.issueCheck.exePathPolicy,
      exeHashPolicy: params.issueCheck.exeHashPolicy,
      policyMode: 'strict',
      decisionReasonCodes: strictFail ? ['STRICT_POLICY_FAIL'] : ['STRICT_POLICY_PASS'],
      evidenceStable,
    };
  }

  const compatibleWarn = strictFail || params.issueCheck.exePathPolicy === 'warn' || params.issueCheck.exeHashPolicy === 'warn';
  return {
    trustDecision: compatibleWarn ? 'allow_with_warning' : 'allow',
    uidMatch: true,
    exePathPolicy: params.issueCheck.exePathPolicy,
    exeHashPolicy: params.issueCheck.exeHashPolicy,
    policyMode: 'compatible',
    decisionReasonCodes: compatibleWarn ? ['COMPATIBLE_POLICY_WARNING'] : ['COMPATIBLE_POLICY_PASS'],
    evidenceStable,
  };
}

// Loop 5 frozen contracts: rollout compatibility, promotion gate safety, break-glass constraints,
// conformance recency, and unknown-major schema handling.
export type RolloutPolicyMode = 'observe' | 'warn' | 'enforce';
export type CapabilityCriticality = 'critical' | 'non_critical';

export interface CapabilityRegistryEntry {
  capabilityKey: string;
  criticality: CapabilityCriticality;
  owner: string;
  introducedInContractVersion: string;
  lastModifiedAt: string;
  registryVersion: string;
}

export interface CapabilityNegotiationDecision {
  allowed: boolean;
  subcode: string | null;
  missingClientCaps: string[];
  missingServerCaps: string[];
}

export function resolveCapabilityNegotiation(params: {
  policyMode: RolloutPolicyMode;
  requiredCaps: string[];
  clientCaps: string[];
  serverCaps: string[];
  registry: Record<string, CapabilityRegistryEntry>;
}): CapabilityNegotiationDecision {
  const required = [...new Set(params.requiredCaps)];
  const clientSet = new Set(params.clientCaps);
  const serverSet = new Set(params.serverCaps);

  const missingServerCaps = required.filter((cap) => !serverSet.has(cap));
  if (missingServerCaps.length > 0) {
    return { allowed: false, subcode: 'SERVER_CAPABILITY_MISSING', missingClientCaps: [], missingServerCaps };
  }

  const missingClientCaps = required.filter((cap) => !clientSet.has(cap));
  if (missingClientCaps.length === 0) {
    return { allowed: true, subcode: null, missingClientCaps: [], missingServerCaps: [] };
  }

  const hasCriticalGap = missingClientCaps.some((cap) => (params.registry[cap]?.criticality ?? 'critical') === 'critical');
  if (params.policyMode === 'enforce' || hasCriticalGap) {
    return { allowed: false, subcode: 'CAPABILITY_MISMATCH', missingClientCaps, missingServerCaps: [] };
  }

  return {
    allowed: true,
    subcode: params.policyMode === 'warn' ? 'CAPABILITY_MISMATCH_WARN' : 'CAPABILITY_MISMATCH_OBSERVED',
    missingClientCaps,
    missingServerCaps: [],
  };
}

export interface PromotionSampleFloor {
  minHandshakeSamples: number;
  minDistinctAgents: number;
  minDistinctProfiles: number;
}

export const PROMOTION_SAMPLE_FLOORS: Record<'observe_to_warn' | 'warn_to_enforce', PromotionSampleFloor> = {
  observe_to_warn: { minHandshakeSamples: 10_000, minDistinctAgents: 50, minDistinctProfiles: 3 },
  warn_to_enforce: { minHandshakeSamples: 50_000, minDistinctAgents: 200, minDistinctProfiles: 5 },
};

export function hasPromotionSampleFloor(params: {
  transition: keyof typeof PROMOTION_SAMPLE_FLOORS;
  handshakeSamples: number;
  distinctAgents: number;
  distinctProfiles: number;
}): { pass: boolean; subcode: string | null } {
  const floor = PROMOTION_SAMPLE_FLOORS[params.transition];
  const pass =
    params.handshakeSamples >= floor.minHandshakeSamples
    && params.distinctAgents >= floor.minDistinctAgents
    && params.distinctProfiles >= floor.minDistinctProfiles;
  return { pass, subcode: pass ? null : 'PROMOTION_INSUFFICIENT_SAMPLE' };
}

export interface RolloutCoverage {
  capabilityDecision: number;
  requiredCaps: number;
  wouldBlock: number;
}

export const WARN_TO_ENFORCE_COVERAGE_FLOORS: RolloutCoverage = {
  capabilityDecision: 99.0,
  requiredCaps: 99.0,
  wouldBlock: 99.5,
};

export function hasCoverageForEnforce(coverage: RolloutCoverage): { pass: boolean; subcode: string | null } {
  const pass =
    coverage.capabilityDecision >= WARN_TO_ENFORCE_COVERAGE_FLOORS.capabilityDecision
    && coverage.requiredCaps >= WARN_TO_ENFORCE_COVERAGE_FLOORS.requiredCaps
    && coverage.wouldBlock >= WARN_TO_ENFORCE_COVERAGE_FLOORS.wouldBlock;
  return { pass, subcode: pass ? null : 'PROMOTION_COVERAGE_INCOMPLETE' };
}

export type BreakGlassScopeDimension = 'environment' | 'region' | 'profile' | 'agentCohort';

export function validateBreakGlassRequest(params: {
  scope: Partial<Record<BreakGlassScopeDimension, string>>;
  affectedAgents: number;
  activeFleetAgents: number;
  approvals: number;
  ttlMs: number;
}): { broadScope: boolean } {
  if (params.ttlMs > 4 * 60 * 60_000) throw new Error('BREAK_GLASS_TTL_EXCEEDED');
  if (params.activeFleetAgents <= 0) throw new Error('BREAK_GLASS_INVALID_FLEET');

  const scopeKeys = Object.keys(params.scope) as BreakGlassScopeDimension[];
  if (scopeKeys.length === 0) throw new Error('BREAK_GLASS_SCOPE_REQUIRED');

  const affectedPct = params.affectedAgents / params.activeFleetAgents;
  const broadScope = affectedPct > 0.2;
  const requiredApprovals = broadScope ? 2 : 1;
  if (params.approvals < requiredApprovals) throw new Error('BREAK_GLASS_APPROVAL_REQUIRED');

  return { broadScope };
}

export const CONFORMANCE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export function validateConformanceArtifact(params: {
  generatedAtMs: number;
  nowMs: number;
  currentServerBuild: string;
  artifactServerBuild: string;
  currentRegistryVersion: string;
  artifactRegistryVersion: string;
}): { pass: boolean; subcode: string | null } {
  const ageMs = params.nowMs - params.generatedAtMs;
  if (ageMs > CONFORMANCE_MAX_AGE_MS) return { pass: false, subcode: 'PROMOTION_CONFORMANCE_STALE' };
  if (params.currentServerBuild !== params.artifactServerBuild) return { pass: false, subcode: 'PROMOTION_CONFORMANCE_STALE' };
  if (params.currentRegistryVersion !== params.artifactRegistryVersion) {
    return { pass: false, subcode: 'PROMOTION_CONFORMANCE_STALE' };
  }
  return { pass: true, subcode: null };
}

export function resolveUnknownMajorSchemaOutcome(params: {
  policyMode: RolloutPolicyMode;
  unresolvedSamples: number;
  currentlyEnforced: boolean;
}): {
  shouldPage: boolean;
  allowOperation: boolean;
  promotionBlocked: boolean;
  enforceHold: boolean;
  subcode: string;
} {
  if (params.unresolvedSamples <= 0) {
    return {
      shouldPage: false,
      allowOperation: true,
      promotionBlocked: false,
      enforceHold: false,
      subcode: 'SCHEMA_MAJOR_OK',
    };
  }

  if (params.policyMode === 'enforce') {
    return {
      shouldPage: true,
      allowOperation: false,
      promotionBlocked: true,
      enforceHold: params.currentlyEnforced,
      subcode: 'SCHEMA_MAJOR_UNKNOWN_ENFORCED',
    };
  }

  return {
    shouldPage: true,
    allowOperation: true,
    promotionBlocked: true,
    enforceHold: false,
    subcode: 'SCHEMA_MAJOR_UNKNOWN',
  };
}

// Loop 6 frozen contracts: drift reconciliation, host-transfer linearization, exception composition,
// forensics signer trust-chain ingestion, anti-flap budget governance, and waiver artifact enforcement.
export type DriftSourceFamily =
  | 'transport_tls'
  | 'socket_identity'
  | 'identity_fingerprint'
  | 'policy_integrity'
  | 'runtime_capability';

export const DRIFT_FAMILY_ORDER: DriftSourceFamily[] = [
  'transport_tls',
  'socket_identity',
  'identity_fingerprint',
  'policy_integrity',
  'runtime_capability',
];

export function canonicalizeDriftFamilies(input: DriftSourceFamily[]): DriftSourceFamily[] {
  return [...new Set(input)].sort((a, b) => DRIFT_FAMILY_ORDER.indexOf(a) - DRIFT_FAMILY_ORDER.indexOf(b));
}

export interface DriftObservation {
  family: DriftSourceFamily;
  detectedAtMs: number;
  seq: number;
}

export function reconcileDriftObservations(observations: DriftObservation[]): {
  order: DriftSourceFamily[];
  driftReconciled: boolean;
} {
  const sorted = [...observations].sort((a, b) => {
    if (a.detectedAtMs !== b.detectedAtMs) return a.detectedAtMs - b.detectedAtMs;
    if (a.seq !== b.seq) return a.seq - b.seq;
    return DRIFT_FAMILY_ORDER.indexOf(a.family) - DRIFT_FAMILY_ORDER.indexOf(b.family);
  });

  return {
    order: canonicalizeDriftFamilies(sorted.map((item) => item.family)),
    driftReconciled: sorted.length > 0,
  };
}

export function resolveTransferCommit(params: {
  phase: 'prepare' | 'commit' | 'finalize';
  transferId: string;
  expectedCommitIndex: number;
  observedCommitIndex: number;
}): {
  committed: boolean;
  retryable: boolean;
  finalStateKnown: boolean;
  subcode: 'TRANSFER_COMMIT_APPLIED' | 'TRANSFER_COMMIT_ALREADY_APPLIED' | 'TRANSFER_COMMIT_CONFLICT';
} {
  if (params.observedCommitIndex === params.expectedCommitIndex) {
    return {
      committed: true,
      retryable: false,
      finalStateKnown: true,
      subcode: 'TRANSFER_COMMIT_APPLIED',
    };
  }

  if (params.observedCommitIndex > params.expectedCommitIndex) {
    return {
      committed: true,
      retryable: false,
      finalStateKnown: true,
      subcode: 'TRANSFER_COMMIT_ALREADY_APPLIED',
    };
  }

  return {
    committed: false,
    retryable: false,
    finalStateKnown: false,
    subcode: 'TRANSFER_COMMIT_CONFLICT',
  };
}

export const MAX_ACTIVE_EXCEPTIONS_PER_SCOPE = 3;

export type ExceptionSafetyInvariant = 'no_bypass_mfa' | 'no_plaintext_token' | 'no_unapproved_remote_write';

export function validateExceptionComposition(params: {
  scopeKey: string;
  activeExceptionCount: number;
  overlays: string[];
  requestedRelaxations: string[];
  protectedInvariants: ExceptionSafetyInvariant[];
}): { accepted: boolean; effectiveRelaxations: string[]; subcode: string | null } {
  if (params.activeExceptionCount >= MAX_ACTIVE_EXCEPTIONS_PER_SCOPE) {
    return { accepted: false, effectiveRelaxations: [], subcode: 'EXCEPTION_ACTIVE_LIMIT' };
  }

  const overlap = params.requestedRelaxations.filter((r) => params.overlays.includes(r));
  const wouldBypassInvariant = overlap.some((relaxation) => params.protectedInvariants.includes(relaxation as ExceptionSafetyInvariant));
  if (wouldBypassInvariant) {
    return { accepted: false, effectiveRelaxations: [], subcode: 'EXCEPTION_CONFLICTS_INVARIANT' };
  }

  return {
    accepted: true,
    effectiveRelaxations: overlap,
    subcode: null,
  };
}

export const SIGNER_ROTATION_OVERLAP_MS = 24 * 60 * 60_000;

export function validateForensicsSigner(params: {
  signerId: string;
  trustedSignerIds: string[];
  overlapSignerIds: string[];
  revokedSignerIds: string[];
  nowMs: number;
  signatureIssuedAtMs: number;
  signerExpiresAtMs: number;
}): { accepted: boolean; subcode: string | null } {
  if (params.revokedSignerIds.includes(params.signerId)) return { accepted: false, subcode: 'FORENSICS_SIGNER_REVOKED' };
  if (params.nowMs > params.signerExpiresAtMs) return { accepted: false, subcode: 'FORENSICS_SIGNER_EXPIRED' };

  const withinRotationWindow = params.nowMs - params.signatureIssuedAtMs <= SIGNER_ROTATION_OVERLAP_MS;
  const active = params.trustedSignerIds.includes(params.signerId);
  const overlap = params.overlapSignerIds.includes(params.signerId) && withinRotationWindow;

  if (!active && !overlap) return { accepted: false, subcode: 'FORENSICS_SIGNER_UNTRUSTED' };
  return { accepted: true, subcode: null };
}

export const ERROR_BUDGET_ENTER_PCT = 5;
export const ERROR_BUDGET_EXIT_PCT = 2;
export const ERROR_BUDGET_HOLD_DWELL_MS = 15 * 60_000;

export function resolveErrorBudgetGovernance(params: {
  currentMode: 'enforce' | 'degraded';
  budgetBurnPercent: number;
  modeSinceMs: number;
  nowMs: number;
  severeIncidentOpen: boolean;
}): { nextMode: 'enforce' | 'degraded'; subcode: string } {
  const dwellSatisfied = params.nowMs - params.modeSinceMs >= ERROR_BUDGET_HOLD_DWELL_MS;
  if (params.currentMode === 'enforce') {
    if (params.budgetBurnPercent >= ERROR_BUDGET_ENTER_PCT) return { nextMode: 'degraded', subcode: 'BUDGET_ENTER_DEGRADED' };
    return { nextMode: 'enforce', subcode: 'BUDGET_STABLE' };
  }

  if (params.severeIncidentOpen) return { nextMode: 'degraded', subcode: 'BUDGET_HOLD_SEVERE_INCIDENT' };
  if (params.budgetBurnPercent <= ERROR_BUDGET_EXIT_PCT && dwellSatisfied) {
    return { nextMode: 'enforce', subcode: 'BUDGET_EXIT_DEGRADED' };
  }
  return { nextMode: 'degraded', subcode: 'BUDGET_HOLD_DWELL' };
}

export const WAIVER_SCHEMA_VERSION = 'v1';

export function validateWaiverArtifact(params: {
  schemaVersion: string;
  scope: string;
  approvalCount: number;
  minApprovals: number;
  expiresAtMs: number;
  nowMs: number;
  signature: string | null;
}): { accepted: boolean; subcode: string | null } {
  if (params.schemaVersion !== WAIVER_SCHEMA_VERSION) return { accepted: false, subcode: 'WAIVER_SCHEMA_UNSUPPORTED' };
  if (!params.signature) return { accepted: false, subcode: 'WAIVER_SIGNATURE_REQUIRED' };
  if (!params.scope) return { accepted: false, subcode: 'WAIVER_SCOPE_REQUIRED' };
  if (params.approvalCount < params.minApprovals) return { accepted: false, subcode: 'WAIVER_APPROVALS_INSUFFICIENT' };
  if (params.nowMs > params.expiresAtMs) return { accepted: false, subcode: 'WAIVER_EXPIRED' };
  return { accepted: true, subcode: null };
}

// Loop 7 frozen contracts: delegated high-risk execution, partition journal trust-chain,
// approval SoD freshness, crypto migration matrix, compliance closure, and causal precedence.
export const DELEGATION_MAX_SKEW_MS = 30_000;

export type DelegationRuntimeMode = 'local' | 'remote' | 'headless';

export interface DelegationBindingTuple {
  delegationId: string;
  principalCanonicalId: string;
  runtimeMode: DelegationRuntimeMode;
  operationClass: string;
  subjectDigest: string;
  constraintsDigest: string;
  policyHash: string;
  approvalId: string;
  nonce: string;
  expiresAt: string;
}

function normalizePrincipalCanonicalId(input: string): string {
  return input.normalize('NFC').trim().toLowerCase();
}

export function canonicalizeDelegationBinding(input: DelegationBindingTuple): DelegationBindingTuple {
  return {
    ...input,
    principalCanonicalId: normalizePrincipalCanonicalId(input.principalCanonicalId),
    runtimeMode: input.runtimeMode,
    operationClass: input.operationClass.trim(),
    subjectDigest: input.subjectDigest.trim(),
    constraintsDigest: input.constraintsDigest.trim(),
    policyHash: input.policyHash.trim(),
    approvalId: input.approvalId.trim(),
    nonce: input.nonce.trim(),
    expiresAt: new Date(input.expiresAt).toISOString(),
  };
}

export function isDelegationExpired(expiresAtIso: string, nowMs: number, skewMs = DELEGATION_MAX_SKEW_MS): boolean {
  const exp = new Date(expiresAtIso).getTime();
  return !Number.isFinite(exp) || nowMs > exp + skewMs;
}

export function resolveDelegationRevocationPrecedence(params: {
  revocationEventIndex: number | null;
  executionCommitIndex: number;
}): { allowed: boolean; subcode: string | null } {
  if (params.revocationEventIndex === null) return { allowed: true, subcode: null };
  if (params.revocationEventIndex <= params.executionCommitIndex) {
    return { allowed: false, subcode: 'AUTH_DELEGATION_REVOKED' };
  }
  return { allowed: true, subcode: null };
}

export interface PartitionJournalEntry {
  epoch: number;
  seq: number;
  entryHash: string;
  prevEntryHash: string;
}

export function validatePartitionJournalChain(entries: PartitionJournalEntry[]): {
  accepted: boolean;
  subcode: 'JOURNAL_OK' | 'QUARANTINED_GAP' | 'QUARANTINED_FORK';
} {
  const byEpoch = new Map<number, PartitionJournalEntry[]>();
  for (const entry of entries) {
    const list = byEpoch.get(entry.epoch) ?? [];
    list.push(entry);
    byEpoch.set(entry.epoch, list);
  }

  for (const list of byEpoch.values()) {
    const seen = new Map<number, string>();
    for (const item of list) {
      const existing = seen.get(item.seq);
      if (existing && existing !== item.entryHash) return { accepted: false, subcode: 'QUARANTINED_FORK' };
      if (!existing) seen.set(item.seq, item.entryHash);
    }

    const ordered = [...list].sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].seq !== i + 1) return { accepted: false, subcode: 'QUARANTINED_GAP' };
      if (i > 0 && ordered[i].prevEntryHash !== ordered[i - 1].entryHash) {
        return { accepted: false, subcode: 'QUARANTINED_GAP' };
      }
    }
  }

  return { accepted: true, subcode: 'JOURNAL_OK' };
}

export function evaluateApprovalSet(params: {
  threshold: number;
  minDistinctTeams: number;
  minDistinctDomains: number;
  approvalMaxAgeMs: number;
  nowMs: number;
  approvals: Array<{ actorCanonicalKey: string; team: string; domain: string; approvedAtMs: number; revoked?: boolean }>;
}): { accepted: boolean; subcode: string | null; uniqueActors: number } {
  const dedup = new Map<string, { team: string; domain: string; approvedAtMs: number; revoked?: boolean }>();
  for (const approval of params.approvals) {
    if (!dedup.has(approval.actorCanonicalKey)) dedup.set(approval.actorCanonicalKey, approval);
  }

  const unique = [...dedup.values()];
  const hasInvalid = unique.some((a) => a.revoked || params.nowMs - a.approvedAtMs > params.approvalMaxAgeMs);
  if (hasInvalid) return { accepted: false, subcode: 'AUTH_APPROVAL_SET_INVALIDATED', uniqueActors: unique.length };

  const uniqueTeams = new Set(unique.map((a) => a.team));
  const uniqueDomains = new Set(unique.map((a) => a.domain));
  const sodPass = uniqueTeams.size >= params.minDistinctTeams && uniqueDomains.size >= params.minDistinctDomains;
  if (unique.length < params.threshold || !sodPass) {
    return { accepted: false, subcode: 'AUTH_APPROVAL_SOD_VIOLATION', uniqueActors: unique.length };
  }

  return { accepted: true, subcode: null, uniqueActors: unique.length };
}

export type CryptoPhase = 'PREPARE' | 'DUAL_VERIFY' | 'DUAL_SIGN_VERIFY' | 'NEW_PRIMARY' | 'RETIRE_OLD';

export const CRYPTO_PHASE_MATRIX: Record<CryptoPhase, { S_old: 0 | 1; S_new: 0 | 1; V_old: 0 | 1; V_new: 0 | 1 }> = {
  PREPARE: { S_old: 1, S_new: 0, V_old: 1, V_new: 0 },
  DUAL_VERIFY: { S_old: 1, S_new: 0, V_old: 1, V_new: 1 },
  DUAL_SIGN_VERIFY: { S_old: 1, S_new: 1, V_old: 1, V_new: 1 },
  NEW_PRIMARY: { S_old: 0, S_new: 1, V_old: 1, V_new: 1 },
  RETIRE_OLD: { S_old: 0, S_new: 1, V_old: 0, V_new: 1 },
};

const CRYPTO_PHASE_ORDER: CryptoPhase[] = ['PREPARE', 'DUAL_VERIFY', 'DUAL_SIGN_VERIFY', 'NEW_PRIMARY', 'RETIRE_OLD'];

export function validateCryptoPhaseState(phase: CryptoPhase, state: { S_old: number; S_new: number; V_old: number; V_new: number }): {
  accepted: boolean;
  subcode: string | null;
} {
  const expected = CRYPTO_PHASE_MATRIX[phase];
  const accepted = expected.S_old === state.S_old
    && expected.S_new === state.S_new
    && expected.V_old === state.V_old
    && expected.V_new === state.V_new;
  return { accepted, subcode: accepted ? null : 'AUTH_CRYPTO_PHASE_INVALID' };
}

export function validateCryptoRollback(params: {
  from: CryptoPhase;
  to: CryptoPhase;
  targetPreconditionsMet: boolean;
}): { allowed: boolean; subcode: string | null } {
  const fromIdx = CRYPTO_PHASE_ORDER.indexOf(params.from);
  const toIdx = CRYPTO_PHASE_ORDER.indexOf(params.to);
  const oneStepBack = toIdx === fromIdx - 1;
  if (!oneStepBack || !params.targetPreconditionsMet) {
    return { allowed: false, subcode: 'AUTH_CRYPTO_ROLLBACK_NOT_PERMITTED' };
  }
  return { allowed: true, subcode: null };
}

export type ComplianceMode = 'observe' | 'warn' | 'enforce';
export type ComplianceClosureStatus = 'CLOSED_COMPLETE' | 'CLOSED_INCOMPLETE' | 'PENDING_EVIDENCE';

export function evaluateComplianceClosure(params: {
  mode: ComplianceMode;
  manifestSchemaVersion: string;
  closureStatus: ComplianceClosureStatus;
  waiverLinked: boolean;
}): { accepted: boolean; subcode: string | null; effectiveStatus: ComplianceClosureStatus } {
  const major = params.manifestSchemaVersion.match(/^(\d+)\./)?.[1] ?? params.manifestSchemaVersion.match(/^v(\d+)/)?.[1] ?? '0';
  const knownMajor = major === '1';

  if (!knownMajor) {
    if (params.mode === 'enforce') return { accepted: false, subcode: 'AUTH_COMPLIANCE_SCHEMA_UNSUPPORTED', effectiveStatus: 'PENDING_EVIDENCE' };
    return { accepted: false, subcode: 'AUTH_COMPLIANCE_SCHEMA_UNSUPPORTED', effectiveStatus: 'PENDING_EVIDENCE' };
  }

  if (params.closureStatus === 'CLOSED_INCOMPLETE' && !params.waiverLinked) {
    return { accepted: false, subcode: 'AUTH_COMPLIANCE_WAIVER_REQUIRED', effectiveStatus: 'PENDING_EVIDENCE' };
  }

  return { accepted: true, subcode: null, effectiveStatus: params.closureStatus };
}

export function resolveCausalConflictPrecedence(params: {
  revocation: boolean;
  policyHashMismatch: boolean;
  approvalInvalid: boolean;
  delegationInvalid: boolean;
  reconciliationSuperseded: boolean;
  authoritativeEventRef: string;
}): {
  allowed: boolean;
  supersessionReason: string | null;
  precedenceRuleId: number | null;
  authoritativeEventRef: string | null;
  requiredOperatorAction: string | null;
} {
  const ordered: Array<{ when: boolean; reason: string; ruleId: number; action: string }> = [
    { when: params.revocation, reason: 'explicit_revocation', ruleId: 1, action: 're-authorize_with_new_approval' },
    { when: params.policyHashMismatch, reason: 'policy_hash_mismatch', ruleId: 2, action: 're-run_with_current_policy' },
    { when: params.approvalInvalid, reason: 'approval_invalidated', ruleId: 3, action: 'collect_fresh_sod_approvals' },
    { when: params.delegationInvalid, reason: 'delegation_invalid', ruleId: 4, action: 'mint_new_delegation' },
    { when: params.reconciliationSuperseded, reason: 'reconciliation_superseded', ruleId: 5, action: 'reconcile_then_retry' },
  ];

  const match = ordered.find((item) => item.when);
  if (!match) {
    return {
      allowed: true,
      supersessionReason: null,
      precedenceRuleId: null,
      authoritativeEventRef: null,
      requiredOperatorAction: null,
    };
  }

  return {
    allowed: false,
    supersessionReason: match.reason,
    precedenceRuleId: match.ruleId,
    authoritativeEventRef: params.authoritativeEventRef,
    requiredOperatorAction: match.action,
  };
}
