/**
 * Extracted resolve logic from `POST /actions/:id/resolve`.
 *
 * Called by both the HTTP route handler and the ApprovalRouter (direct in-process).
 */

import { prisma } from './db';
import { events, emitWalletEvent } from './events';
import { createToken, getTokenHash, escrowToken, type AgentTokenPayload } from './auth';
import { isValidAgentPubkey, normalizeAgentPubkey } from './credential-transport';
import { isUnlocked, getColdWalletAddress } from './cold';
import { normalizeAddress } from './address';
import { getDefault } from './defaults';
import { logger, logEvent } from './logger';
import { getErrorMessage } from './error';
import { autoExecuteAction } from './auto-execute';
import { parsePolicyOperationBinding, parseRequestedPolicy } from './temp-policy';

export interface ResolveActionOptions {
  walletAccess?: string[];
  limits?: Record<string, number>;
}

export interface ResolveActionResult {
  success: boolean;
  statusCode: 200 | 400 | 401 | 404;
  data: Record<string, unknown>;
}

export async function resolveAction(
  actionId: string,
  approved: boolean,
  opts?: ResolveActionOptions,
): Promise<ResolveActionResult> {
  const id = actionId;
  const walletAccess = opts?.walletAccess;
  const overrideLimits = opts?.limits;

  if (typeof approved !== 'boolean') {
    return { success: false, statusCode: 400, data: { success: false, error: 'approved (boolean) is required' } };
  }

  const request = await prisma.humanAction.findUnique({ where: { id } });
  if (!request || request.status !== 'pending') {
    return { success: false, statusCode: 404, data: { success: false, error: 'Action not found or already resolved' } };
  }

  if (request.type === 'strategy:message') {
    return { success: false, statusCode: 400, data: { success: false, error: 'Internal message jobs are not manually resolvable' } };
  }

  // Handle rejection for all types
  if (!approved) {
    await prisma.humanAction.update({
      where: { id },
      data: { status: 'rejected', resolvedAt: new Date() },
    });

    events.actionResolved({ id, type: request.type, approved: false, resolvedBy: 'dashboard' });
    logger.actionResolved(id, request.type, false, 'dashboard');

    // Notify app of rejection via app:emit
    if (request.type === 'action') {
      let meta: { agentId?: string } = {};
      try { meta = JSON.parse(request.metadata || '{}'); } catch {}
      emitWalletEvent('app:emit', {
        strategyId: (meta.agentId || '').replace(/^app:/, ''),
        channel: 'action:resolved',
        data: { requestId: id, approved: false },
      });
    }

    return { success: true, statusCode: 200, data: { success: true, approved: false } };
  }

  // === APPROVAL ===

  // Strategy approvals
  if (request.type === 'strategy:approve') {
    await prisma.humanAction.update({
      where: { id },
      data: { status: 'approved', resolvedAt: new Date() },
    });

    events.actionResolved({ id, type: request.type, approved: true, resolvedBy: 'dashboard' });
    return { success: true, statusCode: 200, data: { success: true, approved: true } };
  }

  // Auth / agent_access / action approvals — generate token
  if (request.type === 'auth' || request.type === 'agent_access' || request.type === 'action') {
    if (!isUnlocked()) {
      return { success: false, statusCode: 401, data: { success: false, error: 'Wallet is locked. Unlock first.' } };
    }

    let metadata: {
      agentId?: string;
      limit?: number;
      permissions?: string[];
      ttl?: number;
      secretHash?: string;
      limits?: { fund?: number; send?: number; swap?: number };
      walletAccess?: string[];
      credentialAccess?: AgentTokenPayload['credentialAccess'];
      pubkey?: string;
      strategyId?: string;
      summary?: string;
      action?: { endpoint?: string; method?: string; body?: Record<string, unknown> };
      approvalScope?: 'one_shot_read' | 'session_token';
      requestedPolicySource?: 'agent' | 'derived_403';
      requestedPolicy?: Record<string, unknown>;
      effectivePolicy?: Record<string, unknown>;
      policyHash?: string;
      compilerVersion?: string;
      binding?: Record<string, unknown>;
    } = {};
    if (request.metadata) {
      try { metadata = JSON.parse(request.metadata); } catch { /* ignore */ }
    }

    const agentId = metadata.agentId || `agent-${id.slice(0, 8)}`;
    const defaultFundLimit = await getDefault<number>('limits.fund', 0);
    const defaultSendLimit = await getDefault<number>('limits.send', 0.1);
    const defaultSwapLimit = await getDefault<number>('limits.swap', 0.1);
    const defaultPermissions = await getDefault<string[]>('permissions.default', ['wallet:create:hot', 'send:hot', 'swap', 'fund', 'action:create']);
    const defaultTtl = await getDefault<number>('ttl.agent', 604800);
    const effectivePolicy = parseRequestedPolicy(metadata.effectivePolicy);
    const compiledBinding = parsePolicyOperationBinding(metadata.binding);
    const oneShotBinding = metadata.approvalScope === 'one_shot_read'
      && compiledBinding
      && typeof metadata.policyHash === 'string'
      && metadata.policyHash.trim().length > 0
      ? {
          reqId: id,
          approvalScope: 'one_shot_read' as const,
          policyHash: metadata.policyHash,
          compilerVersion: typeof metadata.compilerVersion === 'string' && metadata.compilerVersion.trim()
            ? metadata.compilerVersion
            : 'v1',
          ...compiledBinding,
        }
      : undefined;
    const resolvedPermissions = effectivePolicy?.permissions || metadata.permissions || defaultPermissions;
    const resolvedTtl = effectivePolicy?.ttlSeconds || metadata.ttl || defaultTtl;
    const limitFromPolicy = typeof effectivePolicy?.limits?.fund === 'number'
      ? effectivePolicy.limits.fund
      : undefined;
    const limit = overrideLimits?.fund ?? limitFromPolicy ?? metadata.limit ?? defaultFundLimit;
    const permissions = resolvedPermissions;
    const ttl = resolvedTtl;
    let normalizedPubkey = metadata.pubkey;
    if (normalizedPubkey) {
      if (!isValidAgentPubkey(normalizedPubkey)) {
        return { success: false, statusCode: 400, data: { success: false, error: 'Stored pubkey is invalid for token issuance' } };
      }
      normalizedPubkey = normalizeAgentPubkey(normalizedPubkey);
    }
    if (!normalizedPubkey) {
      return { success: false, statusCode: 400, data: { success: false, error: 'pubkey is required when approving token issuance' } };
    }

    const finalWalletAccess = walletAccess
      ? walletAccess.map((addr: string) => normalizeAddress(addr))
      : (effectivePolicy?.walletAccess || metadata.walletAccess);

    // Build limits: per-token overrides > request metadata > system defaults
    const baseLimits = { fund: limit, send: defaultSendLimit, swap: defaultSwapLimit };
    const policyLimits = effectivePolicy?.limits;
    const finalLimits = overrideLimits
      ? { ...baseLimits, ...overrideLimits }
      : policyLimits
        ? { ...baseLimits, ...policyLimits }
        : metadata.limits
        ? { ...baseLimits, ...metadata.limits }
        : baseLimits;

    const effectiveCredentialAccess = effectivePolicy?.credentialAccess || metadata.credentialAccess;

    const token = await createToken(agentId, limit, permissions, ttl, {
      limits: finalLimits,
      walletAccess: finalWalletAccess,
      credentialAccess: effectiveCredentialAccess,
      agentPubkey: normalizedPubkey,
      ...(oneShotBinding ? { oneShotBinding } : {}),
    });
    const tokenHash = getTokenHash(token);

    // Escrow the raw token in memory — never store it in the DB
    escrowToken(id, token);
    logEvent({
      category: 'agent',
      action: 'approval_token_escrowed',
      description: `Escrowed approved token for request ${id}`,
      agentId,
      metadata: {
        reqId: id,
        requestType: request.type,
        approvalScope: metadata.approvalScope || 'session_token',
        tokenHash,
        requestedPolicySource: metadata.requestedPolicySource,
        requestedPolicy: metadata.requestedPolicy ?? null,
        effectivePolicy: effectivePolicy ?? null,
        policyHash: metadata.policyHash,
        compilerVersion: metadata.compilerVersion,
        bindingHash: oneShotBinding?.bindingHash,
      },
    });

    // Update request status with tokenHash (not raw token) for audit/display
    await prisma.humanAction.update({
      where: { id },
      data: {
        status: 'approved',
        resolvedAt: new Date(),
        metadata: JSON.stringify({
          ...metadata,
          tokenHash,
          limits: finalLimits,
          walletAccess: finalWalletAccess,
          pubkey: normalizedPubkey,
          credentialAccess: effectiveCredentialAccess,
          ...(oneShotBinding ? { oneShotBinding } : {}),
          ...(effectivePolicy ? { effectivePolicy } : {}),
        }),
      },
    });

    // Log the approval
    await prisma.log.create({
      data: {
        walletAddress: getColdWalletAddress() || 'system',
        title: 'Agent Access Approved',
        description: `Generated token for ${agentId} with ${limit} ETH limit`,
      },
    });

    events.tokenCreated({
      tokenHash,
      agentId,
      limit,
      permissions,
      expiresAt: Date.now() + ttl * 1000,
    });
    events.actionResolved({ id, type: request.type, approved: true, resolvedBy: 'dashboard' });
    logger.actionResolved(id, request.type, true, 'dashboard');

    // Notify app of approval via app:emit (always, even with auto-execute)
    if (request.type === 'action') {
      emitWalletEvent('app:emit', {
        strategyId: (metadata.agentId || '').replace(/^app:/, ''),
        channel: 'action:resolved',
        data: { requestId: id, approved: true },
      });
    }

    // Auto-execute pre-computed action if present in metadata
    if (metadata.action && (request.type === 'action' || request.type === 'auth')) {
      const action = metadata.action as { endpoint?: string; method?: string; body?: Record<string, unknown> };
      if (action.endpoint && action.method) {
        await autoExecuteAction(
          { endpoint: action.endpoint, method: action.method, body: action.body },
          { requestId: id, agentId: metadata.agentId || '', summary: metadata.summary, token },
        );
      }
    }

    return {
      success: true,
      statusCode: 200,
      data: {
        success: true,
        token,
        agentId,
        limit,
        limits: finalLimits,
        permissions,
        walletAccess: finalWalletAccess,
        expiresIn: ttl,
      },
    };
  }

  // Permission update approvals — generate token with updated permissions
  if (request.type === 'permission_update') {
    if (!isUnlocked()) {
      return { success: false, statusCode: 401, data: { success: false, error: 'Wallet is locked. Unlock first.' } };
    }

    let metadata: {
      agentId?: string;
      tokenHash?: string;
      requestedPermissions?: string[];
      requestedWalletAccess?: string[];
      requestedLimits?: { fund?: number; send?: number; swap?: number };
      requestedPubkey?: string;
      secretHash?: string;
    } = {};
    if (request.metadata) {
      try { metadata = JSON.parse(request.metadata); } catch { /* ignore */ }
    }

    const agentId = metadata.agentId || `agent-${id.slice(0, 8)}`;
    const newPermissions = metadata.requestedPermissions ?? [];
    const newWalletAccess = walletAccess
      ? walletAccess.map((addr: string) => normalizeAddress(addr))
      : metadata.requestedWalletAccess;
    const newLimits = overrideLimits || metadata.requestedLimits;
    let normalizedPubkey = metadata.requestedPubkey;
    if (normalizedPubkey) {
      if (!isValidAgentPubkey(normalizedPubkey)) {
        return { success: false, statusCode: 400, data: { success: false, error: 'requestedPubkey is invalid' } };
      }
      normalizedPubkey = normalizeAgentPubkey(normalizedPubkey);
    }
    if (!normalizedPubkey) {
      return { success: false, statusCode: 400, data: { success: false, error: 'requestedPubkey is required for token issuance' } };
    }

    const ttl = await getDefault<number>('ttl.agent', 604800);
    const token = await createToken(agentId, newLimits?.fund ?? 0, newPermissions, ttl, {
      limits: newLimits,
      walletAccess: newWalletAccess,
      agentPubkey: normalizedPubkey,
    });
    const tokenHash = getTokenHash(token);

    // Escrow the raw token in memory — never store it in the DB
    escrowToken(id, token);
    logEvent({
      category: 'agent',
      action: 'approval_token_escrowed',
      description: `Escrowed permission-update token for request ${id}`,
      agentId,
      metadata: {
        reqId: id,
        requestType: request.type,
        approvalScope: 'session_token',
        tokenHash,
        requestedPermissions: newPermissions,
      },
    });

    await prisma.humanAction.update({
      where: { id },
      data: {
        status: 'approved',
        resolvedAt: new Date(),
        metadata: JSON.stringify({
          ...metadata,
          tokenHash,
          approvedPermissions: newPermissions,
          approvedWalletAccess: newWalletAccess,
          approvedLimits: newLimits,
          requestedPubkey: normalizedPubkey,
        }),
      },
    });

    await prisma.log.create({
      data: {
        walletAddress: getColdWalletAddress() || 'system',
        title: 'Permission Update Approved',
        description: `Updated permissions for ${agentId}`,
      },
    });

    events.tokenCreated({
      tokenHash,
      agentId,
      limit: newLimits?.fund ?? 0,
      permissions: newPermissions,
      expiresAt: Date.now() + ttl * 1000,
    });
    events.actionResolved({ id, type: request.type, approved: true, resolvedBy: 'dashboard' });

    return {
      success: true,
      statusCode: 200,
      data: {
        success: true,
        token,
        agentId,
        permissions: newPermissions,
        walletAccess: newWalletAccess,
        limits: newLimits,
      },
    };
  }

  // For other types (fund_transfer, etc.), update DB and emit event
  await prisma.humanAction.update({
    where: { id },
    data: { status: approved ? 'approved' : 'rejected', resolvedAt: new Date() },
  });

  events.actionResolved({ id, type: request.type, approved, resolvedBy: 'dashboard' });

  return { success: true, statusCode: 200, data: { success: true, approved } };
}
