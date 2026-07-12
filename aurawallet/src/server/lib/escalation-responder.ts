import { randomBytes } from 'crypto';
import { Request, Response } from 'express';
import { prisma } from './db';
import { createHumanActionNotification } from './notifications';
import { events } from './events';
import { hashSecret } from './crypto';
import { getDefault } from './defaults';
import { AgentProfileError, resolveProfileToEffectivePolicy } from './agent-profiles';
import { buildApproveUrl } from './approval-link';
import { buildApprovalClaimFlow, buildClaimEndpoint } from './approval-flow';
import { logEvent } from './logger';
import {
  buildCanonicalApprovalRequired,
  buildCanonicalHardDeny,
  classifyEscalation,
  RequestedPolicySource,
} from './escalation-contract';
import { EscalationRouteId } from './escalation-route-registry';
import {
  compileTempPolicy,
  type PolicyOperationBindingInput,
  type TempPolicy,
  type TempPolicyContract,
} from './temp-policy';

const SESSION_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const STRICT_SESSION_TOKEN_TTL_SECONDS = 60 * 60;
const ESCALATION_PROFILE_ORDER = ['dev', 'strict', 'admin'] as const;

export interface OneShotEscalationContext {
  routeContractId: string;
  reasonCode: string;
  summary: string;
  flowSummary?: string;
  finalStep?: string;
  retryBehavior?: string;
  compile: {
    hasRequestedPolicyInput?: boolean;
    requestedPolicy?: TempPolicy;
    derivedPolicy: TempPolicy;
    contract: TempPolicyContract;
    binding: PolicyOperationBindingInput;
  };
  metadata?: Record<string, unknown>;
  eventMetadata?: Record<string, unknown>;
  responseMetadata?: Record<string, unknown>;
  compileFailureStatusCode?: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (out.length !== value.length) return null;
  return out;
}

function parseTempPolicyValue(value: Record<string, unknown>): TempPolicy | null {
  const permissions = asStringArray(value.permissions);
  if (!permissions || permissions.length === 0) return null;
  const parsed: TempPolicy = { permissions };

  if (typeof value.ttlSeconds === 'number' && Number.isFinite(value.ttlSeconds) && value.ttlSeconds > 0) {
    parsed.ttlSeconds = Math.floor(value.ttlSeconds);
  }
  if (typeof value.maxUses === 'number' && Number.isFinite(value.maxUses) && value.maxUses > 0) {
    parsed.maxUses = Math.floor(value.maxUses);
  }
  if (value.limits && asObject(value.limits)) {
    parsed.limits = value.limits as unknown as TempPolicy['limits'];
  }
  if (Array.isArray(value.walletAccess)) {
    const walletAccess = asStringArray(value.walletAccess);
    if (!walletAccess) return null;
    parsed.walletAccess = walletAccess;
  }
  if (value.credentialAccess && asObject(value.credentialAccess)) {
    parsed.credentialAccess = value.credentialAccess as unknown as TempPolicy['credentialAccess'];
  }
  return parsed;
}

function parseTempPolicyContractValue(value: Record<string, unknown>): TempPolicyContract | null {
  const requiredPermissions = asStringArray(value.requiredPermissions);
  const allowedPermissions = asStringArray(value.allowedPermissions);
  if (!requiredPermissions || !allowedPermissions) return null;
  if (typeof value.maxTtlSeconds !== 'number' || !Number.isFinite(value.maxTtlSeconds) || value.maxTtlSeconds <= 0) {
    return null;
  }
  if (typeof value.defaultTtlSeconds !== 'number' || !Number.isFinite(value.defaultTtlSeconds) || value.defaultTtlSeconds <= 0) {
    return null;
  }
  if (typeof value.maxUses !== 'number' || !Number.isFinite(value.maxUses) || value.maxUses <= 0) {
    return null;
  }
  if (typeof value.defaultMaxUses !== 'number' || !Number.isFinite(value.defaultMaxUses) || value.defaultMaxUses <= 0) {
    return null;
  }

  return {
    requiredPermissions,
    allowedPermissions,
    maxTtlSeconds: Math.floor(value.maxTtlSeconds),
    defaultTtlSeconds: Math.floor(value.defaultTtlSeconds),
    maxUses: Math.floor(value.maxUses),
    defaultMaxUses: Math.floor(value.defaultMaxUses),
    ...(Array.isArray(value.requiredReadScopes)
      ? { requiredReadScopes: asStringArray(value.requiredReadScopes) || [] }
      : {}),
    ...(Array.isArray(value.allowedReadScopes)
      ? { allowedReadScopes: asStringArray(value.allowedReadScopes) || [] }
      : {}),
    ...(Array.isArray(value.requiredWriteScopes)
      ? { requiredWriteScopes: asStringArray(value.requiredWriteScopes) || [] }
      : {}),
    ...(Array.isArray(value.allowedWriteScopes)
      ? { allowedWriteScopes: asStringArray(value.allowedWriteScopes) || [] }
      : {}),
    ...(typeof value.allowLimits === 'boolean' ? { allowLimits: value.allowLimits } : {}),
    ...(typeof value.allowWalletAccess === 'boolean' ? { allowWalletAccess: value.allowWalletAccess } : {}),
    ...(typeof value.enforceExcludeFieldsFromDerived === 'boolean'
      ? { enforceExcludeFieldsFromDerived: value.enforceExcludeFieldsFromDerived }
      : {}),
  };
}

