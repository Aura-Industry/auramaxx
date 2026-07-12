/**
 * auramaxx agent — Retrieve and manage credentials from the agent
 */

import {
  generateEphemeralKeypair,
  bootstrapViaSocket,
  bootstrapViaAuthRequest,
  decryptWithPrivateKey,
  createReadToken,
  encryptToAgentPubkey,
  type EphemeralKeypair,
  type ProfileIssuanceSelection,
} from '../../lib/credential-transport';
import { spawn } from 'child_process';
import { serverUrl } from '../lib/http';
import { getErrorMessage } from '../../lib/error';
import {
  evaluateProjectScopeAccess,
  emitProjectScopeEvent,
  type ProjectScopeMode,
} from '../../lib/project-scope';
import { printBanner, printHelp, printSection, printStatus } from '../lib/theme';
import { handlePermissionDenied } from '../lib/escalation';
import { maybeHandleLockError } from '../lib/lock-unlock-helper';
import {
  canonicalizeCredentialFieldKey,
  getCredentialPrimaryFieldKey,
  normalizeCredentialFieldsForType,
  getCredentialFieldValue,
  NOTE_CONTENT_KEY,
  CREDENTIAL_FIELD_SCHEMA,
  type CredentialType,
} from '../../../../shared/credential-field-schema';
import {
  createSecretGist,
  SecretGistError,
} from '../../lib/secret-gist-share';
import { defaultSecretEnvVarName, normalizeEnvVarName } from '../../lib/secret-env';
import {
  putApprovalContext,
  getClaimedToken,
  consumeClaimedToken,
} from '../lib/approval-context';

// ── Auth ──────────────────────────────────────────────────────────────

type AuthSource = 'socket' | 'env' | 'auth';

interface AuthSession {
  token: string;
  source: AuthSource;
  privateKeyPem?: string;
}

function decodeAgentTokenPayload(
  token: string,
): { permissions?: unknown } | undefined {
  const trimmed = token.trim();
  if (!trimmed) return undefined;
  const [payloadSegment] = trimmed.split('.', 1);
  if (!payloadSegment) return undefined;
  try {
    const decoded = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as { permissions?: unknown };
  } catch {
    return undefined;
  }
}

function resolveAdminPermissionFromToken(token: string): boolean | undefined {
  const payload = decodeAgentTokenPayload(token);
  if (!payload) return undefined;
  if (!Array.isArray(payload.permissions)) return false;
  return payload.permissions.some((permission) => permission === 'admin:*');
}

async function getAuthToken(
  keypair: EphemeralKeypair,
  authSelection?: ProfileIssuanceSelection,
): Promise<AuthSession> {
  const envToken = process.env.AURA_TOKEN;
  if (envToken) {
    return { token: envToken, source: 'env' };
  }

  let socketError: unknown;
  try {
    const token = await bootstrapViaSocket('cli-agent', keypair);
    if (!token || typeof token !== 'string') {
      throw new Error('Socket auth returned empty token.');
    }
    return { token, source: 'socket', privateKeyPem: keypair.privateKeyPem };
  } catch (socketErr) {
    socketError = socketErr;
    const socketMessage = getErrorMessage(socketErr).toLowerCase();
    const indicatesLockedAgent =
      socketMessage.includes('wallet is locked') ||
      socketMessage.includes('agent is locked') ||
      socketMessage.includes('daemon is locked') ||
      socketMessage.includes('unlock before socket auto-approve');
    if (indicatesLockedAgent) {
      throw new Error('Agent is locked. Run `auramaxx unlock` and retry.');
    }
  }

  if (authSelection?.profile) {
    const result = await bootstrapViaAuthRequest(serverUrl(), 'cli-agent', keypair, {
      ...authSelection,
      noWait: true,
      onStatus: (message) => console.error(message),
    });
    if (result.approveUrl) {
      console.error(`Approve at: ${result.approveUrl}`);
    }
    console.error('After approval, re-run with: AURA_TOKEN=<token> npx auramaxx agent ...');
    console.error(`Or use: npx auramaxx auth request --profile ${authSelection.profile} --raw-token`);
    process.exit(1);
  }

  const token = await bootstrapViaAuthRequest(serverUrl(), 'cli-agent', keypair, {
    ...authSelection,
    onStatus: (message) => console.error(message),
  }).catch((authErr) => {
    throw new Error(`${getErrorMessage(socketError)}\n${getErrorMessage(authErr)}`);
  });
  return { token, source: 'auth', privateKeyPem: keypair.privateKeyPem };
}

async function getReadToken(input: {
  authToken: string;
  keypair: EphemeralKeypair;
  authSelection?: ProfileIssuanceSelection;
  fallbackDecryptPrivateKeyPem: string;
}): Promise<{ readToken: string; decryptPrivateKeyPem: string }> {
  const hasAdminPermission = resolveAdminPermissionFromToken(input.authToken);
  if (hasAdminPermission === false) {
    // Non-admin session tokens cannot call /actions/token.
    // Skip delegated token minting to avoid a guaranteed 403 escalation cycle.
    return { readToken: input.authToken, decryptPrivateKeyPem: input.fallbackDecryptPrivateKeyPem };
  }

  try {
    const readToken = await createReadToken(
      serverUrl(),
      input.authToken,
      input.keypair,
      'cli-agent-reader',
      input.authSelection,
    );
    // Delegated read tokens encrypt to the ephemeral read keypair.
    return { readToken, decryptPrivateKeyPem: input.keypair.privateKeyPem };
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.includes('(401)') || message.includes('(403)')) {
      // Profile-issued tokens may not have action:create; direct read can still succeed when secret:read exists.
      // When we fall back to auth token, decrypt with that auth token's key context.
      return { readToken: input.authToken, decryptPrivateKeyPem: input.fallbackDecryptPrivateKeyPem };
    }
    throw error;
  }
}

function decryptCredentialPayload(encrypted: string, privateKeyPem: string): DecryptedCredential {
  const plaintext = decryptWithPrivateKey(encrypted, privateKeyPem);
  return JSON.parse(plaintext) as DecryptedCredential;
}

// ── Types ─────────────────────────────────────────────────────────────

interface CredentialMeta {
  id: string;
  name: string;
  type: string;
  agentId: string;
  meta: Record<string, unknown>;
}

interface DecryptedCredential {
  id: string;
  agentId: string;
  type: string;
  fields: Array<{ key: string; value: string; type?: string; sensitive?: boolean }>;
  health?: {
    status: string;
    flags: { weak: boolean; reused: boolean; breached: boolean; unknown: boolean };
    lastScannedAt: string | null;
  };
}

interface CredentialHealthSummaryResponse {
  summary: {
    totalAnalyzed: number;
    safe: number;
    weak: number;
    reused: number;
    breached: number;
    unknown: number;
    lastScanAt: string | null;
  };
}

interface AgentSummary {
  id: string;
  name?: string;
  isPrimary?: boolean;
}

interface ShareCreateResponse {
  success?: boolean;
  share?: {
    token: string;
    credentialId: string;
    expiresAt: number;
    accessMode: 'anyone' | 'password';
    oneTimeOnly: boolean;
  };
  error?: string;
}

