/**
 * Shared event types for WebSocket communication between
 * Express (wallet layer) and Next.js (UI layer)
 */

// ============================================================================
// WORKSPACE EVENTS - Programmatic workspace control
// ============================================================================

export const WORKSPACE_EVENTS = {
  // Mutations (agent → UI)
  WORKSPACE_CREATED: 'workspace:created',
  WORKSPACE_DELETED: 'workspace:deleted',
  WORKSPACE_UPDATED: 'workspace:updated',
  APP_ADDED: 'app:added',
  APP_REMOVED: 'app:removed',
  APP_UPDATED: 'app:updated',

  // Queries (agent → server → agent)
  STATE_REQUEST: 'workspace:state:request',
  STATE_RESPONSE: 'workspace:state:response',

  // Persistence
  WORKSPACE_SAVE: 'workspace:save',
  WORKSPACE_LOAD: 'workspace:load',
  WORKSPACE_EXPORT: 'workspace:export',
  WORKSPACE_IMPORT: 'workspace:import',
} as const;

export type WorkspaceEventType = (typeof WORKSPACE_EVENTS)[keyof typeof WORKSPACE_EVENTS];

// Workspace event payload types
export interface WorkspaceData {
  id: string;
  name: string;
  slug: string;
  icon?: string;
  emoji?: string;
  color?: string;
  order?: number;
  isDefault?: boolean;
  isCloseable?: boolean;
}

export interface AppData {
  id?: string;
  workspaceId: string;
  appType: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zIndex?: number;
  isVisible?: boolean;
  isLocked?: boolean;
  config?: Record<string, unknown>;
}

export interface AppUpdateData {
  appId: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zIndex?: number;
  isVisible?: boolean;
  isLocked?: boolean;
  config?: Record<string, unknown>;
}

export interface WorkspaceStateRequestData {
  requestId: string;
  workspaceId?: string;
}

export interface WorkspaceStateResponseData {
  requestId: string;
  workspaces: WorkspaceData[];
  activeWorkspaceId: string;
  apps: AppData[];
}

export interface WorkspaceImportData {
  workspace: WorkspaceData;
  apps: AppData[];
}

export type WorkspaceEventData =
  | WorkspaceData
  | AppData
  | AppUpdateData
  | WorkspaceStateRequestData
  | WorkspaceStateResponseData
  | WorkspaceImportData
  | { appId: string }
  | { workspaceId: string };

export interface WorkspaceEvent<T = WorkspaceEventData> {
  type: WorkspaceEventType;
  timestamp: number;
  source: 'agent' | 'ui' | 'server';
  data: T;
}

export function createWorkspaceEvent<T extends WorkspaceEventData>(
  type: WorkspaceEventType,
  data: T,
  source: 'agent' | 'ui' | 'server' = 'ui'
): WorkspaceEvent<T> {
  return {
    type,
    timestamp: Date.now(),
    source,
    data,
  };
}

// ============================================================================
// WALLET EVENTS - Existing wallet layer events
// ============================================================================

// Event payload types
export interface TokenCreatedData {
  tokenHash: string;
  agentId: string;
  limit: number;
  permissions: string[];
  expiresAt: number;
}

export interface TokenRevokedData {
  tokenHash: string;
}

export interface TokenSpentData {
  tokenHash: string;
  amount: number;
  newSpent: number;
  remaining: number;
}

export interface WalletCreatedData {
  address: string;
  tier: 'hot' | 'temp';
  chain: string;
  name?: string;
  tokenHash?: string;
}

export interface AssetChangedData {
  walletAddress: string;
  tokenAddress: string;
  symbol?: string;
  name?: string;
  poolAddress?: string;
  poolVersion?: string;
  icon?: string;
  removed?: boolean;
}

export interface TxCreatedData {
  walletAddress: string;
  id: string;
  type: string;
  txHash?: string;
  amount?: string;
  tokenAddress?: string;
  tokenAmount?: string;
  description?: string;
}

export interface ActionCreatedData {
  id: string;
  type: string;
  source: string;
  summary: string;
  expiresAt: number | null;
  metadata?: Record<string, unknown>;
}

export interface ActionResolvedData {
  id: string;
  type: string;
  approved: boolean;
  resolvedBy: string;
}

export interface CredentialChangedData {
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
}

export interface CredentialAccessedData {
  credentialId: string;
  credentialAgentId: string;
  action: 'credentials.read' | 'credentials.totp';
  allowed: boolean;
  reasonCode: string;
  httpStatus: number;
  actorType: 'admin' | 'agent';
  actorAgentId?: string;
  tokenHash?: string;
}