function parseBindingInputValue(value: Record<string, unknown>): PolicyOperationBindingInput | null {
  const actorId = typeof value.actorId === 'string' ? value.actorId.trim() : '';
  const method = typeof value.method === 'string' ? value.method.trim() : '';
  const routeId = typeof value.routeId === 'string' ? value.routeId.trim() : '';
  const resource = asObject(value.resource);
  if (!actorId || !method || !routeId || !resource) return null;
  const parsed: PolicyOperationBindingInput = {
    actorId,
    method,
    routeId,
    resource,
  };
  const body = asObject(value.body);
  if (body) parsed.body = body;
  return parsed;
}

function parseOneShotEscalationContext(value: unknown): OneShotEscalationContext | null {
  const source = asObject(value);
  if (!source) return null;
  const compile = asObject(source.compile);
  const routeContractId = typeof source.routeContractId === 'string' ? source.routeContractId.trim() : '';
  const reasonCode = typeof source.reasonCode === 'string' ? source.reasonCode.trim() : '';
  const summary = typeof source.summary === 'string' ? source.summary.trim() : '';
  if (!compile || !routeContractId || !reasonCode || !summary) return null;
  const derivedPolicy = asObject(compile.derivedPolicy);
  const contract = asObject(compile.contract);
  const binding = asObject(compile.binding);
  if (!derivedPolicy || !contract || !binding) return null;
  const parsedDerivedPolicy = parseTempPolicyValue(derivedPolicy);
  const parsedContract = parseTempPolicyContractValue(contract);
  const parsedBinding = parseBindingInputValue(binding);
  if (!parsedDerivedPolicy || !parsedContract || !parsedBinding) return null;
  const requestedPolicyCandidate = compile.requestedPolicy && asObject(compile.requestedPolicy)
    ? parseTempPolicyValue(compile.requestedPolicy as Record<string, unknown>)
    : null;
  if (compile.requestedPolicy && !requestedPolicyCandidate) return null;

  return {
    routeContractId,
    reasonCode,
    summary,
    ...(typeof source.flowSummary === 'string' && source.flowSummary.trim()
      ? { flowSummary: source.flowSummary.trim() }
      : {}),
    ...(typeof source.finalStep === 'string' && source.finalStep.trim()
      ? { finalStep: source.finalStep.trim() }
      : {}),
    ...(typeof source.retryBehavior === 'string' && source.retryBehavior.trim()
      ? { retryBehavior: source.retryBehavior.trim() }
      : {}),
    compile: {
      hasRequestedPolicyInput: Boolean(compile.hasRequestedPolicyInput),
      ...(requestedPolicyCandidate ? { requestedPolicy: requestedPolicyCandidate } : {}),
      derivedPolicy: parsedDerivedPolicy,
      contract: parsedContract,
      binding: parsedBinding,
    },
    ...(source.metadata && asObject(source.metadata)
      ? { metadata: source.metadata as Record<string, unknown> }
      : {}),
    ...(source.eventMetadata && asObject(source.eventMetadata)
      ? { eventMetadata: source.eventMetadata as Record<string, unknown> }
      : {}),
    ...(source.responseMetadata && asObject(source.responseMetadata)
      ? { responseMetadata: source.responseMetadata as Record<string, unknown> }
      : {}),
    ...(typeof source.compileFailureStatusCode === 'number'
      ? { compileFailureStatusCode: source.compileFailureStatusCode }
      : {}),
  };
}

