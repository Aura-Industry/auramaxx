/**
 * auramaxx apikey — API key management via CLI
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
  printHelp('APIKEY', 'npx auramaxx apikey <subcommand> [options]', [
    { name: 'list', desc: 'List configured API keys' },
    { name: 'validate <service> <key>', desc: 'Validate API key with upstream provider' },
    { name: 'set <service> <key>', desc: 'Create or update API key (name defaults to "default")' },
    { name: 'delete <id>', desc: 'Delete API key by id' },
  ], [
    'Options:',
    '  --name <name>               API key name for set (default: default)',
    '  --metadata <json>           Metadata object for set',
    '  --token <token>             Bearer token (default: AURA_TOKEN or socket fallback)',
    '  --profile <id>              /auth fallback profile when socket bootstrap is blocked',
    '  --profile-version <v>       /auth fallback profile version',
    '  --profile-overrides <json>  Tighten-only profile override JSON',
    '  --json                      JSON output',
    '',
    'Examples:',
    '  npx auramaxx apikey list',
    '  npx auramaxx apikey validate alchemy sk_xxx',
    '  npx auramaxx apikey set alchemy sk_xxx --name default',
    '  npx auramaxx apikey delete key_abc123',
  ]);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function parseProfileSelection(args: string[]): ProfileIssuanceSelection {
  const profile = getFlagValue(args, '--profile');
  const profileVersion = getFlagValue(args, '--profile-version');
  const profileOverridesRaw = getFlagValue(args, '--profile-overrides');

  let profileOverrides: JsonObject | undefined;
  if (profileOverridesRaw) {
    const parsed = JSON.parse(profileOverridesRaw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--profile-overrides must be a JSON object');
    }
    profileOverrides = parsed as JsonObject;
  }

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
    const result = await bootstrapViaAuthRequest(serverUrl(), 'cli-apikey', keypair, {
      ...selection,
      noWait: true,
      onStatus: (message) => console.error(message),
    });
    if (result.approveUrl) {
      console.error(`Approve at: ${result.approveUrl}`);
    }
    console.error(`After approval, re-run with: AURA_TOKEN=<token> npx auramaxx apikey ...`);
    console.error(`Or use: npx auramaxx auth request --profile ${selection.profile} --raw-token`);
    process.exit(1);
  }

  try {
    return await bootstrapViaSocket('cli-apikey', keypair);
  } catch (socketErr) {
    return bootstrapViaAuthRequest(serverUrl(), 'cli-apikey', keypair, {
      ...selection,
      onStatus: (message) => console.error(message),
    }).catch((authErr) => {
      throw new Error(`${getErrorMessage(socketErr)}\n${getErrorMessage(authErr)}`);
    });
  }
}

async function requestJson(
  path: string,
  token: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${serverUrl()}${path}`, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(12_000),
  });

  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    await handlePermissionDeniedAndExit(res.status, data);
    throw new Error(String(data.error || `HTTP ${res.status}`));
  }
  return data;
}

async function cmdList(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const token = await resolveBearerToken(args);
  const data = await requestJson('/apikeys', token);

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }

  const apiKeys = Array.isArray((data as { apiKeys?: unknown[] }).apiKeys)
    ? (data as { apiKeys: Array<{ id: string; service: string; name: string; keyMasked?: string }> }).apiKeys
    : [];

  if (apiKeys.length === 0) {
    console.log('No API keys configured.');
    return 0;
  }

  for (const key of apiKeys) {
    console.log(`${key.id}  ${key.service}/${key.name}  ${key.keyMasked || ''}`.trim());
  }

  return 0;
}

async function cmdValidate(args: string[]): Promise<number> {
  const service = args[0];
  const key = args[1];
  if (!service || !key) {
    throw new Error('Usage: npx auramaxx apikey validate <service> <key>');
  }

  const json = args.includes('--json');
  const token = await resolveBearerToken(args);
  const data = await requestJson('/apikeys/validate', token, {
    method: 'POST',
    body: { service, key },
  });

  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const valid = (data as { valid?: unknown }).valid === true;
    console.log(`valid=${valid}`);
    if (!valid && typeof data.error === 'string') {
      console.log(`error=${data.error}`);
    }
  }

  return (data as { valid?: unknown }).valid === true ? 0 : 1;
}

async function cmdSet(args: string[]): Promise<number> {
  const service = args[0];
  const key = args[1];
  if (!service || !key) {
    throw new Error('Usage: npx auramaxx apikey set <service> <key> [--name <name>]');
  }

  const name = getFlagValue(args, '--name') || 'default';
  const metadataRaw = getFlagValue(args, '--metadata');
  let metadata: JsonObject | undefined;
  if (metadataRaw) {
    const parsed = JSON.parse(metadataRaw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--metadata must be a JSON object');
    }
    metadata = parsed as JsonObject;
  }

  const json = args.includes('--json');
  const token = await resolveBearerToken(args);
  const data = await requestJson('/apikeys', token, {
    method: 'POST',
    body: {
      service,
      name,
      key,
      ...(metadata ? { metadata } : {}),
    },
  });

  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Saved API key ${service}/${name}.`);
  }

  return 0;
}

async function cmdDelete(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    throw new Error('Usage: npx auramaxx apikey delete <id>');
  }

  const json = args.includes('--json');
  const token = await resolveBearerToken(args);
  const data = await requestJson(`/apikeys/${encodeURIComponent(id)}`, token, { method: 'DELETE' });

  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(String((data as { message?: unknown }).message || 'Deleted API key.'));
  }

  return (data as { success?: unknown }).success === false ? 1 : 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    showHelp();
    process.exit(0);
  }

  try {
    let exitCode = 0;
    switch (subcommand) {
      case 'list':
        exitCode = await cmdList(args.slice(1));
        break;
      case 'validate':
        exitCode = await cmdValidate(args.slice(1));
        break;
      case 'set':
      case 'create':
      case 'upsert':
        exitCode = await cmdSet(args.slice(1));
        break;
      case 'delete':
      case 'del':
      case 'rm':
        exitCode = await cmdDelete(args.slice(1));
        break;
      default:
        throw new Error(`Unknown apikey subcommand: ${subcommand}`);
    }

    process.exit(exitCode);
  } catch (error) {
    console.error(`API key command failed: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`API key command failed: ${getErrorMessage(error)}`);
    process.exit(1);
  });
}
