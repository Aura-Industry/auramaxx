import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { prisma } from '../lib/db';
import { events } from '../lib/events';
import { requireWalletAuth } from '../middleware/auth';
import { requireAdminForRoute, requirePermissionForRoute, isAdmin } from '../lib/permissions';
import { createToken, getTokenHash, type AgentTokenPayload } from '../lib/auth';
import { isValidAgentPubkey, normalizeAgentPubkey, encryptToAgentPubkey } from '../lib/credential-transport';
import { hashSecret } from '../lib/crypto';
import { isUnlocked } from '../lib/cold';
import { normalizeAddress } from '../lib/address';
import { generateVerifiedSummary } from '../lib/verified-summary';
import { listTokensFromDb, revokeToken } from '../lib/sessions';
import { createHumanActionNotification, createNotification } from '../lib/notifications';
import { getDefault } from '../lib/defaults';
import { logger } from '../lib/logger';
import { getErrorMessage } from '../lib/error';
import { buildApproveUrl } from '../lib/approval-link';
import { resolveAction } from '../lib/resolve-action';
import { AgentProfileError, resolveProfileToEffectivePolicy } from '../lib/agent-profiles';
import { buildPolicyPreviewV1, mapPreviewError } from '../lib/policy-preview';
import { buildApprovalClaimFlow, buildClaimEndpoint } from '../lib/approval-flow';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';

const router = Router();

// ============================================================================
// INTERNAL ENDPOINTS — Used by the dashboard, strategy engine, and admin tools.
// External agents should use POST /auth for token requests (with optional
// `action` field for auto-execute on approval). These routes are NOT exposed
// in agent-facing documentation (SKILL.md, CLI.md, etc.).
// ============================================================================