export function buildLegacyPermissionDeniedPayload(input: {
  error: string;
  required: string[];
  have?: string[];
}): Record<string, unknown> {
  const dashboardBase = `http://localhost:${process.env.DASHBOARD_PORT || '4747'}`;
  return {
    error: input.error,
    required: input.required,
    ...(input.have ? { have: input.have } : {}),
    escalation: {
      via: 'auth',
      permissions: input.required,
      dashboard: dashboardBase,
      note: 'Request a new token via POST /auth with a profile that includes the required permissions.',
    },
  };
}

function profileSatisfiesRequiredPermissions(profileId: 'strict' | 'dev' | 'admin', required: string[]): boolean {
  const resolved = resolveProfileToEffectivePolicy({
    profileId,
    profileVersion: 'v1',
  });
  if (resolved.permissions.includes('admin:*')) return true;
  const permissionSet = new Set(resolved.permissions);
  return required.every((permission) => permissionSet.has(permission));
}

function resolveEscalationProfile(required: string[]): 'strict' | 'dev' | 'admin' {
  for (const profileId of ESCALATION_PROFILE_ORDER) {
    if (profileSatisfiesRequiredPermissions(profileId, required)) {
      return profileId;
    }
  }
  return 'admin';
}

async function buildSessionEscalationPayload(input: {
  req: Request;
  routeId: EscalationRouteId;
  error: string;
  required: string[];
  have?: string[];
}): Promise<Record<string, unknown>> {
  const auth = input.req.auth;
  if (!auth) {
    return buildCanonicalHardDeny({
      error: 'Authentication required',
      errorCode: 'insufficient_permissions',
    }) as unknown as Record<string, unknown>;
  }

  const pubkey = typeof auth.token.agentPubkey === 'string' ? auth.token.agentPubkey.trim() : '';
  if (!pubkey) {
    return {
      ...buildCanonicalHardDeny({
        error: input.error,
        errorCode: 'agent_pubkey_missing',
      }),
      note: 'Token cannot self-escalate because agentPubkey is missing.',
      required: input.required,
      have: input.have || auth.token.permissions,
    } as Record<string, unknown>;
  }

  const suggestedProfile = resolveEscalationProfile(input.required);
  const resolvedProfile = resolveProfileToEffectivePolicy({
    profileId: suggestedProfile,
    profileVersion: 'v1',
  });
  const requestedTtl = resolvedProfile.profile.id === 'strict'
    ? Math.min(resolvedProfile.ttlSeconds, STRICT_SESSION_TOKEN_TTL_SECONDS)
    : SESSION_TOKEN_TTL_SECONDS;
  const defaultFundLimit = await getDefault<number>('limits.fund', 0);
  const requestedLimits = { fund: defaultFundLimit };
  const secret = randomBytes(32).toString('hex');
  const secretHash = hashSecret(secret);
  const dashboardBase = `http://localhost:${process.env.DASHBOARD_PORT || '4747'}`;
  const walletBase = process.env.WALLET_SERVER_URL || 'http://127.0.0.1:4242';

  const request = await prisma.humanAction.create({
    data: {
      type: 'auth',
      fromTier: 'system',
      toAddress: null,
      amount: null,
      chain: 'base',
      status: 'pending',
      metadata: JSON.stringify({
        approvalScope: 'session_token',
        agentId: auth.token.agentId,
        limit: defaultFundLimit,
        requestedLimitExplicit: false,
        defaultFundLimit,
        permissions: resolvedProfile.permissions,
        ttl: requestedTtl,
        limits: requestedLimits,
        walletAccess: auth.token.walletAccess,
        credentialAccess: resolvedProfile.credentialAccess,
        profile: resolvedProfile.profile,
        effectivePolicyHash: resolvedProfile.effectivePolicyHash,
        overrideDelta: resolvedProfile.overrideDelta,
        warnings: resolvedProfile.warnings,
        summary: `Permission escalation required for ${input.routeId}`,
        pubkey,
        secretHash,
        routeId: input.routeId,
        requiredPermissions: input.required,
      }),
    },
  });

  await createHumanActionNotification(request);
  events.actionCreated({
    id: request.id,
    type: 'agent_access',
    source: `agent:${auth.token.agentId}`,
    summary: `Permission escalation required for ${input.routeId}`,
    expiresAt: null,
    metadata: {
      approvalScope: 'session_token',
      routeId: input.routeId,
      requiredPermissions: input.required,
      profile: resolvedProfile.profile,
      effectivePolicyHash: resolvedProfile.effectivePolicyHash,
    },
  });

  const flow = buildApprovalClaimFlow({
    requestId: request.id,
    secret,
    approveUrl: buildApproveUrl(dashboardBase, request.id),
    dashboardBase,
    walletBase,
    mode: 'manual_auth_claim',
    summary: 'This permission denial requires human approval, then explicit claim, then retry.',
    step2Label: 'Claim token',
    finalStep: 'Retry original operation after claimStatus=approved.',
    retryBehavior: 'No automatic polling/claiming occurs in background.',
  });
  const claimEndpoint = flow.claim?.endpoint || buildClaimEndpoint(request.id, secret);
  return {
    ...buildCanonicalApprovalRequired({
      error: input.error,
      reqId: request.id,
      approvalScope: 'session_token',
      approveUrl: flow.approveUrl,
      claimAction: {
        transport: 'http',
        kind: 'request',
        method: 'GET',
        endpoint: claimEndpoint,
      },
      retryAction: {
        transport: 'http',
        kind: 'request',
        method: 'POST',
        endpoint: '<retry_original_endpoint>',
        args: { reqId: request.id },
      },
      instructions: flow.instructions || [],
      claimStatus: 'pending',
      retryReady: false,
      policyHash: resolvedProfile.effectivePolicyHash,
      compilerVersion: 'profile.v1',
    }),
    requestId: request.id,
    ...flow,
    secret,
    required: input.required,
    ...(input.have ? { have: input.have } : {}),
    routeId: input.routeId,
    requestedPolicySource: 'derived_403' as RequestedPolicySource,
  } as Record<string, unknown>;
}

