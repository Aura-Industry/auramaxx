/**
 * Strategy Action Executor
 * ========================
 * Executes actions produced by hook intents. Supports internal wallet API
 * calls and external HTTP endpoints, with paper trading mode.
 */

import { createToken } from '../auth';
import { revokeToken } from '../sessions';
import { validateExternalUrl } from '../network';
import { Action, ActionOutcome } from './types';
import { getErrorMessage } from '../error';

/**
 * Execute a single action, either internally against the wallet server
 * or externally against a third-party API.
 */
export async function executeAction(
  action: Action,
  strategyId: string,
  token?: string,
  allowedHosts?: string[],
): Promise<ActionOutcome> {
  const timeout = AbortSignal.timeout(30_000);

  try {
    let url: string;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...action.headers,
    };

    if (action.endpoint.startsWith('/')) {
      // Internal call to wallet server
      url = `http://127.0.0.1:4242${action.endpoint}`;
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      console.log(`[strategy:${strategyId}] exec: ${action.method} ${url} (internal${token ? ', auth' : ', no-auth'})`);
    } else if (action.endpoint.startsWith('http')) {
      // External call — validate against SSRF and allowedHosts
      url = action.endpoint;
      try {
        await validateExternalUrl(url, allowedHosts);
      } catch (err) {
        const msg = getErrorMessage(err);
        console.error(`[strategy:${strategyId}] exec: BLOCKED — ${msg}`);
        return { success: false, error: msg };
      }
      console.log(`[strategy:${strategyId}] exec: ${action.method} ${url} (external)`);
    } else {
      console.error(`[strategy:${strategyId}] exec: invalid endpoint "${action.endpoint}"`);
      return { success: false, error: `Invalid endpoint: ${action.endpoint}` };
    }

    const isExternal = !action.endpoint.startsWith('/');
    const execStart = Date.now();
    const res = await fetch(url, {
      method: action.method,
      headers,
      body: action.body ? JSON.stringify(action.body) : undefined,
      signal: timeout,
      ...(isExternal ? { redirect: 'error' as const } : {}),
    });

    const data = await res.json().catch(() => null);
    const execMs = Date.now() - execStart;

    if (res.status === 401 && action.endpoint.startsWith('/')) {
      console.error(`[strategy:${strategyId}] exec: 401 AUTH FAILURE in ${execMs}ms — token likely expired`);
      throw new Error('AUTH_FAILURE: Internal endpoint returned 401 (token expired or SIGNING_KEY rotated)');
    }

    if (!res.ok) {
      console.error(`[strategy:${strategyId}] exec: ${res.status} in ${execMs}ms — ${data?.error || res.statusText}`);
      return {
        success: false,
        error: `HTTP ${res.status}: ${data?.error || res.statusText}`,
        data,
      };
    }

    console.log(`[strategy:${strategyId}] exec: ${res.status} OK in ${execMs}ms`);
    return { success: true, data };
  } catch (err: unknown) {
    const message = getErrorMessage(err);
    console.error(`[strategy:${strategyId}] exec: threw — ${message}`);
    // Re-throw auth failures so they propagate to tickStrategy's catch block
    if (message.includes('AUTH_FAILURE')) throw err;
    return { success: false, error: message };
  }
}

/**
 * Create a scoped token for a strategy to use when calling internal endpoints.
 * Token is valid for 24 hours and carries the strategy's declared permissions.
 */
export async function createStrategyToken(
  strategyId: string,
  permissions: string[]
): Promise<string> {
  return createToken(
    `strategy:${strategyId}`,
    0,
    permissions,
    86400 // 24h
  );
}

/**
 * Revoke a strategy's token by its hash.
 */
export async function revokeStrategyToken(tokenHash: string): Promise<boolean> {
  return revokeToken(tokenHash);
}
