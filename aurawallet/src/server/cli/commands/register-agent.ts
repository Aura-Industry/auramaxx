/**
 * auramaxx register-agent — Create a subsequent (non-primary) agent
 *
 * Security note:
 * - `--password` is supported for scripted convenience.
 * - Prefer `--password-stdin` to avoid shell history exposure.
 */

import { getErrorMessage } from '../../lib/error';
import { encryptPassword, generateAgentKeypair } from '../../cli/transport-client';
import { parseProfileSelectionInput, resolveCliBearerToken } from '../lib/auth-bootstrap';
import { fetchJson, fetchPublicKey } from '../lib/http';
import { promptPassword } from '../lib/prompt';
import { printHelp } from '../lib/theme';

interface ParsedArgs {
  name?: string;
  password?: string;
  passwordStdin: boolean;
  token?: string;
  profile?: string;
  profileVersion?: string;
  profileOverridesRaw?: string;
  json: boolean;
}

interface RegisterAgentResponse {
  success?: boolean;
  id?: string;
  address?: string;
  solanaAddress?: string;
  name?: string;
  message?: string;
}

function showHelp(): void {
  printHelp('REGISTER AGENT', 'npx auramaxx register-agent [options]', [], [
    'Options:',
    '  --name <name>             Optional agent display name',
    '  --password <pwd>          Agent password (supported for automation)',
    '  --password-stdin          Read agent password from stdin (recommended)',
    '  --token <token>           Bearer token (default: AURA_TOKEN or socket fallback)',
    '  --profile <id>            /auth fallback profile when socket bootstrap is blocked',
    '  --profile-version <v>     /auth fallback profile version',
    '  --profile-overrides <j>   Tighten-only profile override JSON',
    '  --json                    Output raw JSON response',
    '',
    'Examples:',
    '  npx auramaxx register-agent --name bot-2 --password hunter2__',
    '  printf "hunter2__\\n" | npx auramaxx register-agent --name bot-2 --password-stdin',
  ]);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  return {
    name: trimToUndefined(getFlagValue(argv, '--name')),
    password: trimToUndefined(getFlagValue(argv, '--password')),
    passwordStdin: argv.includes('--password-stdin'),
    token: trimToUndefined(getFlagValue(argv, '--token')) || trimToUndefined(process.env.AURA_TOKEN),
    profile: trimToUndefined(getFlagValue(argv, '--profile')),
    profileVersion: trimToUndefined(getFlagValue(argv, '--profile-version')),
    profileOverridesRaw: trimToUndefined(getFlagValue(argv, '--profile-overrides')),
    json: argv.includes('--json'),
  };
}

async function readPasswordFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data.trim());
    });
    process.stdin.on('error', reject);
    setTimeout(() => {
      if (!data) {
        reject(new Error('Timeout waiting for password on stdin'));
      }
    }, 8_000);
  });
}

async function resolvePassword(args: ParsedArgs): Promise<string> {
  if (args.password && args.passwordStdin) {
    throw new Error('Use either --password or --password-stdin, not both');
  }

  const supplied = args.password
    ? args.password
    : args.passwordStdin
      ? await readPasswordFromStdin()
      : await promptPassword('New agent password');

  const password = supplied.trim();
  if (!password) throw new Error('Password is required');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  return password;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  try {
    const parsed = parseArgs(argv);
    let password = await resolvePassword(parsed);

    const selection = parseProfileSelectionInput({
      profile: parsed.profile,
      profileVersion: parsed.profileVersion,
      profileOverridesRaw: parsed.profileOverridesRaw,
    });

    const token = await resolveCliBearerToken({
      explicitToken: parsed.token,
      agentId: 'cli-register-agent',
      rerunCommand: 'npx auramaxx register-agent ...',
      selection,
    });

    const publicKey = await fetchPublicKey();
    const encrypted = encryptPassword(password, publicKey);
    const { publicKey: agentPubkey } = generateAgentKeypair();
    password = '';

    const body: Record<string, unknown> = {
      encrypted,
      pubkey: agentPubkey,
    };
    if (parsed.name) body.name = parsed.name;

    const result = await fetchJson<RegisterAgentResponse>('/setup/agent', {
      method: 'POST',
      body,
      token,
      timeoutMs: 15_000,
    });

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('Agent registered.');
      if (result.id) console.log(`  ID: ${result.id}`);
      if (result.name) console.log(`  Name: ${result.name}`);
      if (result.address) console.log(`  Address: ${result.address}`);
      if (result.solanaAddress) console.log(`  Solana: ${result.solanaAddress}`);
      if (result.message) console.log(`  Message: ${result.message}`);
    }
  } catch (error) {
    console.error(`Register-agent failed: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Register-agent failed: ${getErrorMessage(error)}`);
    process.exit(1);
  });
}

