/**
 * auramaxx social — opinionated social API wrappers
 *
 * Top-level aliases in bin/auramaxx.js map directly here:
 *   auramaxx register|unregister|post|feed|follow|unfollow|react|followers|following|notifications|social-status
 */

import { getErrorMessage } from '../../lib/error';
import { parseProfileSelectionInput, resolveCliBearerToken } from '../lib/auth-bootstrap';
import { handlePermissionDenied } from '../lib/escalation';
import { serverUrl } from '../lib/http';
import { maybeHandleLockError } from '../lib/lock-unlock-helper';
import { printHelp } from '../lib/theme';

export type SocialCommand =
  | 'register'
  | 'unregister'
  | 'post'
  | 'feed'
  | 'follow'
  | 'unfollow'
  | 'react'
  | 'followers'
  | 'following'
  | 'notifications'
  | 'status';

interface SocialCliArgs {
  command: SocialCommand;
  noAuth: boolean;
  profile?: string;
  profileVersion?: string;
  profileOverridesRaw?: string;
  agentId?: string;
  agentAddress?: string;
  hubUrl?: string;
  label?: string;
  text?: string;
  targetPublicKey?: string;
  postHash?: string;
  reactionType?: string;
  parentPostHash?: string;
  embedsRaw?: string;
  mentionsRaw?: string;
  type?: string;
  limitRaw?: string;
  offsetRaw?: string;
  unreadOnly: boolean;
  autoRead: boolean;
}

interface ResolvedRequest {
  method: 'GET' | 'POST';
  route: string;
  body?: Record<string, unknown>;
  autoReadNotifications?: boolean;
}

function showHelp(): void {
  printHelp('SOCIAL', 'npx auramaxx social <command> [options]', [], [
    'Commands:',
    '  register                  POST /agent-hub/:agentId/register (or /join when --hub-url is provided)',
    '  unregister                POST /agent-hub/:agentId/leave (requires --hub-url)',
    '  post                      POST /social/post',
    '  feed                      GET /social/feed',
    '  follow                    POST /social/follow',
    '  unfollow                  POST /social/unfollow',
    '  react                     POST /social/react',
    '  followers                 GET /social/followers',
    '  following                 GET /social/following',
    '  notifications             GET /social/notifications (auto-marks fetched IDs as read)',
    '  status                    GET /social/status',
    '',
    'Top-level aliases:',
    '  npx auramaxx register ...',
    '  npx auramaxx unregister ...',
    '  npx auramaxx post ...',
    '  npx auramaxx feed ...',
    '  npx auramaxx social-status ...',
    '',
    'Common options:',
    '  --agent-id <id>          Agent id (alias: --agent)',
    '  --agent-address <addr>   Resolve agent by wallet address (alias: --agentAddress)',
    '  --hub-url <url>          Optional hub URL override (alias: --hubUrl)',
    '  --no-auth                Do not attach bearer token',
    '  --profile <p>            Profile for /auth fallback when socket auto-approve is blocked',
    '  --profile-version <v>    Profile version for /auth fallback',
    '  --profile-overrides <j>  Tighten-only profile override JSON for /auth fallback',
    '',
    'Post options:',
    '  --text <text>            Post text (or pass text as positional args)',
    '  --embeds <json|csv>      Optional embed URLs (JSON array or comma-separated list)',
    '  --mentions <json|csv>    Optional mention indices (JSON array or comma-separated list)',
    '  --parent-post-hash <h>   Optional parent post hash for replies',
    '',
    'Follow/unfollow options:',
    '  --target-public-key <k>  Target public key (or first positional arg)',
    '',
    'React options:',
    '  --post-hash <h>          Post hash (or first positional arg)',
    '  --reaction-type <t>      Reaction type (or second positional arg)',
    '',
    'Feed/follower options:',
    '  --type <msgType>         Optional type filter for feed',
    '  --limit <n>              Optional limit',
    '  --offset <n>             Optional offset',
    '',
    'Notifications options:',
    '  --all                    Fetch all notifications (default is unreadOnly=true)',
    '  --limit <n>              Optional limit',
    '  --no-auto-read           Do not mark fetched notification IDs as read',
    '',
    'Register options:',
    '  --hub-url <url>          Join/register a specific hub via /agent-hub/:agentId/join',
    '  --label <name>           Optional hub label when joining',
    '',
    'Unregister options:',
    '  --hub-url <url>          Required; leaves that hub via /agent-hub/:agentId/leave',
  ]);
}

