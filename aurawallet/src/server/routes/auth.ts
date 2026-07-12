import { Router, Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { prisma } from '../lib/db';
import { createHumanActionNotification } from '../lib/notifications';
import { events } from '../lib/events';
import { getPublicKey } from '../lib/transport';
import { claimEscrowedToken, escrowToken } from '../lib/auth';
import { isValidAgentPubkey, normalizeAgentPubkey, encryptToAgentPubkey } from '../lib/credential-transport';
import { hashSecret } from '../lib/crypto';
import { getDefault } from '../lib/defaults';
import { logger, logEvent } from '../lib/logger';
import { getErrorMessage } from '../lib/error';
import { AgentProfileError, resolveProfileToEffectivePolicy } from '../lib/agent-profiles';
import { buildApproveUrl } from '../lib/approval-link';
import { buildApprovalClaimFlow, buildClaimEndpoint } from '../lib/approval-flow';
import { ESCALATION_CONTRACT_VERSION } from '../lib/escalation-contract';

const router = Router();
const SESSION_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const STRICT_SESSION_TOKEN_TTL_SECONDS = 60 * 60;
const CLAIM_SECRET_HEADER = 'x-aura-claim-secret';
const CLAIM_SECRET_QUERY = 'secret';
const CLAIM_QUERY_FALLBACK_SUNSET = 'Tue, 30 Jun 2026 00:00:00 GMT';

function buildSessionApprovalContract(input: {
  requestId: string;
  secret: string;
  approveUrl?: string;
}): {
  flow: ReturnType<typeof buildApprovalClaimFlow>;
  claimAction: {
    transport: 'http';
    kind: 'request';
    method: 'GET';
    endpoint: string;
  };
  retryAction: {
    transport: 'http';
    kind: 'request';
    method: 'POST';
    endpoint: string;
    args: { reqId: string };
  };
} {
  const flow = buildApprovalClaimFlow({
    requestId: input.requestId,
    secret: input.secret,
    ...(typeof input.approveUrl === 'string' ? { approveUrl: input.approveUrl } : {}),
    dashboardBase: `http://localhost:${process.env.DASHBOARD_PORT || '4747'}`,
    walletBase: process.env.WALLET_SERVER_URL || 'http://127.0.0.1:4242',
    mode: 'manual_auth_claim',
    summary: 'Auth token is issued only after explicit claim/poll. No background auto-claim.',
    step2Label: 'Claim token',
    finalStep: 'Retry original operation after claimStatus=approved.',
    retryBehavior: 'Until claim succeeds, retry calls stay pending/rejected and do not activate a token.',
  });
  const claimEndpoint = flow.claim?.endpoint || buildClaimEndpoint(input.requestId, input.secret);
  return {
    flow,
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
      args: { reqId: input.requestId },
    },
  };
}

function materializeRetryCommand(originalCommand: string | undefined, reqId: string): string | undefined {
  const base = String(originalCommand || '').trim();
  if (!base) return undefined;
  let command = base.replace(/<reqId>/g, reqId);

  command = command
    .replace(/--req-id\s+\S+/g, `--reqId ${reqId}`)
    .replace(/--request-id\s+\S+/g, `--reqId ${reqId}`)
    .replace(/--requestId\s+\S+/g, `--reqId ${reqId}`)
    .replace(/--reqId\s+\S+/g, `--reqId ${reqId}`);

  if (!/\s--(?:reqId|req-id|requestId|request-id)(?:\s|=|$)/.test(command)) {
    command = `${command} --reqId ${reqId}`;
  }
  return command;
}

function buildRetryInstructions(base: unknown, retryCommand: string | undefined): string[] {
  const existing = Array.isArray(base)
    ? base.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  if (!retryCommand) return existing;
  return [
    `Run this exact command now: ${retryCommand}`,
    ...existing,
  ];
}

function auditApprovalLifecycle(input: {
  requestId: string;
  state:
    | 'request_created'
    | 'claim_pending'
    | 'claim_rejected'
    | 'claim_approved'
    | 'claim_expired'
    | 'claim_invalid_secret'
    | 'claim_missing_request';
  metadata?: Record<string, unknown>;
}): void {
  logEvent({
    category: 'agent',
    action: 'approval_lifecycle',
    description: `Approval lifecycle ${input.state}: ${input.requestId}`,
    metadata: {
      reqId: input.requestId,
      state: input.state,
      ...(input.metadata || {}),
    },
  });
}

