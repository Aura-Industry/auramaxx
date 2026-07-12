/**
 * auramaxx diary — Write heartbeat diary entries via authenticated CLI path.
 *
 * Usage:
 *   npx auramaxx diary write --entry "Heartbeat summary"
 *   npx auramaxx diary write --entry "Heartbeat summary" --date 2026-02-23
 */

import {
  bootstrapViaAuthRequest,
  bootstrapViaSocket,
  generateEphemeralKeypair,
  type ProfileIssuanceSelection,
} from '../../lib/credential-transport';
import { getErrorMessage } from '../../lib/error';
import { handlePermissionDenied } from '../lib/escalation';
import { maybeHandleLockError } from '../lib/lock-unlock-helper';
import { serverUrl } from '../lib/http';
import { printHelp } from '../lib/theme';

interface DiaryCliArgs {
  subcommand: 'write';
  entry: string;
  date?: string;
  agentId?: string;
  profile?: string;
  profileVersion?: string;
  profileOverridesRaw?: string;
}

function showHelp(): void {
  printHelp('DIARY', 'npx auramaxx diary write --entry <text> [options]', [
    { name: 'write', desc: 'Append an entry to {YYYY-MM-DD}_LOGS note' },
  ], [
    'Examples:',
    '  npx auramaxx diary write --entry "Heartbeat: no pending approvals, sync ok."',
    '  npx auramaxx diary write --entry "Task queue idle." --date 2026-02-23',
    '  npx auramaxx diary write --entry "Scoped write to a custom agent." --agent-id primary',
    '',
    'Options:',
    '  --entry <text>            Diary text to append (required)',
    '  --date <YYYY-MM-DD>       Optional date key (defaults to current UTC day)',
    '  --agent-id <id>           Optional target agent id',
    '  --profile <p>             Profile for /auth fallback when socket auto-approve is blocked',
    '  --profile-version <v>     Profile version for /auth fallback',
    '  --profile-overrides <j>   Tighten-only profile override JSON for /auth fallback',
    '',
    'Auth:',
    '  Uses Unix socket by default.',
    '  Falls back to /auth polling when strict local mode disables auto-approve.',
    '  Uses AURA_TOKEN if present.',
  ]);
}

function parseProfileOverrides(raw?: string): ProfileIssuanceSelection['profileOverrides'] | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--profile-overrides must be a JSON object');
  }
  return parsed as ProfileIssuanceSelection['profileOverrides'];
}

function parseArgs(argv: string[]): DiaryCliArgs | null {
  const args = [...argv];
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) return null;

  const subcommand = (args.shift() || '').toLowerCase();
  if (subcommand !== 'write') return null;

  let entry: string | undefined;
  let date: string | undefined;
  let agentId: string | undefined;
  let profile: string | undefined;
  let profileVersion: string | undefined;
  let profileOverridesRaw: string | undefined;
  const positionalEntryParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (current === '--entry') {
      entry = args[i + 1];
      i += 1;
      continue;
    }
    if (current === '--date') {
      date = args[i + 1];
      i += 1;
      continue;
    }
    if (current === '--agent-id') {
      agentId = args[i + 1];
      i += 1;
      continue;
    }
    if (current === '--profile') {
      profile = args[i + 1];
      i += 1;
      continue;
    }
    if (current === '--profile-version') {
      profileVersion = args[i + 1];
      i += 1;
      continue;
    }
    if (current === '--profile-overrides') {
      profileOverridesRaw = args[i + 1];
      i += 1;
      continue;
    }
    if (current.startsWith('--')) {
      throw new Error(`Unknown option: ${current}`);
    }
    positionalEntryParts.push(current);
  }

  const resolvedEntry = (entry ?? positionalEntryParts.join(' ')).trim();
  if (!resolvedEntry) {
    throw new Error('Missing required diary entry. Use --entry "<text>".');
  }

  return {
    subcommand: 'write',
    entry: resolvedEntry,
    ...(date ? { date } : {}),
    ...(agentId ? { agentId } : {}),
    ...(profile ? { profile } : {}),
    ...(profileVersion ? { profileVersion } : {}),
    ...(profileOverridesRaw ? { profileOverridesRaw } : {}),
  };
}