// ── API helpers ───────────────────────────────────────────────────────

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`;
}

function buildOriginalCommand(args: string[]): string {
  const rendered = args.map(shellQuote).join(' ').trim();
  return rendered ? `npx auramaxx ${rendered}` : 'npx auramaxx';
}

function appendReqIdPlaceholder(command: string): string {
  const normalized = command.trim();
  if (!normalized) return '--reqId <reqId>';
  if (/\s--(?:reqId|req-id|requestId|request-id)(?:\s|=|$)/.test(normalized)) {
    return normalized;
  }
  return `${normalized} --reqId <reqId>`;
}

function materializeRetryCommand(command: string | undefined, reqId: string): string {
  const base = String(command || '').trim();
  if (!base) return `<retry_original_command> --reqId ${reqId}`;
  let next = base.replace(/<reqId>/g, reqId);
  next = next
    .replace(/--req-id\s+\S+/g, `--reqId ${reqId}`)
    .replace(/--request-id\s+\S+/g, `--reqId ${reqId}`)
    .replace(/--requestId\s+\S+/g, `--reqId ${reqId}`)
    .replace(/--reqId\s+\S+/g, `--reqId ${reqId}`);
  if (!/\s--(?:reqId|req-id|requestId|request-id)(?:\s|=|$)/.test(next)) {
    next = `${next} --reqId ${reqId}`;
  }
  return next;
}

async function listCredentials(token: string, query?: string): Promise<CredentialMeta[]> {
  const qs = query ? `?q=${encodeURIComponent(query)}` : '';
  const res = await fetch(`${serverUrl()}/credentials${qs}`, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as unknown;
    if (await handlePermissionDenied(res.status, body)) process.exit(1);
    throw new Error(`List failed (${res.status})`);
  }
  const data = await res.json() as { credentials?: CredentialMeta[] };
  return data.credentials || [];
}

async function readCredential(
  credentialId: string,
  readToken: string,
  privateKeyPem: string,
  options?: {
    retryCommandTemplate?: string;
    originalCommand?: string;
    requestedFields?: string[];
  },
): Promise<DecryptedCredential> {
  const originalCommand = String(options?.originalCommand || '').trim();
  const requestedFields = Array.from(new Set(
    (options?.requestedFields || [])
      .map((value) => String(value || '').trim())
      .filter((value) => value.length > 0),
  ));
  const requestBody = requestedFields.length > 0
    ? JSON.stringify({ requestedFields })
    : undefined;
  const res = await fetch(`${serverUrl()}/credentials/${credentialId}/read`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${readToken}`,
      ...(requestBody ? { 'Content-Type': 'application/json' } : {}),
      ...(originalCommand ? { 'X-Aura-Original-Command': originalCommand } : {}),
    },
    ...(requestBody ? { body: requestBody } : {}),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const text = await res.text();
    let body: unknown;
    let escalationBody: unknown;
    try { body = JSON.parse(text) as unknown; } catch { body = text; }
    escalationBody = body;
    if (res.status === 403 && body && typeof body === 'object' && !Array.isArray(body)) {
      const payload = body as Record<string, unknown>;
      const reqId = typeof payload.reqId === 'string' ? payload.reqId : '';
      const secret = typeof payload.secret === 'string' ? payload.secret : '';
      if (payload.requiresHumanApproval === true && reqId && secret) {
        const credential = payload.credential && typeof payload.credential === 'object' && !Array.isArray(payload.credential)
          ? payload.credential as Record<string, unknown>
          : undefined;
        putApprovalContext({
          reqId,
          secret,
          privateKeyPem,
          approvalScope: 'one_shot_read',
          ttlSeconds: 300,
          credentialId: credential && typeof credential.id === 'string' ? credential.id : credentialId,
          credentialName: credential && typeof credential.name === 'string' ? credential.name : undefined,
          retryCommandTemplate: options?.retryCommandTemplate,
        });
        escalationBody = {
          ...payload,
          _agentStoredApprovalContext: true,
          reqId,
        };
      }
    }
    if (await handlePermissionDenied(res.status, escalationBody, {
      retryCommandTemplate: options?.retryCommandTemplate,
    })) process.exit(1);
    throw new Error(`Read failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { encrypted: string };
  return decryptCredentialPayload(data.encrypted, privateKeyPem);
}

async function searchCredentials(token: string, name: string): Promise<CredentialMeta[]> {
  for (const param of [`q=${encodeURIComponent(name)}`, `tag=${encodeURIComponent(name)}`]) {
    const res = await fetch(`${serverUrl()}/credentials?${param}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      if (res.status === 403) {
        const body = await res.json().catch(() => ({})) as unknown;
        if (await handlePermissionDenied(res.status, body)) process.exit(1);
      }
      continue;
    }

    const data = await res.json() as { credentials?: CredentialMeta[] };
    if (data.credentials && data.credentials.length > 0) {
      return data.credentials;
    }
  }
  return [];
}

async function fetchTotpCode(
  credentialId: string,
  token: string,
  options?: { originalCommand?: string },
): Promise<{ code: string; remaining: number }> {
  const originalCommand = String(options?.originalCommand || '').trim();
  const res = await fetch(`${serverUrl()}/credentials/${credentialId}/totp`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(originalCommand ? { 'X-Aura-Original-Command': originalCommand } : {}),
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as unknown;
    if (await handlePermissionDenied(res.status, data)) process.exit(1);
    const parsed = data as { error?: string };
    throw new Error(parsed.error || `TOTP request failed (${res.status})`);
  }
  return await res.json() as { code: string; remaining: number };
}

async function fetchAgents(): Promise<AgentSummary[]> {
  const res = await fetch(`${serverUrl()}/setup/agents`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return [];
  const data = await res.json() as { agents?: AgentSummary[] };
  return data.agents || [];
}

async function fetchAgentNameMap(): Promise<Map<string, string>> {
  const agents = await fetchAgents();
  return new Map(agents.map((v) => [v.id, v.name || v.id]));
}

async function fetchHealthSummary(token: string): Promise<CredentialHealthSummaryResponse['summary']> {
  const res = await fetch(`${serverUrl()}/credentials/health/summary`, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as unknown;
    if (await handlePermissionDenied(res.status, body)) process.exit(1);
    throw new Error(`Health summary failed (${res.status})`);
  }
  const data = await res.json() as CredentialHealthSummaryResponse;
  return data.summary;
}

async function createCredential(
  token: string,
  body: {
    agentId: string;
    name: string;
    type: string;
    sensitiveFields: Array<{ key: string; value: string; sensitive?: boolean }>;
    meta?: Record<string, unknown>;
  },
): Promise<CredentialMeta> {
  const res = await fetch(`${serverUrl()}/credentials`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });

  const data = await res.json().catch(() => ({})) as {
    success?: boolean;
    error?: string;
    credential?: CredentialMeta;
  };

  if (!res.ok || !data.success || !data.credential) {
    if (await handlePermissionDenied(res.status, data)) process.exit(1);
    throw new Error(data.error || `Create failed (${res.status})`);
  }

  return data.credential;
}

