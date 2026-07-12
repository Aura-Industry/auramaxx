import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'crypto';
import * as net from 'net';
import { buildClaimHeaders, buildPollUrl } from './approval-flow';
import { getDefault, SEED_DEFAULTS } from './defaults';
import { resolveAuraSocketCandidates } from './socket-path';

interface HybridEnvelope {
  v: 1;
  alg: 'RSA-OAEP/AES-256-GCM';
  key: string;
  iv: string;
  tag: string;
  data: string;
}

const OAEP_HASH = 'sha256';

function parseAgentPubkey(pubkey: string): KeyObject {
  const value = pubkey.trim();
  if (!value) {
    throw new Error('Public key is required');
  }

  // PEM directly
  if (value.includes('BEGIN PUBLIC KEY')) {
    return createPublicKey(value);
  }

  // Base64(PEM) or DER/SPKI
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0) {
    throw new Error('Invalid public key encoding');
  }

  const decodedText = decoded.toString('utf8');
  if (decodedText.includes('BEGIN PUBLIC KEY')) {
    return createPublicKey(decodedText);
  }

  return createPublicKey({
    key: decoded,
    format: 'der',
    type: 'spki',
  });
}

function rsaEncrypt(data: Buffer, key: KeyObject): Buffer {
  return publicEncrypt(
    {
      key,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: OAEP_HASH,
    },
    data,
  );
}

