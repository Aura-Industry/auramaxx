/**
 * Unified API client for calling both Express and Next.js backends
 *
 * Usage:
 *   import { api, Api, unlockWallet, setupWallet } from '@/lib/api';
 *
 *   // Wallet operations (Express :4242)
 *   const wallets = await api.get(Api.Wallet, '/wallets');
 *   await api.post(Api.Wallet, '/wallet/rename', { address, name });
 *
 *   // Encrypted unlock/setup (password encrypted with server's RSA key)
 *   const result = await unlockWallet(password);
 *   const result = await setupWallet(password);
 *
 *   // Workspace operations (Next.js :4747)
 *   const workspaces = await api.get(Api.Workspace, '/workspace');
 *
 */

import { encryptPassword, getTokenMintPubkey } from './crypto';

// Derive ports from dashboard port at runtime (no env var coordination needed)
// Convention: wallet = dashboard - 505, WS = dashboard + 1
// Default: 4747 → wallet 4242, WS 4748
// Sandbox: 5747 → wallet 5242, WS 5748
const IS_LOCAL = typeof window !== 'undefined'
  && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

const DASHBOARD_PORT_NUM = typeof window !== 'undefined'
  ? parseInt(window.location.port || '4747', 10)
  : parseInt(process.env.DASHBOARD_PORT || '4747', 10);

// When accessed via tunnel (non-localhost), use sibling subdomains over HTTPS
// e.g. wallet.auramaxx.xyz → wallet-api.auramaxx.xyz for Express
const EXPRESS_URL = typeof window !== 'undefined'
  ? IS_LOCAL
    ? `http://${window.location.hostname}:${DASHBOARD_PORT_NUM - 505}`
    : `https://wallet-api.${window.location.hostname.split('.').slice(1).join('.')}`
  : `http://localhost:${DASHBOARD_PORT_NUM - 505}`;

const NEXTJS_URL = typeof window !== 'undefined'
  ? IS_LOCAL
    ? `http://${window.location.hostname}:${DASHBOARD_PORT_NUM}`
    : `${window.location.protocol}//${window.location.host}`
  : `http://localhost:${DASHBOARD_PORT_NUM}`;

/**
 * API target enum - determines which backend to call
 */
export enum Api {
  /** Express :4242 - wallet operations, auth, agents, transactions */
  Wallet = 'wallet',
  /** Next.js :4747/api - workspace CRUD */
  Workspace = 'workspace',
  /** Next.js :4747/api - event logs from database */
  Events = 'events',
  /** Next.js :4747/api - agent dashboard (requests + tokens) */
  AgentDashboard = 'agentDashboard',
}

const API_CONFIG: Record<Api, { baseUrl: string; pathPrefix: string }> = {
  [Api.Wallet]: { baseUrl: EXPRESS_URL, pathPrefix: '' },
  [Api.Workspace]: { baseUrl: NEXTJS_URL, pathPrefix: '/api' },
  [Api.Events]: { baseUrl: NEXTJS_URL, pathPrefix: '/api' },
  [Api.AgentDashboard]: { baseUrl: NEXTJS_URL, pathPrefix: '/api' },
};

const TOKEN_STORAGE_KEY = 'auramaxx_admin_token';

/**
 * Get auth token from browser storage (local preferred over session)
 */
function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  const localToken = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (localToken) return localToken;
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

/**
 * Make an authenticated request to the specified backend
 */
async function request<T>(
  target: Api,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const config = API_CONFIG[target];

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const url = `${config.baseUrl}${config.pathPrefix}${path}`;

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({ error: res.statusText }));

  if (!res.ok) {
    const error = new Error(data.error || `Request failed: ${res.status}`);
    (error as Error & { status: number }).status = res.status;
    throw error;
  }

  return data as T;
}

/**
 * API client with typed methods
 */
/** Get the base URL for the wallet (Express) API */
export function getWalletBaseUrl(): string {
  return EXPRESS_URL;
}

