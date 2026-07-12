import { randomBytes } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import {
  archiveCredential,
  createCredential,
  deleteArchivedCredential,
  deleteCredential,
  duplicateCredential,
  findCredentialLocation,
  getCredential,
  isValidCredentialId,
  listCredentials,
  purgeDeletedCredentials,
  readCredentialSecrets,
  restoreArchivedCredential,
  restoreDeletedCredential,
  updateCredential,
  type CredentialLocation,
} from '../lib/credentials';
import { getErrorMessage } from '../lib/error';
import { hasAnyPermission, isAdmin } from '../lib/permissions';
import { recordCredentialRead } from '../lib/sessions';
import { AgentTokenPayload, CredentialField, CredentialFile, CredentialType } from '../types';
import { requireWalletAuth } from '../middleware/auth';
import { matchesScope, normalizeScope, resolveExcludeFields } from '../lib/credential-scope';
import { resolveDontAskAgainDefault } from '../lib/dont-ask-again-policy';
import { encryptToAgentPubkey } from '../lib/credential-transport';
import { logEvent } from '../lib/logger';
import { generateTOTP, findTotpField } from '../lib/totp';
import { readOAuth2SecretsWithRefresh, OAUTH2_DEFAULT_EXCLUDE_FIELDS } from '../lib/oauth2-refresh';
import { getLinkedAgentGroup, getPrimaryAgentId } from '../lib/cold';
import { createHotWallet, deleteHotWallet, exportHotWallet } from '../lib/hot';
import { evaluateCredentialAccess, type CredentialAccessReasonCode } from '../lib/credential-access-policy';
import { writeCredentialAccessAudit } from '../lib/credential-access-audit';
import { prisma } from '../lib/db';
import { getDefault } from '../lib/defaults';
import { computeGpgFingerprint, computeSshFingerprint } from '../lib/key-fingerprint';
import { events } from '../lib/events';
import { ESCALATION_CONTRACT_VERSION } from '../lib/escalation-contract';
import { respondPermissionDenied, type OneShotEscalationContext } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';
import {
  buildOperationBindingHashes,
  operationBindingMatches,
  parseRequestedPolicy,
  type TempPolicyContract,
  type TempPolicy,
} from '../lib/temp-policy';
import {
  buildCredentialHealthRows,
  summarizeCredentialHealthFlags,
} from '../lib/credential-health';
import {
  canonicalizeCredentialFieldKey,
  CREDENTIAL_FIELD_SCHEMA,
  NOTE_CONTENT_KEY,
  getCredentialFieldValue,
  normalizeCredentialFieldsForType,
} from '../../../shared/credential-field-schema';

const router = Router();

const VALID_CREDENTIAL_TYPES = new Set<CredentialType>([
  'login',
  'card',
  'sso',
  'note',
  'plain_note',
  'hot_wallet',
  'api',
  'apikey',
  'custom',
  'passkey',
  'oauth2',
  'ssh',
  'gpg',
]);

const VALID_FIELD_TYPES = new Set(['text', 'secret', 'url', 'email', 'number']);
const VALID_CREDENTIAL_LOCATIONS = new Set<CredentialLocation>(['active', 'archive', 'recently_deleted']);

const OAUTH2_REAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const oauth2ReauthState = new Map<string, { credentialId: string; redirectUri: string; expiresAt: number }>();

router.use(requireWalletAuth);

router.param('id', (req: Request, res: Response, next: NextFunction, id: string) => {
  if (!isValidCredentialId(id)) {
    res.status(400).json({ success: false, error: 'Invalid credential id format' });
    return;
  }
  next();
});

function parseCredentialLocation(value: unknown, fallback: CredentialLocation = 'active'): CredentialLocation | null {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return null;
  if (!VALID_CREDENTIAL_LOCATIONS.has(value as CredentialLocation)) return null;
  return value as CredentialLocation;
}

function toMetadata(credential: CredentialFile): Omit<CredentialFile, 'encrypted'> & { has_totp?: boolean } {
  const { encrypted: _encrypted, ...metadata } = credential;
  if (credential.meta?.has_totp === true) {
    return { ...metadata, has_totp: true };
  }
  return metadata;
}

function normalizeName(name: string): string {
  return name.trim().normalize('NFKC');
}

function readOriginalCommand(req: Request): string | undefined {
  const value = req.header('x-aura-original-command');
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Keep header storage bounded while preserving full command intent.
  return trimmed.slice(0, 4000);
}

function findSensitiveFieldValue(fields: CredentialField[], key: string): string {
  const field = fields.find((entry) => entry.key === key);
  return typeof field?.value === 'string' ? field.value : '';
}

function upsertSensitiveField(fields: CredentialField[], key: string, value: string): CredentialField[] {
  const next = [...fields];
  const index = next.findIndex((entry) => entry.key === key);
  const normalized: CredentialField = { key, value, type: 'secret', sensitive: true };
  if (index >= 0) next[index] = normalized;
  else next.push(normalized);
  return next;
}

function normalizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...meta };

  if (normalized.tags !== undefined) {
    if (!Array.isArray(normalized.tags)) {
      throw new Error('meta.tags must be an array');
    }
    normalized.tags = normalized.tags
      .filter(tag => typeof tag === 'string')
      .map(tag => normalizeScope(tag))
      .filter(tag => tag.length > 0);
  }

  if (normalized.hosts !== undefined) {
    if (!Array.isArray(normalized.hosts)) {
      throw new Error('meta.hosts must be an array');
    }
    normalized.hosts = normalized.hosts
      .filter(host => typeof host === 'string')
      .map(host => host.trim())
      .filter(host => host.length > 0);
  }

  if (normalized.walletLink !== undefined) {
    if (!normalized.walletLink || typeof normalized.walletLink !== 'object' || Array.isArray(normalized.walletLink)) {
      throw new Error('meta.walletLink must be an object');
    }

    const rawWalletLink = normalized.walletLink as Record<string, unknown>;
    const walletAddress = typeof rawWalletLink.walletAddress === 'string' ? rawWalletLink.walletAddress.trim() : '';
    const chain = typeof rawWalletLink.chain === 'string' ? rawWalletLink.chain.trim() : '';
    const tier = rawWalletLink.tier;
    const source = rawWalletLink.source;
    const label = typeof rawWalletLink.label === 'string' ? rawWalletLink.label.trim() : undefined;
    const version = typeof rawWalletLink.version === 'number' ? rawWalletLink.version : 1;

    if (!walletAddress) throw new Error('meta.walletLink.walletAddress is required');
    if (!chain) throw new Error('meta.walletLink.chain is required');
    if (tier !== 'cold' && tier !== 'hot') throw new Error('meta.walletLink.tier must be "cold" or "hot"');
    if (source !== 'existing' && source !== 'created') throw new Error('meta.walletLink.source must be "existing" or "created"');
    if (version !== 1) throw new Error('meta.walletLink.version must be 1');

    normalized.walletLink = {
      version: 1,
      walletAddress,
      chain,
      tier,
      source,
      ...(label ? { label } : {}),
      linkedAt: new Date().toISOString(),
    };
  }

  return normalized;
}

function isPrimaryAgent(agentId: string): boolean {
  const primaryAgentId = getPrimaryAgentId();
  if (primaryAgentId && agentId === primaryAgentId) return true;
  return agentId === 'primary';
}


function inferSshKeyType(keyText: string | undefined): string {
  if (!keyText) return 'other';
  const key = keyText.toLowerCase();
  if (key.includes('ed25519')) return 'ed25519';
  if (key.includes('rsa')) return 'rsa';
  if (key.includes('ecdsa')) return 'ecdsa';
  return 'other';
}

function enforceKeyCredentialMetadata(
  type: CredentialType,
  meta: Record<string, unknown>,
  sensitiveFields: CredentialField[],
): Record<string, unknown> {
  if (type !== 'ssh' && type !== 'gpg') return meta;

  const nextMeta: Record<string, unknown> = { ...meta };
  delete nextMeta.fingerprint;
  const fieldMap = new Map(sensitiveFields.map(field => [field.key, field.value]));
  const privateKey = fieldMap.get('private_key')?.trim() || '';
  const publicKey = typeof nextMeta.public_key === 'string' ? nextMeta.public_key : '';

  if (!privateKey) {
    throw new Error(`${type} requires sensitive field private_key`);
  }

  if (type === 'ssh') {
    const computed = computeSshFingerprint(publicKey || privateKey);
    if (computed) nextMeta.fingerprint = computed;
    if (!nextMeta.key_type || typeof nextMeta.key_type !== 'string') {
      nextMeta.key_type = inferSshKeyType(publicKey || privateKey);
    }
  }

  if (type === 'gpg') {
    const computed = computeGpgFingerprint(publicKey || privateKey);
    if (computed) nextMeta.fingerprint = computed;
  }

  return nextMeta;
}

const OAUTH2_REQUIRED_SECRET_FIELDS = ['access_token', 'refresh_token', 'client_id', 'client_secret'];
const OAUTH2_REAUTH_RESET_FIELDS = new Set(OAUTH2_REQUIRED_SECRET_FIELDS);

function shouldClearOAuth2ReauthMarker(credentialType: string, sensitiveFields: CredentialField[] | undefined) {
  if (credentialType !== 'oauth2' || !sensitiveFields || sensitiveFields.length === 0) {
    return false;
  }

  return sensitiveFields.some(field => OAUTH2_REAUTH_RESET_FIELDS.has(field.key));
}

function validateOAuth2Meta(meta: Record<string, unknown>) {
  const tokenEndpoint = meta.token_endpoint;
  if (typeof tokenEndpoint !== 'string' || tokenEndpoint.trim().length === 0) {
    throw new Error('oauth2 requires meta.token_endpoint');
  }

  const expiresAt = meta.expires_at;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new Error('oauth2 requires numeric meta.expires_at (unix timestamp seconds)');
  }
}

function validateOAuth2RequiredFields(fields: CredentialField[]) {
  const fieldMap = new Map(fields.map(field => [field.key, field.value]));
  for (const key of OAUTH2_REQUIRED_SECRET_FIELDS) {
    const value = fieldMap.get(key);
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`oauth2 requires sensitive field ${key}`);
    }
  }
}

function mergeOAuth2Fields(base: CredentialField[], updates: CredentialField[] = []): CredentialField[] {
  if (updates.length === 0) return base;

  const merged = new Map<string, CredentialField>();
  for (const field of base) merged.set(field.key, field);
  for (const field of updates) merged.set(field.key, field);
  return [...merged.values()];
}

