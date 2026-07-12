/**
 * auramaxx wallet — opinionated wallet API wrappers (incremental parity)
 */

import {
  bootstrapViaAuthRequest,
  bootstrapViaSocket,
  generateEphemeralKeypair,
  type ProfileIssuanceSelection,
} from '../../lib/credential-transport';
import { getErrorMessage } from '../../lib/error';
import { serverUrl, handlePermissionDeniedAndExit } from '../lib/http';
import { printHelp } from '../lib/theme';

type WalletCommand =
  | 'status'
  | 'assets'
  | 'transactions'
  | 'swap'
  | 'send'
  | 'fund'
  | 'launch';

interface WalletCliArgs {
  command: WalletCommand;
  bodyRaw?: string;
  noAuth: boolean;
  yes: boolean;
  profile?: string;
  profileVersion?: string;
  profileOverridesRaw?: string;
}

function showHelp(): void {
  printHelp('WALLET', 'npx auramaxx wallet <command> [options]', [], [
    'Commands:',
    '  status                     GET /wallet',
    '  assets                     GET /wallet/assets',
    '  transactions               GET /wallet/transactions',
    '  swap --body <json>         POST /swap',
    '  send --body <json>         POST /send',
    '  fund --body <json>         POST /fund',
    '  launch --body <json>       POST /launch',
    '',
    'Options:',
    '  --body <json>             JSON request body (required for mutating commands)',
    '  --no-auth                 Do not attach bearer auth token',
    '  --yes                     Confirm mutating wallet actions (swap/send/fund/launch)',
    '  --profile <p>             Profile for /auth fallback when socket auto-approve is blocked',
    '  --profile-version <v>     Profile version for /auth fallback',
    '  --profile-overrides <j>   Tighten-only profile override JSON for /auth fallback',
  ]);
}

export function parseArgs(argv: string[]): WalletCliArgs | null {
  const args = [...argv];
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) return null;

  const command = args.shift() as WalletCommand | undefined;
  if (!command || !['status', 'assets', 'transactions', 'swap', 'send', 'fund', 'launch'].includes(command)) {
    return null;
  }

  const getValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  return {
    command,
    bodyRaw: getValue('--body'),
    noAuth: args.includes('--no-auth'),
    yes: args.includes('--yes'),
    profile: getValue('--profile'),
    profileVersion: getValue('--profile-version'),
    profileOverridesRaw: getValue('--profile-overrides'),
  };
}

export function resolveRoute(command: WalletCommand): { method: 'GET' | 'POST'; route: string } {
  switch (command) {
    case 'status':
      return { method: 'GET', route: '/wallet' };
    case 'assets':
      return { method: 'GET', route: '/wallet/assets' };
    case 'transactions':
      return { method: 'GET', route: '/wallet/transactions' };
    case 'swap':
      return { method: 'POST', route: '/swap' };
    case 'send':
      return { method: 'POST', route: '/send' };
    case 'fund':
      return { method: 'POST', route: '/fund' };
    case 'launch':
      return { method: 'POST', route: '/launch' };
    default:
      return { method: 'GET', route: '/wallet' };
  }
}

function parseProfileOverrides(raw?: string): ProfileIssuanceSelection['profileOverrides'] | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--profile-overrides must be a JSON object');
  }
  return parsed as ProfileIssuanceSelection['profileOverrides'];
}

function parseBody(raw?: string): unknown | undefined {
  if (!raw) return undefined;
  return JSON.parse(raw) as unknown;
}

async function resolveAuthToken(selection: ProfileIssuanceSelection): Promise<string> {
  const envToken = process.env.AURA_TOKEN;
  if (envToken) return envToken;

  const keypair = generateEphemeralKeypair();

  if (selection.profile) {
    const result = await bootstrapViaAuthRequest(serverUrl(), 'cli-wallet', keypair, {
      ...selection,
      noWait: true,
      onStatus: (message) => console.error(message),
    });
    if (result.approveUrl) {
      console.error(`Approve at: ${result.approveUrl}`);
    }
    console.error(`After approval, re-run with: AURA_TOKEN=<token> npx auramaxx wallet ...`);
    console.error(`Or use: npx auramaxx auth request --profile ${selection.profile} --raw-token`);
    process.exit(1);
  }

  try {
    return await bootstrapViaSocket('cli-wallet', keypair);
  } catch (socketErr) {
    return bootstrapViaAuthRequest(serverUrl(), 'cli-wallet', keypair, {
      ...selection,
      onStatus: (message) => console.error(message),
    }).catch((authErr) => {
      throw new Error(`${getErrorMessage(socketErr)}\n${getErrorMessage(authErr)}`);
    });
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    showHelp();
    process.exit(0);
  }

  const { method, route } = resolveRoute(parsed.command);
  const body = parseBody(parsed.bodyRaw);
  if (method === 'POST' && body === undefined) {
    throw new Error(`'${parsed.command}' requires --body <json>`);
  }
  if (method === 'POST' && !parsed.yes) {
    throw new Error(`'${parsed.command}' is mutating and requires --yes`);
  }

  const profileOverrides = parseProfileOverrides(parsed.profileOverridesRaw);
  const authSelection: ProfileIssuanceSelection = {
    ...(parsed.profile ? { profile: parsed.profile } : {}),
    ...(parsed.profileVersion ? { profileVersion: parsed.profileVersion } : {}),
    ...(profileOverrides ? { profileOverrides } : {}),
  };

  const token = parsed.noAuth ? null : await resolveAuthToken(authSelection);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${serverUrl()}${route}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
    await handlePermissionDeniedAndExit(res.status, payload);
    if (typeof payload === 'string') console.error(`HTTP ${res.status}: ${payload}`);
    else console.error(`HTTP ${res.status}: ${JSON.stringify(payload, null, 2)}`);
    process.exit(1);
  }

  if (typeof payload === 'string') {
    console.log(payload);
    return;
  }

  console.log(JSON.stringify(payload, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`wallet command failed: ${getErrorMessage(error)}`);
    process.exit(1);
  });
}