export function isValidAgentPubkey(pubkey: string): boolean {
  try {
    const key = parseAgentPubkey(pubkey);
    return key.asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

export function normalizeAgentPubkey(pubkey: string): string {
  const key = parseAgentPubkey(pubkey);
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

/**
 * Encrypt credential data to an agent's RSA-OAEP public key.
 *
 * Always uses hybrid RSA-OAEP + AES-256-GCM envelope so that clients
 * only need a single decryption code path.
 */
export function encryptToAgentPubkey(data: string, pubkeyBase64: string): string {
  const key = parseAgentPubkey(pubkeyBase64);
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error('Public key must be RSA');
  }

  const payload = Buffer.from(data, 'utf8');

  // Always hybrid RSA + AES-GCM
  const sessionKey = randomBytes(32); // AES-256
  const iv = randomBytes(12); // GCM nonce
  const cipher = createCipheriv('aes-256-gcm', sessionKey, iv);
  const encryptedData = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedKey = rsaEncrypt(sessionKey, key);

  const envelope: HybridEnvelope = {
    v: 1,
    alg: 'RSA-OAEP/AES-256-GCM',
    key: wrappedKey.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encryptedData.toString('base64'),
  };

  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

// ── Client-side decryption ──

/**
 * Decrypt a hybrid RSA-OAEP/AES-256-GCM envelope (or raw RSA ciphertext).
 * Used by CLI tools to decrypt credentials returned from the server.
 */
export function decryptWithPrivateKey(encryptedBase64: string, privateKeyPem: string): string {
  const decoded = Buffer.from(encryptedBase64, 'base64');
  let envelope: HybridEnvelope;
  try {
    envelope = JSON.parse(decoded.toString('utf8')) as HybridEnvelope;
  } catch {
    return privateDecrypt(
      { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: OAEP_HASH },
      decoded,
    ).toString('utf8');
  }

  if (envelope.v !== 1 || envelope.alg !== 'RSA-OAEP/AES-256-GCM') {
    throw new Error(`Unexpected envelope: v=${envelope.v} alg=${envelope.alg}`);
  }

  const sessionKey = privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: OAEP_HASH },
    Buffer.from(envelope.key, 'base64'),
  );
  const decipher = createDecipheriv('aes-256-gcm', sessionKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ── Ephemeral keypair generation ──



export interface ProfileIssuanceOverrides {
  ttlSeconds?: number;
  maxReads?: number;
  readScopes?: string[];
  writeScopes?: string[];
  excludeFields?: string[];
}

export interface ProfileIssuanceSelection {
  profile?: string;
  profileVersion?: string;
  profileOverrides?: ProfileIssuanceOverrides;
}

export function buildScopedReadTokenIssueRequest(input: {
  agentId?: string;
  pubkey: string;
} & ProfileIssuanceSelection): Record<string, unknown> {
  if (input.profile && input.profile.trim()) {
    return {
      agentId: input.agentId || 'cli-reader',
      profile: input.profile,
      ...(input.profileVersion ? { profileVersion: input.profileVersion } : {}),
      ...(input.profileOverrides ? { profileOverrides: input.profileOverrides } : {}),
      pubkey: input.pubkey,
    };
  }

  return {
    agentId: input.agentId || 'cli-reader',
    permissions: ['secret:read'],
    credentialAccess: { read: ['agent:*'], excludeFields: [] },
    pubkey: input.pubkey,
  };
}

export function buildScopedWriteTokenIssueRequest(input: {
  agentId?: string;
  pubkey: string;
  targetAgentId: string;
} & ProfileIssuanceSelection): Record<string, unknown> {
  if (input.profile && input.profile.trim()) {
    return {
      agentId: input.agentId || 'cli-writer',
      profile: input.profile,
      ...(input.profileVersion ? { profileVersion: input.profileVersion } : {}),
      ...(input.profileOverrides ? { profileOverrides: input.profileOverrides } : {}),
      pubkey: input.pubkey,
    };
  }

  return {
    agentId: input.agentId || 'cli-writer',
    permissions: ['secret:write'],
    credentialAccess: { write: [`agent:${input.targetAgentId}`] },
    pubkey: input.pubkey,
  };
}
export interface EphemeralKeypair {
  publicKeyPem: string;
  privateKeyPem: string;
  publicKeyBase64: string;
}

interface AuthRequestCreateResponse {
  success?: boolean;
  requestId?: string;
  secret?: string;
  approveUrl?: string;
  error?: string;
}

interface AuthRequestPollResponse {
  success?: boolean;
  status?: 'pending' | 'approved' | 'rejected';
  encryptedToken?: string;
  error?: string;
}

export interface AuthRequestBootstrapOptions extends ProfileIssuanceSelection {
  timeoutMs?: number;
  pollIntervalMs?: number;
  onStatus?: (message: string) => void;
  /** If true, create the auth request and return immediately without polling. */
  noWait?: boolean;
}

export interface AuthRequestCreated {
  requestId: string;
  secret: string;
  approveUrl?: string;
}

export function generateEphemeralKeypair(): EphemeralKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    publicKeyBase64: Buffer.from(publicKey, 'utf8').toString('base64'),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseProfileOverridesFromEnv(): ProfileIssuanceOverrides | undefined {
  const raw = process.env.AURA_AUTH_PROFILE_OVERRIDES;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }
    return parsed as ProfileIssuanceOverrides;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON';
    throw new Error(`Invalid AURA_AUTH_PROFILE_OVERRIDES: ${message}`);
  }
}

function seedStringDefault(key: string, fallback: string): string {
  const seed = SEED_DEFAULTS.find((entry) => entry.key === key);
  if (!seed || typeof seed.value !== 'string') return fallback;
  const normalized = seed.value.trim();
  return normalized || fallback;
}

export async function resolveAuthFallbackProfileConfig(options?: AuthRequestBootstrapOptions): Promise<{
  profile: string;
  profileVersion: string;
}> {
  const explicitProfile = options?.profile?.trim();
  const explicitProfileVersion = options?.profileVersion?.trim();

  const defaultProfile = String(await getDefault<string | null>('trust.localProfile', '') || '').trim();
  const defaultProfileVersion = String(await getDefault<string | null>('trust.localProfileVersion', '') || '').trim();

  return {
    profile: explicitProfile || defaultProfile || seedStringDefault('trust.localProfile', 'admin'),
    profileVersion: explicitProfileVersion || defaultProfileVersion || seedStringDefault('trust.localProfileVersion', 'v1'),
  };
}

// ── Socket bootstrap (CLI auth via Unix socket) ──

/**
 * Authenticate with the AuraMaxx server via Unix socket.
 * Returns a bearer token for API access.
 */
export function bootstrapViaSocket(
  agentId: string,
  keypair: EphemeralKeypair,
): Promise<string> {
  const socketPaths = resolveAuraSocketCandidates();

  const connectToSocket = (socketPath: string): Promise<string> => new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        reject(new Error('Socket auth timed out. Is AuraMaxx running? (npx auramaxx start)'));
      }
    }, 5000);

    socket.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Cannot connect to AuraMaxx: ${err.message}\nRun 'npx auramaxx start' first.`));
      }
    });

    socket.on('connect', () => {
      socket.write(JSON.stringify({
        type: 'auth',
        agentId,
        autoApprove: true,
        pubkey: keypair.publicKeyPem,
      }) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.substring(0, idx);
        buffer = buffer.substring(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim()) as {
            type: string;
            encryptedToken?: string;
            message?: string;
          };
          if (msg.type === 'auth_approved' && msg.encryptedToken) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              socket.destroy();
              resolve(decryptWithPrivateKey(msg.encryptedToken, keypair.privateKeyPem));
            }
          } else if (msg.type === 'error') {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              socket.destroy();
              reject(new Error(`Auth error: ${msg.message}`));
            }
          }
        } catch { /* ignore parse errors */ }
      }
    });
  });

  return (async () => {
    let lastError: Error | null = null;
    for (const socketPath of socketPaths) {
      try {
        return await connectToSocket(socketPath);
      } catch (error) {
        const current = error instanceof Error ? error : new Error(String(error));
        lastError = current;
        // Only fall through to secondary path for connection-level failures.
        if (!current.message.startsWith('Cannot connect to AuraMaxx')) {
          throw current;
        }
      }
    }
    throw lastError || new Error('Cannot connect to AuraMaxx.');
  })();
}

/**
 * Fallback auth flow for strict/disabled local auto-approve mode:
 * create /auth request, then poll until human approval resolves.
 *
 * With `noWait: true`, creates the request and returns immediately
 * with the approval URL (no polling). Callers can present the URL
 * and exit, matching the MCP `auth` tool behavior.
 */
export async function bootstrapViaAuthRequest(
  baseUrl: string,
  agentId: string,
  keypair: EphemeralKeypair,
  options: AuthRequestBootstrapOptions & { noWait: true },
): Promise<AuthRequestCreated>;
export async function bootstrapViaAuthRequest(
  baseUrl: string,
  agentId: string,
  keypair: EphemeralKeypair,
  options?: AuthRequestBootstrapOptions,
): Promise<string>;
export async function bootstrapViaAuthRequest(
  baseUrl: string,
  agentId: string,
  keypair: EphemeralKeypair,
  options: AuthRequestBootstrapOptions = {},
): Promise<string | AuthRequestCreated> {
  const resolvedProfile = await resolveAuthFallbackProfileConfig(options);
  const profile = resolvedProfile.profile;
  if (!profile) {
    throw new Error('No profile configured for /auth fallback');
  }

  const profileVersion = resolvedProfile.profileVersion;
  const profileOverrides = options.profileOverrides || parseProfileOverridesFromEnv();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 3_000;

  options.onStatus?.(`Socket auth unavailable; requesting /auth approval with profile '${profile}'.`);

  const createResponse = await fetch(`${baseUrl}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId,
      profile,
      ...(profileVersion ? { profileVersion } : {}),
      ...(profileOverrides ? { profileOverrides } : {}),
      pubkey: keypair.publicKeyPem,
    }),
    signal: AbortSignal.timeout(8_000),
  });

  const createData = await createResponse.json().catch(() => ({})) as AuthRequestCreateResponse;
  if (!createResponse.ok || !createData.success || !createData.requestId || !createData.secret) {
    const reason = createData.error || `HTTP ${createResponse.status}`;
    throw new Error(`Failed to create /auth request: ${reason}`);
  }

  const requestId = createData.requestId;
  const secret = createData.secret;
  const approveUrl = typeof createData.approveUrl === 'string' ? createData.approveUrl : undefined;

  // Non-blocking mode: return immediately with the approval info
  if (options.noWait) {
    const pollUrl = buildPollUrl(baseUrl, requestId, secret);
    if (approveUrl) {
      options.onStatus?.(`Auth request created (${requestId}). Approve at:\n  ${approveUrl}`);
    } else {
      options.onStatus?.(`Auth request created (${requestId}). Awaiting approval.`);
    }
    options.onStatus?.(`Then claim approval token by polling:\n  GET ${pollUrl}`);
    options.onStatus?.('After token claim succeeds, retry your original command with AURA_TOKEN=<token>.');
    return { requestId, secret, approveUrl };
  }

  const startedAt = Date.now();
  let announcedPending = false;

  if (approveUrl) {
    options.onStatus?.(`Auth request created (${requestId}). Approve at:\n  ${approveUrl}\nWaiting for human approval...`);
  } else {
    options.onStatus?.(`Auth request created (${requestId}). Waiting for human approval...`);
  }

  while (Date.now() - startedAt <= timeoutMs) {
    const pollResponse = await fetch(
      buildPollUrl(baseUrl, requestId, secret),
      {
        signal: AbortSignal.timeout(8_000),
        headers: buildClaimHeaders(secret),
      },
    );
    const pollData = await pollResponse.json().catch(() => ({})) as AuthRequestPollResponse;

    if (pollResponse.ok && pollData.success) {
      if (pollData.status === 'approved') {
        if (!pollData.encryptedToken) {
          throw new Error('Approval resolved but encrypted token is missing');
        }
        options.onStatus?.('Approval received. Continuing...');
        return decryptWithPrivateKey(pollData.encryptedToken, keypair.privateKeyPem);
      }

      if (pollData.status === 'rejected') {
        throw new Error(`Auth request rejected (${requestId})`);
      }

      if (pollData.status === 'pending' && !announcedPending) {
        options.onStatus?.('Still pending approval in dashboard...');
        announcedPending = true;
      }
    } else if (pollResponse.status === 410) {
      throw new Error(`Auth token claim expired or already claimed (${requestId})`);
    } else if (pollResponse.status >= 400 && pollResponse.status < 500 && pollResponse.status !== 404) {
      const reason = pollData.error || `HTTP ${pollResponse.status}`;
      throw new Error(`Auth polling failed: ${reason}`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for approval after ${Math.round(timeoutMs / 1000)}s (${requestId})`);
}

/**
 * Create a scoped credential-read token via the server API.
 */
export async function createReadToken(
  baseUrl: string,
  token: string,
  keypair: EphemeralKeypair,
  agentId: string = 'cli-reader',
  profile?: ProfileIssuanceSelection,
): Promise<string> {
  const res = await fetch(`${baseUrl}/actions/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(buildScopedReadTokenIssueRequest({
      agentId,
      pubkey: keypair.publicKeyBase64,
      profile: profile?.profile,
      profileVersion: profile?.profileVersion,
      profileOverrides: profile?.profileOverrides,
    })),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create read token (${res.status}): ${text}`);
  }

  const data = await res.json() as { encryptedToken?: string };
  if (!data.encryptedToken) {
    throw new Error('No encryptedToken in response');
  }

  return decryptWithPrivateKey(data.encryptedToken, keypair.privateKeyPem);
}