function parseFields(value: unknown): CredentialField[] {
  if (!Array.isArray(value)) return [];

  const fields: CredentialField[] = [];
  for (const rawField of value) {
    if (!rawField || typeof rawField !== 'object') continue;
    const raw = rawField as Record<string, unknown>;
    if (typeof raw.key !== 'string' || typeof raw.value !== 'string') continue;

    const key = raw.key.trim();
    if (!key) continue;

    const type = typeof raw.type === 'string' && VALID_FIELD_TYPES.has(raw.type)
      ? raw.type as CredentialField['type']
      : 'text';

    fields.push({
      key,
      value: raw.value,
      type,
      sensitive: !!raw.sensitive,
    });
  }

  return fields;
}

function mergeNonSensitiveFieldsIntoMeta(
  meta: Record<string, unknown>,
  fields: CredentialField[],
): Record<string, unknown> {
  const merged = { ...meta };
  for (const field of fields) {
    if (!field.sensitive) {
      merged[field.key] = field.value;
    }
  }
  return merged;
}

/**
 * Correct field sensitivity flags based on the credential schema.
 * Clients may send fields with incorrect sensitivity (e.g. username marked sensitive).
 * This ensures the schema is the source of truth for which fields are sensitive.
 */
function correctFieldSensitivity(type: string, fields: CredentialField[]): CredentialField[] {
  const schema = CREDENTIAL_FIELD_SCHEMA[type as CredentialType];
  if (!schema || schema.length === 0) return fields;

  const specByKey = new Map(schema.map((spec) => [spec.key, spec]));
  return fields.map((field) => {
    const spec = specByKey.get(field.key);
    if (spec && field.sensitive !== spec.sensitive) {
      return { ...field, sensitive: spec.sensitive };
    }
    return field;
  });
}

function normalizePlainNoteFields(fields: CredentialField[]): CredentialField[] {
  return fields.map((field) => ({ ...field, sensitive: false, type: 'text' }));
}

function resolvePlainNoteContent(
  meta: Record<string, unknown>,
  fallbackFields: CredentialField[] = [],
): string {
  const contentFromMeta = typeof meta[NOTE_CONTENT_KEY] === 'string' ? meta[NOTE_CONTENT_KEY] : '';
  if (contentFromMeta.trim()) return contentFromMeta;

  // Legacy plain-note support: older payloads may still send/store `value`.
  const legacyMetaValue = typeof meta.value === 'string' ? meta.value : '';
  if (legacyMetaValue.trim()) return legacyMetaValue;

  const normalizedFieldValue = getCredentialFieldValue('plain_note', fallbackFields, NOTE_CONTENT_KEY) || '';
  return normalizedFieldValue.trim() ? normalizedFieldValue : '';
}

function normalizePlainNoteMeta(
  meta: Record<string, unknown>,
  fallbackFields: CredentialField[] = [],
): Record<string, unknown> {
  const normalizedMeta = { ...meta };
  const content = resolvePlainNoteContent(normalizedMeta, fallbackFields);
  normalizedMeta[NOTE_CONTENT_KEY] = content;
  delete normalizedMeta.value;
  delete normalizedMeta.key;
  return normalizedMeta;
}

function plainNoteFieldsFromMeta(
  meta: Record<string, unknown>,
  fallbackFields: CredentialField[] = [],
): CredentialField[] {
  const content = resolvePlainNoteContent(meta, fallbackFields);
  return [
    { key: NOTE_CONTENT_KEY, value: content, type: 'text', sensitive: false },
  ];
}

function canReadCredential(req: Request, credential: CredentialFile): boolean {
  const auth = req.auth!;
  if (isAdmin(auth)) return true;
  if (!hasAnyPermission(auth.token.permissions, ['secret:read'])) return false;
  const scopes = auth.token.credentialAccess?.read || [];
  return matchesScope(credential, scopes);
}

function canWriteCredential(req: Request, credential: CredentialFile): boolean {
  const auth = req.auth!;
  if (isAdmin(auth)) return true;
  if (!hasAnyPermission(auth.token.permissions, ['secret:write'])) return false;
  const scopes = auth.token.credentialAccess?.write || [];
  return matchesScope(credential, scopes);
}

function credentialActor(req: Request): {
  actorType: 'admin' | 'agent';
  agentId?: string;
  tokenHash?: string;
} {
  const auth = req.auth!;
  return {
    actorType: isAdmin(auth) ? 'admin' : 'agent',
    agentId: auth.token.agentId,
    tokenHash: auth.tokenHash,
  };
}

function emitCredentialChanged(
  req: Request,
  credential: CredentialFile,
  change:
    | 'created'
    | 'updated'
    | 'archived'
    | 'moved_to_recently_deleted'
    | 'restored_to_active'
    | 'restored_to_archive'
    | 'purged'
    | 'duplicated',
  location?: {
    fromLocation?: CredentialLocation;
    toLocation?: CredentialLocation;
  },
): void {
  const actor = credentialActor(req);
  events.credentialChanged({
    credentialId: credential.id,
    credentialAgentId: credential.agentId,
    change,
    actorType: actor.actorType,
    actorAgentId: actor.agentId,
    tokenHash: actor.tokenHash,
    fromLocation: location?.fromLocation,
    toLocation: location?.toLocation,
  });
}

function emitCredentialAccessed(
  req: Request,
  credential: CredentialFile,
  input: {
    action: 'credentials.read' | 'credentials.totp';
    allowed: boolean;
    reasonCode: string;
    httpStatus: number;
  },
): void {
  const actor = credentialActor(req);
  events.credentialAccessed({
    credentialId: credential.id,
    credentialAgentId: credential.agentId,
    action: input.action,
    allowed: input.allowed,
    reasonCode: input.reasonCode,
    httpStatus: input.httpStatus,
    actorType: actor.actorType,
    actorAgentId: actor.agentId,
    tokenHash: actor.tokenHash,
  });
}

function credentialAccessErrorMessage(reasonCode: string, action: 'credentials.read' | 'credentials.totp'): string {
  if (reasonCode === 'TOKEN_TTL_EXPIRED') return 'Credential access TTL expired';
  if (reasonCode === 'TOKEN_MAX_READS_EXCEEDED') return 'Credential read limit reached';
  if (reasonCode === 'CREDENTIAL_RATE_LIMIT_EXCEEDED') {
    return action === 'credentials.totp'
      ? 'TOTP rate limit exceeded (max 10/min)'
      : 'Credential rate limit exceeded';
  }
  if (reasonCode === 'TOKEN_BINDING_MISMATCH') return 'Claimed token binding mismatch for this retry operation';
  if (reasonCode === 'DENY_EXCLUDED_FIELD') return 'Excluded credential fields require human approval';
  if (reasonCode === 'CREDENTIAL_SCOPE_DENIED') return 'Credential read scope denied';
  if (reasonCode === 'TOKEN_PERMISSION_DENIED') return 'totp:read permission required';
  if (reasonCode === 'TOKEN_AGENT_PUBKEY_MISSING') return 'agentPubkey is required on token for credential reads';
  if (reasonCode === 'CREDENTIAL_TOTP_NOT_CONFIGURED') return 'Credential has no TOTP secret';
  return reasonCode;
}

type CredentialRouteContractId = 'credentials.read' | 'credentials.totp';
const DERIVED_403_POLICY_REJECTED_MESSAGE = 'requestedPolicy is not allowed when requestedPolicySource=derived_403';

function parseRequestedPolicyInput(body: unknown): {
  hasRequestedPolicyInput: boolean;
  requestedPolicy?: TempPolicy;
  rawRequestedPolicy?: unknown;
} {
  const bodyPayload = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const hasRequestedPolicyInput = Object.prototype.hasOwnProperty.call(bodyPayload, 'requestedPolicy');
  const requestedPolicy = parseRequestedPolicy(bodyPayload.requestedPolicy);
  return {
    hasRequestedPolicyInput,
    ...(requestedPolicy ? { requestedPolicy } : {}),
    rawRequestedPolicy: bodyPayload.requestedPolicy,
  };
}

function parseRequestedReadFieldsInput(
  body: unknown,
  credentialType: CredentialType,
): { requestedFields: string[]; requestsAllFields: boolean } {
  const bodyPayload = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const requestedFieldsRaw: string[] = [];

  const appendRequestedField = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    requestedFieldsRaw.push(trimmed);
  };

  if (Array.isArray(bodyPayload.requestedFields)) {
    for (const value of bodyPayload.requestedFields) {
      appendRequestedField(value);
    }
  }
  appendRequestedField(bodyPayload.requestedField);
  appendRequestedField(bodyPayload.field);

  const requestsAllFields = requestedFieldsRaw.some((value) => value === '*');
  const requestedFields = Array.from(new Set(
    requestedFieldsRaw
      .filter((value) => value !== '*')
      .map((value) => normalizeScope(canonicalizeCredentialFieldKey(credentialType, value))),
  ));

  return { requestedFields, requestsAllFields };
}

function buildCredentialRouteContract(input: {
  routeId: CredentialRouteContractId;
  credentialId: string;
  approvalTtl: number;
}): TempPolicyContract {
  const requiredPermissions = input.routeId === 'credentials.totp'
    ? ['secret:read', 'totp:read']
    : ['secret:read'];
  return {
    requiredPermissions,
    allowedPermissions: requiredPermissions,
    requiredReadScopes: [input.credentialId],
    allowedReadScopes: [input.credentialId],
    allowedWriteScopes: [],
    maxTtlSeconds: input.approvalTtl,
    defaultTtlSeconds: input.approvalTtl,
    maxUses: 1,
    defaultMaxUses: 1,
    allowLimits: false,
    allowWalletAccess: false,
    enforceExcludeFieldsFromDerived: true,
  };
}

function buildDerivedCredentialPolicy(input: {
  routeId: CredentialRouteContractId;
  credentialId: string;
  approvalTtl: number;
  escalationExcludeFields: string[];
}): TempPolicy {
  const requiredPermissions = input.routeId === 'credentials.totp'
    ? ['secret:read', 'totp:read']
    : ['secret:read'];
  return {
    permissions: requiredPermissions,
    limits: { fund: 0, send: 0, swap: 0 },
    credentialAccess: {
      read: [input.credentialId],
      write: [],
      excludeFields: input.escalationExcludeFields,
      maxReads: 1,
      ttl: input.approvalTtl,
    },
    ttlSeconds: input.approvalTtl,
    maxUses: 1,
  };
}