async function resolveAuthToken(selection: ProfileIssuanceSelection): Promise<string> {
  const envToken = process.env.AURA_TOKEN;
  if (envToken) return envToken;

  const keypair = generateEphemeralKeypair();

  // If an explicit profile is requested, create a non-blocking approval request
  // so the caller can immediately share the approval URL with a human.
  if (selection.profile) {
    const result = await bootstrapViaAuthRequest(serverUrl(), 'cli-diary', keypair, {
      ...selection,
      noWait: true,
      onStatus: (message) => console.error(message),
    });
    if (result.approveUrl) {
      console.error(`Approve at: ${result.approveUrl}`);
    }
    console.error('Approval is required before diary write can continue.');
    console.error('After approval, re-run the same diary command.');
    process.exit(1);
  }

  try {
    return await bootstrapViaSocket('cli-diary', keypair);
  } catch (socketErr) {
    return bootstrapViaAuthRequest(serverUrl(), 'cli-diary', keypair, {
      ...selection,
      onStatus: (message) => console.error(message),
    }).catch((authErr) => {
      throw new Error(`${getErrorMessage(socketErr)}\n${getErrorMessage(authErr)}`);
    });
  }
}

function getPayloadError(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const maybeError = (payload as Record<string, unknown>).error;
  return typeof maybeError === 'string' ? maybeError : '';
}

function looksLikeAuthHeaderIssue(statusCode: number, payload: unknown): boolean {
  if (statusCode !== 401) return false;
  const message = getPayloadError(payload).toLowerCase();
  return (
    message.includes('authorization header') ||
    message.includes('missing authorization') ||
    message.includes('invalid or expired token')
  );
}

async function writeDiary(args: DiaryCliArgs): Promise<void> {
  const profileOverrides = parseProfileOverrides(args.profileOverridesRaw);
  const authSelection: ProfileIssuanceSelection = {
    ...(args.profile ? { profile: args.profile } : {}),
    ...(args.profileVersion ? { profileVersion: args.profileVersion } : {}),
    ...(profileOverrides ? { profileOverrides } : {}),
  };
  const token = await resolveAuthToken(authSelection);

  const body: Record<string, unknown> = {
    entry: args.entry,
    ...(args.date ? { date: args.date } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
  };

  const res = await fetch(`${serverUrl()}/what_is_happening/diary`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
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
      context: 'diary command',
      statusCode: res.status,
      payload,
    });
    if (!handledLock) {
      if (await handlePermissionDenied(res.status, payload)) process.exit(1);
      if (typeof payload === 'string') {
        console.error(`HTTP ${res.status}: ${payload}`);
      } else {
        console.error(`HTTP ${res.status}: ${JSON.stringify(payload, null, 2)}`);
      }
      if (looksLikeAuthHeaderIssue(res.status, payload)) {
        console.error('Auth is required to write diary entries.');
        console.error('Ask a human to approve access using the approval URL shown above, then retry.');
      }
    }
    process.exit(1);
  }

  if (typeof payload === 'string') {
    console.log(payload);
    return;
  }

  console.log(JSON.stringify(payload, null, 2));
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    showHelp();
    process.exit(0);
  }

  await writeDiary(parsed);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (error) => {
    const handledLock = await maybeHandleLockError({ context: 'diary command', error });
    if (!handledLock) {
      const message = getErrorMessage(error);
      console.error(`Diary command failed: ${message}`);
      if (
        message.includes('Timed out waiting for approval') ||
        message.includes('Failed to create /auth request') ||
        message.includes('Invalid or expired token') ||
        message.includes('Authorization header')
      ) {
        console.error('Ask a human to open the approval link, approve access, then retry this diary command.');
      }
    }
    process.exit(1);
  });
}