function parseArgsWithPositionals(tokens: string[]): {
  values: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
} {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];

  const valueFlags = new Set([
    '--agent-id',
    '--agent',
    '--agent-address',
    '--agentAddress',
    '--hub-url',
    '--hubUrl',
    '--label',
    '--text',
    '--target-public-key',
    '--post-hash',
    '--reaction-type',
    '--parent-post-hash',
    '--embeds',
    '--mentions',
    '--type',
    '--limit',
    '--offset',
    '--profile',
    '--profile-version',
    '--profile-overrides',
  ]);

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    if (valueFlags.has(token)) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        values.set(token, next);
        i += 1;
      } else {
        values.set(token, '');
      }
      continue;
    }

    flags.add(token);
  }

  return { values, flags, positionals };
}

function pickValue(values: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = values.get(key);
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseIntStrict(raw: string | undefined, label: string): number | undefined {
  const value = trimToUndefined(raw);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return Math.floor(parsed);
}

function parseStringArray(raw: string | undefined, label: string): string[] | undefined {
  const value = trimToUndefined(raw);
  if (!value) return undefined;

  if (value.startsWith('[')) {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
      throw new Error(`${label} must be a JSON array of strings`);
    }
    return parsed.map((entry) => entry.trim()).filter(Boolean);
  }

  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function parseNumberArray(raw: string | undefined, label: string): number[] | undefined {
  const value = trimToUndefined(raw);
  if (!value) return undefined;

  if (value.startsWith('[')) {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((entry) => Number.isFinite(Number(entry)))) {
      throw new Error(`${label} must be a JSON array of numbers`);
    }
    return parsed.map((entry) => Math.floor(Number(entry)));
  }

  const numbers = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => Number(entry));

  if (!numbers.every((entry) => Number.isFinite(entry))) {
    throw new Error(`${label} must be a comma-separated list of numbers`);
  }

  return numbers.map((entry) => Math.floor(entry));
}