async function resolveOneShotApprovalTtl(auth: NonNullable<Request['auth']>): Promise<number> {
  const strictLikeReadToken = !isAdmin(auth)
    && Array.isArray(auth.token.permissions)
    && auth.token.permissions.length > 0
    && auth.token.permissions.every((permission) => permission === 'secret:read');
  const defaultApprovalTtl = strictLikeReadToken ? 300 : 600;
  const configuredApprovalTtl = await getDefault<number>('ttl.action', defaultApprovalTtl);
  return strictLikeReadToken
    ? Math.min(configuredApprovalTtl, 300)
    : configuredApprovalTtl;
}

async function writeDerivedPolicyRejectedAccess(params: {
  req: Request;
  res: Response;
  credential: CredentialFile;
  action: 'credentials.read' | 'credentials.totp';
  reasonCode: 'CREDENTIAL_SCOPE_DENIED' | 'DENY_EXCLUDED_FIELD' | 'TOKEN_PERMISSION_DENIED';
  rawRequestedPolicy: unknown;
}): Promise<void> {
  await writeDeniedCredentialAccess({
    req: params.req,
    credential: params.credential,
    action: params.action,
    reasonCode: params.reasonCode,
    httpStatus: 400,
    metadata: {
      policyCompileErrorCode: 'client_policy_not_allowed_for_derived_source',
      policyCompileErrorMessage: DERIVED_403_POLICY_REJECTED_MESSAGE,
      requestedPolicySource: 'derived_403',
      hasRequestedPolicyInput: true,
      requestedPolicy: params.rawRequestedPolicy ?? null,
    },
  });
  params.res.status(400).json({
    success: false,
    error: DERIVED_403_POLICY_REJECTED_MESSAGE,
    errorCode: 'client_policy_not_allowed_for_derived_source',
    requestedPolicySource: 'derived_403',
  });
}

function buildCredentialOneShotDenyContext(input: {
  auth: NonNullable<Request['auth']>;
  routeContractId: CredentialRouteContractId;
  reasonCode: 'CREDENTIAL_SCOPE_DENIED' | 'DENY_EXCLUDED_FIELD' | 'TOKEN_PERMISSION_DENIED';
  credential: CredentialFile;
  approvalTtl: number;
  escalationExcludeFields: string[];
  requestedPolicyInput: ReturnType<typeof parseRequestedPolicyInput>;
  summary: string;
  flowSummary: string;
  finalStep: string;
  retryBehavior: string;
  originalCommand?: string;
  metadata?: Record<string, unknown>;
  eventMetadata?: Record<string, unknown>;
  responseMetadata?: Record<string, unknown>;
}): OneShotEscalationContext {
  return {
    routeContractId: input.routeContractId,
    reasonCode: input.reasonCode,
    summary: input.summary,
    flowSummary: input.flowSummary,
    finalStep: input.finalStep,
    retryBehavior: input.retryBehavior,
    compile: {
      hasRequestedPolicyInput: input.requestedPolicyInput.hasRequestedPolicyInput,
      ...(input.requestedPolicyInput.requestedPolicy
        ? { requestedPolicy: input.requestedPolicyInput.requestedPolicy }
        : {}),
      derivedPolicy: buildDerivedCredentialPolicy({
        routeId: input.routeContractId,
        credentialId: input.credential.id,
        approvalTtl: input.approvalTtl,
        escalationExcludeFields: input.escalationExcludeFields,
      }),
      contract: buildCredentialRouteContract({
        routeId: input.routeContractId,
        credentialId: input.credential.id,
        approvalTtl: input.approvalTtl,
      }),
      binding: {
        actorId: input.auth.token.agentId || 'agent',
        method: 'POST',
        routeId: input.routeContractId,
        resource: { credentialId: input.credential.id },
        body: {},
      },
    },
    metadata: {
      credentialId: input.credential.id,
      credentialName: input.credential.name,
      credentialAgentId: input.credential.agentId,
      ...(input.originalCommand ? { originalCommand: input.originalCommand } : {}),
      ...(input.metadata || {}),
    },
    eventMetadata: {
      agentId: input.auth.token.agentId,
      credentialId: input.credential.id,
      credentialName: input.credential.name,
      ...(input.eventMetadata || {}),
    },
    responseMetadata: {
      credential: {
        id: input.credential.id,
        name: input.credential.name,
        agentId: input.credential.agentId,
      },
      ...(input.responseMetadata || {}),
    },
  };
}

function validateCredentialOperationBinding(input: {
  tokenBinding?: AgentTokenPayload['oneShotBinding'];
  routeId: CredentialRouteContractId;
  credentialId: string;
}): {
  hasBinding: boolean;
  matches: boolean;
  reqId?: string;
  policyHash?: string;
  compilerVersion?: string;
  expectedMethod: string;
  expectedRouteId: string;
  expectedBinding: {
    routeId: string;
    method: string;
    resourceHash: string;
    bodyHash: string;
    bindingHash: string;
  } | null;
  actualBinding: {
    actorId: string;
    method: string;
    routeId: string;
    resourceHash: string;
    bodyHash: string;
    bindingHash: string;
  } | null;
} {
  const tokenBinding = input.tokenBinding;
  if (!tokenBinding || typeof tokenBinding !== 'object') {
    return {
      hasBinding: false,
      matches: true,
      expectedMethod: 'POST',
      expectedRouteId: input.routeId,
      expectedBinding: null,
      actualBinding: null,
    };
  }
  const bindingActorId = typeof tokenBinding.actorId === 'string' ? tokenBinding.actorId : '';
  const bindingMethod = typeof tokenBinding.method === 'string' ? tokenBinding.method : '';
  const bindingRouteId = typeof tokenBinding.routeId === 'string' ? tokenBinding.routeId : '';
  const bindingResourceHash = typeof tokenBinding.resourceHash === 'string' ? tokenBinding.resourceHash : '';
  const bindingBodyHash = typeof tokenBinding.bodyHash === 'string' ? tokenBinding.bodyHash : '';
  const bindingHash = typeof tokenBinding.bindingHash === 'string' ? tokenBinding.bindingHash : '';
  const policyHash = typeof tokenBinding.policyHash === 'string' ? tokenBinding.policyHash : undefined;
  const compilerVersion = typeof tokenBinding.compilerVersion === 'string' ? tokenBinding.compilerVersion : undefined;
  const reqId = typeof tokenBinding.reqId === 'string' ? tokenBinding.reqId : undefined;
  const hasBinding =
    bindingActorId.length > 0
    && bindingMethod.length > 0
    && bindingRouteId.length > 0
    && bindingResourceHash.length > 0
    && bindingBodyHash.length > 0
    && bindingHash.length > 0
    && typeof policyHash === 'string'
    && policyHash.length > 0;
  const expectedBinding = hasBinding
    ? buildOperationBindingHashes({
        actorId: bindingActorId,
        method: 'POST',
        routeId: input.routeId,
        resource: { credentialId: input.credentialId },
        body: {},
        policyHash,
      })
    : null;
  const matches = hasBinding
    ? operationBindingMatches({
        binding: {
          actorId: bindingActorId,
          method: bindingMethod,
          routeId: bindingRouteId,
          resourceHash: bindingResourceHash,
          bodyHash: bindingBodyHash,
        },
        actorId: bindingActorId,
        method: 'POST',
        routeId: input.routeId,
        resource: { credentialId: input.credentialId },
        body: {},
      })
    : false;
  return {
    hasBinding,
    matches,
    reqId,
    policyHash,
    compilerVersion,
    expectedMethod: bindingMethod || 'POST',
    expectedRouteId: bindingRouteId || input.routeId,
    expectedBinding: expectedBinding
      ? {
          routeId: expectedBinding.routeId,
          method: expectedBinding.method,
          resourceHash: expectedBinding.resourceHash,
          bodyHash: expectedBinding.bodyHash,
          bindingHash: expectedBinding.bindingHash,
        }
      : null,
    actualBinding: hasBinding
      ? {
          actorId: bindingActorId,
          method: bindingMethod,
          routeId: bindingRouteId,
          resourceHash: bindingResourceHash,
          bodyHash: bindingBodyHash,
          bindingHash,
        }
      : null,
  };
}

function buildBindingMismatchPayload(input: {
  reqId?: string;
  policyHash?: string;
  compilerVersion?: string;
  expectedMethod: string;
  expectedRouteId: string;
  expectedBinding: {
    routeId: string;
    method: string;
    resourceHash: string;
    bodyHash: string;
    bindingHash: string;
  };
}): Record<string, unknown> {
  const reqId = input.reqId;
  const claimCommand = reqId ? `npx auramaxx auth claim ${reqId} --json` : undefined;
  const retryCommand = reqId
    ? `<retry_original_command> --reqId ${reqId}`
    : '<retry_original_command>';
  return {
    contractVersion: ESCALATION_CONTRACT_VERSION,
    success: false,
    requiresHumanApproval: false,
    ...(reqId ? { reqId } : {}),
    approvalScope: 'one_shot_read',
    errorCode: 'operation_binding_mismatch',
    claimStatus: 'approved',
    retryReady: false,
    error: `Claimed token is bound to ${input.expectedMethod} ${input.expectedRouteId}; this retry does not match the bound operation.`,
    ...(claimCommand ? {
      claimAction: {
        transport: 'cli',
        kind: 'command',
        command: claimCommand,
      },
    } : {}),
    retryAction: {
      transport: 'cli',
      kind: 'command',
      command: retryCommand,
    },
    ...(claimCommand ? {
      instructions: [
        `1) Re-claim approval token: ${claimCommand}`,
        `2) Retry original command with correct reqId binding: ${retryCommand}`,
      ],
    } : {}),
    expectedBinding: input.expectedBinding,
    ...(input.policyHash ? { policyHash: input.policyHash } : {}),
    ...(input.compilerVersion ? { compilerVersion: input.compilerVersion } : {}),
  };
}