export const api = {
  /**
   * GET request
   */
  get: <T>(target: Api, path: string, params?: Record<string, string | number | boolean>, options?: RequestInit) => {
    let url = path;
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          searchParams.set(key, String(value));
        }
      }
      const queryString = searchParams.toString();
      if (queryString) {
        url = `${path}?${queryString}`;
      }
    }
    return request<T>(target, url, { method: 'GET', ...options });
  },

  /**
   * POST request
   */
  post: <T>(target: Api, path: string, body?: unknown) =>
    request<T>(target, path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    }),

  /**
   * PUT request
   */
  put: <T>(target: Api, path: string, body?: unknown) =>
    request<T>(target, path, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    }),

  /**
   * PATCH request
   */
  patch: <T>(target: Api, path: string, body?: unknown) =>
    request<T>(target, path, {
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    }),

  /**
   * DELETE request
   */
  delete: <T>(target: Api, path: string) =>
    request<T>(target, path, { method: 'DELETE' }),

  /**
   * Get the base URL for a target (useful for debugging)
   */
  getBaseUrl: (target: Api = Api.Wallet) => {
    const config = API_CONFIG[target];
    return `${config.baseUrl}${config.pathPrefix}`;
  },
};

// Type definitions for common API responses
export interface WalletData {
  address: string;
  tier: 'cold' | 'hot' | 'temp';
  chain: string;
  balance?: string;
  name?: string;
  color?: string;
  emoji?: string;
  description?: string;
  hidden?: boolean;
  tokenHash?: string;
  createdAt?: string;
}

export interface WalletsResponse {
  wallets: WalletData[];
  unlocked: boolean;
  agent?: { id: string; remaining: number };
}

