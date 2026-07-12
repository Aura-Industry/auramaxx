/**
 * auramaxx env — Load env vars from agent via .aura file
 *
 * Usage:
 *   npx auramaxx env -- <cmd> [args]   Run command with agent-injected env vars
 *   npx auramaxx env inject             Write .env file from .aura mappings
 *   npx auramaxx env check              Verify all mapped credentials exist
 *   npx auramaxx env list               Show mappings without values
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  generateEphemeralKeypair,
  bootstrapViaSocket,
  bootstrapViaAuthRequest,
  decryptWithPrivateKey,
  createReadToken,
} from '../../lib/credential-transport';
import { serverUrl, fetchSetupStatus } from '../lib/http';
import { getErrorMessage } from '../../lib/error';
import { maybeHandleLockError } from '../lib/lock-unlock-helper';
import { createCredentialViaApi, getPrimaryAgentId } from '../lib/credential-create';
import { migrateDotenv } from '../lib/dotenv-migrate';
import { promptInput } from '../lib/prompt';
import {
  type AuraMapping,
  type CredentialMeta,
  type DecryptedCredential,
  searchCredential,
  readCredential,
  resolveMappings as sharedResolveMappings,
} from '../lib/credential-resolve';
import { parseAuraFile } from '../lib/aura-parser';

// ── Pre-flight check: server running + agent exists ──

function isConnectionError(err: unknown): boolean {
  const msg = getErrorMessage(err).toLowerCase();
  if (msg.includes('econnrefused') || msg.includes('fetch failed') || msg.includes('enoent')) return true;

  const anyErr = err as { code?: unknown; errno?: unknown };
  const code = typeof anyErr?.code === 'string' ? anyErr.code : undefined;
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND') return true;
  const errno = typeof anyErr?.errno === 'number' ? anyErr.errno : undefined;
  return errno === -61 || errno === -111; // macOS/WASI ECONNREFUSED codes
}

export async function checkServerAndAgent(): Promise<void> {
  let status: Awaited<ReturnType<typeof fetchSetupStatus>>;
  try {
    status = await fetchSetupStatus();
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    if (isConnectionError(err)) {
      console.error('Aura server not running. Run `npx auramaxx` first.');
    } else {
      console.error(`Cannot connect to Aura server: ${msg}`);
    }
    process.exit(1);
    return;
  }

  if (!status.hasWallet) {
    console.error('No agent found. Run `npx auramaxx` to bootstrap setup.');
    process.exit(1);
    return;
  }
}

// ── Ephemeral RSA keypair ──

const keypair = generateEphemeralKeypair();

// ── Auth: socket or AURA_TOKEN env var ──

async function getAuthToken(): Promise<string> {
  const envToken = process.env.AURA_TOKEN;
  if (envToken) return envToken;
  try {
    return await bootstrapViaSocket('cli-env', keypair);
  } catch (socketErr) {
    return bootstrapViaAuthRequest(serverUrl(), 'cli-env', keypair, {
      onStatus: (message) => console.error(message),
    }).catch((authErr) => {
      throw new Error(`${getErrorMessage(socketErr)}\n${getErrorMessage(authErr)}`);
    });
  }
}

// ── .aura file parsing ──

function findAuraFile(): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.aura');
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* ignore stat errors */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// parseAuraFile moved to ../lib/aura-parser.ts
export { parseAuraFile } from '../lib/aura-parser';

// ── Resolve mappings to env vars (delegates to shared module, audit finding #3) ──

async function resolveMappings(
  mappings: AuraMapping[],
  token: string,
  readToken: string,
): Promise<{ resolved: Map<string, string>; errors: string[]; missing: AuraMapping[] }> {
  const base = serverUrl();
  const decryptFn = (encrypted: string) => decryptWithPrivateKey(encrypted, keypair.privateKeyPem);
  return sharedResolveMappings(mappings, base, token, readToken, decryptFn);
}

// ── Env value escaping for .env file ──

/**
 * Escape a value for safe inclusion in a .env file.
 * Handles newlines, backslashes, dollar signs, and quotes.
 */
export function escapeEnvValue(value: string): string {
  // Always double-quote and escape special chars
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\$/g, '\\$')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

// ── Subcommands ──

function suggestFromDotenvIfPresent(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    console.error('Tip: Found a .env file in this directory. Run `npx auramaxx env init` to migrate it.');
  }
}