async function updateCredential(
  token: string,
  credentialId: string,
  body: {
    sensitiveFields?: Array<{ key: string; value: string; sensitive?: boolean }>;
    name?: string;
    meta?: Record<string, unknown>;
  },
): Promise<CredentialMeta> {
  const res = await fetch(`${serverUrl()}/credentials/${encodeURIComponent(credentialId)}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });

  const data = await res.json().catch(() => ({})) as {
    success?: boolean;
    error?: string;
    credential?: CredentialMeta;
  };

  if (!res.ok || !data.success || !data.credential) {
    if (await handlePermissionDenied(res.status, data)) process.exit(1);
    throw new Error(data.error || `Update failed (${res.status})`);
  }

  return data.credential;
}

async function deleteCredential(
  token: string,
  credentialId: string,
  location: 'active' | 'archive' | 'recently_deleted' = 'active',
): Promise<{ success: boolean; action?: string; deleted?: boolean; error?: string }> {
  const qs = new URLSearchParams({ location }).toString();
  const res = await fetch(`${serverUrl()}/credentials/${encodeURIComponent(credentialId)}?${qs}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  const data = await res.json().catch(() => ({})) as {
    success?: boolean;
    action?: string;
    deleted?: boolean;
    error?: string;
  };
  if (!res.ok) {
    if (await handlePermissionDenied(res.status, data)) process.exit(1);
    throw new Error(data.error || `Delete failed (${res.status})`);
  }
  return { success: data.success === true, action: data.action, deleted: data.deleted };
}

async function createShare(
  token: string,
  body: {
    credentialId: string;
    expiresAfter?: string;
    accessMode?: 'anyone' | 'password';
    password?: string;
    oneTimeOnly?: boolean;
  },
): Promise<ShareCreateResponse['share']> {
  const res = await fetch(`${serverUrl()}/credential-shares`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });

  const data = await res.json().catch(() => ({})) as ShareCreateResponse;
  if (!res.ok || !data.success || !data.share) {
    if (await handlePermissionDenied(res.status, data)) process.exit(1);
    throw new Error(data.error || `Share create failed (${res.status})`);
  }
  return data.share;
}

function resolveShareUrlForGist(shareToken: string): string {
  const configuredBase = String(process.env.AURA_SHARE_BASE_URL || '').trim();
  if (configuredBase) {
    try {
      const parsed = new URL(configuredBase);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const normalizedBase = configuredBase.replace(/\/+$/, '');
        return `${normalizedBase}/share/${shareToken}`;
      }
    } catch {
      // fall back to API share URL below when base URL is invalid
    }
  }
  return `${serverUrl()}/credential-shares/${shareToken}`;
}

// ── Scope + target resolution ─────────────────────────────────────────

function normalizeProjectScopeMode(raw: unknown): ProjectScopeMode {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'strict') return 'strict';
  if (value === 'auto') return 'auto';
  if (value === 'off') return 'off';
  return 'off';
}

