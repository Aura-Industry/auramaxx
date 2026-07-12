/**
 * HTTP helpers for CLI commands
 */

import { handlePermissionDenied } from './escalation';

const DEFAULT_SERVER_URL = 'http://localhost:4242';

/**
 * Get the wallet server URL from env or default
 */
export function serverUrl(): string {
  return process.env.WALLET_SERVER_URL || DEFAULT_SERVER_URL;
}

/**
 * Emit structured 403 escalation guidance and terminate the current CLI command
 * when the response maps to a human-approval contract.
 */
export async function handlePermissionDeniedAndExit(status: number, body: unknown): Promise<void> {
  if (await handlePermissionDenied(status, body)) {
    process.exit(1);
  }
}

/**
 * Fetch JSON from the wallet server
 */
export async function fetchJson<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; timeoutMs?: number } = {}
): Promise<T> {
  const url = `${serverUrl()}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) {
    headers['Authorization'] = `Bearer ${opts.token}`;
  }

  const response = await fetch(url, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: typeof opts.timeoutMs === 'number' ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });

  const data = await response.json().catch(() => ({})) as T & { error?: string };

  if (!response.ok) {
    await handlePermissionDeniedAndExit(response.status, data);
    throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
  }

  return data;
}

/**
 * Fetch the server's RSA public key for password encryption
 */
export async function fetchPublicKey(): Promise<string> {
  const data = await fetchJson<{ publicKey: string }>('/auth/connect');
  return data.publicKey;
}

/**
 * Check if the wallet server is running
 */
export async function isServerRunning(): Promise<boolean> {
  try {
    await fetchJson('/health');
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll /health until the server is up, or timeout
 */
export async function waitForServer(timeoutMs: number = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerRunning()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not start within ${timeoutMs / 1000}s`);
}

/**
 * Setup status from GET /setup
 */
export interface SetupStatus {
  hasWallet: boolean;
  unlocked: boolean;
  address: string | null;
  adapters?: { telegram: boolean; webhook: boolean };
  apiKeys?: { alchemy: boolean; anthropic: boolean };
  defaultChain?: string;
}

/**
 * Fetch setup status from the wallet server
 */
export async function fetchSetupStatus(): Promise<SetupStatus> {
  return fetchJson<SetupStatus>('/setup');
}
