/**
 * Shared redaction helpers for logs/events/tool output.
 */

const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_RE = /(secret|password|passphrase|token(?!\s*hash\b)|api[_-]?key|private[_-]?key|mnemonic|seed|authorization|cookie)/i;
const SAFE_TOKEN_KEY_RE = /(tokenhash|hashed|hash)$/i;

function isSensitiveKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (!normalized) return false;
  if (SAFE_TOKEN_KEY_RE.test(normalized)) return false;
  return SENSITIVE_KEY_RE.test(normalized);
}

function redactQueryParams(url: URL): URL {
  for (const key of Array.from(url.searchParams.keys())) {
    if (isSensitiveKey(key)) {
      url.searchParams.set(key, REDACTED);
    }
  }
  return url;
}

/**
 * Redact sensitive query-string values in absolute URLs or relative request paths.
 */
export function redactUrlQuery(raw: string): string {
  if (!raw || typeof raw !== 'string') return raw;
  if (!raw.includes('?')) return raw;

  try {
    const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    const parsed = new URL(raw, 'http://localhost');
    redactQueryParams(parsed);
    if (isAbsolute) {
      return parsed.toString();
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    const [base, queryAndHash] = raw.split('?', 2);
    if (!queryAndHash) return raw;
    const [query, hash = ''] = queryAndHash.split('#', 2);
    const params = new URLSearchParams(query);
    for (const key of Array.from(params.keys())) {
      if (isSensitiveKey(key)) {
        params.set(key, REDACTED);
      }
    }
    const nextQuery = params.toString();
    return `${base}${nextQuery ? `?${nextQuery}` : ''}${hash ? `#${hash}` : ''}`;
  }
}

function redactStringValue(value: string): string {
  if (!value) return value;
  return value.includes('?') ? redactUrlQuery(value) : value;
}

/**
 * Recursively redact secret-shaped keys from arbitrary payloads.
 */
export function redactSensitiveData(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 8) return '[TRUNCATED]';

  if (typeof value === 'string') {
    return redactStringValue(value);
  }
  if (typeof value !== 'object') {
    return value;
  }

  const tracking = seen || new WeakSet<object>();
  if (tracking.has(value as object)) {
    return '[CIRCULAR]';
  }
  tracking.add(value as object);

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveData(entry, depth + 1, tracking));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactSensitiveData(entry, depth + 1, tracking);
  }
  return out;
}

/**
 * Parse + redact JSON object strings; fallback to URL redaction on plain strings.
 */
export function redactJsonString(raw: string): string {
  if (!raw || typeof raw !== 'string') return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return JSON.stringify(redactSensitiveData(parsed));
  } catch {
    return redactUrlQuery(raw);
  }
}