async function fetchProjectScopeMode(): Promise<ProjectScopeMode> {
  try {
    const res = await fetch(`${serverUrl()}/setup`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return 'off';
    const data = await res.json() as { projectScopeMode?: unknown };
    return normalizeProjectScopeMode(data.projectScopeMode);
  } catch {
    return 'off';
  }
}

async function resolveCredentialTarget(
  token: string,
  name: string,
  options: {
    agentName?: string;
    first?: boolean;
    surface: string;
    actor: string;
  },
): Promise<{ target: CredentialMeta; agentNames: Map<string, string> }> {
  const matches = await searchCredentials(token, name);
  if (matches.length === 0) {
    throw new Error(`No credential found matching "${name}"`);
  }

  const exactMatches = matches.filter((m) => m.name.toLowerCase() === name.toLowerCase());
  const candidateMatches = exactMatches.length > 0 ? exactMatches : matches;

  const agentNames = await fetchAgentNameMap();
  const projectScopeMode = await fetchProjectScopeMode();

  const scopedDecision = evaluateProjectScopeAccess({
    surface: options.surface,
    requested: { agentName: options.agentName || null, credentialName: name },
    candidates: candidateMatches.map((m) => ({
      id: m.id,
      name: m.name,
      agentName: agentNames.get(m.agentId) || null,
    })),
    actor: options.actor,
    projectScopeMode,
  });

  emitProjectScopeEvent({
    actor: options.actor,
    surface: options.surface,
    requestedCredential: { agentName: options.agentName || null, credentialName: name },
    decision: scopedDecision,
  });

  if (!scopedDecision.allowed) {
    throw new Error(`${scopedDecision.code}: ${scopedDecision.remediation}`);
  }

  const allowedIds = new Set(scopedDecision.allowedCandidates.map((c) => c.id).filter(Boolean));
  const scopedMatches = candidateMatches.filter((m) => allowedIds.has(m.id));
  const agentFiltered = options.agentName
    ? scopedMatches.filter((m) => (agentNames.get(m.agentId) || '').toLowerCase() === options.agentName!.toLowerCase())
    : scopedMatches;

  if (agentFiltered.length === 0) {
    throw new Error(`PROJECT_SCOPE_DENIED: No allowed credential found for "${name}" in agent "${options.agentName}".`);
  }

  return { target: agentFiltered[0], agentNames };
}

function resolveAgentId(agents: AgentSummary[], agentName?: string): string {
  if (agents.length === 0) {
    throw new Error('No agents found. Initialize setup first.');
  }

  if (agentName) {
    const found = agents.find((v) => (v.name || '').toLowerCase() === agentName.toLowerCase());
    if (!found) {
      throw new Error(`Agent not found: ${agentName}`);
    }
    return found.id;
  }

  const primary = agents.find((v) => v.isPrimary);
  if (primary) return primary.id;
  return agents[0].id;
}

// ── CLI parsing ────────────────────────────────────────────────────────

function showHelp(): void {
  printHelp('AGENT', 'npx auramaxx agent <subcommand> [options]', [
    { name: 'list', desc: 'List credential names (supports --name/--field filters)' },
    { name: 'get <name>', desc: 'Print primary value only (use --json for full payload)' },
    { name: 'inject <name> [-- <cmd>]', desc: 'Save primary secret to env var and optionally run command' },
    { name: 'set <name> <value>', desc: 'Upsert secret (default type: api key, default field: value)' },
    { name: 'share <name>', desc: 'Create GitHub secret gist share for credential by name' },
    { name: 'delete <name>', desc: 'Delete credential by name (lifecycle delete)' },
    { name: 'health', desc: 'Print credential health summary' },
  ], [
    'Options:',
    '  --field <f>              get/set: field key override; list: field key/value contains query',
    '  --name <v>               list: credential name/title contains query',
    '  --env <v>                get/inject: env var override',
    '  --type <t>               Set type (set only; default: api key)',
    '  --tags <a,b,c>            Comma-separated tags (set only)',
    '  --agent <v>              Restrict to agent name',
    '  --json                   JSON output',
    '  --first                  Compatibility flag (first match is already default)',
    '  --totp                   Print current TOTP code only (get)',
    '  --danger-plaintext       Print plaintext secret in local socket get output (unsafe)',
    '  --expires-after <v>      Share expiry: 15m|1h|24h|7d|30d (default: 24h)',
    '  --password <pwd>         Share password (implies accessMode=password)',
    '  --one-time               Share one-time-only access',
    '  --location <v>           Delete location: active|archive|recently_deleted',
    '  --reqId <id>             Retry using a previously claimed one-shot approval token (aliases: --req-id, --requestId, --request-id)',
    '  --profile <p>            /auth fallback profile when socket is blocked',
    '  --profile-version <v>    /auth fallback profile version',
    '  --profile-overrides <j>  Tighten-only profile override JSON',
    '',
    'Examples:',
    '  npx auramaxx agent list --name prod',
    '  npx auramaxx agent list --name prod --field token',
    '  npx auramaxx agent get DONTLOOK --env AURA_DONTLOOK -- printenv AURA_DONTLOOK',
    '',
    'Auth: Uses Unix socket by default. Falls back to /auth polling when strict local mode blocks auto-approve.',
    '      Set AURA_TOKEN for headless/CI.',
  ]);
}

export function parseArgs(args: string[]): {
  subcommand: string | undefined;
  flagJson: boolean;
  flagFirst: boolean;
  flagTotp: boolean;
  flagOneTime: boolean;
  flagDangerPlaintext: boolean;
  fieldName: string | undefined;
  secretEnvName: string | undefined;
  agentName: string | undefined;
  expiresAfter: string | undefined;
  sharePassword: string | undefined;
  deleteLocation: string | undefined;
  reqId: string | undefined;
  authProfile: string | undefined;
  authProfileVersion: string | undefined;
  authProfileOverrides: string | undefined;
  typeName: string | undefined;
  tags: string[] | undefined;
  extraFields: Array<{ key: string; value: string }>;
  positional: string[];
  execCommand: string[];
} {
  const separatorIdx = args.indexOf('--');
  const parseableArgs = separatorIdx === -1 ? args : args.slice(0, separatorIdx);
  const execCommand = separatorIdx === -1 ? [] : args.slice(separatorIdx + 1);

  const subcommand = parseableArgs[0];
  const flagJson = parseableArgs.includes('--json');
  const flagFirst = parseableArgs.includes('--first');
  const flagTotp = parseableArgs.includes('--totp');
  const flagOneTime = parseableArgs.includes('--one-time');
  const flagDangerPlaintext = parseableArgs.includes('--danger-plaintext');
  let fieldName: string | undefined;
  const secretEnvIdx = parseableArgs.indexOf('--env');
  const legacySecretEnvIdx = parseableArgs.indexOf('--name');
  const secretEnvName = secretEnvIdx !== -1
    ? parseableArgs[secretEnvIdx + 1]
    : (legacySecretEnvIdx !== -1 ? parseableArgs[legacySecretEnvIdx + 1] : undefined);
  const agentIdx = parseableArgs.indexOf('--agent');
  const agentName = agentIdx !== -1 ? parseableArgs[agentIdx + 1] : undefined;
  const expiresAfterIdx = parseableArgs.indexOf('--expires-after');
  const expiresAfter = expiresAfterIdx !== -1 ? parseableArgs[expiresAfterIdx + 1] : undefined;
  const passwordIdx = parseableArgs.indexOf('--password');
  const sharePassword = passwordIdx !== -1 ? parseableArgs[passwordIdx + 1] : undefined;
  const locationIdx = parseableArgs.indexOf('--location');
  const deleteLocation = locationIdx !== -1 ? parseableArgs[locationIdx + 1] : undefined;
  const reqIdFlag = ['--reqId', '--req-id', '--requestId', '--request-id']
    .find((flag) => parseableArgs.includes(flag));
  const reqIdIdx = reqIdFlag ? parseableArgs.indexOf(reqIdFlag) : -1;
  const reqId = reqIdIdx !== -1 ? parseableArgs[reqIdIdx + 1] : undefined;
  const profileIdx = parseableArgs.indexOf('--profile');
  const authProfile = profileIdx !== -1 ? parseableArgs[profileIdx + 1] : undefined;
  const profileVersionIdx = parseableArgs.indexOf('--profile-version');
  const authProfileVersion = profileVersionIdx !== -1 ? parseableArgs[profileVersionIdx + 1] : undefined;
  const profileOverridesIdx = parseableArgs.indexOf('--profile-overrides');
  const authProfileOverrides = profileOverridesIdx !== -1 ? parseableArgs[profileOverridesIdx + 1] : undefined;
  const typeIdx = parseableArgs.indexOf('--type');
  const typeName = typeIdx !== -1 ? parseableArgs[typeIdx + 1] : undefined;
  const tagsIdx = parseableArgs.indexOf('--tags');
  const tagsRaw = tagsIdx !== -1 ? parseableArgs[tagsIdx + 1] : undefined;
  const tags = tagsRaw
    ? Array.from(new Set(tagsRaw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)))
    : undefined;

  const knownValueFlags = new Set([
    '--name', '--env', '--agent', '--expires-after', '--password', '--location', '--reqId', '--req-id', '--requestId', '--request-id', '--profile', '--profile-version', '--profile-overrides', '--type', '--tags',
  ]);
  const knownBooleanFlags = new Set(['--json', '--first', '--totp', '--one-time', '--danger-plaintext']);

  const positional: string[] = [];
  const extraFields: Array<{ key: string; value: string }> = [];
  for (let i = 1; i < parseableArgs.length; i++) {
    const arg = parseableArgs[i];
    if (!arg) continue;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    // Handle --field specially: supports --field key=value and --field key
    if (arg === '--field') {
      const nextArg = parseableArgs[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        const eqIdx = nextArg.indexOf('=');
        if (eqIdx > 0) {
          extraFields.push({ key: nextArg.slice(0, eqIdx), value: nextArg.slice(eqIdx + 1) });
        } else {
          fieldName = fieldName || nextArg;
        }
        i++;
      }
      continue;
    }

    if (knownValueFlags.has(arg)) {
      i++;
      continue;
    }

    if (knownBooleanFlags.has(arg)) {
      continue;
    }

    const key = arg.slice(2).trim();
    if (!key) continue;

    const value = parseableArgs[i + 1];
    if (!value || value.startsWith('--')) {
      continue;
    }

    extraFields.push({ key, value });
    i++;
  }

  return {
    subcommand,
    flagJson,
    flagFirst,
    flagTotp,
    flagOneTime,
    flagDangerPlaintext,
    fieldName,
    secretEnvName,
    agentName,
    expiresAfter,
    sharePassword,
    deleteLocation,
    reqId,
    authProfile,
    authProfileVersion,
    authProfileOverrides,
    typeName,
    tags,
    extraFields,
    positional,
    execCommand,
  };
}

type CredentialField = { key: string; value: string; type?: string; sensitive?: boolean };

const TYPE_ALIASES: Record<string, string> = {
  'api key': 'apikey',
  'api-key': 'apikey',
  api_key: 'apikey',
};

function normalizeCredentialType(type: string | undefined): string {
  const normalized = String(type || '').trim().toLowerCase();
  if (!normalized) return 'apikey';
  return TYPE_ALIASES[normalized] || normalized;
}

function resolvePrimaryField(type: string, fields: CredentialField[]): CredentialField | undefined {
  const defaultFieldKey = getCredentialPrimaryFieldKey(type);
  return fields.find((f) => f.key.toLowerCase() === defaultFieldKey.toLowerCase())
    || fields.find((f) => f.key.toLowerCase() === 'value')
    || fields[0];
}

function resolvePrimarySecretField(type: string, fields: CredentialField[]): CredentialField | undefined {
  const defaultFieldKey = getCredentialPrimaryFieldKey(type).toLowerCase();
  return fields.find((f) => f.key.toLowerCase() === defaultFieldKey && f.sensitive !== false)
    || fields.find((f) => f.sensitive !== false);
}

function shouldAutoDecryptSensitiveValues(): boolean {
  return String(process.env.AUTO_DECRYPT || '').trim().toLowerCase() === 'true'
    && String(process.env.AURA_AGENT_PASSWORD || '').trim().length > 0;
}

function isSensitiveField(field: CredentialField): boolean {
  return field.sensitive !== false;
}