export async function cmdRun(cmdArgs: string[]): Promise<void> {
  if (cmdArgs.length === 0) {
    console.error('Usage: npx auramaxx env -- <command> [args]');
    process.exit(1);
  }

  await checkServerAndAgent();

  const auraFile = findAuraFile();
  if (!auraFile) {
    console.error('No .aura file found in current or parent directories.');
    suggestFromDotenvIfPresent();
    process.exit(1);
  }

  const mappings = parseAuraFile(auraFile);
  if (mappings.length === 0) {
    console.error('No mappings found in .aura file.');
    process.exit(1);
  }

  const token = await getAuthToken();
  const readToken = await createReadToken(serverUrl(), token, keypair, 'cli-env-reader');
  let { resolved, errors, missing } = await resolveMappings(mappings, token, readToken);

  // Interactive creation for missing credentials (TTY only)
  if (missing.length > 0 && process.stdin.isTTY) {
    try {
      const agentId = await getPrimaryAgentId(token);
      const created = await interactiveCreateMissing(missing, token, agentId);
      for (const [key, value] of created) {
        resolved.set(key, value);
      }
      errors = errors.filter(e => !missing.some(m => e.includes(m.envVar) && created.has(m.envVar)));
      missing = missing.filter(m => !created.has(m.envVar));
    } catch (err) {
      console.error(`  Interactive setup failed: ${getErrorMessage(err)}`);
    }
  }

  if (errors.length > 0 && missing.length > 0) {
    for (const err of errors) console.error(`  ✗ ${err}`);
    console.error(`\n${errors.length} of ${mappings.length} credentials failed to resolve.`);
    process.exit(1);
  }

  console.error(`✓ Resolved ${resolved.size} credentials from agent`);

  const env = { ...process.env };
  for (const [key, value] of resolved) {
    env[key] = value;
  }

  const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
    stdio: 'inherit',
    env,
    shell: false,
  });

  const forwardSignal = (sig: NodeJS.Signals) => child.kill(sig);
  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);

  child.on('exit', (code, signal) => {
    process.off('SIGINT', forwardSignal);
    process.off('SIGTERM', forwardSignal);
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });
}

export async function cmdInject(): Promise<void> {
  await checkServerAndAgent();

  const auraFile = findAuraFile();
  if (!auraFile) {
    console.error('No .aura file found in current or parent directories.');
    suggestFromDotenvIfPresent();
    process.exit(1);
  }

  const mappings = parseAuraFile(auraFile);
  if (mappings.length === 0) {
    console.error('No mappings found in .aura file.');
    process.exit(1);
  }

  const token = await getAuthToken();
  const readToken = await createReadToken(serverUrl(), token, keypair, 'cli-env-reader');
  const { resolved, errors } = await resolveMappings(mappings, token, readToken);

  if (errors.length > 0) {
    for (const err of errors) console.error(`  ✗ ${err}`);
    console.error(`\n${errors.length} of ${mappings.length} credentials failed to resolve.`);
    process.exit(1);
  }

  // Write .env in same directory as .aura
  const envPath = path.join(path.dirname(auraFile), '.env');
  const lines = ['# Generated by auramaxx env inject — DO NOT COMMIT'];
  for (const [key, value] of resolved) {
    lines.push(`${key}=${escapeEnvValue(value)}`);
  }

  // Write with restrictive permissions (0600 — owner read/write only)
  const fd = fs.openSync(envPath, 'w', 0o600);
  fs.writeSync(fd, lines.join('\n') + '\n');
  fs.closeSync(fd);

  console.log(`✓ Resolved ${resolved.size} credentials from agent`);
  console.log(`✓ Wrote .env (${resolved.size} variables, mode 0600)`);

  // Check .gitignore
  const gitignorePath = path.join(path.dirname(auraFile), '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    if (!gitignore.includes('.env')) {
      console.log('⚠ Make sure .env is in .gitignore!');
    }
  } else {
    console.log('⚠ No .gitignore found — make sure .env is not committed!');
  }
}

export async function cmdCheck(): Promise<void> {
  await checkServerAndAgent();

  const auraFile = findAuraFile();
  if (!auraFile) {
    console.error('No .aura file found in current or parent directories.');
    suggestFromDotenvIfPresent();
    process.exit(1);
  }

  console.log(`.aura: ${auraFile}`);

  const mappings = parseAuraFile(auraFile);
  if (mappings.length === 0) {
    console.log('No mappings found.');
    return;
  }

  const token = await getAuthToken();
  let allOk = true;

  for (const mapping of mappings) {
    const meta = await searchCredential(serverUrl(), token, mapping.credentialName);
    if (meta) {
      console.log(`  ✓ ${mapping.envVar} → ${mapping.credentialName}/${mapping.field} (found)`);
    } else {
      console.log(`  ✗ ${mapping.envVar} → ${mapping.credentialName}/${mapping.field} (not found)`);
      allOk = false;
    }
  }

  console.log('');
  if (allOk) {
    console.log(`All ${mappings.length} credentials resolved successfully.`);
  } else {
    console.log('Some credentials could not be found.');
    process.exit(1);
  }
}