async function writeDeniedCredentialAccess(params: {
  req: Request;
  credential: CredentialFile;
  action: 'credentials.read' | 'credentials.totp';
  reasonCode: 'TOKEN_TTL_EXPIRED' | 'TOKEN_MAX_READS_EXCEEDED' | 'CREDENTIAL_RATE_LIMIT_EXCEEDED' | 'TOKEN_BINDING_MISMATCH' | 'CREDENTIAL_SCOPE_DENIED' | 'TOKEN_PERMISSION_DENIED' | 'TOKEN_AGENT_PUBKEY_MISSING' | 'CREDENTIAL_TOTP_NOT_CONFIGURED' | 'DENY_EXCLUDED_FIELD';
  httpStatus: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const auth = params.req.auth!;
  await writeCredentialAccessAudit({
    credentialId: params.credential.id,
    credentialAgentId: params.credential.agentId,
    action: params.action,
    allowed: false,
    reasonCode: params.reasonCode,
    httpStatus: params.httpStatus,
    tokenHash: auth.tokenHash,
    actorAgentId: auth.token.agentId,
    requestId: params.req.header('x-request-id') ?? undefined,
    actorType: isAdmin(auth) ? 'admin' : 'agent',
    metadata: params.metadata,
  });
  emitCredentialAccessed(params.req, params.credential, {
    action: params.action,
    allowed: false,
    reasonCode: params.reasonCode,
    httpStatus: params.httpStatus,
  });
}

type HealthScanJobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'expired';

const healthScanJobs = new Map<string, {
  status: HealthScanJobStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}>();

function newScanId(): string {
  return `scan-${Math.random().toString(36).slice(2, 10)}`;
}

function listHealthCredentials(req: Request): CredentialFile[] {
  const auth = req.auth!;
  const reuseScopeMode = req.query.reuseScope === 'agent' ? 'agent' : 'group';
  const selectedAgent = typeof req.query.agent === 'string' ? req.query.agent : undefined;

  const candidates = listCredentials();
  const readable = isAdmin(auth)
    ? candidates
    : candidates.filter(credential => matchesScope(credential, auth.token.credentialAccess?.read || []));

  if (!selectedAgent) return readable;
  if (reuseScopeMode === 'agent') return readable.filter(c => c.agentId === selectedAgent);

  const group = new Set(getLinkedAgentGroup(selectedAgent));
  return readable.filter(c => group.has(c.agentId));
}

function pruneExpiredHealthJobs(): void {
  const now = Date.now();
  for (const [id, job] of healthScanJobs.entries()) {
    const terminal = job.status === 'complete' || job.status === 'failed';
    if (!terminal) continue;
    if (now - job.updatedAt > 30 * 60 * 1000) {
      healthScanJobs.set(id, { ...job, status: 'expired', updatedAt: now });
    }
  }
}

// POST /credentials — create
router.post('/', async (req: Request, res: Response) => {
  try {
    const auth = req.auth!;
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['secret:write'])) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SECRET_WRITE_PERMISSION,
        error: 'secret:write permission required',
        required: ['secret:write'],
        have: auth.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId : '';
    const type = typeof req.body?.type === 'string' ? req.body.type : '';
    const rawName = typeof req.body?.name === 'string' ? req.body.name : '';

    if (!agentId || !type || !rawName) {
      res.status(400).json({ success: false, error: 'agentId, type, and name are required' });
      return;
    }
    if (!VALID_CREDENTIAL_TYPES.has(type as CredentialType)) {
      res.status(400).json({ success: false, error: `Invalid credential type: ${type}` });
      return;
    }

    const name = normalizeName(rawName);
    const rawMeta = req.body?.meta && typeof req.body.meta === 'object' && !Array.isArray(req.body.meta)
      ? req.body.meta as Record<string, unknown>
      : {};
    const normalizedMeta = normalizeMeta(rawMeta);
    const rawFieldsInitial = normalizeCredentialFieldsForType(type, parseFields(req.body?.fields));
    const rawFields = type === 'plain_note' ? normalizePlainNoteFields(rawFieldsInitial) : rawFieldsInitial;
    const sensitiveFieldsInitial = normalizeCredentialFieldsForType(type, parseFields(req.body?.sensitiveFields));
    const sensitiveFields = type === 'plain_note' ? [] : sensitiveFieldsInitial;
    // Combine all fields and correct sensitivity based on schema so that
    // fields like username/url are never incorrectly treated as sensitive.
    const allFieldsCombined = normalizeCredentialFieldsForType(type, [...rawFields, ...sensitiveFields]);
    const allFieldsCorrected = correctFieldSensitivity(type, allFieldsCombined);
    let fieldsToEncrypt = allFieldsCorrected.filter(field => field.sensitive);
    let finalMeta = mergeNonSensitiveFieldsIntoMeta(normalizedMeta, allFieldsCorrected);
    let provisionedHotWalletAddress: string | null = null;

    if (type === 'plain_note') {
      const normalizedPlainNoteMeta = normalizePlainNoteMeta(finalMeta, rawFields);
      if (!resolvePlainNoteContent(normalizedPlainNoteMeta, rawFields)) {
        res.status(400).json({ success: false, error: 'plain_note requires non-empty content field' });
        return;
      }
      finalMeta = normalizedPlainNoteMeta;
    }

    if (!isAdmin(auth) && type === 'hot_wallet') {
      const candidate: CredentialFile = {
        id: 'pending',
        agentId,
        type: type as CredentialType,
        name,
        meta: finalMeta,
        encrypted: { ciphertext: '', iv: '', salt: '', mac: '' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const scopes = auth.token.credentialAccess?.write || [];
      if (!matchesScope(candidate, scopes)) {
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SCOPE_WRITE,
          error: 'Credential write scope denied',
          required: ['secret:write'],
          have: auth.token.permissions,
          extraPayload: { success: false },
        });
        return;
      }
    }

    if (type === 'hot_wallet') {
      if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['wallet:create:hot'])) {
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_WALLET_CREATE_HOT_PERMISSION,
          error: 'wallet:create:hot permission required',
          required: ['wallet:create:hot'],
          have: auth.token.permissions,
          extraPayload: { success: false },
        });
        return;
      }

      const chainFromMeta = typeof finalMeta.chain === 'string' ? finalMeta.chain.trim().toLowerCase() : '';
      const chain = chainFromMeta || 'base';
      try {
        const hotWallet = await createHotWallet({
          tokenHash: auth.tokenHash,
          chain,
          name,
          coldWalletId: agentId === 'primary' ? undefined : agentId,
        });
        provisionedHotWalletAddress = hotWallet.address;
        const exported = await exportHotWallet(hotWallet.address);

        fieldsToEncrypt = [{
          key: 'private_key',
          value: exported.privateKey,
          type: 'secret',
          sensitive: true,
        }];

        finalMeta = normalizeMeta({
          ...finalMeta,
          address: hotWallet.address,
          chain: hotWallet.chain || chain,
          walletLink: {
            version: 1,
            walletAddress: hotWallet.address,
            chain: hotWallet.chain || chain,
            tier: 'hot',
            source: 'created',
            ...(hotWallet.name ? { label: hotWallet.name } : {}),
          },
        });
      } catch (error) {
        if (provisionedHotWalletAddress) {
          await deleteHotWallet(provisionedHotWalletAddress).catch(() => {});
        }
        throw error;
      }
    }

    if (type === 'oauth2') {
      if (!isPrimaryAgent(agentId)) {
        res.status(400).json({ success: false, error: 'oauth2 credentials must be stored in the primary agent' });
        return;
      }
      validateOAuth2Meta(finalMeta);
      validateOAuth2RequiredFields(fieldsToEncrypt.length > 0 ? fieldsToEncrypt : rawFields);
    }

    if (type === 'ssh' || type === 'gpg') {
      finalMeta = enforceKeyCredentialMetadata(type as CredentialType, finalMeta, fieldsToEncrypt);
    }

    if (!isAdmin(auth) && type !== 'hot_wallet') {
      const candidate: CredentialFile = {
        id: 'pending',
        agentId,
        type: type as CredentialType,
        name,
        meta: finalMeta,
        encrypted: { ciphertext: '', iv: '', salt: '', mac: '' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const scopes = auth.token.credentialAccess?.write || [];
      if (!matchesScope(candidate, scopes)) {
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SCOPE_WRITE,
          error: 'Credential write scope denied',
          required: ['secret:write'],
          have: auth.token.permissions,
          extraPayload: { success: false },
        });
        return;
      }
    }

    // Auto-set has_totp flag in meta if TOTP field present (check both 'totp' and 'otp' for compat)
    if (findTotpField(fieldsToEncrypt)) {
      finalMeta.has_totp = true;
    }

    let created: CredentialFile;
    try {
      created = createCredential(agentId, type as CredentialType, name, finalMeta, fieldsToEncrypt);
    } catch (error) {
      if (provisionedHotWalletAddress) {
        await deleteHotWallet(provisionedHotWalletAddress).catch(() => {});
      }
      throw error;
    }

    emitCredentialChanged(req, created, 'created', { toLocation: 'active' });
    res.json({ success: true, credential: toMetadata(created) });
  } catch (error) {
    res.status(400).json({ success: false, error: getErrorMessage(error) });
  }
});