async function buildOneShotEscalationPayload(input: {
  req: Request;
  routeId: EscalationRouteId;
  error: string;
  required: string[];
  have?: string[];
  requestedPolicySource: RequestedPolicySource;
  context: OneShotEscalationContext;
}): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
  const auth = input.req.auth;
  if (!auth) {
    return {
      statusCode: 403,
      payload: buildCanonicalHardDeny({
        error: 'Authentication required',
        errorCode: 'insufficient_permissions',
      }) as unknown as Record<string, unknown>,
    };
  }

  const pubkey = typeof auth.token.agentPubkey === 'string' ? auth.token.agentPubkey.trim() : '';
  if (!pubkey) {
    return {
      statusCode: 403,
      payload: {
        ...buildCanonicalHardDeny({
          error: input.error,
          errorCode: 'agent_pubkey_missing',
        }),
        note: 'Token cannot self-escalate because agentPubkey is missing.',
        required: input.required,
        have: input.have || auth.token.permissions,
        routeId: input.routeId,
        routeContractId: input.context.routeContractId,
      } as Record<string, unknown>,
    };
  }

  const compileResult = compileTempPolicy({
    requestedPolicySource: input.requestedPolicySource,
    ...(input.context.compile.requestedPolicy
      ? { requestedPolicy: input.context.compile.requestedPolicy }
      : {}),
    hasRequestedPolicyInput: input.context.compile.hasRequestedPolicyInput,
    derivedPolicy: input.context.compile.derivedPolicy,
    contract: input.context.compile.contract,
    binding: input.context.compile.binding,
  });
  if (!compileResult.ok) {
    return {
      statusCode: input.context.compileFailureStatusCode || 400,
      payload: {
        success: false,
        error: compileResult.message,
        errorCode: compileResult.errorCode,
        requestedPolicySource: input.requestedPolicySource,
        routeId: input.routeId,
        routeContractId: input.context.routeContractId,
      },
    };
  }

  const policyResult = compileResult.value;
  const effectivePolicy = policyResult.effectivePolicy;
  const effectiveCredentialAccess = effectivePolicy.credentialAccess || {
    read: [],
    write: [],
    excludeFields: [],
    maxReads: effectivePolicy.maxUses || 1,
    ttl: effectivePolicy.ttlSeconds || 300,
  };
  const ttl = effectivePolicy.ttlSeconds || effectiveCredentialAccess.ttl || 300;
  const secret = randomBytes(32).toString('hex');
  const secretHash = hashSecret(secret);
  const dashboardBase = `http://localhost:${process.env.DASHBOARD_PORT || '4747'}`;
  const walletBase = process.env.WALLET_SERVER_URL || 'http://127.0.0.1:4242';

  const metadata: Record<string, unknown> = {
    ...(input.context.metadata || {}),
    approvalScope: 'one_shot_read',
    agentId: auth.token.agentId,
    limit: 0,
    limits: { fund: 0, send: 0, swap: 0 },
    permissions: effectivePolicy.permissions,
    ttl,
    credentialAccess: effectiveCredentialAccess,
    pubkey,
    secretHash,
    summary: input.context.summary,
    escalationReason: input.context.reasonCode,
    routeId: input.routeId,
    routeContractId: input.context.routeContractId,
    requestedPolicySource: policyResult.requestedPolicySource,
    ...(policyResult.requestedPolicy ? { requestedPolicy: policyResult.requestedPolicy } : {}),
    effectivePolicy,
    policyHash: policyResult.policyHash,
    compilerVersion: policyResult.compilerVersion,
    binding: policyResult.binding,
  };

  const request = await prisma.humanAction.create({
    data: {
      type: 'auth',
      fromTier: 'system',
      toAddress: null,
      amount: null,
      chain: 'base',
      status: 'pending',
      metadata: JSON.stringify(metadata),
    },
  });

  await createHumanActionNotification(request);
  events.actionCreated({
    id: request.id,
    type: 'agent_access',
    source: `agent:${auth.token.agentId || 'agent'}`,
    summary: input.context.summary,
    expiresAt: null,
    metadata: {
      approvalScope: 'one_shot_read',
      routeId: input.routeId,
      routeContractId: input.context.routeContractId,
      reasonCode: input.context.reasonCode,
      ...(input.context.eventMetadata || {}),
    },
  });

  const flow = buildApprovalClaimFlow({
    requestId: request.id,
    secret,
    approveUrl: buildApproveUrl(dashboardBase, request.id),
    dashboardBase,
    walletBase,
    mode: 'one_time_scoped_read',
    summary: input.context.flowSummary
      || 'This approval grants a one-shot scoped token (maxReads=1, short TTL).',
    finalStep: input.context.finalStep
      || 'Retry the original operation after claim succeeds.',
    retryBehavior: input.context.retryBehavior
      || 'Retrying before claim completion will return another approval-required response.',
  });
  const claimEndpoint = flow.claim?.endpoint || buildClaimEndpoint(request.id, secret);
  const payload: Record<string, unknown> = {
    ...buildCanonicalApprovalRequired({
      error: input.error,
      reqId: request.id,
      approvalScope: 'one_shot_read',
      approveUrl: flow.approveUrl,
      claimAction: {
        transport: 'http',
        kind: 'request',
        method: 'GET',
        endpoint: claimEndpoint,
      },
      retryAction: {
        transport: 'http',
        kind: 'request',
        method: 'POST',
        endpoint: '<retry_original_endpoint>',
        args: { reqId: request.id },
      },
      instructions: flow.instructions || [],
      claimStatus: 'pending',
      retryReady: false,
      policyHash: policyResult.policyHash,
      compilerVersion: policyResult.compilerVersion,
    }),
    requestId: request.id,
    ...flow,
    secret,
    required: input.required,
    ...(input.have ? { have: input.have } : {}),
    routeId: input.routeId,
    routeContractId: input.context.routeContractId,
    reasonCode: input.context.reasonCode,
    requestedPolicySource: policyResult.requestedPolicySource,
    ...(policyResult.requestedPolicy ? { requestedPolicy: policyResult.requestedPolicy } : {}),
    effectivePolicy,
    binding: policyResult.binding,
    escalated: true,
    message: 'Action escalated — waiting for human approval',
    ...(input.context.responseMetadata || {}),
  };
  return {
    statusCode: 403,
    payload,
  };
}