function cmdList(): void {
  const auraFile = findAuraFile();
  if (!auraFile) {
    console.error('No .aura file found in current or parent directories.');
    suggestFromDotenvIfPresent();
    process.exit(1);
  }

  console.log(`.aura: ${auraFile}`);
  const mappings = parseAuraFile(auraFile);

  if (mappings.length === 0) {
    console.log('No mappings found.');
    return;
  }

  for (const m of mappings) {
    const ref = m.agent ? `@${m.agent}/${m.credentialName}/${m.field}` : `${m.credentialName}/${m.field}`;
    console.log(`  ${m.envVar} → ${ref}`);
  }
}

// ── Init (from-dotenv migration) ──

async function cmdInit(): Promise<void> {
  await checkServerAndAgent();

  const args = process.argv.slice(2);
  const fromIdx = args.indexOf('--from');
  const fromPath = fromIdx >= 0 && fromIdx + 1 < args.length ? args[fromIdx + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  const noGroup = args.includes('--no-group');

  const envPath = fromPath || path.join(process.cwd(), '.env');

  const token = await getAuthToken();

  await migrateDotenv({
    token,
    envPath,
    noGroup,
    dryRun,
  });
}

// ── Interactive credential creation for missing entries ──

async function interactiveCreateMissing(
  missingMappings: AuraMapping[],
  token: string,
  agentId: string,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();

  const byCredential = new Map<string, AuraMapping[]>();
  for (const m of missingMappings) {
    const list = byCredential.get(m.credentialName) || [];
    list.push(m);
    byCredential.set(m.credentialName, list);
  }

  console.log(`\n  ${missingMappings.length} credential(s) not found. Let's create them:\n`);

  for (const [credName, mappings] of byCredential) {
    const fields: Array<{ key: string; value: string }> = [];

    for (const m of mappings) {
      const value = await promptInput(`  Enter value for ${m.envVar} (→ ${credName}/${m.field})`);
      if (!value) {
        console.log(`  Skipped ${m.envVar}`);
        continue;
      }
      fields.push({ key: m.field, value });
      resolved.set(m.envVar, value);
    }

    if (fields.length > 0) {
      const result = await createCredentialViaApi({ token, agentId, name: credName, fields });
      if (result.success) {
        console.log(`  ✓ Created credential: ${credName}`);
      } else {
        console.error(`  ✗ Failed to create ${credName}: ${result.error}`);
        for (const f of fields) {
          const mapping = mappings.find(m => m.field === f.key);
          if (mapping) resolved.delete(mapping.envVar);
        }
      }
    }
  }

  return resolved;
}

// ── Help ──

function showHelp(): void {
  console.log(`
  auramaxx env — Load env vars from agent

  Usage:
    npx auramaxx env -- <cmd> [args]   Run command with agent-injected env vars
    npx auramaxx env inject             Write .env file from .aura mappings
    npx auramaxx env check              Verify all mapped credentials exist
    npx auramaxx env list               Show mappings without values
    npx auramaxx env init               Migrate .env to agent + .aura
                          [--from <path>] [--dry-run] [--no-group]

  Auth: Uses Unix socket by default. Falls back to /auth polling when strict local mode disables auto-approve.
        Set AURA_TOKEN env var for headless/CI.

  The .aura file maps env var names to agent credential references:

    # .aura
    DATABASE_URL=database-prod/url
    STRIPE_KEY=stripe/secret_key
    AGENT_TOKEN=@agent/openai/api_key    # from 'agent' agent
`);
}

// ── Main ──

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const dashIdx = args.indexOf('--');
  if (dashIdx !== -1) {
    const cmdArgs = args.slice(dashIdx + 1);
    return cmdRun(cmdArgs);
  }

  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    showHelp();
    process.exit(0);
  }

  switch (subcommand) {
    case 'init':
      return cmdInit();
    case 'inject':
      return cmdInject();
    case 'check':
      return cmdCheck();
    case 'list':
      return cmdList();
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      showHelp();
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch(async (err) => {
    const handledLock = await maybeHandleLockError({ context: 'env command', error: err });
    if (!handledLock) {
      console.error(`Error: ${getErrorMessage(err)}`);
    }
    process.exit(1);
  });
}