function toMetaBackedFields(meta: Record<string, unknown> | undefined): CredentialField[] {
  if (!meta || typeof meta !== 'object') return [];
  const out: CredentialField[] = [];
  for (const [key, rawValue] of Object.entries(meta)) {
    if (rawValue === undefined || rawValue === null) continue;

    if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      out.push({ key, value: String(rawValue), type: 'text', sensitive: false });
      continue;
    }

    if (Array.isArray(rawValue) && rawValue.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      out.push({ key, value: rawValue.map((v) => String(v)).join(','), type: 'text', sensitive: false });
    }
  }
  return out;
}

function mergeCredentialFields(
  type: string,
  decryptedFields: CredentialField[],
  meta: Record<string, unknown> | undefined,
): CredentialField[] {
  const out = [...decryptedFields];
  const known = new Set(out.map((field) => field.key.toLowerCase()));
  for (const metaField of normalizeCredentialFieldsForType(type, toMetaBackedFields(meta))) {
    const key = metaField.key.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    out.push(metaField);
  }
  return out;
}

function findField(type: string, fields: CredentialField[], key: string): CredentialField | undefined {
  const normalizedKey = key.trim().toLowerCase();
  if (!normalizedKey) return undefined;
  const direct = fields.find((field) => field.key.toLowerCase() === normalizedKey);
  if (direct) return direct;
  const canonicalKey = canonicalizeCredentialFieldKey(type, key);
  return fields.find((field) => field.key.toLowerCase() === canonicalKey.toLowerCase());
}

function normalizeListFilterQuery(input: string | undefined): string | null {
  const candidate = String(input || '').trim().toLowerCase();
  return candidate.length > 0 ? candidate : null;
}

function matchesListNameFilter(credential: CredentialMeta, query: string): boolean {
  if (credential.name.toLowerCase().includes(query)) return true;
  const title = typeof credential.meta?.title === 'string' ? credential.meta.title.toLowerCase() : '';
  return title.includes(query);
}

function matchesListFieldFilter(
  credential: CredentialMeta,
  decrypted: DecryptedCredential,
  query: string,
): boolean {
  const normalizedType = normalizeCredentialType(decrypted.type || credential.type);
  const mergedFields = mergeCredentialFields(normalizedType, decrypted.fields, credential.meta);
  return mergedFields.some((field) => {
    const keyMatch = field.key.toLowerCase().includes(query);
    const valueMatch = field.value.toLowerCase().includes(query);
    return keyMatch || valueMatch;
  });
}

const SECRET_EXEC_USAGE = 'Usage: npx auramaxx secret exec <name> [--env ENV_VAR] [-- <command>]';
const SECRET_INJECT_USAGE = 'Usage: npx auramaxx inject <name> [--env ENV_VAR] [-- <command>]';

interface ResolvedReadAuthContext {
  readToken: string;
  privateKeyPem: string;
  reqId?: string;
  consumeAfterAttempt: boolean;
}

function missingOrExpiredClaimPayload(reqId: string, retryCommandTemplate?: string): Record<string, unknown> {
  const claimCommand = `npx auramaxx auth claim ${reqId} --json`;
  const retryCommand = materializeRetryCommand(retryCommandTemplate, reqId);
  return {
    success: false,
    requiresHumanApproval: false,
    reqId,
    approvalScope: 'one_shot_read',
    errorCode: 'missing_or_expired_claim',
    claimStatus: 'expired',
    retryReady: false,
    error: `No active claimed token for reqId=${reqId}.`,
    nextAction: claimCommand,
    claimAction: {
      transport: 'cli',
      kind: 'command',
      command: claimCommand,
    },
    retryAction: {
      transport: 'cli',
      kind: 'command',
      command: retryCommand,
    },
    instructions: [
      `1) Ask a human to approve request ${reqId} in dashboard`,
      `2) Claim token: ${claimCommand}`,
      `3) Run this exact command: ${retryCommand}`,
    ],
  };
}

function printMissingOrExpiredClaim(reqId: string, retryCommandTemplate?: string): void {
  console.error(JSON.stringify(missingOrExpiredClaimPayload(reqId, retryCommandTemplate), null, 2));
}

async function resolveReadAuthContext(input: {
  authToken: string;
  keypair: EphemeralKeypair;
  decryptPrivateKeyPem: string;
  authSelection?: ProfileIssuanceSelection;
  reqId?: string;
  retryCommandTemplate?: string;
}): Promise<ResolvedReadAuthContext | null> {
  const reqId = String(input.reqId || '').trim();
  if (reqId) {
    const claimed = getClaimedToken(reqId);
    if (!claimed) {
      printMissingOrExpiredClaim(reqId, input.retryCommandTemplate);
      return null;
    }
    return {
      readToken: claimed.token,
      privateKeyPem: claimed.privateKeyPem || input.decryptPrivateKeyPem,
      reqId,
      consumeAfterAttempt: true,
    };
  }

  const readAuth = await getReadToken({
    authToken: input.authToken,
    keypair: input.keypair,
    authSelection: input.authSelection,
    fallbackDecryptPrivateKeyPem: input.decryptPrivateKeyPem,
  });
  return {
    readToken: readAuth.readToken,
    privateKeyPem: readAuth.decryptPrivateKeyPem,
    consumeAfterAttempt: false,
  };
}

function finalizeReadAuthContext(input: ResolvedReadAuthContext): void {
  if (input.consumeAfterAttempt && input.reqId) {
    consumeClaimedToken(input.reqId);
  }
}

