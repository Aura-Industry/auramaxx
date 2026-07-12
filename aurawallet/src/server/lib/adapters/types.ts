/**
 * Core interfaces for the approval adapter system.
 *
 * Adapters receive action notifications and relay human decisions
 * back to the wallet server via POST /actions/:id/resolve.
 */

import type { VerifiedSummary } from '../verified-summary';

/** Notification sent to adapters when an action is created */
export interface ActionNotification {
  id: string;
  type: string;
  source: string;
  summary: string;
  expiresAt: number | null;
  metadata?: Record<string, unknown>;
  verifiedSummary?: VerifiedSummary;
}

/** Resolution sent to adapters when an action is resolved (by any channel) */
export interface ActionResolution {
  id: string;
  type: string;
  approved: boolean;
  resolvedBy: string;
}

/** Incoming chat message from an adapter */
export interface ChatMessage {
  /** Raw text from the user */
  text: string;
  /** Adapter-specific sender ID (Telegram chat ID, etc.) */
  senderId: string;
  /** Optional: explicit app target (e.g., "/app-name" prefix) */
  targetApp?: string;
}

/** Reply from the AI engine to an adapter chat message */
export interface ChatReply {
  text: string;
  /** Optional metadata for rich formatting */
  metadata?: Record<string, unknown>;
}

/** Options passed when resolving an action */
export interface ResolveOptions {
  walletAccess?: string[];
  limits?: { fund?: number; send?: number; swap?: number };
}

/** Result of a resolve call */
export interface ResolveResult {
  success: boolean;
  error?: string;
  token?: string;
  agentId?: string;
}

/** Context provided to adapters on start */
export interface AdapterContext {
  /** Resolve an action by ID */
  resolve(actionId: string, approved: boolean, opts?: ResolveOptions): Promise<ResolveResult>;
  /** Base URL of the wallet server */
  serverUrl: string;
  /** Route a chat message to a app's AI */
  sendMessage(appId: string, text: string, onProgress?: (status: string) => void, adapter?: string): Promise<{ reply: string | null; error?: string }>;
  /** Resolve which app should handle a message */
  resolveApp(targetApp?: string): Promise<string | null>;
}

/** Approval adapter interface — implement this for new channels */
export interface ApprovalAdapter {
  /** Unique name for this adapter instance */
  name: string;
  /** Start the adapter (called once with context) */
  start(ctx: AdapterContext): Promise<void>;
  /** Called when an action is created and needs human review */
  notify(action: ActionNotification): Promise<void>;
  /** Called when an action is resolved (so adapter can clean up UI) */
  resolved(resolution: ActionResolution): Promise<void>;
  /** Stop the adapter and clean up resources */
  stop(): Promise<void>;
  /** Optional: handle incoming chat messages (adapters that support chat) */
  onMessage?(message: ChatMessage): Promise<ChatReply | null>;
}

/** Factory function type for creating adapters */
export type AdapterFactory = (config: Record<string, unknown>) => ApprovalAdapter;
