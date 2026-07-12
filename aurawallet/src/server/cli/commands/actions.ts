/**
 * auramaxx actions — Human-action request and token management
 */

import {
  decryptWithPrivateKey,
  generateEphemeralKeypair,
  type ProfileIssuanceSelection,
} from '../../lib/credential-transport';
import { buildPollUrl } from '../../lib/approval-flow';
import { getErrorMessage } from '../../lib/error';
import { waitForAuthDecision } from '../lib/approval-poll';
import { parseProfileSelectionInput, resolveCliBearerToken } from '../lib/auth-bootstrap';
import { printHelp } from '../lib/theme';
import { serverUrl, fetchJson } from '../lib/http';

type JsonObject = Record<string, unknown>;

interface ParsedPollCommon {
  json: boolean;
  rawToken: boolean;
  unsafeShowSecret: boolean;
  noWait: boolean;
  timeoutMs: number;
  intervalMs: number;
}

function showHelp(): void {
  printHelp('ACTIONS', 'npx auramaxx actions <subcommand> [options]', [
    { name: 'create', desc: 'Create action request and optionally poll for approval token' },
    { name: 'pending', desc: 'List pending human actions' },
    { name: 'resolve <id>', desc: 'Approve or reject a pending action' },
    { name: 'tokens', desc: 'List agent tokens (admin)' },
    { name: 'revoke <tokenHash>', desc: 'Revoke token by hash (or --self)' },
  ], [
    'Create options:',
    '  --summary <text>             Required summary',
    '  --permissions <a,b,c>        Required permission CSV',
    '  --ttl <seconds>              Optional token TTL for approved action token',
    '  --limit-fund <eth>           Optional fund limit override',
    '  --limit-send <eth>           Optional send limit override',
    '  --limit-swap <eth>           Optional swap limit override',
    '  --wallet-access <a,b,c>      Optional wallet access CSV',
    '  --credential-read <a,b,c>    Optional credential read scope CSV',
    '  --credential-write <a,b,c>   Optional credential write scope CSV',
    '  --exclude-fields <a,b,c>     Optional excluded field CSV',
    '  --metadata <json>            Optional metadata object',
    '  --no-wait                    Do not poll for approval result',
    '  --timeout-ms <ms>            Poll timeout (default: 120000)',
    '  --interval-ms <ms>           Poll interval (default: 3000)',
    '  --raw-token                  Print full approved token',
    '  --unsafe-show-secret         Print full claim secret in output (unsafe)',
    '  --json                       JSON output',
    '',
    'Auth bootstrap options (when AURA_TOKEN is not set):',
    '  --profile <id>               /auth fallback profile (default: trust.localProfile, then dev)',
    '  --profile-version <v>        /auth fallback profile version (default: v1)',
    '  --profile-overrides <json>   Tighten-only profile override JSON',
    '',
    'Resolve options:',
    '  --approve                    Approve action',
    '  --reject                     Reject action',
    '  --wallet-access <a,b,c>      Optional wallet access override',
    '  --limits <json>              Optional limits override object',
    '',
    'Token options:',
    '  --token <token>              Use this bearer token (default: AURA_TOKEN or socket fallback)',
    '  --self                       Revoke current token (for revoke subcommand)',
    '',
    'Examples:',
    '  npx auramaxx actions create --summary "Grant read" --permissions secret:read',
    '  npx auramaxx actions pending',
    '  npx auramaxx actions resolve act_123 --approve',
    '  npx auramaxx actions tokens',
    '  npx auramaxx actions revoke tok_abc',
  ]);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function parseInteger(args: string[], flag: string, fallback: number): number {
  const raw = getFlagValue(args, flag);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number`);
  return Math.floor(n);
}

function parseNumber(args: string[], flag: string): number | undefined {
  const raw = getFlagValue(args, flag);
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a non-negative number`);
  return n;
}

