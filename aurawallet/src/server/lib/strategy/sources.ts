/**
 * Strategy Source Fetcher
 * =======================
 * Fetches external data sources defined in strategy manifests.
 * Handles dependency ordering, template variable substitution,
 * JSONPath-lite extraction, and auth headers.
 */

import type { SourceDef, StrategyManifest, StrategyConfig } from './types';
import { validateExternalUrl, sanitizePathSegment } from '../network';
import { getErrorMessage } from '../error';

const BASE_URL = 'http://127.0.0.1:4242';

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch all sources respecting dependency order.
 * Independent sources (no `depends`) run in parallel,
 * dependent sources run after their parent resolves.
 */
export async function fetchAllSources(
  manifest: StrategyManifest,
  config: StrategyConfig,
  configOverrides?: Record<string, unknown> | null,
  token?: string,
): Promise<Record<string, unknown[]>> {
  const mergedConfig = { ...config, ...configOverrides };
  const results: Record<string, unknown[]> = {};

  // Separate independent and dependent sources
  const independent: SourceDef[] = [];
  const dependent: SourceDef[] = [];

  for (const source of manifest.sources) {
    if (source.depends) {
      dependent.push(source);
    } else {
      independent.push(source);
    }
  }

  // Fetch all independent sources in parallel
  const independentResults = await Promise.all(
    independent.map(async (source) => {
      try {
        const data = await fetchSource(source, mergedConfig, manifest.id, undefined, token, manifest.allowedHosts);
        return { id: source.id, data };
      } catch (err) {
        if (source.optional) return { id: source.id, data: [] };
        throw err;
      }
    }),
  );

  for (const { id, data } of independentResults) {
    results[id] = data;
  }

  // Fetch dependent sources in order (sources are already topologically sorted by loader)
  for (const source of dependent) {
    const parentData = source.depends ? results[source.depends] : undefined;
    try {
      const data = await fetchSource(source, mergedConfig, manifest.id, parentData, token, manifest.allowedHosts);
      results[source.id] = data;
    } catch (err) {
      if (source.optional) {
        results[source.id] = [];
        continue;
      }
      throw err;
    }
  }

  return results;
}

/** Fetch a single source with timeout */
async function fetchSource(
  source: SourceDef,
  config: StrategyConfig,
  appId: string,
  parentData?: unknown[],
  token?: string,
  allowedHosts?: string[],
): Promise<unknown[]> {
  const rawUrl = resolveUrl(source.url, config, parentData);
  const isInternal = rawUrl.startsWith('/');
  let url = isInternal ? BASE_URL + rawUrl : rawUrl;

  // SSRF protection: validate external URLs against private IPs and allowedHosts
  if (!isInternal) {
    await validateExternalUrl(url, allowedHosts);
  }

  const headers = await getAuthHeaders(source, appId, token);
  // Internal endpoints get the strategy token automatically
  if (isInternal && token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const hasAuth = Object.keys(headers).length > 0;

  console.log(`[strategy:${appId}]     fetch ${source.id}: ${source.method} ${url}${hasAuth ? ' (auth)' : ''}`);
  const fetchStart = Date.now();

  try {
    const options: RequestInit = {
      method: source.method,
      headers,
      signal: controller.signal,
      ...(!isInternal ? { redirect: 'error' as const } : {}),
    };

    if (source.method === 'POST' && source.body) {
      (options.headers as Record<string, string>)['Content-Type'] = 'application/json';
      options.body = JSON.stringify(source.body);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`Source "${source.id}" returned ${response.status}`);
    }

    const data = await response.json();
    const fetchMs = Date.now() - fetchStart;

    let result: unknown[];
    if (source.select) {
      result = applySelect(data, source.select);
    } else {
      result = Array.isArray(data) ? data : [data];
    }

    console.log(`[strategy:${appId}]     fetch ${source.id}: ${fetchMs}ms → ${result.length} item(s)`);
    return result;
  } catch (err) {
    const fetchMs = Date.now() - fetchStart;
    const errMsg = getErrorMessage(err);
    console.error(`[strategy:${appId}]     fetch ${source.id}: FAILED in ${fetchMs}ms — ${errMsg}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Template variable substitution on URL.
 * Replaces ${config.x} with config values.
 * Replaces ${key} with config values or comma-joined parent data values.
 */
export function resolveUrl(
  url: string,
  config: StrategyConfig,
  parentData?: unknown[],
): string {
  return url.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    // ${config.x} — explicit config reference
    if (expr.startsWith('config.')) {
      const key = expr.slice('config.'.length);
      const val = config[key];
      return val != null ? String(val) : '';
    }

    // Try config first
    if (config[expr] != null) {
      return String(config[expr]);
    }

    // Try extracting values from parent data
    if (parentData && parentData.length > 0) {
      const values = parentData
        .map((item) => {
          if (item != null && typeof item === 'object') {
            return (item as Record<string, unknown>)[expr];
          }
          return undefined;
        })
        .filter((v) => v != null);

      if (values.length > 0) {
        return values.join(',');
      }
    }

    return '';
  });
}

/**
 * JSONPath-lite extraction.
 * `select.items` defines where the array is (e.g., `$.data`).
 * Other keys extract fields from each item.
 */
export function applySelect(
  data: unknown,
  select: Record<string, string>,
): unknown[] {
  const itemsPath = select.items;
  const items = itemsPath ? resolvePath(data, itemsPath) : data;

  if (!Array.isArray(items)) {
    return items != null ? [items] : [];
  }

  // If there are no field selectors beyond `items`, return raw items
  const fieldKeys = Object.keys(select).filter((k) => k !== 'items');
  if (fieldKeys.length === 0) return items;

  // Extract specified fields from each item
  return items.map((item) => {
    const result: Record<string, unknown> = {};
    for (const key of fieldKeys) {
      result[key] = resolvePath(item, select[key]);
    }
    return result;
  });
}

/**
 * Simple path navigation: $.field.nested or $.array.0.field
 * `$` alone returns root.
 */
export function resolvePath(obj: unknown, path: string): unknown {
  if (path === '$') return obj;

  const parts = path.replace(/^\$\.?/, '').split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;

    // Numeric index for arrays
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[parseInt(part, 10)];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}

/**
 * Get auth headers for a source.
 * Reads API key from AppStorage by source.key.
 * Returns headers based on source.auth type.
 */
export async function getAuthHeaders(
  source: SourceDef,
  appId: string,
  token?: string,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};

  if (!source.auth || source.auth === 'none' || !source.key) {
    return headers;
  }

  let apiKey = '';

  if (token) {
    try {
      const safeAppId = sanitizePathSegment(appId);
      const res = await fetch(`${BASE_URL}/apps/${safeAppId}/apikey/${source.key}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const body = await res.json();
        apiKey = body.value ?? '';
      }
    } catch (err) {
      console.warn(`[strategy:${appId}] failed to fetch API key for source ${source.key}:`, getErrorMessage(err));
    }
  }

  if (source.auth === 'bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (source.auth === 'header') {
    const headerName = source.header || 'X-API-Key';
    headers[headerName] = apiKey;
  }
  // 'query' auth is handled via URL params, not headers

  return headers;
}
