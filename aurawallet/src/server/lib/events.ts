/**
 * Webhook emitter for notifying Next.js of wallet events
 * Posts events to Next.js API which broadcasts to WebSocket clients
 * Also stores all events in database for debugging/audit trail
 */

import { prisma } from './db';
import { log } from './pino';
import { redactSensitiveData } from './redaction';

// Event types (mirrored from src/lib/events.ts)
export const WALLET_EVENTS = {
  TOKEN_CREATED: 'token:created',
  TOKEN_REVOKED: 'token:revoked',
  TOKEN_SPENT: 'token:spent',
  WALLET_CREATED: 'wallet:created',
  WALLET_CHANGED: 'wallet:changed',
  ASSET_CHANGED: 'asset:changed',
  TX_CREATED: 'tx:created',
  ACTION_CREATED: 'action:created',
  ACTION_RESOLVED: 'action:resolved',
  AGENT_UNLOCKED: 'agent:unlocked',
  CREDENTIAL_CHANGED: 'credential:changed',
  CREDENTIAL_ACCESSED: 'credential:accessed',
  SECRET_ACCESSED: 'secret:accessed',
} as const;

export type WalletEventType = (typeof WALLET_EVENTS)[keyof typeof WALLET_EVENTS];

interface WalletEvent<T = unknown> {
  type: WalletEventType | string;
  timestamp: number;
  source: 'express' | 'nextjs';
  data: T;
}

// WebSocket server broadcast endpoint (runs on port 4748)
const WS_BROADCAST_URL = process.env.WS_BROADCAST_URL ?? 'http://localhost:4748/broadcast';

/**
 * Store event in database (non-blocking)
 * Automatically stores all events for debugging and audit purposes
 */
function storeEvent<T>(event: WalletEvent<T>): void {
  const sanitizedData = redactSensitiveData(event.data);
  prisma.event.create({
    data: {
      type: event.type,
      source: event.source,
      data: JSON.stringify(sanitizedData),
      timestamp: new Date(event.timestamp),
    },
  })
    .then(() => {
      // Stored successfully
    })
    .catch((err) => {
      log.error({ err: err.message }, 'failed to store event in DB');
    });
}

/**
 * Emit a wallet event to Next.js webhook
 * Non-blocking - failures are logged but don't affect the calling code
 * Events are automatically stored in the database
 */
export function emitWalletEvent<T>(type: WalletEventType | string, data: T): void {
  const sanitizedData = redactSensitiveData(data) as T;
  const event: WalletEvent<T> = {
    type,
    timestamp: Date.now(),
    source: 'express',
    data: sanitizedData,
  };

  // Store in database (non-blocking)
  storeEvent(event);

  // Fire and forget broadcast to WebSocket server - don't block the request
  // Skip when WS_BROADCAST_URL is empty (e.g. in tests)
  if (!WS_BROADCAST_URL) return;

  fetch(WS_BROADCAST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })
    .then((res) => {
      if (!res.ok) {
        log.warn({ status: res.status, type }, 'WebSocket broadcast failed');
      }
    })
    .catch((err) => {
      // Log but don't throw - this is non-critical
      log.warn({ err: err.message, type }, 'failed to broadcast to WebSocket');
    });
}

// Type-safe event emitters for each event type
export const events = {
  tokenCreated: (data: {
    tokenHash: string;
    agentId: string;
    limit: number;
    permissions: string[];
    expiresAt: number;
  }) => emitWalletEvent(WALLET_EVENTS.TOKEN_CREATED, data),

  tokenRevoked: (data: { tokenHash: string }) =>
    emitWalletEvent(WALLET_EVENTS.TOKEN_REVOKED, data),

  tokenSpent: (data: {
    tokenHash: string;
    amount: number;
    newSpent: number;
    remaining: number;
    limitType?: 'fund' | 'send' | 'swap';
  }) => emitWalletEvent(WALLET_EVENTS.TOKEN_SPENT, data),

  walletCreated: (data: {
    address: string;
    tier: 'hot' | 'temp';
    chain: string;
    name?: string;
    tokenHash?: string;
  }) => emitWalletEvent(WALLET_EVENTS.WALLET_CREATED, data),

  walletChanged: (data: {
    address: string;
    reason: 'created' | 'updated';
  }) => emitWalletEvent(WALLET_EVENTS.WALLET_CHANGED, data),

  assetChanged: (data: {
    walletAddress: string;
    tokenAddress: string;
    symbol?: string;
    name?: string;
    poolAddress?: string;
    poolVersion?: string;
    icon?: string;
    removed?: boolean;
  }) => emitWalletEvent(WALLET_EVENTS.ASSET_CHANGED, data),

  txCreated: (data: {
    walletAddress: string;
    id: string;
    type: string;
    txHash?: string;
    amount?: string;
    tokenAddress?: string;
    tokenAmount?: string;
    description?: string;
  }) => emitWalletEvent(WALLET_EVENTS.TX_CREATED, data),

  actionCreated: (data: {
    id: string;
    type: string;
    source: string;
    summary: string;
    expiresAt: number | null;
    metadata?: Record<string, unknown>;
  }) => emitWalletEvent(WALLET_EVENTS.ACTION_CREATED, data),

  actionResolved: (data: {
    id: string;
    type: string;
    approved: boolean;
    resolvedBy: string;
  }) => emitWalletEvent(WALLET_EVENTS.ACTION_RESOLVED, data),

  agentUnlocked: (data: { address: string; agentId: string }) =>
    emitWalletEvent(WALLET_EVENTS.AGENT_UNLOCKED, data),

  credentialChanged: (data: {
    credentialId: string;
    credentialAgentId: string;
    change:
      | 'created'
      | 'updated'
      | 'archived'
      | 'moved_to_recently_deleted'
      | 'restored_to_active'
      | 'restored_to_archive'
      | 'purged'
      | 'duplicated';
    actorType: 'admin' | 'agent';
    actorAgentId?: string;
    tokenHash?: string;
    fromLocation?: 'active' | 'archive' | 'recently_deleted';
    toLocation?: 'active' | 'archive' | 'recently_deleted';
  }) => emitWalletEvent(WALLET_EVENTS.CREDENTIAL_CHANGED, data),

  credentialAccessed: (data: {
    credentialId: string;
    credentialAgentId: string;
    action: 'credentials.read' | 'credentials.totp';
    allowed: boolean;
    reasonCode: string;
    httpStatus: number;
    actorType: 'admin' | 'agent';
    actorAgentId?: string;
    tokenHash?: string;
  }) => emitWalletEvent(WALLET_EVENTS.CREDENTIAL_ACCESSED, data),

  secretAccessed: (data: {
    credentialId: string;
    credentialName: string;
    credentialAgentId: string;
    surface: 'inject_secret' | 'get_secret';
    envVar?: string;
    actorAgentId?: string;
    tokenHash?: string;
  }) => emitWalletEvent(WALLET_EVENTS.SECRET_ACCESSED, data),

  /**
   * Generic event emitter for custom/new event types
   * Events are automatically stored in the database
   */
  custom: <T>(type: string, data: T) => emitWalletEvent(type, data),
};