export interface NotificationCreatedData {
  agentId: string;
  notificationId: string;
  category: string;
  title: string;
}

export interface BalanceUpdatedData {
  chain: string;
  type: 'native' | 'token';
  balances: { walletAddress: string; tokenAddress?: string; balance: string }[];
}

// Union of all event data types
export type WalletEventData =
  | TokenCreatedData
  | TokenRevokedData
  | TokenSpentData
  | WalletCreatedData
  | AssetChangedData
  | BalanceUpdatedData
  | TxCreatedData
  | ActionCreatedData
  | ActionResolvedData
  | CredentialChangedData
  | CredentialAccessedData
  | NotificationCreatedData;

// Event types as const for type safety
export const WALLET_EVENTS = {
  TOKEN_CREATED: 'token:created',
  TOKEN_REVOKED: 'token:revoked',
  TOKEN_SPENT: 'token:spent',
  WALLET_CREATED: 'wallet:created',
  WALLET_CHANGED: 'wallet:changed',
  ASSET_CHANGED: 'asset:changed',
  BALANCE_UPDATED: 'balance:updated',
  TX_CREATED: 'tx:created',
  ACTION_CREATED: 'action:created',
  ACTION_RESOLVED: 'action:resolved',
  CREDENTIAL_CHANGED: 'credential:changed',
  CREDENTIAL_ACCESSED: 'credential:accessed',
  SECRET_ACCESSED: 'secret:accessed',
  NOTIFICATION_CREATED: 'notification:created',
} as const;

export type WalletEventType = (typeof WALLET_EVENTS)[keyof typeof WALLET_EVENTS];

// Main event interface
export interface WalletEvent<T = WalletEventData> {
  type: WalletEventType;
  timestamp: number;
  source: 'express' | 'nextjs';
  data: T;
}

// Type-safe event creators
export function createWalletEvent<T extends WalletEventData>(
  type: WalletEventType,
  data: T,
  source: 'express' | 'nextjs' = 'nextjs'
): WalletEvent<T> {
  return {
    type,
    timestamp: Date.now(),
    source,
    data,
  };
}

// ============================================================================
// THEME EVENTS - Theme system control
// ============================================================================

export const THEME_EVENTS = {
  // Query (agent → server → agent)
  THEME_REQUEST: 'theme:request',
  THEME_RESPONSE: 'theme:response',

  // Mutations (agent/ui → server → broadcast)
  THEME_UPDATED: 'theme:updated',
  THEME_MODE_CHANGED: 'theme:mode:changed',
  THEME_ACCENT_CHANGED: 'theme:accent:changed',
  WORKSPACE_THEME_UPDATED: 'workspace:theme:updated',
} as const;

export type ThemeEventType = (typeof THEME_EVENTS)[keyof typeof THEME_EVENTS];

// Theme event payload types
export interface ThemeRequestData {
  requestId: string;
}

export interface ThemeResponseData {
  requestId: string;
  activeThemeId: string;
  accentColor: string;
  mode: 'light' | 'dark';
}

export interface ThemeModeChangedData {
  mode: 'light' | 'dark';
}

export interface ThemeAccentChangedData {
  accent: string;
}

export interface WorkspaceThemeUpdatedData {
  workspaceId: string;
  mode?: 'light' | 'dark' | null;
  accent?: string | null;
  overrides?: string | null;
}

export type ThemeEventData =
  | ThemeRequestData
  | ThemeResponseData
  | ThemeModeChangedData
  | ThemeAccentChangedData
  | WorkspaceThemeUpdatedData;

export interface ThemeEvent<T = ThemeEventData> {
  type: ThemeEventType;
  timestamp: number;
  source: 'agent' | 'ui' | 'server';
  data: T;
}

export function createThemeEvent<T extends ThemeEventData>(
  type: ThemeEventType,
  data: T,
  source: 'agent' | 'ui' | 'server' = 'ui'
): ThemeEvent<T> {
  return {
    type,
    timestamp: Date.now(),
    source,
    data,
  };
}

// ============================================================================
// APP EVENTS - Third-party app communication
// ============================================================================

export const APP_EVENTS = {
  APP_MESSAGE: 'app:message',     // app → agent (via host bridge)
  APP_RESPONSE: 'app:response',   // agent → app (via host bridge)
  APP_DATA: 'app:data',           // host → app (real-time data push)
  APP_EMIT: 'app:emit',           // strategy → app targeted event
} as const;

export type AppEventType = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];