// GET /credentials — list metadata
router.get('/', async (req: Request, res: Response) => {
  try {
    const auth = req.auth!;
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['secret:read'])) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SECRET_READ_PERMISSION,
        error: 'secret:read permission required',
        required: ['secret:read'],
        have: auth.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    const agentId = typeof req.query.agent === 'string' ? req.query.agent : undefined;
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    const location = parseCredentialLocation(req.query.location, 'active');

    if (type && !VALID_CREDENTIAL_TYPES.has(type as CredentialType)) {
      res.status(400).json({ success: false, error: `Invalid credential type: ${type}` });
      return;
    }
    if (!location) {
      res.status(400).json({ success: false, error: 'Invalid location. Expected active, archive, or recently_deleted' });
      return;
    }

    const credentials = listCredentials({
      agentId,
      type: type as CredentialType | undefined,
      tag,
      query,
    }, location);

    const filtered = isAdmin(auth)
      ? credentials
      : credentials.filter(credential => matchesScope(credential, auth.token.credentialAccess?.read || []));

    const includeHealth = req.query.health === '1' || req.query.health === 'true';

    if (!includeHealth) {
      res.json({
        success: true,
        credentials: filtered.map(toMetadata),
      });
      return;
    }

    const rows = await buildCredentialHealthRows(filtered, readCredentialSecrets);
    const rowById = new Map(rows.map(row => [row.id, row.health]));

    res.json({
      success: true,
      credentials: filtered.map(credential => ({
        ...toMetadata(credential),
        health: rowById.get(credential.id)
          ? { status: rowById.get(credential.id)!.status }
          : undefined,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

// GET /credentials/health/summary — aggregate credential health
router.get('/health/summary', async (req: Request, res: Response) => {
  try {
    const auth = req.auth!;
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['secret:read'])) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SECRET_READ_PERMISSION,
        error: 'secret:read permission required',
        required: ['secret:read'],
        have: auth.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    pruneExpiredHealthJobs();

    const credentials = listHealthCredentials(req);
    const rows = await buildCredentialHealthRows(credentials, readCredentialSecrets);
    const summary = summarizeCredentialHealthFlags(rows.map((row) => row.health.flags));

    res.json({
      success: true,
      summary: {
        totalAnalyzed: summary.total,
        safe: summary.safe,
        weak: summary.weak,
        reused: summary.reused,
        breached: summary.breached,
        unknown: summary.unknown,
        lastScanAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

// GET /credentials/health — per-credential health rows
router.get('/health', async (req: Request, res: Response) => {
  try {
    const auth = req.auth!;
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['secret:read'])) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SECRET_READ_PERMISSION,
        error: 'secret:read permission required',
        required: ['secret:read'],
        have: auth.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    pruneExpiredHealthJobs();

    const credentials = listHealthCredentials(req);
    const rows = await buildCredentialHealthRows(credentials, readCredentialSecrets);

    res.json({ success: true, credentials: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

// POST /credentials/health/rescan — async job kickoff
router.post('/health/rescan', async (req: Request, res: Response) => {
  try {
    const auth = req.auth!;
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['secret:read'])) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SECRET_READ_PERMISSION,
        error: 'secret:read permission required',
        required: ['secret:read'],
        have: auth.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    const scanId = newScanId();
    const now = Date.now();
    healthScanJobs.set(scanId, { status: 'queued', createdAt: now, updatedAt: now });

    void (async () => {
      try {
        healthScanJobs.set(scanId, { status: 'running', createdAt: now, updatedAt: Date.now() });
        const credentials = listHealthCredentials(req);
        await buildCredentialHealthRows(credentials, readCredentialSecrets);
        healthScanJobs.set(scanId, { status: 'complete', createdAt: now, updatedAt: Date.now() });
      } catch (error) {
        healthScanJobs.set(scanId, {
          status: 'failed',
          createdAt: now,
          updatedAt: Date.now(),
          error: getErrorMessage(error),
        });
      }
    })();

    res.json({ accepted: true, scanId });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

// GET /credentials/health/rescan/:scanId — read async scan status
router.get('/health/rescan/:scanId', async (req: Request<{ scanId: string }>, res: Response) => {
  try {
    const auth = req.auth!;
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['secret:read'])) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SECRET_READ_PERMISSION,
        error: 'secret:read permission required',
        required: ['secret:read'],
        have: auth.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    pruneExpiredHealthJobs();

    const scan = healthScanJobs.get(req.params.scanId);
    if (!scan) {
      res.status(404).json({ success: false, error: 'Scan job not found' });
      return;
    }

    res.json({
      success: true,
      scanId: req.params.scanId,
      scan: {
        status: scan.status,
        createdAt: new Date(scan.createdAt).toISOString(),
        updatedAt: new Date(scan.updatedAt).toISOString(),
        error: scan.error,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

// GET /credentials/:id — metadata
router.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const credential = getCredential(req.params.id);
    if (!credential) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }

    if (!canReadCredential(req, credential)) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SCOPE_READ,
        error: 'Credential read scope denied',
        required: ['secret:read'],
        have: req.auth?.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    res.json({ success: true, credential: toMetadata(credential) });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

// PUT /credentials/:id — update
router.put('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const credential = getCredential(req.params.id);
    if (!credential) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }
    if (!canWriteCredential(req, credential)) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SCOPE_WRITE,
        error: 'Credential write scope denied',
        required: ['secret:write'],
        have: req.auth?.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    let updatedMeta: Record<string, unknown> | undefined;
    const hasMetaInput = req.body && Object.prototype.hasOwnProperty.call(req.body, 'meta');
    if (hasMetaInput) {
      if (!req.body.meta || typeof req.body.meta !== 'object' || Array.isArray(req.body.meta)) {
        res.status(400).json({ success: false, error: 'meta must be an object' });
        return;
      }
      updatedMeta = normalizeMeta(req.body.meta as Record<string, unknown>);
    }

    const parsedFields = normalizeCredentialFieldsForType(credential.type, parseFields(req.body?.fields));
    const fields = credential.type === 'plain_note' ? normalizePlainNoteFields(parsedFields) : parsedFields;
    const hasSensitiveInput = req.body && Object.prototype.hasOwnProperty.call(req.body, 'sensitiveFields');
    const parsedSensitiveFields = hasSensitiveInput
      ? normalizeCredentialFieldsForType(credential.type, parseFields(req.body.sensitiveFields))
      : [];

    // Combine all incoming fields and correct sensitivity based on schema.
    const allUpdateFields = normalizeCredentialFieldsForType(credential.type, [...fields, ...parsedSensitiveFields]);
    const allUpdateFieldsCorrected = credential.type === 'plain_note'
      ? normalizePlainNoteFields(allUpdateFields)
      : correctFieldSensitivity(credential.type, allUpdateFields);

    const hasNonSensitiveFields = allUpdateFieldsCorrected.some(f => !f.sensitive);
    if (hasNonSensitiveFields || updatedMeta) {
      const baseMeta = updatedMeta || { ...credential.meta };
      updatedMeta = mergeNonSensitiveFieldsIntoMeta(baseMeta, allUpdateFieldsCorrected);
    }

    if (credential.type === 'plain_note' && updatedMeta) {
      const existingPlainNoteSecrets = readCredentialSecrets(credential.id);
      const plainNoteFallbackFields = [...existingPlainNoteSecrets, ...allUpdateFieldsCorrected];
      updatedMeta = normalizePlainNoteMeta(updatedMeta, plainNoteFallbackFields);
      if (!resolvePlainNoteContent(updatedMeta, plainNoteFallbackFields)) {
        res.status(400).json({ success: false, error: 'plain_note requires non-empty content field' });
        return;
      }
    }

    let sensitiveFields: CredentialField[] | undefined;
    if (credential.type === 'plain_note') {
      sensitiveFields = [];
    } else if (hasSensitiveInput || allUpdateFieldsCorrected.length > 0) {
      const correctedSensitive = allUpdateFieldsCorrected.filter(field => field.sensitive);
      if (correctedSensitive.length > 0) {
        sensitiveFields = correctedSensitive;
      } else if (hasSensitiveInput) {
        // Client explicitly sent sensitiveFields but after correction none are sensitive
        sensitiveFields = [];
      }
    }

    // Auto-set has_totp flag in meta if TOTP field present in update
    if (sensitiveFields && findTotpField(sensitiveFields)) {
      if (!updatedMeta) updatedMeta = { ...credential.meta };
      updatedMeta.has_totp = true;
    }

    const rawName = typeof req.body?.name === 'string' ? normalizeName(req.body.name) : undefined;

    if (credential.type === 'oauth2') {
      const baseMeta = credential.meta as Record<string, unknown>;
      const updatedReauthMeta = shouldClearOAuth2ReauthMarker(credential.type, sensitiveFields)
        ? {
            ...baseMeta,
            needs_reauth: false,
            reauth_reason: null,
          }
        : baseMeta;

      const finalMeta = { ...baseMeta, ...updatedReauthMeta, ...updatedMeta };
      validateOAuth2Meta(finalMeta);
      if (!isPrimaryAgent(credential.agentId)) {
        res.status(400).json({ success: false, error: 'oauth2 credentials must be stored in the primary agent' });
        return;
      }

      if (sensitiveFields !== undefined) {
        const existingSensitiveFields = readCredentialSecrets(req.params.id);
        const effectiveSensitiveFields = mergeOAuth2Fields(existingSensitiveFields, sensitiveFields);
        validateOAuth2RequiredFields(effectiveSensitiveFields);
      }

      updatedMeta = finalMeta;
    }


    if ((credential.type === 'ssh' || credential.type === 'gpg') && updatedMeta) {
      const existingSensitiveFields = readCredentialSecrets(credential.id);
      const effectiveSensitiveFields = sensitiveFields !== undefined
        ? mergeOAuth2Fields(existingSensitiveFields, sensitiveFields)
        : existingSensitiveFields;
      updatedMeta = enforceKeyCredentialMetadata(credential.type, updatedMeta, effectiveSensitiveFields);
    }

    const updated = updateCredential(req.params.id, {
      name: rawName,
      meta: updatedMeta,
      sensitiveFields,
    });

    emitCredentialChanged(req, updated, 'updated', { toLocation: 'active' });
    res.json({ success: true, credential: toMetadata(updated) });
  } catch (error) {
    res.status(400).json({ success: false, error: getErrorMessage(error) });
  }
});

// DELETE /credentials/:id — lifecycle delete:
// active -> archive, archive -> recently_deleted, recently_deleted -> permanent delete
router.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const location = parseCredentialLocation(req.query.location, 'active');
    if (!location) {
      res.status(400).json({ success: false, error: 'Invalid location. Expected active, archive, or recently_deleted' });
      return;
    }

    const credential = getCredential(req.params.id, location);
    if (!credential) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }
    if (!canWriteCredential(req, credential)) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SCOPE_WRITE,
        error: 'Credential write scope denied',
        required: ['secret:write'],
        have: req.auth?.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    if (location === 'active') {
      const archived = archiveCredential(req.params.id);
      if (archived) {
        emitCredentialChanged(req, archived, 'archived', {
          fromLocation: 'active',
          toLocation: 'archive',
        });
      }
      res.json({ success: true, action: 'archived', credential: archived ? toMetadata(archived) : null });
      return;
    }

    if (location === 'archive') {
      const deleted = deleteArchivedCredential(req.params.id);
      if (deleted) {
        emitCredentialChanged(req, deleted, 'moved_to_recently_deleted', {
          fromLocation: 'archive',
          toLocation: 'recently_deleted',
        });
      }
      res.json({ success: true, action: 'moved_to_recently_deleted', credential: deleted ? toMetadata(deleted) : null });
      return;
    }

    const deleted = deleteCredential(req.params.id, 'recently_deleted');
    if (deleted) {
      emitCredentialChanged(req, credential, 'purged', {
        fromLocation: 'recently_deleted',
      });
    }
    res.json({ success: true, action: 'purged', deleted });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

// POST /credentials/:id/restore — restore from archive/recently_deleted
router.post('/:id/restore', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const from = parseCredentialLocation(req.body?.from ?? req.query.from, 'archive');
    if (!from || from === 'active') {
      res.status(400).json({ success: false, error: 'Invalid from location. Expected archive or recently_deleted' });
      return;
    }

    const credential = getCredential(req.params.id, from);
    if (!credential) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }
    if (!canWriteCredential(req, credential)) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SCOPE_WRITE,
        error: 'Credential write scope denied',
        required: ['secret:write'],
        have: req.auth?.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    if (from === 'archive') {
      const restored = restoreArchivedCredential(req.params.id);
      if (restored) {
        emitCredentialChanged(req, restored, 'restored_to_active', {
          fromLocation: 'archive',
          toLocation: 'active',
        });
      }
      res.json({ success: true, action: 'restored_to_active', credential: restored ? toMetadata(restored) : null });
      return;
    }

    const restored = restoreDeletedCredential(req.params.id);
    if (restored) {
      emitCredentialChanged(req, restored, 'restored_to_archive', {
        fromLocation: 'recently_deleted',
        toLocation: 'archive',
      });
    }
    res.json({ success: true, action: 'restored_to_archive', credential: restored ? toMetadata(restored) : null });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

// POST /credentials/:id/duplicate — duplicate an active credential
router.post('/:id/duplicate', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const auth = req.auth!;
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['secret:write'])) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SECRET_WRITE_PERMISSION,
        error: 'secret:write permission required',
        required: ['secret:write'],
        have: auth.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    const source = getCredential(req.params.id, 'active');
    if (!source) {
      res.status(404).json({ success: false, error: 'Credential not found in active location' });
      return;
    }

    if (!canWriteCredential(req, source)) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SCOPE_WRITE,
        error: 'Credential write scope denied',
        required: ['secret:write'],
        have: auth.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    const { name, agentId } = req.body || {};
    const newCred = duplicateCredential(req.params.id, {
      name: typeof name === 'string' ? name : undefined,
      agentId: typeof agentId === 'string' ? agentId : undefined,
    });

    emitCredentialChanged(req, newCred, 'duplicated');
    res.json({ success: true, credential: toMetadata(newCred) });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

// POST /credentials/purge — manual retention sweep for recently deleted credentials
router.post('/purge', (req: Request, res: Response) => {
  try {
    const daysRaw = req.body?.retentionDays;
    const retentionDays = typeof daysRaw === 'number' && Number.isFinite(daysRaw) && daysRaw > 0
      ? Math.floor(daysRaw)
      : 30;
    const summary = purgeDeletedCredentials(retentionDays);
    res.json({ success: true, retentionDays, ...summary });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

// POST /credentials/:id/read — decrypt, filter fields, re-encrypt to agent pubkey
router.post('/:id/read', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const auth = req.auth!;
    const originalCommand = readOriginalCommand(req);
    const requestedLocation = parseCredentialLocation(req.query.location, 'active');
    if (!requestedLocation) {
      res.status(400).json({ success: false, error: 'Invalid location. Expected active, archive, or recently_deleted' });
      return;
    }

    let credentialLocation: CredentialLocation = requestedLocation;
    let credential = getCredential(req.params.id, credentialLocation);
    if (!credential && requestedLocation === 'active') {
      const detectedLocation = findCredentialLocation(req.params.id);
      if (detectedLocation) {
        credentialLocation = detectedLocation;
        credential = getCredential(req.params.id, credentialLocation);
      }
    }

    if (!credential) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }

    const tokenBinding = auth.token.oneShotBinding;
    if (tokenBinding && typeof tokenBinding === 'object') {
      const bindingCheck = validateCredentialOperationBinding({
        tokenBinding,
        routeId: 'credentials.read',
        credentialId: credential.id,
      });
      if (!bindingCheck.matches || !bindingCheck.expectedBinding) {
        await writeDeniedCredentialAccess({
          req,
          credential,
          action: 'credentials.read',
          reasonCode: 'TOKEN_BINDING_MISMATCH',
          httpStatus: 403,
          metadata: {
            reqId: bindingCheck.reqId,
            policyHash: bindingCheck.policyHash,
            compilerVersion: bindingCheck.compilerVersion,
            actualBinding: bindingCheck.actualBinding,
            expectedBinding: bindingCheck.expectedBinding,
          },
        });
        res.status(403).json(buildBindingMismatchPayload({
          reqId: bindingCheck.reqId,
          policyHash: bindingCheck.policyHash,
          compilerVersion: bindingCheck.compilerVersion,
          expectedMethod: bindingCheck.expectedMethod,
          expectedRouteId: bindingCheck.expectedRouteId,
          expectedBinding: bindingCheck.expectedBinding || {
            routeId: 'credentials.read',
            method: 'POST',
            resourceHash: '',
            bodyHash: '',
            bindingHash: '',
          },
        }));
        return;
      }
    }

    if (!canReadCredential(req, credential)) {
      const requestedPolicyInput = parseRequestedPolicyInput(req.body);
      if (requestedPolicyInput.hasRequestedPolicyInput) {
        await writeDerivedPolicyRejectedAccess({
          req,
          res,
          credential,
          action: 'credentials.read',
          reasonCode: 'CREDENTIAL_SCOPE_DENIED',
          rawRequestedPolicy: requestedPolicyInput.rawRequestedPolicy,
        });
        return;
      }
      const approvalTtl = await resolveOneShotApprovalTtl(auth);
      const scopeExcludeFields = isAdmin(auth)
        ? []
        : Array.from(new Set(resolveExcludeFields(auth.token.credentialAccess?.excludeFields, credential.type).map((field) => normalizeScope(field))));
      const context = buildCredentialOneShotDenyContext({
        auth,
        routeContractId: 'credentials.read',
        reasonCode: 'CREDENTIAL_SCOPE_DENIED',
        credential,
        approvalTtl,
        escalationExcludeFields: scopeExcludeFields,
        requestedPolicyInput,
        summary: `${auth.token.agentId || 'agent'} requests scoped read access for credential "${credential.name}"`,
        flowSummary: 'This approval grants a one-shot scoped read token (maxReads=1, short TTL).',
        finalStep: 'Retry the original secret read/inject call after claim succeeds.',
        retryBehavior: 'Retrying before claim completion will return another approval-required response.',
        originalCommand,
        metadata: {
          policyContext: {
            readScopes: auth.token.credentialAccess?.read || [],
            tokenExcludeFields: auth.token.credentialAccess?.excludeFields ?? null,
            effectiveExcludeFields: scopeExcludeFields,
            credentialType: credential.type,
          },
        },
        responseMetadata: {
          effectiveExcludeFields: scopeExcludeFields,
        },
      });
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_READ_SCOPE_DENIED,
        error: credentialAccessErrorMessage('CREDENTIAL_SCOPE_DENIED', 'credentials.read'),
        required: ['secret:read'],
        have: auth.token.permissions,
        requestedPolicySource: 'derived_403',
        denyContext: context,
        extraPayload: { success: false },
        onResponsePayload: async (payload, httpStatus) => {
          await writeDeniedCredentialAccess({
            req,
            credential,
            action: 'credentials.read',
            reasonCode: 'CREDENTIAL_SCOPE_DENIED',
            httpStatus,
            metadata: {
              escalationRouteId: ESCALATION_ROUTE_IDS.CREDENTIALS_READ_SCOPE_DENIED,
              routeContractId: 'credentials.read',
              requestedPolicySource: 'derived_403',
              reqId: typeof payload.reqId === 'string' ? payload.reqId : undefined,
              policyHash: typeof payload.policyHash === 'string' ? payload.policyHash : undefined,
              compilerVersion: typeof payload.compilerVersion === 'string' ? payload.compilerVersion : undefined,
            },
          });
        },
      });
      return;
    }

    const decision = evaluateCredentialAccess({
      tokenHash: auth.tokenHash,
      token: auth.token,
      credentialId: credential.id,
      action: 'credentials.read',
    });
    if (!decision.allowed) {
      const denyReason = decision.reasonCode as Exclude<CredentialAccessReasonCode, 'ALLOW'>;
      await writeDeniedCredentialAccess({
        req,
        credential,
        action: 'credentials.read',
        reasonCode: denyReason,
        httpStatus: decision.httpStatus,
        metadata: {
          limiterWindowMs: decision.limiterWindowMs,
          limiterLimit: decision.limiterLimit,
          limiterCount: decision.limiterCount,
        },
      });
      res.status(decision.httpStatus).json({
        success: false,
        error: credentialAccessErrorMessage(denyReason, 'credentials.read'),
        reasonCode: denyReason,
      });
      return;
    }

    if (!auth.token.agentPubkey) {
      await writeDeniedCredentialAccess({
        req,
        credential,
        action: 'credentials.read',
        reasonCode: 'TOKEN_AGENT_PUBKEY_MISSING',
        httpStatus: 400,
      });
      res.status(400).json({
        success: false,
        error: credentialAccessErrorMessage('TOKEN_AGENT_PUBKEY_MISSING', 'credentials.read'),
        reasonCode: 'TOKEN_AGENT_PUBKEY_MISSING',
      });
      return;
    }

    // For oauth2 credentials, auto-refresh if expired.
    // For plain notes, we still read encrypted fields as a fallback for older data.
    const rawSecrets = credential.type === 'oauth2' && credentialLocation === 'active'
      ? await readOAuth2SecretsWithRefresh(credential.id)
      : readCredentialSecrets(credential.id, credentialLocation);
    const secrets = credential.type === 'plain_note'
      ? plainNoteFieldsFromMeta(credential.meta, rawSecrets)
      : normalizeCredentialFieldsForType(credential.type, rawSecrets);

    // Admin tokens should always read full credential payloads in the dashboard.
    // Exclusion defaults are intended for delegated agent tokens.
    const baseExclude = isAdmin(auth)
      ? []
      : resolveExcludeFields(auth.token.credentialAccess?.excludeFields, credential.type);
    const baseExcludedNormalized = new Set(baseExclude.map(field => normalizeScope(field)));
    const requestedReadFields = parseRequestedReadFieldsInput(req.body, credential.type);
    const excludedFieldsPresent = Array.from(new Set(
      secrets
        .map((field) => normalizeScope(field.key))
        .filter((fieldKey) => baseExcludedNormalized.has(fieldKey)),
    ));
    const requestedExcludedFields = isAdmin(auth)
      ? []
      : requestedReadFields.requestsAllFields
        ? excludedFieldsPresent
        : Array.from(new Set(
            requestedReadFields.requestedFields
              .map((field) => normalizeScope(field))
              .filter((fieldKey) => baseExcludedNormalized.has(fieldKey)),
          ));
    if (requestedExcludedFields.length > 0) {
      const approvalTtl = await resolveOneShotApprovalTtl(auth);
      const approvalSummaryBase = `${auth.token.agentId || 'agent'} requests excluded fields (${requestedExcludedFields.join(', ')}) from credential "${credential.name}"`;
      const approvalSummary = approvalSummaryBase.length > 500
        ? `${approvalSummaryBase.slice(0, 497)}...`
        : approvalSummaryBase;
      const requestedExcludedNormalized = new Set(requestedExcludedFields.map((field) => normalizeScope(field)));
      const escalationExcludeFields = Array.from(
        new Set(
          baseExclude
            .map((field) => normalizeScope(field))
            .filter((field) => !requestedExcludedNormalized.has(field)),
        ),
      );
      const requestedPolicyInput = parseRequestedPolicyInput(req.body);
      if (requestedPolicyInput.hasRequestedPolicyInput) {
        await writeDerivedPolicyRejectedAccess({
          req,
          res,
          credential,
          action: 'credentials.read',
          reasonCode: 'DENY_EXCLUDED_FIELD',
          rawRequestedPolicy: requestedPolicyInput.rawRequestedPolicy,
        });
        return;
      }
      const dontAskAgainDecision = resolveDontAskAgainDefault(requestedExcludedFields);
      const context = buildCredentialOneShotDenyContext({
        auth,
        routeContractId: 'credentials.read',
        reasonCode: 'DENY_EXCLUDED_FIELD',
        credential,
        approvalTtl,
        escalationExcludeFields,
        requestedPolicyInput,
        summary: approvalSummary,
        flowSummary: 'This approval grants a one-shot scoped read token (maxReads=1, short TTL).',
        finalStep: 'Retry the original secret read/inject call after claim succeeds.',
        retryBehavior: 'Retrying before claim completion will return another approval-required response.',
        originalCommand,
        metadata: {
          requestedFields: requestedExcludedFields,
          policyContext: {
            readScopes: auth.token.credentialAccess?.read || [],
            tokenExcludeFields: auth.token.credentialAccess?.excludeFields ?? null,
            effectiveExcludeFields: baseExclude,
            credentialType: credential.type,
            dontAskAgainDefaultOn: dontAskAgainDecision.defaultOn,
            dontAskAgainReason: dontAskAgainDecision.reason,
          },
        },
        eventMetadata: {
          requestedFields: requestedExcludedFields,
          effectiveExcludeFields: baseExclude,
        },
        responseMetadata: {
          requestedFields: requestedExcludedFields,
          effectiveExcludeFields: baseExclude,
          dontAskAgainDefaultOn: dontAskAgainDecision.defaultOn,
          dontAskAgainReason: dontAskAgainDecision.reason,
        },
      });
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_READ_EXCLUDED_FIELD,
        error: credentialAccessErrorMessage('DENY_EXCLUDED_FIELD', 'credentials.read'),
        required: ['secret:read'],
        have: auth.token.permissions,
        requestedPolicySource: 'derived_403',
        denyContext: context,
        extraPayload: { success: false },
        onResponsePayload: async (payload, httpStatus) => {
          const requestId = typeof payload.reqId === 'string' ? payload.reqId : undefined;
          await writeDeniedCredentialAccess({
            req,
            credential,
            action: 'credentials.read',
            reasonCode: 'DENY_EXCLUDED_FIELD',
            httpStatus,
            metadata: {
              humanActionId: requestId,
              requestedFields: requestedExcludedFields,
              effectiveExcludeFields: baseExclude,
              dontAskAgainDefaultOn: dontAskAgainDecision.defaultOn,
              dontAskAgainReason: dontAskAgainDecision.reason,
              escalationRouteId: ESCALATION_ROUTE_IDS.CREDENTIALS_READ_EXCLUDED_FIELD,
              routeContractId: 'credentials.read',
              requestedPolicySource: 'derived_403',
              policyHash: typeof payload.policyHash === 'string' ? payload.policyHash : undefined,
              compilerVersion: typeof payload.compilerVersion === 'string' ? payload.compilerVersion : undefined,
            },
          });
          logEvent({
            category: 'agent',
            action: 'credential_access_decision',
            description: `Credential access denied (excluded fields): ${credential.id}`,
            agentId: auth.token.agentId,
            metadata: {
              credentialId: credential.id,
              route: 'credentials.read',
              allowed: false,
              reasonCode: 'DENY_EXCLUDED_FIELD',
              requestedFields: requestedExcludedFields,
              humanActionId: requestId,
            },
          });
        },
      });
      return;
    }
    // For oauth2, always exclude refresh machinery from agent reads
    const oauth2Exclude = credential.type === 'oauth2' ? OAUTH2_DEFAULT_EXCLUDE_FIELDS : [];
    const excluded = new Set(
      [...baseExclude, ...oauth2Exclude].map(field => normalizeScope(field)),
    );
    const filteredFields = secrets.filter(field => !excluded.has(normalizeScope(field.key)));

    const [healthRow] = await buildCredentialHealthRows([credential], () => secrets);

    const encrypted = encryptToAgentPubkey(
      JSON.stringify({
        id: credential.id,
        agentId: credential.agentId,
        type: credential.type,
        fields: filteredFields,
        health: healthRow?.health,
      }),
      auth.token.agentPubkey,
    );

    // Increment read usage only after successful encryption.
    recordCredentialRead(auth.tokenHash);

    const auditId = await writeCredentialAccessAudit({
      credentialId: credential.id,
      credentialAgentId: credential.agentId,
      action: 'credentials.read',
      allowed: true,
      reasonCode: 'ALLOW',
      httpStatus: 200,
      tokenHash: auth.tokenHash,
      actorAgentId: auth.token.agentId,
      requestId: req.header('x-request-id') ?? undefined,
      actorType: isAdmin(auth) ? 'admin' : 'agent',
      metadata: {
        returnedFieldKeys: filteredFields.map((field) => field.key),
      },
    });
    emitCredentialAccessed(req, credential, {
      action: 'credentials.read',
      allowed: true,
      reasonCode: 'ALLOW',
      httpStatus: 200,
    });

    const secretSurface = req.header('x-secret-surface') as 'inject_secret' | 'get_secret' | undefined;
    if (secretSurface) {
      events.secretAccessed({
        credentialId: credential.id,
        credentialName: req.header('x-credential-name') || credential.name,
        credentialAgentId: credential.agentId,
        surface: secretSurface,
        envVar: req.header('x-secret-envvar') || undefined,
        actorAgentId: auth.token.agentId,
        tokenHash: auth.tokenHash,
      });
    }

    logEvent({
      category: 'agent',
      action: 'credential_access_decision',
      description: `Credential access allow: ${credential.id}`,
      agentId: auth.token.agentId,
      metadata: {
        auditId,
        credentialId: credential.id,
        route: 'credentials.read',
        allowed: true,
        reasonCode: 'ALLOW',
      },
    });

    res.json({
      success: true,
      credentialId: credential.id,
      encrypted,
    });
  } catch (error) {
    res.status(400).json({ success: false, error: getErrorMessage(error) });
  }
});

// POST /credentials/:id/totp — generate current TOTP code
router.post('/:id/totp', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const auth = req.auth!;
    const originalCommand = readOriginalCommand(req);

    const credential = getCredential(req.params.id);
    if (!credential) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }

    const tokenBinding = auth.token.oneShotBinding;
    if (tokenBinding && typeof tokenBinding === 'object') {
      const bindingCheck = validateCredentialOperationBinding({
        tokenBinding,
        routeId: 'credentials.totp',
        credentialId: credential.id,
      });
      if (!bindingCheck.matches || !bindingCheck.expectedBinding) {
        await writeDeniedCredentialAccess({
          req,
          credential,
          action: 'credentials.totp',
          reasonCode: 'TOKEN_BINDING_MISMATCH',
          httpStatus: 403,
          metadata: {
            reqId: bindingCheck.reqId,
            policyHash: bindingCheck.policyHash,
            compilerVersion: bindingCheck.compilerVersion,
            actualBinding: bindingCheck.actualBinding,
            expectedBinding: bindingCheck.expectedBinding,
          },
        });
        res.status(403).json(buildBindingMismatchPayload({
          reqId: bindingCheck.reqId,
          policyHash: bindingCheck.policyHash,
          compilerVersion: bindingCheck.compilerVersion,
          expectedMethod: bindingCheck.expectedMethod,
          expectedRouteId: bindingCheck.expectedRouteId,
          expectedBinding: bindingCheck.expectedBinding || {
            routeId: 'credentials.totp',
            method: 'POST',
            resourceHash: '',
            bodyHash: '',
            bindingHash: '',
          },
        }));
        return;
      }
    }

    if (!canReadCredential(req, credential)) {
      const requestedPolicyInput = parseRequestedPolicyInput(req.body);
      if (requestedPolicyInput.hasRequestedPolicyInput) {
        await writeDerivedPolicyRejectedAccess({
          req,
          res,
          credential,
          action: 'credentials.totp',
          reasonCode: 'CREDENTIAL_SCOPE_DENIED',
          rawRequestedPolicy: requestedPolicyInput.rawRequestedPolicy,
        });
        return;
      }
      const approvalTtl = await resolveOneShotApprovalTtl(auth);
      const context = buildCredentialOneShotDenyContext({
        auth,
        routeContractId: 'credentials.totp',
        reasonCode: 'CREDENTIAL_SCOPE_DENIED',
        credential,
        approvalTtl,
        escalationExcludeFields: [],
        requestedPolicyInput,
        summary: `${auth.token.agentId || 'agent'} requests scoped TOTP access for credential "${credential.name}"`,
        flowSummary: 'This approval grants a one-shot scoped TOTP token (maxReads=1, short TTL).',
        finalStep: 'Retry the original TOTP request after claim succeeds.',
        retryBehavior: 'Retrying before claim completion will return another approval-required response.',
        originalCommand,
        metadata: {
          policyContext: {
            readScopes: auth.token.credentialAccess?.read || [],
            tokenExcludeFields: auth.token.credentialAccess?.excludeFields ?? null,
            credentialType: credential.type,
          },
        },
      });
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_TOTP_SCOPE_DENIED,
        error: credentialAccessErrorMessage('CREDENTIAL_SCOPE_DENIED', 'credentials.totp'),
        required: ['secret:read', 'totp:read'],
        have: auth.token.permissions,
        requestedPolicySource: 'derived_403',
        denyContext: context,
        extraPayload: { success: false },
        onResponsePayload: async (payload, httpStatus) => {
          await writeDeniedCredentialAccess({
            req,
            credential,
            action: 'credentials.totp',
            reasonCode: 'CREDENTIAL_SCOPE_DENIED',
            httpStatus,
            metadata: {
              escalationRouteId: ESCALATION_ROUTE_IDS.CREDENTIALS_TOTP_SCOPE_DENIED,
              routeContractId: 'credentials.totp',
              requestedPolicySource: 'derived_403',
              reqId: typeof payload.reqId === 'string' ? payload.reqId : undefined,
              policyHash: typeof payload.policyHash === 'string' ? payload.policyHash : undefined,
              compilerVersion: typeof payload.compilerVersion === 'string' ? payload.compilerVersion : undefined,
            },
          });
        },
      });
      return;
    }

    // totp:read permission required (admin bypasses)
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['totp:read'])) {
      const approvalTtl = await resolveOneShotApprovalTtl(auth);
      const requestedPolicyInput = parseRequestedPolicyInput(req.body);
      if (requestedPolicyInput.hasRequestedPolicyInput) {
        await writeDerivedPolicyRejectedAccess({
          req,
          res,
          credential,
          action: 'credentials.totp',
          reasonCode: 'TOKEN_PERMISSION_DENIED',
          rawRequestedPolicy: requestedPolicyInput.rawRequestedPolicy,
        });
        return;
      }
      const approvalSummaryBase = `${auth.token.agentId || 'agent'} requests TOTP access for credential "${credential.name}"`;
      const approvalSummary = approvalSummaryBase.length > 500
        ? `${approvalSummaryBase.slice(0, 497)}...`
        : approvalSummaryBase;
      const context = buildCredentialOneShotDenyContext({
        auth,
        routeContractId: 'credentials.totp',
        reasonCode: 'TOKEN_PERMISSION_DENIED',
        credential,
        approvalTtl,
        escalationExcludeFields: [],
        requestedPolicyInput,
        summary: approvalSummary,
        flowSummary: 'This approval grants a one-shot scoped TOTP token (maxReads=1, short TTL).',
        finalStep: 'Retry the original TOTP request after claim succeeds.',
        retryBehavior: 'Retrying before claim completion will return another approval-required response.',
        originalCommand,
      });
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_TOTP_PERMISSION_DENIED,
        error: credentialAccessErrorMessage('TOKEN_PERMISSION_DENIED', 'credentials.totp'),
        required: ['totp:read'],
        have: auth.token.permissions,
        requestedPolicySource: 'derived_403',
        denyContext: context,
        extraPayload: { success: false },
        onResponsePayload: async (payload, httpStatus) => {
          await writeDeniedCredentialAccess({
            req,
            credential,
            action: 'credentials.totp',
            reasonCode: 'TOKEN_PERMISSION_DENIED',
            httpStatus,
            metadata: {
              humanActionId: typeof payload.reqId === 'string' ? payload.reqId : undefined,
              escalationRouteId: ESCALATION_ROUTE_IDS.CREDENTIALS_TOTP_PERMISSION_DENIED,
              routeContractId: 'credentials.totp',
              requestedPolicySource: 'derived_403',
              policyHash: typeof payload.policyHash === 'string' ? payload.policyHash : undefined,
              compilerVersion: typeof payload.compilerVersion === 'string' ? payload.compilerVersion : undefined,
            },
          });
        },
      });
      return;
    }

    const decision = evaluateCredentialAccess({
      tokenHash: auth.tokenHash,
      token: auth.token,
      credentialId: credential.id,
      action: 'credentials.totp',
    });
    if (!decision.allowed) {
      const denyReason = decision.reasonCode as Exclude<CredentialAccessReasonCode, 'ALLOW'>;
      await writeDeniedCredentialAccess({
        req,
        credential,
        action: 'credentials.totp',
        reasonCode: denyReason,
        httpStatus: decision.httpStatus,
        metadata: {
          limiterWindowMs: decision.limiterWindowMs,
          limiterLimit: decision.limiterLimit,
          limiterCount: decision.limiterCount,
        },
      });
      res.status(decision.httpStatus).json({
        success: false,
        error: credentialAccessErrorMessage(denyReason, 'credentials.totp'),
        reasonCode: denyReason,
      });
      return;
    }

    const secrets = readCredentialSecrets(credential.id);
    const totpField = findTotpField(secrets);
    if (!totpField) {
      await writeDeniedCredentialAccess({
        req,
        credential,
        action: 'credentials.totp',
        reasonCode: 'CREDENTIAL_TOTP_NOT_CONFIGURED',
        httpStatus: 400,
      });
      res.status(400).json({
        success: false,
        error: credentialAccessErrorMessage('CREDENTIAL_TOTP_NOT_CONFIGURED', 'credentials.totp'),
        reasonCode: 'CREDENTIAL_TOTP_NOT_CONFIGURED',
      });
      return;
    }

    const result = generateTOTP(totpField.value, credential.name);
    recordCredentialRead(auth.tokenHash);

    const auditId = await writeCredentialAccessAudit({
      credentialId: credential.id,
      credentialAgentId: credential.agentId,
      action: 'credentials.totp',
      allowed: true,
      reasonCode: 'ALLOW',
      httpStatus: 200,
      tokenHash: auth.tokenHash,
      actorAgentId: auth.token.agentId,
      requestId: req.header('x-request-id') ?? undefined,
      actorType: isAdmin(auth) ? 'admin' : 'agent',
    });
    emitCredentialAccessed(req, credential, {
      action: 'credentials.totp',
      allowed: true,
      reasonCode: 'ALLOW',
      httpStatus: 200,
    });

    logEvent({
      category: 'agent',
      action: 'credential_access_decision',
      description: `Credential TOTP access allow: ${credential.id}`,
      agentId: auth.token.agentId,
      metadata: {
        auditId,
        credentialId: credential.id,
        route: 'credentials.totp',
        allowed: true,
        reasonCode: 'ALLOW',
      },
    });

    res.json({ success: true, code: result.code, remaining: result.remaining });
  } catch (error) {
    res.status(400).json({ success: false, error: getErrorMessage(error) });
  }
});

