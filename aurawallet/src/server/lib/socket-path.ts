const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\';
const DEFAULT_SOCKET_PORT = '4242';

function parsePort(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.port) return url.port;
    if (url.protocol === 'https:') return '443';
    if (url.protocol === 'http:') return '80';
  } catch {
    // Ignore parse errors and use legacy path fallback.
  }
  return undefined;
}

export function resolveAuraSocketIdentity(uid?: number | string): number | string {
  if (uid !== undefined && uid !== null) return uid;
  return process.getuid?.() ?? 'unknown';
}

function sanitizePathSegment(value: string | number): string {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildSocketName(uid: number | string, port?: string): string {
  const safeUid = sanitizePathSegment(uid);
  if (port && port !== DEFAULT_SOCKET_PORT) {
    return `aura-cli-${safeUid}-${sanitizePathSegment(port)}`;
  }
  return `aura-cli-${safeUid}`;
}

function buildSocketPath(uid: number | string, port?: string): string {
  const name = buildSocketName(uid, port);
  if (process.platform === 'win32') {
    return `${WINDOWS_PIPE_PREFIX}${name}`;
  }
  return `/tmp/${name}.sock`;
}

export function resolveAuraSocketPath(options: {
  uid?: number | string;
  serverUrl?: string;
  serverPort?: string | number;
} = {}): string {
  const explicit = process.env.AURA_SOCKET_PATH;
  if (explicit && explicit.trim()) return explicit.trim();

  const uid = resolveAuraSocketIdentity(options.uid);
  const port =
    parsePort(options.serverPort !== undefined ? String(options.serverPort) : undefined) ||
    parsePort(options.serverUrl) ||
    parsePort(process.env.WALLET_SERVER_PORT) ||
    parsePort(process.env.WALLET_SERVER_URL);

  return buildSocketPath(uid, port);
}

export function resolveAuraSocketCandidates(options: {
  uid?: number | string;
  serverUrl?: string;
  serverPort?: string | number;
} = {}): string[] {
  const primary = resolveAuraSocketPath(options);
  if (process.platform === 'win32') {
    return [primary];
  }
  const uid = resolveAuraSocketIdentity(options.uid);
  const legacy = buildSocketPath(uid);
  if (primary === legacy) return [legacy];
  return [primary, legacy];
}
