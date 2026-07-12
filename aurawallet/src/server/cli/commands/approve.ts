/**
 * auramaxx approve — approve a pending human action by id (admin-only)
 */

import {
  bootstrapViaAuthRequest,
  bootstrapViaSocket,
  generateEphemeralKeypair,
  type ProfileIssuanceSelection,
} from '../../lib/credential-transport';
import { getErrorMessage } from '../../lib/error';
import { printHelp } from '../lib/theme';
import { serverUrl, handlePermissionDeniedAndExit } from '../lib/http';

type JsonObject = Record<string, unknown>;

function showHelp(): void {
  printHelp('APPROVE', 'npx auramaxx approve <actionId> [options]', [], [
    'Options:',
    '  --token <token>              Use this bearer token (default: AURA_TOKEN or socket fallback)',
    '  --wallet-access <a,b,c>      Optional wallet access override',
    '  --limits <json>              Optional limits override object',
    '  --json                       JSON output',
    '',
    'Auth bootstrap options (when AURA_TOKEN is not set):',
    '  --profile <id>               /auth fallback profile (default: trust.localProfile, then dev)',
    '  --profile-version <v>        /auth fallback profile version (default: v1)',
    '  --profile-overrides <json>   Tighten-only profile override JSON',
    '',
    'Examples:',
    '  npx auramaxx approve act_123',
    '  npx auramaxx approve act_123 --json',
  ]);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
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

function parseProfileSelection(args: string[]): ProfileIssuanceSelection {
  const profile = getFlagValue(args, '--profile');
  const profileVersion = getFlagValue(args, '--profile-version');
  const profileOverrides = parseJsonObject(args, '--profile-overrides');
  return {
    ...(profile ? { profile } : {}),
    ...(profileVersion ? { profileVersion } : {}),
    ...(profileOverrides ? { profileOverrides } : {}),
  };
}

async function resolveBearerToken(args: string[]): Promise<string> {
  const explicit = getFlagValue(args, '--token') || process.env.AURA_TOKEN;
  if (explicit) return explicit;

  const selection = parseProfileSelection(args);
  const keypair = generateEphemeralKeypair();

  if (selection.profile) {
    const result = await bootstrapViaAuthRequest(serverUrl(), 'cli-approve', keypair, {
      ...selection,
      noWait: true,
      onStatus: (message) => console.error(message),
    });
    if (result.approveUrl) {
      console.error(`Approve at: ${result.approveUrl}`);
    }
    console.error('After approval, re-run with: AURA_TOKEN=<token> npx auramaxx approve <actionId>');
    console.error(`Or use: npx auramaxx auth request --profile ${selection.profile} --raw-token`);
    process.exit(1);
  }

  try {
    return await bootstrapViaSocket('cli-approve', keypair);
  } catch (socketErr) {
    return bootstrapViaAuthRequest(serverUrl(), 'cli-approve', keypair, {
      ...selection,
      onStatus: (message) => console.error(message),
    }).catch((authErr) => {
      throw new Error(`${getErrorMessage(socketErr)}\n${getErrorMessage(authErr)}`);
    });
  }
}

async function getJson(path: string, token?: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${serverUrl()}${path}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(12_000),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    await handlePermissionDeniedAndExit(res.status, data);
    throw new Error(String(data.error || `HTTP ${res.status}`));
  }
  return data;
}

async function postJson(path: string, token: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${serverUrl()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12_000),
  });

  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    await handlePermissionDeniedAndExit(res.status, data);
    throw new Error(String(data.error || `HTTP ${res.status}`));
  }
  return data;
}

async function classifyNotResolvable(actionId: string): Promise<string> {
  try {
    const data = await getJson(`/actions/${encodeURIComponent(actionId)}/summary`);
    const status = String((data as { status?: unknown }).status || '').toLowerCase();
    if (status === 'approved') return 'Action already approved.';
    if (status === 'rejected') return 'Action already rejected.';
    if (status === 'pending') return 'Action is pending but could not be approved (try again).';
    return `Action is not approvable (status=${status || 'unknown'}).`;
  } catch {
    return 'Action not found.';
  }
}

async function verifyAdmin(token: string): Promise<void> {
  try {
    await getJson('/actions/tokens', token);
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.toLowerCase().includes('admin')) {
      throw new Error('Admin token required. Request one with: npx auramaxx auth request --profile admin --raw-token');
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const actionId = args[0];

  if (!actionId || actionId === '--help' || actionId === '-h') {
    showHelp();
    process.exit(0);
  }

  try {
    const json = args.includes('--json');
    const token = await resolveBearerToken(args);
    await verifyAdmin(token);

    const walletAccess = parseCsv(args, '--wallet-access');
    const limits = parseJsonObject(args, '--limits');

    let data: Record<string, unknown>;
    try {
      data = await postJson(`/actions/${encodeURIComponent(actionId)}/approve`, token, {
        ...(walletAccess ? { walletAccess } : {}),
        ...(limits ? { limits } : {}),
      });
    } catch (error) {
      const message = getErrorMessage(error).toLowerCase();
      if (message.includes('not found or already resolved')) {
        const classified = await classifyNotResolvable(actionId);
        throw new Error(classified);
      }
      throw error;
    }

    if (json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`Approved ${actionId}.`);
    }
    process.exit(0);
  } catch (error) {
    console.error(`Approve command failed: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Approve command failed: ${getErrorMessage(error)}`);
    process.exit(1);
  });
}