async function runSecretExec(command: string[], envVarName: string, secretValue: string): Promise<number> {
  if (command.length === 0) {
    process.env[envVarName] = secretValue;
    printBanner('SECRET DECRYPTED');
    printStatus('Env Var', envVarName);
    printStatus('Docs', 'https://www.aurawallet.sh/docs/how-to-auramaxx/WORKING_WITH_SECRETS.md');
    printStatus('Secret', '*******');
    printSection('WHATDO');
    console.log(`Saved to env variable ${envVarName}.`);
    console.log("Scope: current CLI process only. Use '-- <command>' to inject into a child command.");
    console.log('');
    return 0;
  }

  return await new Promise<number>((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      env: {
        ...process.env,
        [envVarName]: secretValue,
      },
    });

    child.on('error', (error) => {
      console.error(`Failed to execute command: ${getErrorMessage(error)}`);
      resolve(1);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}

function resolveSetType(typeName: string | undefined): { requestType: string; normalizedType: string; defaultFieldKey: string } {
  const normalizedType = normalizeCredentialType(typeName);
  const requestType = ['login', 'card', 'sso', 'note', 'plain_note', 'hot_wallet', 'api', 'apikey', 'custom', 'passkey', 'oauth2', 'ssh', 'gpg'].includes(normalizedType)
    ? normalizedType
    : 'custom';
  const defaultFieldKey = getCredentialPrimaryFieldKey(normalizedType);
  return { requestType, normalizedType, defaultFieldKey };
}

function resolveFieldSensitivity(credentialType: string, fieldKey: string): boolean {
  const schema = CREDENTIAL_FIELD_SCHEMA[credentialType as CredentialType];
  if (!schema) return false;
  const spec = schema.find((f) => f.key.toLowerCase() === fieldKey.toLowerCase()
    || (f.aliases || []).some((a) => a.toLowerCase() === fieldKey.toLowerCase()));
  return spec ? spec.sensitive : false;
}

// ── Output formatting ──────────────────────────────────────────────────

export function formatCredential(
  target: { name: string; type: string; id: string; agentId?: string; meta?: Record<string, unknown> },
  decrypted: DecryptedCredential,
  opts: {
    json: boolean;
    fieldName?: string;
    autoDecryptSensitive?: boolean;
    encryptSensitiveValue?: (value: string) => string;
  },
): { output: string; exitCode: number } {
  if (opts.json) {
    return {
      output: JSON.stringify({
        name: target.name,
        type: target.type,
        id: target.id,
        agentId: decrypted.agentId || target.agentId,
        meta: target.meta || {},
        health: decrypted.health,
        fields: decrypted.fields,
      }, null, 2),
      exitCode: 0,
    };
  }

  const resolvedType = normalizeCredentialType(decrypted.type || target.type);
  const allFields = mergeCredentialFields(resolvedType, decrypted.fields, target.meta);
  const autoDecryptSensitive = opts.autoDecryptSensitive ?? true;
  const serializeFieldValue = (field: CredentialField): string => {
    if (!isSensitiveField(field) || autoDecryptSensitive) {
      return field.value;
    }
    if (!opts.encryptSensitiveValue) {
      return field.value;
    }
    return opts.encryptSensitiveValue(field.value);
  };

  if (opts.fieldName) {
    const field = findField(resolvedType, allFields, opts.fieldName);
    if (!field) {
      return {
        output: `Field "${opts.fieldName}" not found. Available: ${allFields.map((f) => f.key).join(', ')}`,
        exitCode: 1,
      };
    }
    return { output: serializeFieldValue(field), exitCode: 0 };
  }

  const primary = resolvePrimaryField(resolvedType, allFields);
  if (!primary) {
    return {
      output: 'No fields found on credential.',
      exitCode: 1,
    };
  }

  return {
    output: serializeFieldValue(primary),
    exitCode: 0,
  };
}

// ── Main command ───────────────────────────────────────────────────────

export async function runAgentCli(args: string[]): Promise<number> {
  const {
    subcommand,
    flagJson,
    flagFirst,
    flagTotp,
    flagOneTime,
    flagDangerPlaintext,
    fieldName,
    secretEnvName,
    agentName,
    expiresAfter,
    sharePassword,
    deleteLocation,
    reqId,
    authProfile,
    authProfileVersion,
    authProfileOverrides,
    typeName,
    tags,
    extraFields,
    positional,
    execCommand,
  } = parseArgs(args);

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    showHelp();
    return 0;
  }

  const keypair = generateEphemeralKeypair();
  let profileOverrides: ProfileIssuanceSelection['profileOverrides'] | undefined;
  if (authProfileOverrides) {
    try {
      const parsed = JSON.parse(authProfileOverrides) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('must be a JSON object');
      }
      profileOverrides = parsed as ProfileIssuanceSelection['profileOverrides'];
    } catch (error) {
      console.error(`Invalid --profile-overrides: ${getErrorMessage(error)}`);
      return 1;
    }
  }

  const authSelection: ProfileIssuanceSelection = {
    ...(authProfile ? { profile: authProfile } : {}),
    ...(authProfileVersion ? { profileVersion: authProfileVersion } : {}),
    ...(profileOverrides ? { profileOverrides } : {}),
  };
  const originalCommand = buildOriginalCommand(args);
  const retryCommandTemplate = appendReqIdPlaceholder(originalCommand);

  try {
    const { token, source: authSource, privateKeyPem: authPrivateKeyPem } = await getAuthToken(keypair, authSelection);
    const decryptPrivateKeyPem = authPrivateKeyPem || keypair.privateKeyPem;

    if (subcommand === 'list') {
      const listNameQuery = normalizeListFilterQuery(secretEnvName);
      const listFieldQuery = normalizeListFilterQuery(fieldName);

      let credentials = await listCredentials(token);
      if (agentName) {
        const normalizedAgentQuery = agentName.toLowerCase();
        const agentNames = await fetchAgentNameMap();
        credentials = credentials.filter((credential) => {
          const resolvedName = (agentNames.get(credential.agentId) || '').toLowerCase();
          const resolvedId = credential.agentId.toLowerCase();
          return resolvedName === normalizedAgentQuery || resolvedId === normalizedAgentQuery;
        });
      }
      if (listNameQuery) {
        credentials = credentials.filter((credential) => matchesListNameFilter(credential, listNameQuery));
      }

      if (listFieldQuery) {
        const readAuthContext = await resolveReadAuthContext({
          authToken: token,
          keypair,
          decryptPrivateKeyPem,
          authSelection,
          reqId,
          retryCommandTemplate,
        });
        if (!readAuthContext) return 1;
        let fieldMatches: boolean[] = [];
        try {
          fieldMatches = await Promise.all(credentials.map(async (credential) => {
            try {
              const decrypted = await readCredential(credential.id, readAuthContext.readToken, readAuthContext.privateKeyPem, {
                retryCommandTemplate,
                originalCommand,
              });
              return matchesListFieldFilter(credential, decrypted, listFieldQuery);
            } catch {
              // Best effort: unreadable credentials are excluded from field-filtered results.
              return false;
            }
          }));
        } finally {
          finalizeReadAuthContext(readAuthContext);
        }
        credentials = credentials.filter((_credential, idx) => fieldMatches[idx]);
      }

      if (flagJson) {
        console.log(JSON.stringify(credentials.map((c) => ({ name: c.name, type: c.type, id: c.id })), null, 2));
      } else if (credentials.length === 0) {
        console.log('No credentials found.');
      } else {
        for (const c of credentials) {
          console.log(`${c.name}  (${c.type})`);
        }
      }
      return 0;
    }

    if (subcommand === 'health') {
      const summary = await fetchHealthSummary(token);
      if (flagJson) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`Analyzed: ${summary.totalAnalyzed}`);
        console.log(`Safe: ${summary.safe}`);
        console.log(`Weak: ${summary.weak}`);
        console.log(`Reused: ${summary.reused}`);
        console.log(`Breached: ${summary.breached}`);
        console.log(`Unknown: ${summary.unknown}`);
      }
      return 0;
    }

    if (subcommand === 'secret' || subcommand === 'inject' || subcommand === 'use') {
      const isInjectShortcut = subcommand === 'inject' || subcommand === 'use';
      const action = isInjectShortcut ? 'exec' : positional[0];
      const name = isInjectShortcut ? positional[0] : positional[1];
      if (action !== 'exec' || !name) {
        console.error(isInjectShortcut ? SECRET_INJECT_USAGE : SECRET_EXEC_USAGE);
        return 1;
      }

      const requestedEnvVar = secretEnvName || defaultSecretEnvVarName(name);
      const envVarName = normalizeEnvVarName(requestedEnvVar);
      if (!envVarName) {
        console.error('Invalid --env. Expected shell env var format like AURA_SECRET or GITHUB_PAT.');
        return 1;
      }

      const { target } = await resolveCredentialTarget(token, name, {
        agentName,
        first: flagFirst,
        surface: 'cli_secret_exec',
        actor: 'cli-agent',
      });

      const readAuthContext = await resolveReadAuthContext({
        authToken: token,
        keypair,
        decryptPrivateKeyPem,
        authSelection,
        reqId,
        retryCommandTemplate,
      });
      if (!readAuthContext) return 1;

      try {
        const resolvedType = normalizeCredentialType(target.type);
        const requestedFieldKey = fieldName
          ? canonicalizeCredentialFieldKey(resolvedType, fieldName)
          : getCredentialPrimaryFieldKey(resolvedType);
        const requestedFields = [
          requestedFieldKey,
        ];
        const decrypted = await readCredential(target.id, readAuthContext.readToken, readAuthContext.privateKeyPem, {
          retryCommandTemplate,
          originalCommand,
          requestedFields,
        });
        const effectiveType = normalizeCredentialType(decrypted.type || target.type);
        const allFields = mergeCredentialFields(effectiveType, decrypted.fields, target.meta);
        const selectedField = fieldName
          ? findField(effectiveType, allFields, fieldName)
          : resolvePrimarySecretField(effectiveType, allFields);
        if (!selectedField) {
          if (fieldName) {
            console.error(`Field "${fieldName}" not found on credential.`);
          } else {
            console.error('No sensitive field found on credential.');
          }
          return 1;
        }

        return await runSecretExec(execCommand, envVarName, selectedField.value);
      } finally {
        finalizeReadAuthContext(readAuthContext);
      }
    }

    if (subcommand === 'get') {
      const name = positional[0];
      if (!name) {
        console.error('Usage: npx auramaxx agent get <name>');
        return 1;
      }

      const { target } = await resolveCredentialTarget(token, name, {
        agentName,
        first: flagFirst,
        surface: 'cli_agent_get',
        actor: 'cli-agent',
      });

      if (flagTotp) {
        const totp = await fetchTotpCode(target.id, token, { originalCommand });
        process.stdout.write(totp.code);
        return 0;
      }

      const readAuthContext = await resolveReadAuthContext({
        authToken: token,
        keypair,
        decryptPrivateKeyPem,
        authSelection,
        reqId,
        retryCommandTemplate,
      });
      if (!readAuthContext) return 1;

      const resolvedTargetType = normalizeCredentialType(target.type);
      const requestedReadFields = flagJson
        ? (fieldName
            ? [canonicalizeCredentialFieldKey(resolvedTargetType, fieldName)]
            : ['*'])
        : fieldName
          ? [canonicalizeCredentialFieldKey(resolvedTargetType, fieldName)]
          : [getCredentialPrimaryFieldKey(resolvedTargetType)];

      let decrypted: DecryptedCredential;
      try {
        decrypted = await readCredential(target.id, readAuthContext.readToken, readAuthContext.privateKeyPem, {
          retryCommandTemplate,
          originalCommand,
          requestedFields: requestedReadFields,
        });
      } finally {
        finalizeReadAuthContext(readAuthContext);
      }

      const hasTotpField = decrypted.fields.some((f) => f.key === 'totp' || f.key === 'otp');
      if (hasTotpField) {
        try {
          const totp = await fetchTotpCode(target.id, token, { originalCommand });
          decrypted.fields.push({ key: 'totp_code', value: totp.code, type: 'text', sensitive: false });
        } catch {
          // ignore TOTP enrichment failure
        }
      }

      if (execCommand.length > 0) {
        const requestedEnvVar = secretEnvName || defaultSecretEnvVarName(target.name || name);
        const envVarName = normalizeEnvVarName(requestedEnvVar);
        if (!envVarName) {
          console.error('Invalid --env. Expected shell env var format like AURA_SECRET or GITHUB_PAT.');
          return 1;
        }

        const resolvedType = normalizeCredentialType(decrypted.type || target.type);
        const allFields = mergeCredentialFields(resolvedType, decrypted.fields, target.meta);
        const selectedField = fieldName
          ? findField(resolvedType, allFields, fieldName)
          : resolvePrimarySecretField(resolvedType, allFields) || resolvePrimaryField(resolvedType, allFields);
        if (fieldName && !selectedField) {
          console.error(`Field "${fieldName}" not found. Available: ${allFields.map((f) => f.key).join(', ')}`);
          return 1;
        }
        const secretValue = selectedField?.value || '';
        if (!secretValue) {
          console.error(`Credential "${target.name || name}" has no extractable secret value`);
          return 1;
        }

        return await runSecretExec(execCommand, envVarName, secretValue);
      }

      if (authSource === 'socket' && !flagJson && !fieldName) {
        const noteField = getCredentialFieldValue('note', decrypted.fields, NOTE_CONTENT_KEY);
        const passwordField = decrypted.fields.find((f) => f.sensitive)?.value;
        const secretValue = noteField || passwordField || decrypted.fields[0]?.value || '';
        if (!secretValue) {
          console.error(`Credential "${target.name || name}" has no extractable secret value`);
          return 1;
        }

        const envVar = defaultSecretEnvVarName(target.name || name);
        process.env[envVar] = secretValue;
        printBanner('SECRET DECRYPTED');
        printStatus('Env Var', envVar);
        printStatus('Docs', 'https://www.aurawallet.sh/docs/how-to-auramaxx/WORKING_WITH_SECRETS.md');
        printStatus('Secret', flagDangerPlaintext ? secretValue : '*******');
        printSection('WHATDO');
        console.log(`Saved to env variable ${envVar}.`);
        console.log("Scope: current CLI process only. Use '-- <command>' to inject into a child command.");
        console.log('');
        return 0;
      }

      const autoDecryptSensitive = shouldAutoDecryptSensitiveValues();
      const result = formatCredential(target, decrypted, {
        json: flagJson,
        fieldName,
        autoDecryptSensitive,
        encryptSensitiveValue: (value: string) => encryptToAgentPubkey(value, keypair.publicKeyPem),
      });
      if (result.exitCode !== 0) {
        console.error(result.output);
        return result.exitCode;
      }

      if (fieldName) {
        process.stdout.write(result.output);
      } else {
        console.log(result.output);
      }
      return 0;
    }

    if (subcommand === 'set') {
      const name = positional[0];
      const value = positional[1];
      const resolvedType = resolveSetType(typeName);
      const fieldKey = fieldName || resolvedType.defaultFieldKey;

      if (!name || value === undefined) {
        console.error('Usage: npx auramaxx agent set <name> <value> [--type <type>] [--field <key>] [--tags a,b,c] [--agent <name>] [--another-field <value>]');
        return 1;
      }

      const setFields: Array<{ key: string; value: string; sensitive?: boolean }> = [
        { key: fieldKey, value, sensitive: true },
        ...extraFields.map((f) => ({ key: f.key, value: f.value, sensitive: resolveFieldSensitivity(resolvedType.requestType, f.key) })),
      ];
      const nextMeta = tags ? { tags } : undefined;

      const matches = await searchCredentials(token, name);
      if (matches.length > 0) {
        const { target } = await resolveCredentialTarget(token, name, {
          agentName,
          first: flagFirst,
          surface: 'cli_agent_set',
          actor: 'cli-agent',
        });

        let nextFields: Array<{ key: string; value: string; type?: string; sensitive?: boolean }> = [...setFields];

        // Preserve existing fields when read scope is available.
        try {
          const readAuthContext = await resolveReadAuthContext({
            authToken: token,
            keypair,
            decryptPrivateKeyPem,
            authSelection,
            reqId,
            retryCommandTemplate,
          });
          if (!readAuthContext) return 1;
          try {
            const decrypted = await readCredential(target.id, readAuthContext.readToken, readAuthContext.privateKeyPem, {
              retryCommandTemplate,
              originalCommand,
            });
            const effectiveType = decrypted.type || resolvedType.requestType;
            const existing = [...decrypted.fields];
            for (const next of setFields) {
              const index = existing.findIndex((f) => f.key.toLowerCase() === next.key.toLowerCase());
              const sensitive = next.sensitive ?? resolveFieldSensitivity(effectiveType, next.key);
              if (index >= 0) {
                existing[index] = { ...existing[index], key: next.key, value: next.value, sensitive };
              } else {
                existing.push({ key: next.key, value: next.value, sensitive });
              }
            }
            nextFields = existing;
          } finally {
            finalizeReadAuthContext(readAuthContext);
          }
        } catch {
          // write-only tokens may not be allowed to read; replace with single field in that case.
        }

        const updated = await updateCredential(token, target.id, {
          sensitiveFields: nextFields.map((f) => ({ key: f.key, value: f.value, sensitive: f.sensitive ?? false })),
          ...(nextMeta ? { meta: nextMeta } : {}),
        });

        if (flagJson) {
          console.log(JSON.stringify({ success: true, action: 'updated', credential: updated }, null, 2));
        } else {
          console.log(`Updated ${updated.name} (${updated.id})`);
        }
        return 0;
      }

      const agents = await fetchAgents();
      const agentId = resolveAgentId(agents, agentName);
      const created = await createCredential(token, {
        agentId,
        type: resolvedType.requestType,
        name,
        sensitiveFields: setFields,
        ...(nextMeta ? { meta: nextMeta } : {}),
      });

      if (flagJson) {
        console.log(JSON.stringify({ success: true, action: 'created', credential: created }, null, 2));
      } else {
        console.log(`Created ${created.name} (${created.id})`);
      }
      return 0;
    }

    if (subcommand === 'share') {
      const name = positional[0];
      if (!name) {
        console.error('Usage: npx auramaxx agent share <name> [--expires-after 24h] [--password xxx] [--one-time]');
        return 1;
      }

      const { target } = await resolveCredentialTarget(token, name, {
        agentName,
        first: flagFirst,
        surface: 'cli_agent_share',
        actor: 'cli-agent',
      });

      const accessMode: 'anyone' | 'password' = sharePassword ? 'password' : 'anyone';
      const shareResult = await createShare(token, {
        credentialId: target.id,
        expiresAfter: expiresAfter || '24h',
        accessMode,
        ...(sharePassword ? { password: sharePassword } : {}),
        oneTimeOnly: flagOneTime,
      });
      if (!shareResult) throw new Error('Share creation returned empty result');
      const share = shareResult;

      const link = resolveShareUrlForGist(share.token);
      const fallbackLink = `${serverUrl()}/credential-shares/${share.token}`;
      const normalizedType = normalizeCredentialType(target.type);
      let gistFields = normalizeCredentialFieldsForType(
        normalizedType,
        toMetaBackedFields(target.meta),
      )
        .map((field) => ({
          key: String(field.key || '').trim(),
          value: String(field.value || '').trim(),
          sensitive: field.sensitive !== false,
        }))
        .filter((field) => field.key.length > 0 && field.value.length > 0);
      try {
        const readAuthContext = await resolveReadAuthContext({
          authToken: token,
          keypair,
          decryptPrivateKeyPem,
          authSelection,
          reqId,
          retryCommandTemplate,
        });
        if (!readAuthContext) return 1;
        try {
          const decrypted = await readCredential(target.id, readAuthContext.readToken, readAuthContext.privateKeyPem, {
            retryCommandTemplate,
            originalCommand,
          });
          gistFields = mergeCredentialFields(
            normalizedType,
            decrypted.fields,
            target.meta,
          )
            .map((field) => ({
              key: String(field.key || '').trim(),
              value: String(field.value || '').trim(),
              sensitive: field.sensitive !== false,
            }))
            .filter((field) => field.key.length > 0 && field.value.length > 0);
        } finally {
          finalizeReadAuthContext(readAuthContext);
        }
      } catch {
        // Preserve share behavior for write-only tokens; gist may still include non-secret metadata.
      }
      let gist: Awaited<ReturnType<typeof createSecretGist>> | null = null;
      let gistError: SecretGistError | null = null;
      try {
        gist = await createSecretGist({
          credentialId: target.id,
          credentialName: target.name,
          credentialType: target.type,
          shareUrl: link,
          accessMode: share.accessMode,
          oneTimeOnly: share.oneTimeOnly,
          expiresAfter: expiresAfter || '24h',
          fields: gistFields,
        });
      } catch (error) {
        if (error instanceof SecretGistError) {
          gistError = error;
        } else {
          throw error;
        }
      }

      if (flagJson) {
        console.log(JSON.stringify({
          success: true,
          share,
          link: gist ? link : fallbackLink,
          gist,
          fallback: gist ? null : 'local_link',
          gistError: gistError
            ? {
                code: gistError.code,
                message: gistError.message,
                remediation: gistError.remediation,
                detail: gistError.detail,
              }
            : null,
        }, null, 2));
      } else {
        if (gist) {
          console.log(`Secret gist created for ${target.name}`);
          console.log(`  gist: ${gist.url}`);
          console.log(`  marker: ${gist.marker}`);
          console.log(`  title: ${gist.title}`);
        } else {
          console.log(`GitHub gist unavailable for ${target.name}; using local share link fallback.`);
          if (gistError) {
            console.log(`  gistError: ${gistError.message}`);
            console.log(`  remediation: ${gistError.remediation}`);
            if (gistError.detail) {
              console.log(`  detail: ${gistError.detail}`);
            }
          }
          console.log(`  shareLink: ${fallbackLink}`);
        }
        console.log(`  token: ${share.token}`);
        console.log(`  shareLink: ${gist ? link : fallbackLink}`);
        console.log(`  accessMode: ${share.accessMode}`);
        console.log(`  oneTimeOnly: ${share.oneTimeOnly}`);
      }
      return 0;
    }

    if (subcommand === 'delete' || subcommand === 'del') {
      const name = positional[0];
      if (!name) {
        console.error('Usage: npx auramaxx agent delete <name> [--location active|archive|recently_deleted]');
        return 1;
      }

      const location = (deleteLocation || 'active').toLowerCase();
      if (!['active', 'archive', 'recently_deleted'].includes(location)) {
        console.error('Invalid --location. Expected active, archive, or recently_deleted.');
        return 1;
      }

      const { target } = await resolveCredentialTarget(token, name, {
        agentName,
        first: flagFirst,
        surface: 'cli_agent_delete',
        actor: 'cli-agent',
      });

      const result = await deleteCredential(
        token,
        target.id,
        location as 'active' | 'archive' | 'recently_deleted',
      );

      if (flagJson) {
        console.log(JSON.stringify({ success: true, credentialId: target.id, result }, null, 2));
      } else {
        console.log(`Deleted ${target.name} (${target.id}) -> ${result.action || 'ok'}`);
      }
      return 0;
    }

    console.error(`Unknown agent subcommand: ${subcommand}`);
    showHelp();
    return 1;
  } catch (error) {
    if (error instanceof SecretGistError) {
      console.error(`Error: ${error.message}`);
      console.error(`Remediation: ${error.remediation}`);
      if (error.detail) {
        console.error(`Detail: ${error.detail}`);
      }
      return 1;
    }
    const handledLock = await maybeHandleLockError({ context: 'agent command', error });
    if (!handledLock) {
      console.error(`Error: ${getErrorMessage(error)}`);
    }
    return 1;
  }
}

async function main(): Promise<void> {
  const exitCode = await runAgentCli(process.argv.slice(2));
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error: ${getErrorMessage(error)}`);
    process.exit(1);
  });
}
