/**
 * Event logger helper for consistent event emission across Express routes
 * Convenience wrapper around events.custom() for structured logging
 */

import { events } from './events';

export type EventCategory = 'auth' | 'wallet' | 'transaction' | 'token' | 'request' | 'system' | 'agent';

export interface LogParams {
  category: EventCategory;
  action: string;
  description: string;
  agentId?: string;
  walletAddress?: string;
  txHash?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Log an event with structured data
 * Emits to WebSocket and stores in database
 */
export function logEvent(params: LogParams): void {
  const eventType = `${params.category}:${params.action}`;
  events.custom(eventType, {
    description: params.description,
    agentId: params.agentId,
    walletAddress: params.walletAddress,
    txHash: params.txHash,
    timestamp: Date.now(),
    ...params.metadata,
  });
}

/**
 * Convenience methods for common events
 */
export const logger = {
  // ── Auth Events ──────────────────────────────────────────────

  /** Wallet unlocked event */
  unlocked: (address: string) =>
    logEvent({
      category: 'auth',
      action: 'unlocked',
      description: `Wallet unlocked: ${address.slice(0, 10)}...`,
      walletAddress: address,
    }),

  /** Wallet locked event */
  locked: () =>
    logEvent({
      category: 'auth',
      action: 'locked',
      description: 'Wallet locked',
    }),

  /** Auth failure (invalid/expired/revoked token, missing header) */
  authFailed: (reason: string, path: string, metadata?: Record<string, unknown>) =>
    logEvent({
      category: 'auth',
      action: 'auth_failed',
      description: `Auth failed: ${reason}`,
      metadata: { path, reason, ...metadata },
    }),

  /** Permission denied */
  permissionDenied: (permission: string, agentId: string, path: string) =>
    logEvent({
      category: 'auth',
      action: 'permission_denied',
      description: `Permission denied: ${permission}`,
      agentId,
      metadata: { permission, path },
    }),

  /** Token validated successfully */
  tokenValidated: (agentId: string, tokenHash: string) =>
    logEvent({
      category: 'auth',
      action: 'token_validated',
      description: `Token validated for ${agentId}`,
      agentId,
      metadata: { tokenHash },
    }),

  // ── Token Events ─────────────────────────────────────────────

  /** Agent token created */
  tokenCreated: (agentId: string, tokenHash: string, limit: number, permissions: string[]) =>
    logEvent({
      category: 'token',
      action: 'created',
      description: `Token created for ${agentId} (limit: ${limit} ETH)`,
      agentId,
      metadata: { tokenHash, limit, permissions },
    }),

  /** Agent token revoked */
  tokenRevoked: (tokenHash: string, revokedBy?: string) =>
    logEvent({
      category: 'token',
      action: 'revoked',
      description: `Token revoked: ${tokenHash.slice(0, 12)}...`,
      metadata: { tokenHash, revokedBy },
    }),

  /** Spending limit exceeded */
  limitExceeded: (agentId: string, limitType: string, requested: number, remaining: number) =>
    logEvent({
      category: 'token',
      action: 'limit_exceeded',
      description: `${limitType} limit exceeded: requested ${requested}, remaining ${remaining}`,
      agentId,
      metadata: { limitType, requested, remaining },
    }),

  // ── Wallet Events ────────────────────────────────────────────

  /** Cold wallet setup event */
  setup: (address: string) =>
    logEvent({
      category: 'wallet',
      action: 'setup',
      description: `Cold wallet created: ${address.slice(0, 10)}...`,
      walletAddress: address,
    }),

  /** Hot/temp wallet created event */
  walletCreated: (address: string, tier: string, agentId?: string) =>
    logEvent({
      category: 'wallet',
      action: 'created',
      description: `${tier} wallet created`,
      walletAddress: address,
      agentId,
      metadata: { tier },
    }),

  /** Wallet renamed/updated */
  walletRenamed: (address: string, agentId?: string) =>
    logEvent({
      category: 'wallet',
      action: 'renamed',
      description: `Wallet updated: ${address.slice(0, 10)}...`,
      walletAddress: address,
      agentId,
    }),

  /** Wallet private key exported */
  walletExported: (address: string, agentId?: string) =>
    logEvent({
      category: 'wallet',
      action: 'exported',
      description: `Private key exported: ${address.slice(0, 10)}...`,
      walletAddress: address,
      agentId,
    }),

  /** Seed phrase exported */
  seedExported: (agentId?: string) =>
    logEvent({
      category: 'wallet',
      action: 'seed_exported',
      description: `Seed phrase exported${agentId ? ` (agent: ${agentId})` : ''}`,
      metadata: { agentId },
    }),

  // ── Transaction Events ───────────────────────────────────────

  /** ETH send event */
  send: (from: string, to: string, amount: string, txHash: string, agentId?: string) =>
    logEvent({
      category: 'transaction',
      action: 'send',
      description: `Sent ${amount} ETH`,
      walletAddress: from,
      txHash,
      agentId,
      metadata: { to, amount },
    }),

  /** Cold to hot fund transfer event */
  fund: (to: string, amount: string, txHash: string, agentId?: string) =>
    logEvent({
      category: 'transaction',
      action: 'fund',
      description: `Funded ${amount} ETH`,
      walletAddress: to,
      txHash,
      agentId,
      metadata: { amount },
    }),

  /** Token swap event */
  swap: (wallet: string, fromToken: string, toToken: string, amount: string, txHash: string, agentId?: string) =>
    logEvent({
      category: 'transaction',
      action: 'swap',
      description: `Swapped ${amount} ${fromToken} to ${toToken}`,
      walletAddress: wallet,
      txHash,
      agentId,
      metadata: { fromToken, toToken, amount },
    }),

  // ── Agent Events ─────────────────────────────────────────────

  /** Agent requested access */
  agentRequested: (agentId: string, requestId: string, limit: number) =>
    logEvent({
      category: 'agent',
      action: 'access_requested',
      description: `${agentId} requested access (limit: ${limit} ETH)`,
      agentId,
      metadata: { requestId, limit },
    }),

  /** Agent polled for token */
  agentPolled: (requestId: string) =>
    logEvent({
      category: 'agent',
      action: 'polled',
      description: `Token poll for request ${requestId}`,
      metadata: { requestId },
    }),

  /** Permission update requested */
  permissionRequested: (agentId: string, requestId: string, permissions: string[]) =>
    logEvent({
      category: 'agent',
      action: 'permission_requested',
      description: `${agentId} requested permission update`,
      agentId,
      metadata: { requestId, permissions },
    }),

  /** Action created by agent */
  actionCreated: (agentId: string, requestId: string, type: string, summary: string) =>
    logEvent({
      category: 'agent',
      action: 'action_created',
      description: `${agentId} created ${type}: ${summary}`,
      agentId,
      metadata: { requestId, type, summary },
    }),

  /** Action resolved (approved/rejected) */
  actionResolved: (requestId: string, type: string, approved: boolean, resolvedBy: string) =>
    logEvent({
      category: 'agent',
      action: 'action_resolved',
      description: `${type} ${approved ? 'approved' : 'rejected'} by ${resolvedBy}`,
      metadata: { requestId, type, approved, resolvedBy },
    }),

  // ── System Events ────────────────────────────────────────────

  /** System nuke (full reset) */
  nuke: () =>
    logEvent({
      category: 'system',
      action: 'nuke',
      description: 'System nuke: all data wiped',
    }),

  /** Database backup */
  backup: (filename: string) =>
    logEvent({
      category: 'system',
      action: 'backup',
      description: `Database backup created: ${filename}`,
      metadata: { filename },
    }),

  /** API key created */
  apiKeyCreated: (service: string, name: string) =>
    logEvent({
      category: 'system',
      action: 'apikey_created',
      description: `API key created: ${service}/${name}`,
      metadata: { service, name },
    }),

  /** API key deleted */
  apiKeyDeleted: (service: string, name: string) =>
    logEvent({
      category: 'system',
      action: 'apikey_deleted',
      description: `API key deleted: ${service}/${name}`,
      metadata: { service, name },
    }),

  /** All API keys revoked */
  apiKeysRevokedAll: (revokedCount: number) =>
    logEvent({
      category: 'system',
      action: 'apikey_revoked_all',
      description: `All API keys revoked (${revokedCount})`,
      metadata: { revokedCount },
    }),

  /** Strategy toggled */
  strategyToggled: (strategyId: string, enabled: boolean) =>
    logEvent({
      category: 'system',
      action: 'strategy_toggled',
      description: `Strategy ${strategyId} ${enabled ? 'enabled' : 'disabled'}`,
      metadata: { strategyId, enabled },
    }),

  /** Adapter configuration changed */
  adapterChanged: (action: string, type: string) =>
    logEvent({
      category: 'system',
      action: 'adapter_changed',
      description: `Adapter ${type}: ${action}`,
      metadata: { action, type },
    }),

  /** App operation */
  appOperation: (operation: string, appId: string, agentId?: string) =>
    logEvent({
      category: 'system',
      action: 'app_operation',
      description: `App ${operation}: ${appId}`,
      agentId,
      metadata: { operation, appId },
    }),

  /** Server error */
  error: (message: string, path?: string, metadata?: Record<string, unknown>) =>
    logEvent({
      category: 'system',
      action: 'error',
      description: `Error: ${message}`,
      metadata: { path, ...metadata },
    }),
};