// POST /credentials/:id/reauth — oauth2 re-auth start/complete flow
router.post('/:id/reauth', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const auth = req.auth!;
    if (!isAdmin(auth)) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_ADMIN,
        error: 'Admin access required',
        required: ['admin:*'],
        have: auth.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }

    const credential = getCredential(req.params.id);
    if (!credential) {
      res.status(404).json({ success: false, error: 'Credential not found' });
      return;
    }

    if (credential.type !== 'oauth2') {
      res.status(400).json({ success: false, error: 'Re-auth only applies to oauth2 credentials' });
      return;
    }

    const authorizationEndpoint = credential.meta.authorization_endpoint as string | undefined;
    const tokenEndpoint = credential.meta.token_endpoint as string | undefined;
    if (!authorizationEndpoint || !tokenEndpoint) {
      res.status(400).json({
        success: false,
        error: 'OAuth2 credentials require both `authorization_endpoint` and `token_endpoint` for re-auth.',
      });
      return;
    }

    const secrets = readCredentialSecrets(credential.id);
    const clientId = findSensitiveFieldValue(secrets, 'client_id');
    const clientSecret = findSensitiveFieldValue(secrets, 'client_secret');
    const existingRefreshToken = findSensitiveFieldValue(secrets, 'refresh_token');

    if (!clientId) {
      res.status(400).json({ success: false, error: 'oauth2 reauth requires sensitive field client_id' });
      return;
    }

    const body = (req.body || {}) as { code?: string; state?: string; redirect_uri?: string };
    const code = typeof body.code === 'string' ? body.code.trim() : '';

    if (!code) {
      const redirectUri = (typeof body.redirect_uri === 'string' && body.redirect_uri.trim())
        || (credential.meta.redirect_uri as string | undefined)
        || 'urn:ietf:wg:oauth:2.0:oob';
      const state = randomBytes(16).toString('hex');
      oauth2ReauthState.set(state, {
        credentialId: credential.id,
        redirectUri,
        expiresAt: Date.now() + OAUTH2_REAUTH_STATE_TTL_MS,
      });

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
      });
      const scopes = typeof credential.meta.scopes === 'string' ? credential.meta.scopes.trim() : '';
      if (scopes) params.set('scope', scopes);

      res.json({
        success: true,
        phase: 'authorization_required',
        message: 'Open provider consent URL, then submit returned authorization code to complete re-auth.',
        credentialId: credential.id,
        authorization_url: `${authorizationEndpoint}${authorizationEndpoint.includes('?') ? '&' : '?'}${params.toString()}`,
        state,
      });
      return;
    }

    const providedState = typeof body.state === 'string' ? body.state.trim() : '';
    if (!providedState) {
      res.status(400).json({ success: false, error: 'state is required when completing oauth2 reauth' });
      return;
    }

    const stateRecord = oauth2ReauthState.get(providedState);
    if (!stateRecord || stateRecord.credentialId !== credential.id || stateRecord.expiresAt < Date.now()) {
      res.status(400).json({ success: false, error: 'Invalid or expired reauth state. Start re-auth again.' });
      return;
    }

    const redirectUri = stateRecord.redirectUri;
    oauth2ReauthState.delete(providedState);

    const authMethod = String(credential.meta.auth_method || 'client_secret_post');
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (authMethod === 'client_secret_post') {
      tokenBody.set('client_id', clientId);
      tokenBody.set('client_secret', clientSecret);
    } else {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      headers.authorization = `Basic ${basic}`;
      tokenBody.set('client_id', clientId);
    }

    const tokenRes = await fetch(tokenEndpoint, {
      method: 'POST',
      headers,
      body: tokenBody.toString(),
    });

    let tokenPayload: Record<string, unknown> = {};
    try {
      tokenPayload = await tokenRes.json() as Record<string, unknown>;
    } catch {
      tokenPayload = {};
    }

    if (!tokenRes.ok) {
      const reason = String(tokenPayload.error_description || tokenPayload.error || `OAuth2 re-auth failed (${tokenRes.status})`);
      updateCredential(credential.id, {
        meta: {
          ...credential.meta,
          needs_reauth: true,
          reauth_reason: reason,
        },
      });
      res.status(400).json({ success: false, error: reason, phase: 'failed' });
      return;
    }

    const accessToken = String(tokenPayload.access_token || '').trim();
    if (!accessToken) {
      res.status(400).json({ success: false, error: 'Provider response missing access_token' });
      return;
    }

    const refreshToken = String(tokenPayload.refresh_token || existingRefreshToken || '').trim();
    const expiresIn = Number(tokenPayload.expires_in);
    const nextExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
      ? Math.floor(Date.now() / 1000) + expiresIn
      : Number(credential.meta.expires_at || Math.floor(Date.now() / 1000) + 3600);

    let nextSecrets = upsertSensitiveField(secrets, 'access_token', accessToken);
    nextSecrets = upsertSensitiveField(nextSecrets, 'refresh_token', refreshToken);

    updateCredential(credential.id, {
      meta: {
        ...credential.meta,
        expires_at: nextExpiresAt,
        needs_reauth: false,
        reauth_reason: null,
        last_refreshed: new Date().toISOString(),
      },
      sensitiveFields: nextSecrets,
    });

    res.json({
      success: true,
      phase: 'completed',
      credentialId: credential.id,
      message: 'OAuth2 credential re-authenticated successfully.',
      expires_at: nextExpiresAt,
    });
  } catch (error) {
    res.status(400).json({ success: false, error: getErrorMessage(error) });
  }
});

export default router;