// GET /actions/pending — List all pending human actions
router.get('/pending', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ACTIONS_READ, 'action:read'), async (_req: Request, res: Response) => {
  try {
    const actions = await prisma.humanAction.findMany({
      where: {
        status: 'pending',
        NOT: { type: 'strategy:message' },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, actions });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /actions/:id/summary — Public sanitized action details for the approval page
router.get('/:id/summary', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const action = await prisma.humanAction.findUnique({ where: { id: req.params.id } });
    if (!action) { res.status(404).json({ error: 'Action not found' }); return; }

    const metadata = action.metadata ? JSON.parse(action.metadata) : {};

    // Derive display fields from stored metadata
    const summary: Record<string, unknown> = {
      id: action.id,
      type: action.type,
      status: action.status,
      createdAt: action.createdAt,
      action: metadata.summary || `${action.type} request`,
      profile: typeof metadata.profile === 'object' ? metadata.profile.displayName || metadata.profile.id : metadata.profile,
    };

    // Permissions → scope
    if (Array.isArray(metadata.permissions) && metadata.permissions.length > 0) {
      summary.scope = metadata.permissions;
    }

    // Risk based on permissions
    const perms = metadata.permissions || [];
    const highRisk = perms.some((p: string) => ['admin:*', 'fund', 'send:hot', 'launch'].includes(p));
    const medRisk = perms.some((p: string) => ['swap', 'trade:all', 'wallet:create:hot'].includes(p));
    summary.risk = highRisk ? 'high' : medRisk ? 'medium' : 'low';

    // Impact descriptions (skip zero-value limits)
    const impact: string[] = [];
    // Default fund limit line (kept for reference, intentionally disabled).
    // if (metadata.limit && metadata.limit > 0) impact.push(`Fund limit: ${metadata.limit} ETH`);
    if (metadata.limits?.send && metadata.limits.send > 0) impact.push(`Send limit: ${metadata.limits.send} ETH`);
    if (metadata.limits?.swap && metadata.limits.swap > 0) impact.push(`Swap limit: ${metadata.limits.swap} ETH`);
    if (metadata.ttl) impact.push(`Token TTL: ${Math.round(metadata.ttl / 60)} minutes`);
    if (impact.length > 0) summary.impact = impact;

    // Never expose: secretHash, pubkey, token data
    res.json({ success: true, ...summary });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /actions — Create a human action request (app proposes an action for approval)
// Requires Bearer token with action:create permission
router.post('/', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ACTIONS_CREATE, 'action:create'), async (req: Request, res: Response) => {
  try {
    const { summary, permissions, limits, walletAccess, ttl, type, metadata, notify, pubkey, credentialAccess } = req.body;

    // Validate summary (required for all types)
    if (!summary || typeof summary !== 'string' || summary.trim().length === 0) {
      res.status(400).json({ success: false, error: 'summary is required and must be a non-empty string' });
      return;
    }

    const MAX_SUMMARY_LENGTH = 500;
    if (summary.length > MAX_SUMMARY_LENGTH) {
      res.status(400).json({ success: false, error: `summary must be ${MAX_SUMMARY_LENGTH} characters or fewer` });
      return;
    }

    const callerAgentId = req.auth!.token.agentId;

    // === Notification-only branch: no permissions/limits needed ===
    if (type === 'notify') {
      const request = await prisma.humanAction.create({
        data: {
          type: 'notify',
          fromTier: 'system',
          toAddress: null,
          amount: null,
          chain: 'base',
          status: 'acknowledged',
          resolvedAt: new Date(),
          metadata: JSON.stringify({ agentId: callerAgentId, summary, ...(metadata || {}) }),
        },
      });

      // Info notification (dismiss only, no approve/reject)
      await createNotification({
        type: 'info',
        category: 'general',
        title: 'Notification',
        message: summary,
        actions: [{ id: 'dismiss', label: 'DISMISS', type: 'secondary', action: 'dismiss' }],
        metadata: { ...(metadata || {}), agentId: callerAgentId },
        source: 'agent',
        agentId: callerAgentId,
      });

      // Emit to WebSocket for dashboard; adapters check type themselves
      if (notify !== false) {
        events.actionCreated({
          id: request.id,
          type: 'notify',
          source: `agent:${callerAgentId}`,
          summary,
          expiresAt: null,
          metadata: { agentId: callerAgentId, ...(metadata || {}) },
        });
      }

      logger.actionCreated(callerAgentId, request.id, 'notify', summary);

      res.json({ success: true, id: request.id });
      return;
    }

    // === Standard approval flow: permissions required ===

    // Validate permissions
    if (!permissions || !Array.isArray(permissions) || permissions.length === 0) {
      res.status(400).json({ success: false, error: 'permissions must be a non-empty array' });
      return;
    }

    // Block privilege escalation — cannot request admin/wildcard or action:create
    const blocked = permissions.filter((p: string) => p === 'admin:*' || p === '*' || p === 'action:create');
    if (blocked.length > 0) {
      res.status(400).json({ success: false, error: `Cannot request privileged permissions: ${blocked.join(', ')}` });
      return;
    }

    const requestedCredentialAccess = credentialAccess && typeof credentialAccess === 'object' && !Array.isArray(credentialAccess)
      ? credentialAccess as AgentTokenPayload['credentialAccess']
      : undefined;
    if (typeof pubkey !== 'string' || !pubkey.trim()) {
      res.status(400).json({ success: false, error: 'pubkey is required' });
      return;
    }
    if (!isValidAgentPubkey(pubkey)) {
      res.status(400).json({ success: false, error: 'pubkey must be a valid RSA public key (PEM or base64)' });
      return;
    }
    const normalizedPubkey = normalizeAgentPubkey(pubkey);

    const defaultActionTtl = await getDefault<number>('ttl.action', 3600);
    const actionTtl = typeof ttl === 'number' && ttl > 0 ? ttl : defaultActionTtl;

    // Generate secret for polling (same pattern as POST /auth)
    const secret = randomBytes(32).toString('hex');
    const secretHash = hashSecret(secret);

    // Preserve pre-computed action from metadata if provided (for auto-execute on approval)
    const precomputedAction = metadata?.action || undefined;

    // Generate server-verified summary from actual action parameters
    const verifiedSummary = generateVerifiedSummary({
      agentId: callerAgentId,
      summary,
      permissions,
      limits: limits || undefined,
      walletAccess: walletAccess || undefined,
      ttl: actionTtl,
      action: precomputedAction,
    });

    const request = await prisma.humanAction.create({
      data: {
        type: 'action',
        fromTier: 'system',
        toAddress: null,
        amount: null,
        chain: 'base',
        status: 'pending',
        metadata: JSON.stringify({
          approvalScope: 'session_token',
          agentId: callerAgentId,
          permissions,
          limits: limits || undefined,
          walletAccess: walletAccess || undefined,
          credentialAccess: requestedCredentialAccess,
          pubkey: normalizedPubkey,
          ttl: actionTtl,
          secretHash,
          summary,
          action: precomputedAction,
          verifiedSummary,
        }),
      },
    });

    // Create notification for human approval
    await createHumanActionNotification(request);

    // Emit WebSocket event
    events.actionCreated({
      id: request.id,
      type: 'action',
      source: `agent:${callerAgentId}`,
      summary,
      expiresAt: null,
      metadata: {
        approvalScope: 'session_token',
        agentId: callerAgentId,
        permissions,
        limits,
        summary,
        verifiedSummary,
      },
    });

    logger.actionCreated(callerAgentId, request.id, 'action', summary);

    const dashboardBase = `http://localhost:${process.env.DASHBOARD_PORT || '4747'}`;
    const walletBase = process.env.WALLET_SERVER_URL || 'http://127.0.0.1:4242';
    const flow = buildApprovalClaimFlow({
      requestId: request.id,
      secret,
      approveUrl: buildApproveUrl(dashboardBase, request.id),
      dashboardBase,
      walletBase,
      mode: 'manual_auth_claim',
      summary: 'Action token is issued only after explicit claim/poll. No background auto-claim.',
      step2Label: 'Claim token',
      finalStep: 'Retry original operation after claimStatus=approved.',
      retryBehavior: 'Until claim succeeds, retries remain pending/rejected and no active token is available.',
    });
    const claimEndpoint = flow.claim?.endpoint || buildClaimEndpoint(request.id, secret);
    res.json({
      success: true,
      requestId: request.id,
      reqId: request.id,
      ...flow,
      secret,
      claimStatus: 'pending',
      retryReady: false,
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
      approveUrl: flow.approveUrl,
      message: 'Action escalated — waiting for human approval',
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /actions/:id/resolve — Approve or reject a human action
router.post('/:id/resolve', requireWalletAuth, requirePermissionForRoute(ESCALATION_ROUTE_IDS.ACTIONS_RESOLVE, 'action:resolve'), async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { approved, walletAccess, limits } = req.body;
    if (approved === true && !isAdmin(req.auth!)) {
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.ACTIONS_RESOLVE_ADMIN,
        error: 'Admin access required to approve actions',
        required: ['admin:*'],
        have: req.auth?.token.permissions,
        extraPayload: { success: false },
      });
      return;
    }
    const result = await resolveAction(req.params.id, approved, { walletAccess, limits });
    res.status(result.statusCode).json(result.data);
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /actions/:id/approve — Admin-only shortcut for approving a pending human action
router.post('/:id/approve', requireWalletAuth, requireAdminForRoute(ESCALATION_ROUTE_IDS.ACTIONS_APPROVE_ADMIN), async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { walletAccess, limits } = req.body || {};
    const result = await resolveAction(req.params.id, true, { walletAccess, limits });
    res.status(result.statusCode).json(result.data);
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

// POST /actions/token/preview - Preview effective token policy without issuing token (requires admin)
router.post('/token/preview', requireWalletAuth, requireAdminForRoute(ESCALATION_ROUTE_IDS.ACTIONS_APPROVE_ADMIN), async (req: Request, res: Response) => {
  try {
    const { profile, profileVersion, profileOverrides } = req.body;

    if (typeof profile !== 'string' || profile.trim().length === 0) {
      res.status(422).json({ version: 'v1', code: 'ERR_OVERRIDE_INVALID', error: 'profile is required' });
      return;
    }

    const previewInput = {
      profileId: profile,
      profileVersion: typeof profileVersion === 'string' ? profileVersion : undefined,
      overrides: profileOverrides,
    };

    const resolved = resolveProfileToEffectivePolicy(previewInput);
    const preview = buildPolicyPreviewV1(previewInput, resolved);

    res.json(preview);
  } catch (error) {
    if (error instanceof AgentProfileError) {
      const mapped = mapPreviewError(error.code);
      res.status(mapped.status).json(mapped.error);
      return;
    }
    const mapped = mapPreviewError('ERR_RESOLUTION_FAILED');
    res.status(mapped.status).json(mapped.error);
  }
});

// POST /actions/token - Create signed token for agent (requires admin)
router.post('/token', requireWalletAuth, requireAdminForRoute(ESCALATION_ROUTE_IDS.ACTIONS_APPROVE_ADMIN), async (req: Request, res: Response) => {
  try {
    const {
      agentId,
      limit,
      permissions,
      ttl,
      limits,           // Per-permission limits
      walletAccess,     // Wallet access grants
      credentialAccess,
      pubkey,
      profile,
      profileVersion,
      profileOverrides,
    } = req.body;

    if (!agentId || typeof agentId !== 'string') {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }

    // Legacy limit or new limits.fund
    const fundLimit = typeof limit === 'number' ? limit : (limits?.fund ?? 0);
    if (fundLimit < 0) {
      res.status(400).json({ error: 'limit must be a non-negative number (in ETH)' });
      return;
    }

    // Wallet must be unlocked
    if (!isUnlocked()) {
      res.status(401).json({ error: 'Wallet is locked. Unlock first.' });
      return;
    }

    const defaultSendLimit = await getDefault<number>('limits.send', 0.1);
    const defaultSwapLimit = await getDefault<number>('limits.swap', 0.1);
    const defaultTtl = await getDefault<number>('ttl.agent', 604800);

    const hasProfile = typeof profile === 'string' && profile.trim().length > 0;
    const hasPermissions = permissions !== undefined;
    if (hasProfile === hasPermissions) {
      res.status(400).json({
        error: 'Provide exactly one issuance mode: profile OR permissions.',
        code: 'ISSUANCE_XOR_REQUIRED',
      });
      return;
    }

    if (!hasProfile && (profileVersion !== undefined || profileOverrides !== undefined)) {
      res.status(400).json({
        error: 'profileVersion/profileOverrides require profile.',
        code: 'PROFILE_FIELDS_WITHOUT_PROFILE',
      });
      return;
    }

    if (hasPermissions && (!Array.isArray(permissions) || permissions.length === 0)) {
      res.status(400).json({
        error: 'permissions must be a non-empty array when using permissions mode.',
        code: 'PERMISSIONS_REQUIRED',
      });
      return;
    }

    const resolvedProfile = hasProfile
      ? resolveProfileToEffectivePolicy({
        profileId: profile.trim(),
        profileVersion: typeof profileVersion === 'string' ? profileVersion : undefined,
        overrides: profileOverrides,
      })
      : null;

    const validPermissions = resolvedProfile
      ? [...resolvedProfile.permissions]
      : [...permissions];

    if (typeof pubkey !== 'string' || !pubkey.trim()) {
      res.status(400).json({ error: 'pubkey is required' });
      return;
    }
    if (!isValidAgentPubkey(pubkey)) {
      res.status(400).json({ error: 'pubkey must be a valid RSA public key (PEM or base64)' });
      return;
    }
    const normalizedPubkey = normalizeAgentPubkey(pubkey);

    const ttlSeconds = resolvedProfile
      ? resolvedProfile.ttlSeconds
      : (typeof ttl === 'number' ? ttl : defaultTtl);

    // Normalize wallet access addresses
    const normalizedWalletAccess = walletAccess && Array.isArray(walletAccess)
      ? walletAccess.map((addr: string) => normalizeAddress(addr))
      : undefined;

    // Build limits: per-token overrides > system defaults
    const baseLimits = { fund: fundLimit, send: defaultSendLimit, swap: defaultSwapLimit };
    const tokenLimits = limits ? { ...baseLimits, ...limits } : baseLimits;

    const effectiveCredentialAccess = resolvedProfile
      ? resolvedProfile.credentialAccess
      : credentialAccess;

    const token = await createToken(agentId, fundLimit, validPermissions, ttlSeconds, {
      limits: tokenLimits,
      walletAccess: normalizedWalletAccess,
      credentialAccess: effectiveCredentialAccess,
      agentPubkey: normalizedPubkey,
    });

    const tokenHash = getTokenHash(token);

    // Emit WebSocket event for direct token creation
    events.tokenCreated({
      tokenHash,
      agentId,
      limit: fundLimit,
      permissions: validPermissions,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });

    if (resolvedProfile) {
      events.custom('agent_profile:issued', {
        eventSchemaVersion: 1,
        eventType: 'agent_profile.issued',
        profile: resolvedProfile.profile,
        effectivePolicyHash: resolvedProfile.effectivePolicyHash,
        overrideDelta: resolvedProfile.overrideDelta,
        actor: 'admin',
        agentId,
        tokenHash,
        timestamp: Date.now(),
      });
    }

    // Encrypt token to agent pubkey if provided (prevents model provider from seeing it)
    const responseToken = normalizedPubkey
      ? { encryptedToken: encryptToAgentPubkey(token, normalizedPubkey) }
      : { token };

    res.json({
      success: true,
      ...responseToken,
      agentId,
      limit: fundLimit,
      limits: tokenLimits,
      permissions: validPermissions,
      walletAccess: normalizedWalletAccess,
      credentialAccess: effectiveCredentialAccess,
      profile: resolvedProfile ? resolvedProfile.profile : undefined,
      effectivePolicyHash: resolvedProfile ? resolvedProfile.effectivePolicyHash : undefined,
      overrideDelta: resolvedProfile ? resolvedProfile.overrideDelta : undefined,
      warnings: resolvedProfile ? resolvedProfile.warnings : undefined,
      hasPubkey: !!normalizedPubkey,
      expiresIn: ttlSeconds
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

// GET /actions/tokens - List all agent tokens (requires admin)
router.get('/tokens', requireWalletAuth, requireAdminForRoute(ESCALATION_ROUTE_IDS.ACTIONS_APPROVE_ADMIN), async (_req: Request, res: Response) => {
  try {
    const tokens = await listTokensFromDb();

    const active = tokens.filter(t => t.isActive && !t.isExpired && !t.isRevoked && t.remaining > 0);
    const inactive = tokens.filter(t => !t.isActive && !t.isExpired && !t.isRevoked);
    const expired = tokens.filter(t => t.isExpired);
    const revoked = tokens.filter(t => t.isRevoked);
    const depleted = tokens.filter(t => !t.isExpired && !t.isRevoked && t.remaining <= 0);

    res.json({
      success: true,
      tokens: {
        active,
        inactive,
        expired,
        revoked,
        depleted
      },
      total: tokens.length
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// POST /actions/tokens/revoke - Revoke a token (admin or agent with own token)
router.post('/tokens/revoke', requireWalletAuth, async (req: Request, res: Response) => {
  try {
    const { tokenHash } = req.body;
    const auth = req.auth!;

    // Agent can only revoke their own token
    if (!isAdmin(auth)) {
      if (tokenHash && tokenHash !== auth.tokenHash) {
        res.status(403).json({ error: 'Agents can only revoke their own token' });
        return;
      }
      const success = await revokeToken(auth.tokenHash);
      if (success) {
        logger.tokenRevoked(auth.tokenHash, auth.token.agentId);
      }
      res.json({ success, message: success ? 'Token revoked' : 'Token not found' });
      return;
    }

    // Admin revoking any token
    if (!tokenHash || typeof tokenHash !== 'string') {
      res.status(400).json({ error: 'tokenHash is required' });
      return;
    }

    const success = await revokeToken(tokenHash);

    if (success) {
      events.tokenRevoked({ tokenHash });
      logger.tokenRevoked(tokenHash, 'admin');
    }

    res.json({ success, message: success ? 'Token revoked' : 'Token not found' });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

export default router;