export interface TrackedAsset {
  id: string;
  walletAddress: string;
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  lastBalance: string | null;
  lastBalanceAt: string | null;
  isHidden: boolean;
  chain: string;
  poolAddress: string | null;
  poolVersion: string | null;
  icon: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetsResponse {
  success: boolean;
  assets: TrackedAsset[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface Transaction {
  id: string;
  walletAddress: string;
  txHash: string | null;
  type: string;
  status: string;
  amount: string | null;
  tokenAddress: string | null;
  tokenAmount: string | null;
  from: string | null;
  to: string | null;
  description: string | null;
  blockNumber: number | null;
  chain: string;
  createdAt: string;
  updatedAt: string;
  executedAt: string | null;
}

export interface TransactionsResponse {
  success: boolean;
  transactions: Transaction[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface DashboardResponse {
  success: boolean;
  requests: Array<{
    id: string;
    type: string;
    status: string;
    createdAt: string;
    metadata?: string;
    chain: string;
    amount?: string;
  }>;
  tokens: {
    active: Array<{
      tokenHash: string;
      agentId: string;
      limit: number;
      spent: number;
      remaining: number;
      permissions: string[];
      expiresAt: number;
      isActive: boolean;
      isRevoked: boolean;
      isExpired: boolean;
    }>;
    inactive: Array<{
      tokenHash: string;
      agentId: string;
      limit: number;
      spent: number;
      remaining: number;
      permissions: string[];
      expiresAt: number;
      isActive: boolean;
      isRevoked: boolean;
      isExpired: boolean;
    }>;
  };
  counts: {
    pendingActions: number;
    activeTokens: number;
    inactiveTokens: number;
  };
}

// ============================================================================
// Encrypted Password Transport
// ============================================================================

// Cached server public key (cleared on failed decryption to force refetch)
let serverPublicKey: string | null = null;

/**
 * Fetch the server's public key for encrypting passwords
 * Key is cached until server restart (which invalidates it)
 */
async function getServerPublicKey(): Promise<string> {
  if (!serverPublicKey) {
    const res = await api.get<{ publicKey: string }>(Api.Wallet, '/auth/connect');
    serverPublicKey = res.publicKey;
  }
  return serverPublicKey;
}

/**
 * Clear cached public key (call on decryption failure to force refetch)
 */
export function clearServerPublicKey(): void {
  serverPublicKey = null;
}

export interface UnlockResponse {
  success: boolean;
  message?: string;
  address?: string;
  token?: string;
  error?: string;
}

export interface SetupResponse {
  success: boolean;
  address?: string;
  mnemonic?: string;
  token?: string;
  message?: string;
  error?: string;
}

export interface ChangePrimaryPasswordResponse {
  success: boolean;
  message?: string;
}

export interface RecoverWalletResponse {
  success: boolean;
  message?: string;
  address?: string;
  token?: string;
}

/**
 * Unlock the wallet with encrypted password transport
 * @param password - Plaintext password (will be encrypted before sending)
 * @param agentId - Optional agent ID (defaults to primary agent)
 * @returns Unlock response with optional admin token
 */
export async function unlockWallet(password: string, agentId?: string, pubkey?: string): Promise<UnlockResponse> {
  const publicKey = await getServerPublicKey();
  const encrypted = await encryptPassword(password, publicKey);
  const tokenPubkey = pubkey ?? await getTokenMintPubkey();
  const path = agentId ? `/unlock/${agentId}` : '/unlock';

  try {
    return await api.post<UnlockResponse>(Api.Wallet, path, { encrypted, pubkey: tokenPubkey });
  } catch (err) {
    // If decryption failed on server, clear cached key and retry once
    const error = err as Error & { status?: number };
    if (error.message?.includes('decrypt') || error.message?.includes('refetch')) {
      clearServerPublicKey();
      const newKey = await getServerPublicKey();
      const newEncrypted = await encryptPassword(password, newKey);
      return await api.post<UnlockResponse>(Api.Wallet, path, { encrypted: newEncrypted, pubkey: tokenPubkey });
    }
    throw err;
  }
}

/**
 * Set up a new cold wallet with encrypted password transport
 * @param password - Plaintext password (will be encrypted before sending)
 * @returns Setup response with mnemonic
 */
export async function setupWallet(password: string, pubkey?: string): Promise<SetupResponse> {
  const publicKey = await getServerPublicKey();
  const encrypted = await encryptPassword(password, publicKey);
  const tokenPubkey = pubkey ?? await getTokenMintPubkey();

  try {
    return await api.post<SetupResponse>(Api.Wallet, '/setup', { encrypted, pubkey: tokenPubkey });
  } catch (err) {
    // If decryption failed on server, clear cached key and retry once
    const error = err as Error & { status?: number };
    if (error.message?.includes('decrypt') || error.message?.includes('refetch')) {
      clearServerPublicKey();
      const newKey = await getServerPublicKey();
      const newEncrypted = await encryptPassword(password, newKey);
      return await api.post<SetupResponse>(Api.Wallet, '/setup', { encrypted: newEncrypted, pubkey: tokenPubkey });
    }
    throw err;
  }
}

/**
 * Change the primary agent password with encrypted password transport.
 */
export async function changePrimaryAgentPassword(
  currentPassword: string,
  newPassword: string,
): Promise<ChangePrimaryPasswordResponse> {
  const publicKey = await getServerPublicKey();
  const currentEncrypted = await encryptPassword(currentPassword, publicKey);
  const newEncrypted = await encryptPassword(newPassword, publicKey);

  try {
    return await api.post<ChangePrimaryPasswordResponse>(Api.Wallet, '/setup/password', {
      currentEncrypted,
      newEncrypted,
    });
  } catch (err) {
    const error = err as Error & { status?: number };
    if (error.message?.includes('decrypt') || error.message?.includes('refetch')) {
      clearServerPublicKey();
      const newKey = await getServerPublicKey();
      const retryCurrentEncrypted = await encryptPassword(currentPassword, newKey);
      const retryNewEncrypted = await encryptPassword(newPassword, newKey);
      return await api.post<ChangePrimaryPasswordResponse>(Api.Wallet, '/setup/password', {
        currentEncrypted: retryCurrentEncrypted,
        newEncrypted: retryNewEncrypted,
      });
    }
    throw err;
  }
}

/**
 * Re-key session with a new RSA public key (no password required).
 * Used after page refresh when token survives but keypair is lost.
 */
export async function rekeySession(pubkey: string): Promise<{ success: boolean; token: string }> {
  return api.post<{ success: boolean; token: string }>(Api.Wallet, '/unlock/rekey', { pubkey });
}

/**
 * Recover primary agent access using seed phrase and set a new password.
 */
export async function recoverWalletAccess(
  mnemonic: string,
  newPassword: string,
  pubkey?: string,
): Promise<RecoverWalletResponse> {
  const tokenPubkey = pubkey ?? await getTokenMintPubkey();
  return api.post<RecoverWalletResponse>(Api.Wallet, '/unlock/recover', {
    mnemonic,
    newPassword,
    pubkey: tokenPubkey,
  });
}