function parseCsv(args: string[], flag: string): string[] | undefined {
  const raw = getFlagValue(args, flag);
  if (!raw) return undefined;
  const out = raw.split(',').map((v) => v.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function parseJsonObject(args: string[], flag: string): JsonObject | undefined {
  const raw = getFlagValue(args, flag);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object`);
  }
  return parsed as JsonObject;
}

function parsePollCommon(args: string[]): ParsedPollCommon {
  return {
    json: args.includes('--json'),
    rawToken: args.includes('--raw-token'),
    unsafeShowSecret: args.includes('--unsafe-show-secret'),
    noWait: args.includes('--no-wait'),
    timeoutMs: parseInteger(args, '--timeout-ms', 120_000),
    intervalMs: parseInteger(args, '--interval-ms', 3_000),
  };
}

function parseProfileSelection(args: string[]): ProfileIssuanceSelection {
  return parseProfileSelectionInput({
    profile: getFlagValue(args, '--profile'),
    profileVersion: getFlagValue(args, '--profile-version'),
    profileOverridesRaw: getFlagValue(args, '--profile-overrides'),
  });
}

async function resolveBearerToken(args: string[]): Promise<string> {
  return resolveCliBearerToken({
    explicitToken: getFlagValue(args, '--token') || process.env.AURA_TOKEN,
    agentId: 'cli-actions',
    rerunCommand: 'npx auramaxx actions ...',
    selection: parseProfileSelection(args),
  });
}

function maskToken(token: string): string {
  if (token.length <= 24) return token;
  return `${token.slice(0, 20)}...${token.slice(-4)}`;
}

async function cmdCreate(args: string[]): Promise<number> {
  console.error('DEPRECATED: `actions create` is deprecated. Use `npx auramaxx auth request --profile <profile>` instead.');
  console.error('  To include a pre-computed action: --action \'{"endpoint":"/send","method":"POST","body":{...}}\'');
  console.error('');
  const common = parsePollCommon(args);
  const summary = getFlagValue(args, '--summary');
  const permissions = parseCsv(args, '--permissions');
  if (!summary) throw new Error('--summary is required');
  if (!permissions || permissions.length === 0) throw new Error('--permissions is required');

  const token = await resolveBearerToken(args);
  const keypair = generateEphemeralKeypair();

  const ttl = parseNumber(args, '--ttl');
  const limitFund = parseNumber(args, '--limit-fund');
  const limitSend = parseNumber(args, '--limit-send');
  const limitSwap = parseNumber(args, '--limit-swap');
  const metadata = parseJsonObject(args, '--metadata');
  const walletAccess = parseCsv(args, '--wallet-access');
  const credentialRead = parseCsv(args, '--credential-read');
  const credentialWrite = parseCsv(args, '--credential-write');
  const excludeFields = parseCsv(args, '--exclude-fields');

  const limits: Record<string, number> = {};
  if (limitFund !== undefined) limits.fund = limitFund;
  if (limitSend !== undefined) limits.send = limitSend;
  if (limitSwap !== undefined) limits.swap = limitSwap;

  const credentialAccess: Record<string, unknown> = {};
  if (credentialRead) credentialAccess.read = credentialRead;
  if (credentialWrite) credentialAccess.write = credentialWrite;
  if (excludeFields) credentialAccess.excludeFields = excludeFields;

  const body: Record<string, unknown> = {
    summary,
    permissions,
    pubkey: keypair.publicKeyPem,
    ...(ttl !== undefined ? { ttl } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    ...(walletAccess ? { walletAccess } : {}),
    ...(Object.keys(credentialAccess).length > 0 ? { credentialAccess } : {}),
    ...(metadata ? { metadata } : {}),
  };

  const created = await fetchJson<{
    success?: boolean;
    requestId?: string;
    secret?: string;
    approveUrl?: string;
    pollUrl?: string;
    claim?: { method?: string; endpoint?: string };
    instructions?: string[];
    message?: string;
  }>('/actions', {
    method: 'POST',
    token,
    body,
    timeoutMs: 12_000,
  });

  if (!created.success || !created.requestId || !created.secret) {
    throw new Error('Action request did not return requestId/secret');
  }
  const claimUrl = typeof created.pollUrl === 'string'
    ? created.pollUrl
    : buildPollUrl(serverUrl(), created.requestId, created.secret);

  if (common.noWait) {
    if (common.json) {
      console.log(JSON.stringify({
        success: true,
        status: 'pending',
        requestId: created.requestId,
        secret: common.unsafeShowSecret ? created.secret : undefined,
        secretPreview: common.unsafeShowSecret ? undefined : '[REDACTED]',
        approveUrl: created.approveUrl,
        pollUrl: claimUrl,
        claim: created.claim,
        instructions: created.instructions,
      }, null, 2));
    } else {
      console.log(`Action request created.`);
      console.log(`  requestId: ${created.requestId}`);
      if (common.unsafeShowSecret) {
        console.log(`  secret: ${created.secret}`);
      } else {
        console.log('  secret: [REDACTED]');
      }
      if (created.approveUrl) {
        console.log(`  approveUrl: ${created.approveUrl}`);
      }
      console.log(`  claimUrl: ${claimUrl}`);
      console.log('Approve first, then claim the token and retry your original command.');
    }
    return 0;
  }

  console.log(`Action request created (${created.requestId}). Waiting for approval...`);

  const { response, attempts, elapsedMs } = await waitForAuthDecision(
    serverUrl(),
    created.requestId,
    created.secret,
    {
      timeoutMs: common.timeoutMs,
      intervalMs: common.intervalMs,
      onPending: ({ attempt }) => {
        if (attempt === 1 || attempt % 5 === 0) {
          console.log('  pending...');
        }
      },
    },
  );

  if (response.status === 'rejected') {
    if (common.json) {
      console.log(JSON.stringify({
        success: true,
        status: 'rejected',
        requestId: created.requestId,
        attempts,
        elapsedMs,
      }, null, 2));
    } else {
      console.log('Action request was rejected.');
    }
    return 1;
  }

  if (!response.encryptedToken) {
    throw new Error('Approved action response missing encryptedToken');
  }

  const approvedToken = decryptWithPrivateKey(response.encryptedToken, keypair.privateKeyPem);

  if (common.json) {
    console.log(JSON.stringify({
      success: true,
      status: 'approved',
      requestId: created.requestId,
      attempts,
      elapsedMs,
      token: common.rawToken ? approvedToken : undefined,
      tokenPreview: maskToken(approvedToken),
    }, null, 2));
  } else {
    console.log('Approved.');
    if (common.rawToken) {
      console.log(`  token: ${approvedToken}`);
    } else {
      console.log(`  token: ${maskToken(approvedToken)}`);
      console.log('  (use --raw-token to print full token)');
    }
    console.log('  Approved token is available for immediate retry flows.');
  }

  return 0;
}

async function cmdPending(args: string[]): Promise<number> {
  const token = await resolveBearerToken(args);
  const json = args.includes('--json');
  const data = await fetchJson<Record<string, unknown>>('/actions/pending', {
    token,
    timeoutMs: 12_000,
  });

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }

  const actions = Array.isArray((data as { actions?: unknown[] }).actions)
    ? (data as { actions: Array<{ id: string; type: string; status: string; metadata?: string }> }).actions
    : [];

  if (actions.length === 0) {
    console.log('No pending actions.');
    return 0;
  }

  for (const action of actions) {
    console.log(`${action.id}  type=${action.type}  status=${action.status}`);
  }
  return 0;
}

async function cmdResolve(args: string[]): Promise<number> {
  const actionId = args[0];
  if (!actionId) throw new Error('Usage: npx auramaxx actions resolve <id> --approve|--reject');

  const approve = args.includes('--approve');
  const reject = args.includes('--reject');
  if (approve === reject) {
    throw new Error('Specify exactly one of --approve or --reject');
  }

  const token = await resolveBearerToken(args);
  const walletAccess = parseCsv(args, '--wallet-access');
  const limits = parseJsonObject(args, '--limits');
  const json = args.includes('--json');

  const data = await fetchJson<Record<string, unknown>>(`/actions/${encodeURIComponent(actionId)}/resolve`, {
    method: 'POST',
    token,
    body: {
      approved: approve,
      ...(walletAccess ? { walletAccess } : {}),
      ...(limits ? { limits } : {}),
    },
    timeoutMs: 12_000,
  });

  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Resolved ${actionId}: ${approve ? 'approved' : 'rejected'}`);
  }

  return 0;
}