export async function respondPermissionDenied(input: {
  req: Request;
  res: Response;
  routeId: EscalationRouteId;
  error: string;
  required: string[];
  have?: string[];
  requestedPolicySource?: RequestedPolicySource;
  denyContext?: Record<string, unknown> | OneShotEscalationContext;
  statusCode?: number;
  forceLegacy?: boolean;
  extraPayload?: Record<string, unknown>;
  onResponsePayload?: (payload: Record<string, unknown>, statusCode: number) => void | Promise<void>;
}): Promise<void> {
  const statusCode = input.statusCode || 403;
  const classifier = classifyEscalation({
    routeId: input.routeId,
    hasDenyContext: Boolean(input.denyContext),
    requestedPolicySource: input.requestedPolicySource,
  });
  logEvent({
    category: 'auth',
    action: 'permission_escalation_classified',
    description: `403 classifier ${classifier.decision} for ${input.routeId}`,
    agentId: input.req.auth?.token.agentId,
    metadata: {
      routeId: input.routeId,
      method: input.req.method,
      decision: classifier.decision,
      reasonCode: classifier.reasonCode,
      requestedPolicySource: input.requestedPolicySource || null,
    },
  });

  if (input.forceLegacy || classifier.reasonCode === 'wallet_deferred_legacy') {
    const payload = {
      ...buildLegacyPermissionDeniedPayload({
        error: input.error,
        required: input.required,
        have: input.have,
      }),
      ...(input.extraPayload || {}),
    };
    if (input.onResponsePayload) await input.onResponsePayload(payload, statusCode);
    input.res.status(statusCode).json(payload);
    return;
  }

  if (classifier.decision === 'hard_deny') {
    const code = classifier.reasonCode === 'missing_deny_context'
      ? 'missing_deny_context'
      : classifier.reasonCode === 'route_not_allowlisted'
        ? 'route_not_allowlisted'
        : 'unknown_classifier_outcome';
    const payload = {
      ...buildCanonicalHardDeny({
        error: input.error,
        errorCode: code,
      }),
      routeId: input.routeId,
      required: input.required,
      ...(input.have ? { have: input.have } : {}),
      ...(input.extraPayload || {}),
    };
    if (input.onResponsePayload) await input.onResponsePayload(payload, statusCode);
    input.res.status(statusCode).json(payload);
    return;
  }

  if (classifier.decision === 'escalate_one_shot') {
    const oneShotContext = parseOneShotEscalationContext(input.denyContext);
    if (!oneShotContext) {
      const payload = {
        ...buildCanonicalHardDeny({
          error: 'Cannot build one-shot escalation without valid denyContext.',
          errorCode: 'missing_deny_context',
        }),
        routeId: input.routeId,
        required: input.required,
        ...(input.have ? { have: input.have } : {}),
        ...(input.extraPayload || {}),
      };
      if (input.onResponsePayload) await input.onResponsePayload(payload, statusCode);
      input.res.status(statusCode).json(payload);
      return;
    }
    try {
      const oneShotResult = await buildOneShotEscalationPayload({
        req: input.req,
        routeId: input.routeId,
        error: input.error,
        required: input.required,
        have: input.have,
        requestedPolicySource: input.requestedPolicySource || 'derived_403',
        context: oneShotContext,
      });
      const payload = {
        ...oneShotResult.payload,
        ...(input.extraPayload || {}),
      };
      if (input.onResponsePayload) await input.onResponsePayload(payload, oneShotResult.statusCode);
      input.res.status(oneShotResult.statusCode).json(payload);
      return;
    } catch (error) {
      const fallbackError = error instanceof AgentProfileError ? error.message : 'Failed to create approval request';
      const payload = {
        ...buildCanonicalHardDeny({
          error: fallbackError,
          errorCode: 'approval_request_failed',
        }),
        routeId: input.routeId,
        required: input.required,
        ...(input.have ? { have: input.have } : {}),
        ...(input.extraPayload || {}),
      };
      if (input.onResponsePayload) await input.onResponsePayload(payload, statusCode);
      input.res.status(statusCode).json(payload);
      return;
    }
  }

  try {
    const payload = await buildSessionEscalationPayload({
      req: input.req,
      routeId: input.routeId,
      error: input.error,
      required: input.required,
      have: input.have,
    });
    const responsePayload = {
      ...payload,
      ...(input.extraPayload || {}),
    };
    if (input.onResponsePayload) await input.onResponsePayload(responsePayload, statusCode);
    input.res.status(statusCode).json(responsePayload);
  } catch (error) {
    const fallbackError = error instanceof AgentProfileError ? error.message : 'Failed to create approval request';
    const payload = {
      ...buildCanonicalHardDeny({
        error: fallbackError,
        errorCode: 'approval_request_failed',
      }),
      routeId: input.routeId,
      required: input.required,
      ...(input.have ? { have: input.have } : {}),
      ...(input.extraPayload || {}),
    };
    if (input.onResponsePayload) await input.onResponsePayload(payload, statusCode);
    input.res.status(statusCode).json(payload);
  }
}

export const _testOnly = {
  profileSatisfiesRequiredPermissions,
  resolveEscalationProfile,
};