// GET /auth/connect - Get server's public key for encrypting passwords
// This is a public endpoint - no authentication required
router.get('/connect', (_req: Request, res: Response) => {
  res.json({ publicKey: getPublicKey() });
});

// POST /auth - Agent requests access token (queued for human approval)
// Returns a requestId and secret that can be used to retrieve the token later
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      agentId,
      limit,
      permissions,
      ttl,
      limits,
      walletAccess,
      pubkey,
      credentialAccess,
      profile,
      profileVersion,
      profileOverrides,
      action,
    } = req.body;

    if (!agentId || typeof agentId !== 'string') {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }

    if (typeof profile !== 'string' || profile.trim().length === 0) {
      res.status(400).json({
        error: 'profile is required for agent issuance',
        code: 'AGENT_PROFILE_REQUIRED',
      });
      return;
    }

    const hasRawIssuancePayload = (
      permissions !== undefined ||
      ttl !== undefined ||
      credentialAccess !== undefined
    );
    if (hasRawIssuancePayload) {
      res.status(400).json({
        error: 'Raw permission issuance is disabled on /auth. Use profile + optional profileOverrides.',
        code: 'AGENT_PROFILE_ONLY',
      });
      return;
    }

    const defaultFundLimit = await getDefault<number>('limits.fund', 0);
    const providedLimits = limits && typeof limits === 'object' && !Array.isArray(limits)
      ? limits as { fund?: number; send?: number; swap?: number }
      : undefined;
    const requestedFundFromLimits = typeof providedLimits?.fund === 'number' ? providedLimits.fund : undefined;
    const requestedLimitExplicit = typeof limit === 'number' || typeof requestedFundFromLimits === 'number';
    const requestedLimit = requestedFundFromLimits ?? (typeof limit === 'number' ? limit : defaultFundLimit);
    const resolvedProfile = resolveProfileToEffectivePolicy({
      profileId: profile,
      profileVersion: typeof profileVersion === 'string' ? profileVersion : undefined,
      overrides: profileOverrides,
    });
    const requestedPermissions = [...resolvedProfile.permissions];
    // Session token TTL policy:
    // - strict profile: short-lived (default 1h, tighten-only overrides allowed)
    // - dev/admin profiles: fixed 7d session TTL
    const requestedTtl = resolvedProfile.profile.id === 'strict'
      ? Math.min(resolvedProfile.ttlSeconds, STRICT_SESSION_TOKEN_TTL_SECONDS)
      : SESSION_TOKEN_TTL_SECONDS;
    const requestedLimits = providedLimits
      ? { ...providedLimits, fund: requestedLimit }
      : { fund: requestedLimit };
    const approvalSummary = requestedLimitExplicit
      ? `${agentId} requesting ${requestedLimit} ETH access`
      : `${agentId} requesting access`;

    const requestedWalletAccess = Array.isArray(walletAccess)
      ? walletAccess.map((addr: string) => addr.toLowerCase())
      : undefined;
    const requestedCredentialAccess = resolvedProfile.credentialAccess;

    if (typeof pubkey !== 'string' || !pubkey.trim()) {
      res.status(400).json({ error: 'pubkey is required' });
      return;
    }
    if (!isValidAgentPubkey(pubkey)) {
      res.status(400).json({ error: 'pubkey must be a valid RSA public key (PEM or base64)' });
      return;
    }
    const normalizedPubkey = normalizeAgentPubkey(pubkey);

    // Validate optional pre-computed action for auto-execute on approval
    let validatedAction: { endpoint: string; method: string; body?: Record<string, unknown> } | undefined;
    if (action && typeof action === 'object' && !Array.isArray(action)) {
      const { endpoint, method, body } = action as Record<string, unknown>;
      if (typeof endpoint === 'string' && typeof method === 'string') {
        validatedAction = {
          endpoint,
          method: method.toUpperCase(),
          ...(body && typeof body === 'object' && !Array.isArray(body) ? { body: body as Record<string, unknown> } : {}),
        };
      }
    }

    // Generate a secret for retrieving the token later
    const secret = randomBytes(32).toString('hex');
    const secretHash = hashSecret(secret);

    // Create pending request with secretHash in metadata
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
          agentId,
          limit: requestedLimit,
          requestedLimitExplicit,
          defaultFundLimit,
          permissions: requestedPermissions,
          ttl: requestedTtl,
          limits: requestedLimits,
          walletAccess: requestedWalletAccess,
          credentialAccess: requestedCredentialAccess,
          profile: resolvedProfile.profile,
          effectivePolicyHash: resolvedProfile.effectivePolicyHash,
          overrideDelta: resolvedProfile.overrideDelta,
          warnings: resolvedProfile.warnings,
          summary: approvalSummary,
          pubkey: normalizedPubkey,
          secretHash,
          ...(validatedAction ? { action: validatedAction } : {}),
          // tokenHash will be added here when approved (raw token stays in memory escrow)
        })
      }
    });

    // Create notification for human approval
    await createHumanActionNotification(request);

    // Emit WebSocket event
    events.actionCreated({
      id: request.id,
      type: 'agent_access',
      source: `agent:${agentId}`,
      summary: approvalSummary,
      expiresAt: null,
      metadata: {
        approvalScope: 'session_token',
        agentId,
        limit: requestedLimit,
        limits: requestedLimits,
        requestedLimitExplicit,
        defaultFundLimit,
        permissions: requestedPermissions,
        summary: approvalSummary,
        profile: resolvedProfile.profile,
        effectivePolicyHash: resolvedProfile.effectivePolicyHash,
      },
    });

    logger.agentRequested(agentId, request.id, requestedLimit);
    auditApprovalLifecycle({
      requestId: request.id,
      state: 'request_created',
      metadata: {
        approvalScope: 'session_token',
        agentId,
        profile: resolvedProfile.profile.id,
        profileVersion: resolvedProfile.profile.version,
        requestedPolicySource: 'derived_403',
        policyHash: resolvedProfile.effectivePolicyHash,
      },
    });

    const dashboardBase = `http://localhost:${process.env.DASHBOARD_PORT || '4747'}`;
    const contract = buildSessionApprovalContract({
      requestId: request.id,
      secret,
      approveUrl: buildApproveUrl(dashboardBase, request.id),
    });
    res.json({
      success: true,
      requestId: request.id,
      reqId: request.id,
      ...contract.flow,
      secret, // Only returned once - agent must store this!
      claimStatus: 'pending',
      retryReady: false,
      claimAction: contract.claimAction,
      retryAction: contract.retryAction,
      instructions: contract.flow.instructions || [],
      approveUrl: contract.flow.approveUrl,
      message: 'Action escalated — waiting for human approval',
      agentId,
      limit: requestedLimit,
      permissions: requestedPermissions,
      limits: requestedLimits,
      credentialAccess: requestedCredentialAccess,
      profile: resolvedProfile.profile,
      effectivePolicyHash: resolvedProfile.effectivePolicyHash,
      policyHash: resolvedProfile.effectivePolicyHash,
      compilerVersion: 'profile.v1',
      overrideDelta: resolvedProfile.overrideDelta,
      warnings: resolvedProfile.warnings,
      ttl: requestedTtl,
      requestedLimitExplicit,
      defaultFundLimit,
    });
  } catch (error) {
    if (error instanceof AgentProfileError) {
      res.status(400).json({ error: error.message, code: error.code });
      return;
    }
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// GET /auth/pending - List pending auth requests (public, shows sanitized info)
router.get('/pending', async (_req: Request, res: Response) => {
  try {
    const requests = await prisma.humanAction.findMany({
      where: {
        type: 'auth',
        status: 'pending'
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      requests: requests.map(r => {
        const metadata = r.metadata ? JSON.parse(r.metadata) : {};
        // Don't expose secretHash
        const safeMetadata = { ...metadata };
        delete safeMetadata.secretHash;
        return {
          ...r,
          metadata: safeMetadata
        };
      })
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// POST /auth/validate - Validate a token and return its info
// Used by Next.js WebSocket server to authenticate connections
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      res.status(400).json({ valid: false, error: 'token is required' });
      return;
    }

    // Import validation functions
    const { validateToken, getTokenHash } = await import('../lib/auth');
    const { isRevoked } = await import('../lib/sessions');

    // Validate token (admin tokens are just tokens with admin:* permission)
    const payload = validateToken(token);
    if (!payload) {
      res.json({ valid: false, error: 'Invalid or expired token' });
      return;
    }

    const tokenHash = getTokenHash(token);

    // Check if revoked
    if (isRevoked(tokenHash)) {
      res.json({ valid: false, error: 'Token has been revoked' });
      return;
    }

    logger.tokenValidated(payload.agentId, tokenHash);

    res.json({
      valid: true,
      isAdmin: payload.permissions.includes('admin:*'),
      tokenHash,
      payload: {
        agentId: payload.agentId,
        permissions: payload.permissions,
        limits: payload.limits,
        walletAccess: payload.walletAccess,
        exp: payload.exp
      }
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ valid: false, error: message });
  }
});

// GET /auth/:requestId - Agent polls for token (requires secret)
router.get('/:requestId', async (req: Request<{ requestId: string }>, res: Response) => {
  try {
    const { requestId } = req.params;
    const headerSecret = req.get(CLAIM_SECRET_HEADER);
    const querySecret = typeof req.query[CLAIM_SECRET_QUERY] === 'string' ? req.query[CLAIM_SECRET_QUERY] : undefined;
    const hasHeaderSecret = typeof headerSecret === 'string' && headerSecret.length > 0;
    const hasQuerySecret = typeof querySecret === 'string' && querySecret.length > 0;
    const secret = hasHeaderSecret ? headerSecret : hasQuerySecret ? querySecret : undefined;

    if (!secret) {
      res.status(400).json({ error: `${CLAIM_SECRET_HEADER} header is required` });
      return;
    }

    if (!hasHeaderSecret && hasQuerySecret) {
      // Temporary compatibility fallback until all callers migrate off ?secret=.
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', CLAIM_QUERY_FALLBACK_SUNSET);
      res.setHeader('Warning', `299 - "${CLAIM_SECRET_QUERY} query parameter is deprecated; use ${CLAIM_SECRET_HEADER} header"`);
      logEvent({
        category: 'auth',
        action: 'claim_query_fallback_used',
        description: 'Deprecated auth claim query secret fallback used',
        metadata: { requestId },
      });
    }

    if (hasHeaderSecret && hasQuerySecret && headerSecret !== querySecret) {
      logEvent({
        category: 'auth',
        action: 'claim_secret_source_conflict',
        description: 'Auth claim received conflicting header/query secrets; using header',
        metadata: { requestId },
      });
    }

    const preferenceApplied = hasHeaderSecret
      ? CLAIM_SECRET_HEADER
      : `${CLAIM_SECRET_HEADER}; fallback=${CLAIM_SECRET_QUERY}`;
    res.setHeader('Preference-Applied', preferenceApplied);

    const request = await prisma.humanAction.findUnique({
      where: { id: requestId }
    });

    if (!request) {
      auditApprovalLifecycle({
        requestId,
        state: 'claim_missing_request',
      });
      res.status(404).json({ error: 'Request not found' });
      return;
    }

    // Parse metadata
    let metadata: {
      agentId?: string;
      limit?: number;
      requestedLimitExplicit?: boolean;
      defaultFundLimit?: number;
      permissions?: string[];
      ttl?: number;
      approvalScope?: 'one_shot_read' | 'session_token';
      secretHash?: string;
      tokenHash?: string;
      limits?: { fund?: number; send?: number; swap?: number };
      walletAccess?: string[];
      profile?: { id: string; version: string; displayName?: string; rationale?: string };
      effectivePolicyHash?: string;
      overrideDelta?: string[];
      warnings?: string[];
      requestedPolicySource?: 'agent' | 'derived_403';
      requestedPolicy?: Record<string, unknown>;
      effectivePolicy?: Record<string, unknown>;
      policyHash?: string;
      compilerVersion?: string;
      binding?: Record<string, unknown>;
      approveUrl?: string;
      pubkey?: string;
      originalCommand?: string;
    } = {};
    if (request.metadata) {
      try {
        metadata = JSON.parse(request.metadata);
      } catch {
        // ignore parse errors
      }
    }

    // Verify secret (timing-safe comparison)
    const providedHash = hashSecret(secret);
    if (!metadata.secretHash) {
      auditApprovalLifecycle({
        requestId,
        state: 'claim_invalid_secret',
        metadata: {
          reason: 'secret_hash_missing',
        },
      });
      res.status(403).json({ error: 'Invalid secret' });
      return;
    }
    const providedBuf = Buffer.from(providedHash, 'hex');
    const expectedBuf = Buffer.from(metadata.secretHash, 'hex');
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      auditApprovalLifecycle({
        requestId,
        state: 'claim_invalid_secret',
        metadata: {
          reason: 'secret_hash_mismatch',
        },
      });
      res.status(403).json({ error: 'Invalid secret' });
      return;
    }

    const contract = buildSessionApprovalContract({
      requestId,
      secret,
      ...(typeof metadata.approveUrl === 'string' ? { approveUrl: metadata.approveUrl } : {}),
    });
    const retryCommand = materializeRetryCommand(metadata.originalCommand, requestId);
    const instructions = buildRetryInstructions(contract.flow.instructions, retryCommand);

    // Return status based on request state
    if (request.status === 'pending') {
      auditApprovalLifecycle({
        requestId,
        state: 'claim_pending',
        metadata: {
          approvalScope: metadata.approvalScope,
          requestedPolicySource: metadata.requestedPolicySource,
          policyHash: metadata.policyHash,
          compilerVersion: metadata.compilerVersion,
        },
      });
      res.json({
        success: true,
        status: 'pending',
        ...contract.flow,
        reqId: requestId,
        requestId,
        claimStatus: 'pending',
        retryReady: false,
        claimAction: contract.claimAction,
        retryAction: contract.retryAction,
        instructions,
        ...(retryCommand ? { retryCommand } : {}),
        ...((metadata.policyHash || metadata.effectivePolicyHash) ? { policyHash: metadata.policyHash || metadata.effectivePolicyHash } : {}),
        ...((metadata.compilerVersion || metadata.effectivePolicyHash) ? { compilerVersion: metadata.compilerVersion || 'profile.v1' } : {}),
        message: 'Waiting for human approval',
      });
      return;
    }

    if (request.status === 'rejected') {
      auditApprovalLifecycle({
        requestId,
        state: 'claim_rejected',
        metadata: {
          approvalScope: metadata.approvalScope,
          requestedPolicySource: metadata.requestedPolicySource,
          policyHash: metadata.policyHash,
          compilerVersion: metadata.compilerVersion,
        },
      });
      res.json({
        success: true,
        status: 'rejected',
        ...contract.flow,
        reqId: requestId,
        requestId,
        claimStatus: 'rejected',
        retryReady: false,
        claimAction: contract.claimAction,
        retryAction: contract.retryAction,
        instructions,
        ...(retryCommand ? { retryCommand } : {}),
        ...((metadata.policyHash || metadata.effectivePolicyHash) ? { policyHash: metadata.policyHash || metadata.effectivePolicyHash } : {}),
        ...((metadata.compilerVersion || metadata.effectivePolicyHash) ? { compilerVersion: metadata.compilerVersion || 'profile.v1' } : {}),
        message: 'Request was rejected',
      });
      return;
    }

    if (request.status === 'approved') {
      const pubkey = typeof metadata.pubkey === 'string' ? metadata.pubkey : '';
      if (!pubkey) {
        res.status(500).json({ error: 'No pubkey available to return encrypted token' });
        return;
      }
      if (!isValidAgentPubkey(pubkey)) {
        res.status(500).json({ error: 'Invalid pubkey available to return encrypted token' });
        return;
      }
      const normalizedPubkey = normalizeAgentPubkey(pubkey);

      const tokenToReturn = claimEscrowedToken(requestId);
      if (!tokenToReturn) {
        auditApprovalLifecycle({
          requestId,
          state: 'claim_expired',
          metadata: {
            approvalScope: metadata.approvalScope,
            requestedPolicySource: metadata.requestedPolicySource,
            policyHash: metadata.policyHash,
            compilerVersion: metadata.compilerVersion,
          },
        });
        const policyHash = metadata.policyHash || metadata.effectivePolicyHash;
        const compilerVersion = metadata.compilerVersion || (metadata.effectivePolicyHash ? 'profile.v1' : undefined);
        res.status(410).json({
          contractVersion: ESCALATION_CONTRACT_VERSION,
          success: false,
          status: 'approved',
          error: 'Token already claimed or expired',
          errorCode: 'missing_or_expired_claim',
          requiresHumanApproval: false,
          reqId: requestId,
          requestId,
          approvalScope: metadata.approvalScope || 'session_token',
          approveUrl: contract.flow.approveUrl,
          pollUrl: contract.flow.pollUrl,
          claim: contract.flow.claim,
          approvalFlow: contract.flow.approvalFlow,
          claimStatus: 'expired',
          retryReady: false,
          claimAction: contract.claimAction,
          retryAction: contract.retryAction,
          instructions,
          ...(retryCommand ? { retryCommand } : {}),
          ...(policyHash ? { policyHash } : {}),
          ...(compilerVersion ? { compilerVersion } : {}),
          ...(metadata.requestedPolicySource ? { requestedPolicySource: metadata.requestedPolicySource } : {}),
          ...(metadata.requestedPolicy ? { requestedPolicy: metadata.requestedPolicy } : {}),
          ...(metadata.effectivePolicy ? { effectivePolicy: metadata.effectivePolicy } : {}),
          ...(metadata.binding ? { binding: metadata.binding } : {}),
        });
        return;
      }

      let encryptedToken: string;
      try {
        encryptedToken = encryptToAgentPubkey(tokenToReturn, normalizedPubkey);
      } catch (error) {
        escrowToken(requestId, tokenToReturn);
        res.status(500).json({ error: `Failed to encrypt token for delivery: ${getErrorMessage(error)}` });
        return;
      }

      auditApprovalLifecycle({
        requestId,
        state: 'claim_approved',
        metadata: {
          approvalScope: metadata.approvalScope,
          tokenHash: metadata.tokenHash,
          requestedPolicySource: metadata.requestedPolicySource,
          policyHash: metadata.policyHash,
          compilerVersion: metadata.compilerVersion,
          bindingHash: metadata.binding && typeof metadata.binding === 'object'
            ? (metadata.binding as Record<string, unknown>).bindingHash
            : undefined,
        },
      });

      res.json({
        success: true,
        status: 'approved',
        ...contract.flow,
        reqId: requestId,
        requestId,
        requiresHumanApproval: false,
        claimStatus: 'approved',
        retryReady: true,
        claimAction: contract.claimAction,
        retryAction: contract.retryAction,
        instructions,
        ...(retryCommand ? { retryCommand } : {}),
        ...((metadata.policyHash || metadata.effectivePolicyHash) ? { policyHash: metadata.policyHash || metadata.effectivePolicyHash } : {}),
        ...((metadata.compilerVersion || metadata.effectivePolicyHash) ? { compilerVersion: metadata.compilerVersion || 'profile.v1' } : {}),
        approvalScope: metadata.approvalScope,
        ttl: metadata.ttl,
        encryptedToken,
        agentId: metadata.agentId,
        limit: metadata.limit,
        limits: metadata.limits,
        permissions: metadata.permissions,
        walletAccess: metadata.walletAccess,
        profile: metadata.profile,
        effectivePolicyHash: metadata.effectivePolicyHash,
        overrideDelta: metadata.overrideDelta,
        warnings: metadata.warnings,
        requestedPolicySource: metadata.requestedPolicySource,
        requestedPolicy: metadata.requestedPolicy,
        effectivePolicy: metadata.effectivePolicy,
        binding: metadata.binding,
      });
      return;
    }

    res.status(400).json({ error: `Unknown status: ${request.status}` });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

export default router;