async function cmdTokens(args: string[]): Promise<number> {
  const token = await resolveBearerToken(args);
  const json = args.includes('--json');
  const data = await fetchJson<Record<string, unknown>>('/actions/tokens', {
    token,
    timeoutMs: 12_000,
  });

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }

  const total = Number((data as { total?: unknown }).total || 0);
  const tokens = (data as { tokens?: Record<string, unknown[]> }).tokens || {};
  const active = Array.isArray(tokens.active) ? tokens.active.length : 0;
  const inactive = Array.isArray(tokens.inactive) ? tokens.inactive.length : 0;
  const expired = Array.isArray(tokens.expired) ? tokens.expired.length : 0;
  const revoked = Array.isArray(tokens.revoked) ? tokens.revoked.length : 0;
  const depleted = Array.isArray(tokens.depleted) ? tokens.depleted.length : 0;

  console.log(`total=${total}`);
  console.log(`active=${active}`);
  console.log(`inactive=${inactive}`);
  console.log(`expired=${expired}`);
  console.log(`revoked=${revoked}`);
  console.log(`depleted=${depleted}`);
  return 0;
}

async function cmdRevoke(args: string[]): Promise<number> {
  const token = await resolveBearerToken(args);
  const json = args.includes('--json');
  const self = args.includes('--self');
  const tokenHash = self ? undefined : args[0];

  if (!self && !tokenHash) {
    throw new Error('Usage: npx auramaxx actions revoke <tokenHash> (or --self)');
  }

  const body = self ? {} : { tokenHash };
  const data = await fetchJson<Record<string, unknown>>('/actions/tokens/revoke', {
    method: 'POST',
    token,
    body,
    timeoutMs: 12_000,
  });

  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(String((data as { message?: unknown }).message || 'Token revoke attempted.'));
  }

  return (data as { success?: boolean }).success === false ? 1 : 0;
}

export async function runActionsCli(args: string[]): Promise<number> {
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    showHelp();
    return 0;
  }

  switch (subcommand) {
    case 'create':
      return await cmdCreate(args.slice(1));
    case 'pending':
    case 'list':
      return await cmdPending(args.slice(1));
    case 'resolve':
      return await cmdResolve(args.slice(1));
    case 'tokens':
      return await cmdTokens(args.slice(1));
    case 'revoke':
      return await cmdRevoke(args.slice(1));
    default:
      throw new Error(`Unknown actions subcommand: ${subcommand}`);
  }
}

async function main(): Promise<void> {
  try {
    const exitCode = await runActionsCli(process.argv.slice(2));
    process.exit(exitCode);
  } catch (error) {
    console.error(`Actions command failed: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Actions command failed: ${getErrorMessage(error)}`);
    process.exit(1);
  });
}