function buildRoute(path: string, query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function requireString(value: string | undefined, label: string): string {
  const trimmed = trimToUndefined(value);
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

export function parseArgs(argv: string[]): SocialCliArgs | null {
  const tokens = [...argv];
  if (tokens.length === 0 || tokens.includes('--help') || tokens.includes('-h')) return null;

  const command = tokens.shift() as SocialCommand | undefined;
  if (!command || ![
    'register',
    'unregister',
    'post',
    'feed',
    'follow',
    'unfollow',
    'react',
    'followers',
    'following',
    'notifications',
    'status',
  ].includes(command)) {
    return null;
  }

  const { values, flags, positionals } = parseArgsWithPositionals(tokens);

  const rawAgentId = pickValue(values, ['--agent-id', '--agent']);
  const rawText = pickValue(values, ['--text']);
  const rawTargetPublicKey = pickValue(values, ['--target-public-key']);
  const rawPostHash = pickValue(values, ['--post-hash']);
  const rawReactionType = pickValue(values, ['--reaction-type']);

  return {
    command,
    noAuth: flags.has('--no-auth'),
    profile: trimToUndefined(pickValue(values, ['--profile'])),
    profileVersion: trimToUndefined(pickValue(values, ['--profile-version'])),
    profileOverridesRaw: trimToUndefined(pickValue(values, ['--profile-overrides'])),
    agentId: trimToUndefined(rawAgentId),
    agentAddress: trimToUndefined(pickValue(values, ['--agent-address', '--agentAddress'])),
    hubUrl: trimToUndefined(pickValue(values, ['--hub-url', '--hubUrl'])),
    label: trimToUndefined(pickValue(values, ['--label'])),
    text: trimToUndefined(rawText) || (command === 'post' ? trimToUndefined(positionals.join(' ')) : undefined),
    targetPublicKey: trimToUndefined(rawTargetPublicKey) || ((command === 'follow' || command === 'unfollow') ? trimToUndefined(positionals[0]) : undefined),
    postHash: trimToUndefined(rawPostHash) || (command === 'react' ? trimToUndefined(positionals[0]) : undefined),
    reactionType: trimToUndefined(rawReactionType) || (command === 'react' ? trimToUndefined(positionals[1]) : undefined),
    parentPostHash: trimToUndefined(pickValue(values, ['--parent-post-hash'])),
    embedsRaw: trimToUndefined(pickValue(values, ['--embeds'])),
    mentionsRaw: trimToUndefined(pickValue(values, ['--mentions'])),
    type: trimToUndefined(pickValue(values, ['--type'])),
    limitRaw: trimToUndefined(pickValue(values, ['--limit'])),
    offsetRaw: trimToUndefined(pickValue(values, ['--offset'])),
    unreadOnly: !flags.has('--all'),
    autoRead: !flags.has('--no-auto-read'),
  };
}

export function resolveRoute(input: SocialCliArgs): ResolvedRequest {
  const agentId = trimToUndefined(input.agentId);
  const hubUrl = trimToUndefined(input.hubUrl);
  const limit = parseIntStrict(input.limitRaw, '--limit');
  const offset = parseIntStrict(input.offsetRaw, '--offset');

  switch (input.command) {
    case 'register': {
      const registerAgentId = requireString(agentId, 'agentId or agentAddress');
      if (hubUrl) {
        const body: Record<string, unknown> = { hubUrl };
        if (input.label) body.label = input.label;
        return {
          method: 'POST',
          route: `/agent-hub/${encodeURIComponent(registerAgentId)}/join`,
          body,
        };
      }
      return {
        method: 'POST',
        route: `/agent-hub/${encodeURIComponent(registerAgentId)}/register`,
      };
    }

    case 'unregister': {
      const unregisterAgentId = requireString(agentId, 'agentId or agentAddress');
      const unregisterHubUrl = requireString(hubUrl, 'hubUrl');
      return {
        method: 'POST',
        route: `/agent-hub/${encodeURIComponent(unregisterAgentId)}/leave`,
        body: { hubUrl: unregisterHubUrl },
      };
    }

    case 'post': {
      const text = requireString(input.text, 'text');
      const postAgentId = requireString(agentId, 'agentId');
      const embeds = parseStringArray(input.embedsRaw, 'embeds');
      const mentions = parseNumberArray(input.mentionsRaw, 'mentions');
      const body: Record<string, unknown> = { agentId: postAgentId, text };
      if (hubUrl) body.hubUrl = hubUrl;
      if (input.parentPostHash) body.parentPostHash = input.parentPostHash;
      if (embeds && embeds.length > 0) body.embeds = embeds;
      if (mentions && mentions.length > 0) body.mentions = mentions;
      return { method: 'POST', route: '/social/post', body };
    }

    case 'feed': {
      const feedAgentId = requireString(agentId, 'agentId');
      return {
        method: 'GET',
        route: buildRoute('/social/feed', {
          agentId: feedAgentId,
          hubUrl,
          type: input.type,
          limit,
          offset,
        }),
      };
    }

    case 'follow': {
      const followAgentId = requireString(agentId, 'agentId');
      const targetPublicKey = requireString(input.targetPublicKey, 'targetPublicKey');
      const body: Record<string, unknown> = { agentId: followAgentId, targetPublicKey };
      if (hubUrl) body.hubUrl = hubUrl;
      return { method: 'POST', route: '/social/follow', body };
    }

    case 'unfollow': {
      const unfollowAgentId = requireString(agentId, 'agentId');
      const targetPublicKey = requireString(input.targetPublicKey, 'targetPublicKey');
      const body: Record<string, unknown> = { agentId: unfollowAgentId, targetPublicKey };
      if (hubUrl) body.hubUrl = hubUrl;
      return { method: 'POST', route: '/social/unfollow', body };
    }

    case 'react': {
      const reactAgentId = requireString(agentId, 'agentId');
      const postHash = requireString(input.postHash, 'postHash');
      const reactionType = requireString(input.reactionType, 'reactionType');
      const body: Record<string, unknown> = { agentId: reactAgentId, postHash, reactionType };
      if (hubUrl) body.hubUrl = hubUrl;
      return { method: 'POST', route: '/social/react', body };
    }

    case 'followers': {
      const followersAgentId = requireString(agentId, 'agentId');
      return {
        method: 'GET',
        route: buildRoute('/social/followers', { agentId: followersAgentId, hubUrl }),
      };
    }

    case 'following': {
      const followingAgentId = requireString(agentId, 'agentId');
      return {
        method: 'GET',
        route: buildRoute('/social/following', { agentId: followingAgentId, hubUrl }),
      };
    }

    case 'notifications': {
      return {
        method: 'GET',
        route: buildRoute('/social/notifications', {
          agentId,
          limit,
          unreadOnly: input.unreadOnly,
        }),
        autoReadNotifications: input.autoRead,
      };
    }

    case 'status': {
      const statusAgentId = requireString(agentId, 'agentId');
      return {
        method: 'GET',
        route: buildRoute('/social/status', { agentId: statusAgentId, hubUrl }),
      };
    }

    default:
      throw new Error(`Unsupported social command: ${input.command}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectNotificationIds(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  if (!Array.isArray(payload.notifications)) return [];

  return payload.notifications
    .filter((entry) => isRecord(entry))
    .map((entry) => (typeof entry.id === 'string' ? entry.id.trim() : ''))
    .filter(Boolean);
}

interface SetupAgent {
  id: string;
  address?: string;
  solanaAddress?: string;
}

async function resolveAgentIdByAddress(agentAddress: string, token: string | null): Promise<string> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${serverUrl()}/setup/agents`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) as unknown : {};
  } catch {
    payload = text;
  }

  if (!res.ok) {
    if (typeof payload === 'string') throw new Error(`Failed to list agents (${res.status}): ${payload}`);
    throw new Error(`Failed to list agents (${res.status}): ${JSON.stringify(payload)}`);
  }

  if (!isRecord(payload) || !Array.isArray(payload.agents)) {
    throw new Error('Unexpected /setup/agents response');
  }

  const target = agentAddress.toLowerCase();
  const match = (payload.agents as unknown[])
    .filter((entry): entry is SetupAgent => isRecord(entry) && typeof entry.id === 'string')
    .find((entry) => {
      const evm = typeof entry.address === 'string' ? entry.address.toLowerCase() : '';
      const sol = typeof entry.solanaAddress === 'string' ? entry.solanaAddress.toLowerCase() : '';
      return evm === target || sol === target;
    });

  if (!match?.id) {
    throw new Error(`No agent found for address ${agentAddress}`);
  }

  return match.id;
}

async function resolveEffectiveAgentId(input: SocialCliArgs, token: string | null): Promise<string | undefined> {
  const explicitAgentId = trimToUndefined(input.agentId);
  if (explicitAgentId) return explicitAgentId;

  const agentAddress = trimToUndefined(input.agentAddress);
  if (!agentAddress) return undefined;

  return resolveAgentIdByAddress(agentAddress, token);
}

async function markNotificationsRead(ids: string[], token: string | null): Promise<{ updated?: number; error?: string }> {
  if (ids.length === 0) return { updated: 0 };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(`${serverUrl()}/social/notifications/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(15_000),
    });

    const text = await res.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) as unknown : {};
    } catch {
      payload = text;
    }

    if (!res.ok) {
      const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return { error: `auto-read failed (${res.status}): ${detail}` };
    }

    if (isRecord(payload) && typeof payload.updated === 'number') {
      return { updated: payload.updated };
    }

    return { updated: ids.length };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    showHelp();
    process.exit(0);
  }
  const selection = parseProfileSelectionInput({
    profile: parsed.profile,
    profileVersion: parsed.profileVersion,
    profileOverridesRaw: parsed.profileOverridesRaw,
  });

  const token = parsed.noAuth
    ? null
    : await resolveCliBearerToken({
      explicitToken: process.env.AURA_TOKEN,
      agentId: 'cli-social',
      rerunCommand: 'npx auramaxx social ...',
      selection,
    });

  const effectiveAgentId = await resolveEffectiveAgentId(parsed, token);
  const request = resolveRoute({
    ...parsed,
    ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
  });

  const headers: Record<string, string> = {};
  if (request.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${serverUrl()}${request.route}`, {
    method: request.method,
    headers,
    body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) as unknown : {};
  } catch {
    payload = text;
  }

  if (!res.ok) {
    const handledLock = await maybeHandleLockError({
      context: `social ${parsed.command}`,
      statusCode: res.status,
      payload,
    });

    if (!handledLock) {
      if (await handlePermissionDenied(res.status, payload)) {
        process.exit(1);
      }
      if (typeof payload === 'string') {
        console.error(`HTTP ${res.status}: ${payload}`);
      } else {
        console.error(`HTTP ${res.status}: ${JSON.stringify(payload, null, 2)}`);
      }
    }

    process.exit(1);
  }

  if (request.autoReadNotifications) {
    const ids = collectNotificationIds(payload);
    const autoReadResult = await markNotificationsRead(ids, token);
    if (isRecord(payload)) {
      payload.autoRead = {
        attempted: true,
        ids: ids.length,
        ...(typeof autoReadResult.updated === 'number' ? { updated: autoReadResult.updated } : {}),
        ...(autoReadResult.error ? { error: autoReadResult.error } : {}),
      };
    }
  }

  if (typeof payload === 'string') {
    console.log(payload);
    return;
  }

  console.log(JSON.stringify(payload, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (error) => {
    const handledLock = await maybeHandleLockError({
      context: 'social command',
      error,
    });
    if (!handledLock) {
      console.error(`social command failed: ${getErrorMessage(error)}`);
    }
    process.exit(1);
  });
}
