/**
 * Strategy State Manager
 * ======================
 * In-memory state with persistence via REST API (AppStorage endpoints).
 * State is kept in memory for fast access, persisted on demand through
 * authenticated REST calls using the strategy's token.
 */

import { sanitizePathSegment } from '../network';

const STATE_KEY = '_strategy_state';
const CONFIG_KEY = '_strategy_config';
const BASE_URL = 'http://127.0.0.1:4242';

/** In-memory state for all active strategies */
const states = new Map<string, Record<string, unknown>>();

/** Per-strategy auth tokens for REST API calls */
const tokens = new Map<string, string>();

/** Set the auth token for a strategy */
export function setToken(id: string, token: string): void {
  tokens.set(id, token);
}

/** Clear the auth token for a strategy */
export function clearToken(id: string): void {
  tokens.delete(id);
}

/** Get state for a strategy (creates empty object if none) */
export function getState(id: string): Record<string, unknown> {
  let state = states.get(id);
  if (!state) {
    state = {};
    states.set(id, state);
  }
  return state;
}

/** Merge updates into existing state */
export function updateState(id: string, updates: Record<string, unknown>): void {
  const state = getState(id);
  Object.assign(state, updates);
}

/** Persist state to DB via REST API */
export async function persistState(strategyId: string): Promise<void> {
  const state = states.get(strategyId);
  if (!state) return;

  const token = tokens.get(strategyId);
  if (!token) {
    console.error(`[strategy:${strategyId}] persistState: no token set, skipping`);
    return;
  }

  const safeId = sanitizePathSegment(strategyId);
  const res = await fetch(`${BASE_URL}/apps/${safeId}/storage/${STATE_KEY}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ value: state }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`persistState failed (${res.status}): ${text}`);
  }
}

/** Restore state from DB via REST API into memory */
export async function restoreState(strategyId: string): Promise<void> {
  const token = tokens.get(strategyId);
  if (!token) {
    console.error(`[strategy:${strategyId}] restoreState: no token set, skipping`);
    return;
  }

  const safeId = sanitizePathSegment(strategyId);
  const res = await fetch(`${BASE_URL}/apps/${safeId}/storage/${STATE_KEY}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (res.status === 404) {
    // No stored state — initialize empty
    if (!states.has(strategyId)) {
      states.set(strategyId, {});
    }
    return;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`restoreState failed (${res.status}): ${text}`);
  }

  const body = await res.json();
  const value = body.value;

  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    states.set(strategyId, value as Record<string, unknown>);
  } else if (typeof value === 'string') {
    // Handle double-stringified values (app SDK may pre-stringify)
    try {
      const parsed = JSON.parse(value);
      states.set(strategyId, typeof parsed === 'object' && parsed !== null ? parsed : {});
    } catch {
      states.set(strategyId, {});
    }
  } else {
    states.set(strategyId, {});
  }
}

/** Read config overrides via REST API */
export async function getConfigOverrides(
  strategyId: string,
): Promise<Record<string, unknown> | null> {
  const token = tokens.get(strategyId);
  if (!token) {
    console.error(`[strategy:${strategyId}] getConfigOverrides: no token set, skipping`);
    return null;
  }

  const safeId = sanitizePathSegment(strategyId);
  const res = await fetch(`${BASE_URL}/apps/${safeId}/storage/${CONFIG_KEY}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`getConfigOverrides failed (${res.status}): ${text}`);
  }

  const body = await res.json();
  const value = body.value;

  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

/** Write config overrides via REST API */
export async function setConfigOverrides(
  strategyId: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  const token = tokens.get(strategyId);
  if (!token) {
    console.error(`[strategy:${strategyId}] setConfigOverrides: no token set, skipping`);
    return;
  }

  const safeId = sanitizePathSegment(strategyId);
  const res = await fetch(`${BASE_URL}/apps/${safeId}/storage/${CONFIG_KEY}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ value: overrides }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`setConfigOverrides failed (${res.status}): ${text}`);
  }
}

/** Persist all states (for shutdown) */
export async function persistAllStates(): Promise<void> {
  const ids = Array.from(states.keys());
  await Promise.all(ids.map((id) => persistState(id)));
}
