/**
 * auramaxx api — Generic wallet API caller from CLI
 *
 * Usage:
 *   npx auramaxx api GET /health
 *   npx auramaxx api POST /auth --body '{"agentId":"cli-api","profile":"dev","profileVersion":"v1","pubkey":"..."}' --no-auth
 *   npx auramaxx api POST /credentials --body '{"name":"X","type":"note","fields":[{"key":"content","value":"hello"}]}'
 */

import {
  type ProfileIssuanceSelection,
} from '../../lib/credential-transport';
import { getErrorMessage } from '../../lib/error';
import { parseProfileSelectionInput, resolveCliBearerToken } from '../lib/auth-bootstrap';
import { handlePermissionDenied } from '../lib/escalation';
import { maybeHandleLockError } from '../lib/lock-unlock-helper';
import { serverUrl } from '../lib/http';
import { printHelp } from '../lib/theme';

interface ApiCliArgs {
  method: string;
  endpoint: string;
  bodyRaw?: string;
  noAuth: boolean;
  profile?: string;
  profileVersion?: string;
  profileOverridesRaw?: string;
}

function showHelp(): void {
  printHelp('API', 'npx auramaxx api [METHOD] <endpoint> [options]', [], [
    'Examples:',
    '  npx auramaxx api GET /health --no-auth',
    '  npx auramaxx api GET /setup --no-auth',
    '  npx auramaxx api GET /wallets',
    '  npx auramaxx api POST /credential-shares --body \'{"credentialId":"cred_x","expiresAfter":"24h"}\'',
    '  npx auramaxx api GET /credential-shares/<token> --no-auth',
    '  npx auramaxx api POST /auth --no-auth --body \'{"agentId":"cli-api","profile":"dev","profileVersion":"v1","pubkey":"..."}\'',
    '',
    'Options:',
    '  --body <json>             JSON request body',
    '  --no-auth                 Do not attach bearer auth token',
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

function parseArgs(argv: string[]): ApiCliArgs | null {
  const args = [...argv];
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) return null;

  let method = 'GET';
  let endpoint = '';

  if (args[0].startsWith('/')) {
    endpoint = args.shift()!;
  } else {
    method = (args.shift() || 'GET').toUpperCase();
    endpoint = args.shift() || '';
  }

  if (!endpoint) return null;
  if (!endpoint.startsWith('/')) endpoint = `/${endpoint}`;

  const getValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  return {
    method,
    endpoint,
    bodyRaw: getValue('--body'),
    noAuth: args.includes('--no-auth'),
    profile: getValue('--profile'),
    profileVersion: getValue('--profile-version'),
    profileOverridesRaw: getValue('--profile-overrides'),
  };
}

function parseBody(raw?: string): unknown | undefined {
  if (!raw) return undefined;
  return JSON.parse(raw) as unknown;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    showHelp();
    process.exit(0);
  }

  const base = serverUrl();
  const url = `${base}${parsed.endpoint}`;

  const authSelection: ProfileIssuanceSelection = parseProfileSelectionInput({
    profile: parsed.profile,
    profileVersion: parsed.profileVersion,
    profileOverridesRaw: parsed.profileOverridesRaw,
  });

  const body = parseBody(parsed.bodyRaw);
  const token = parsed.noAuth
    ? null
    : await resolveCliBearerToken({
      explicitToken: process.env.AURA_TOKEN,
      agentId: 'cli-api',
      rerunCommand: 'npx auramaxx api ...',
      selection: authSelection,
    });

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, {
    method: parsed.method,
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
    const handledLock = await maybeHandleLockError({
      context: 'api command',
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
        const obj = payload as Record<string, unknown>;
        const approvalUrl = typeof obj.approveUrl === 'string' ? obj.approveUrl : undefined;
        const actionId = typeof obj.actionId === 'string' ? obj.actionId : undefined;

        if (approvalUrl) {
          console.error(`\nApproval required. Open: ${approvalUrl}`);
          if (actionId) console.error(`Action ID: ${actionId}`);
          console.error('After approval, retry the same command.');
        }
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (error) => {
    const handledLock = await maybeHandleLockError({ context: 'api command', error });
    if (!handledLock) {
      console.error(`API call failed: ${getErrorMessage(error)}`);
    }
    process.exit(1);
  });
}
