/**
 * auramaxx shell-hook — Auto-load .aura env vars on cd (like direnv)
 *
 * Usage:
 *   aura shell-hook bash       Output bash hook script
 *   aura shell-hook zsh        Output zsh hook script
 *   aura shell-hook install    Auto-detect shell, add to rc file
 *   aura shell-hook allow      Whitelist current directory
 *   aura shell-hook deny       Remove directory from whitelist
 *   aura shell-hook status     Show whitelist + active dir
 *   aura shell-hook resolve    Internal: resolve .aura and output export statements
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { getErrorMessage } from '../../lib/error';
import {
  escapeForShell,
  searchCredential,
  readCredential,
  validateEnvVarName,
} from '../lib/credential-resolve';

// ── Paths ──

const AURA_DIR = process.env.WALLET_DATA_DIR || path.join(os.homedir(), '.auramaxx');
const ALLOWED_FILE = path.join(AURA_DIR, 'shell-allowed.json');
const CACHE_DIR = path.join(AURA_DIR, 'shell-cache');
const CACHE_SECRET_FILE = path.join(AURA_DIR, 'shell-cache.secret');

// ── Whitelist ──

interface AllowedEntry {
  allowedAt: string;
  hash: string;
}

function loadAllowed(): Record<string, AllowedEntry> {
  try {
    return JSON.parse(fs.readFileSync(ALLOWED_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveAllowed(allowed: Record<string, AllowedEntry>): void {
  fs.mkdirSync(path.dirname(ALLOWED_FILE), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(ALLOWED_FILE, 'w', 0o600);
  fs.writeSync(fd, JSON.stringify(allowed, null, 2) + '\n');
  fs.closeSync(fd);
  fs.chmodSync(ALLOWED_FILE, 0o600);
}

function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ── Cache ──

function getOrCreateCacheSecret(): string {
  try {
    const existing = fs.readFileSync(CACHE_SECRET_FILE, 'utf-8').trim();
    if (existing) {
      try { fs.chmodSync(CACHE_SECRET_FILE, 0o600); } catch {}
      return existing;
    }
  } catch {
    // fall through and recreate
  }

  const secret = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(CACHE_SECRET_FILE), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(CACHE_SECRET_FILE, 'w', 0o600);
  fs.writeSync(fd, secret);
  fs.closeSync(fd);
  fs.chmodSync(CACHE_SECRET_FILE, 0o600);
  return secret;
}

interface CacheEntry {
  vars: Record<string, string>;
  expiresAt: number;
  auraHash: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCacheKey(dir: string): string {
  // Key cache filenames with install-local secret material so paths are not
  // deterministically hashable from directory names alone.
  const secret = getOrCreateCacheSecret();
  return crypto.createHmac('sha256', secret).update(dir).digest('hex').slice(0, 16);
}

function getLegacyCacheKey(dir: string): string {
  return crypto.createHash('sha256').update(dir).digest('hex').slice(0, 16);
}

function getCache(dir: string, auraHash: string): Record<string, string> | null {
  const cacheFile = path.join(CACHE_DIR, `${getCacheKey(dir)}.json`);
  const legacyCacheFile = path.join(CACHE_DIR, `${getLegacyCacheKey(dir)}.json`);

  // Intentional invalidation of legacy deterministic cache filenames.
  try { fs.unlinkSync(legacyCacheFile); } catch {}

  try {
    const raw = fs.readFileSync(cacheFile, 'utf-8');
    const trimmed = raw.trimStart();
    // Try encrypted format first, fall back to legacy plaintext
    let entry: CacheEntry;
    if (trimmed.startsWith('{')) {
      // Legacy plaintext — delete it (audit finding #2)
      fs.unlinkSync(cacheFile);
      return null;
    }
    entry = JSON.parse(decryptCacheEntry(raw));
    if (!entry || typeof entry !== 'object' || typeof entry.expiresAt !== 'number' || typeof entry.auraHash !== 'string' || typeof entry.vars !== 'object' || entry.vars === null) {
      throw new Error('invalid cache entry payload');
    }
    if (entry.expiresAt > Date.now() && entry.auraHash === auraHash) {
      return entry.vars;
    }
  } catch {
    // Cache miss or decryption failure — best-effort cleanup of corrupt entries
    try { fs.unlinkSync(cacheFile); } catch {}
  }
  return null;
}

/**
 * Derive a machine- and install-local encryption key for cache at rest.
 * Includes a per-install secret stored under ~/.auramaxx to avoid
 * deterministic, host/user-only key derivation.
 */
function getCacheEncryptionKey(): Buffer {
  const material = `auramaxx-cache:${AURA_DIR}:${getOrCreateCacheSecret()}`;
  return crypto.createHash('sha256').update(material).digest();
}

function encryptCacheEntry(data: string): string {
  const key = getCacheEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all base64)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptCacheEntry(blob: string): string {
  const key = getCacheEncryptionKey();
  const parts = blob.split(':');
  if (parts.length !== 3) {
    throw new Error('invalid cache entry format');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}

function setCache(dir: string, vars: Record<string, string>, auraHash: string): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CACHE_DIR, 0o700); } catch {}
  const cacheFile = path.join(CACHE_DIR, `${getCacheKey(dir)}.json`);
  const legacyCacheFile = path.join(CACHE_DIR, `${getLegacyCacheKey(dir)}.json`);
  try { fs.unlinkSync(legacyCacheFile); } catch {}
  const entry: CacheEntry = {
    vars,
    expiresAt: Date.now() + CACHE_TTL_MS,
    auraHash,
  };
  const encrypted = encryptCacheEntry(JSON.stringify(entry));
  const fd = fs.openSync(cacheFile, 'w', 0o600);
  fs.writeSync(fd, encrypted);
  fs.closeSync(fd);
  fs.chmodSync(cacheFile, 0o600);
}

// ── Shell hooks ──

function bashHook(): string {
  return `# Aura shell hook — auto-load .aura env vars
_aura_hook() {
  local prev_aura_dir="\${_AURA_DIR:-}"
  local aura_file=""
  local check_dir="$PWD"

  while [ "$check_dir" != "/" ]; do
    if [ -f "$check_dir/.aura" ]; then
      aura_file="$check_dir/.aura"
      break
    fi
    check_dir="$(dirname "$check_dir")"
  done

  if [ -n "$aura_file" ]; then
    local aura_dir="$(dirname "$aura_file")"
    if [ "$aura_dir" != "$prev_aura_dir" ]; then
      if [ -n "$prev_aura_dir" ] && [ -n "\${_AURA_VARS:-}" ]; then
        for var in $_AURA_VARS; do unset "$var"; done
      fi
      local output
      output="$(aura shell-hook resolve 2>/dev/null)"
      if [ $? -eq 0 ] && [ -n "$output" ]; then
        eval "$output"
        export _AURA_DIR="$aura_dir"
      fi
    fi
  elif [ -n "$prev_aura_dir" ]; then
    if [ -n "\${_AURA_VARS:-}" ]; then
      for var in $_AURA_VARS; do unset "$var"; done
    fi
    unset _AURA_DIR _AURA_VARS
  fi
}

if [[ ";\${PROMPT_COMMAND:-};" != *";_aura_hook;"* ]]; then
  PROMPT_COMMAND="_aura_hook;\${PROMPT_COMMAND:-}"
fi
`;
}

function zshHook(): string {
  return `# Aura shell hook — auto-load .aura env vars
_aura_hook() {
  local prev_aura_dir="\${_AURA_DIR:-}"
  local aura_file=""
  local check_dir="$PWD"

  while [[ "$check_dir" != "/" ]]; do
    if [[ -f "$check_dir/.aura" ]]; then
      aura_file="$check_dir/.aura"
      break
    fi
    check_dir="$(dirname "$check_dir")"
  done

  if [[ -n "$aura_file" ]]; then
    local aura_dir="$(dirname "$aura_file")"
    if [[ "$aura_dir" != "$prev_aura_dir" ]]; then
      if [[ -n "$prev_aura_dir" ]] && [[ -n "\${_AURA_VARS:-}" ]]; then
        for var in \${(z)_AURA_VARS}; do unset "$var"; done
      fi
      local output
      output="$(aura shell-hook resolve 2>/dev/null)"
      if [[ $? -eq 0 ]] && [[ -n "$output" ]]; then
        eval "$output"
        export _AURA_DIR="$aura_dir"
      fi
    fi
  elif [[ -n "$prev_aura_dir" ]]; then
    if [[ -n "\${_AURA_VARS:-}" ]]; then
      for var in \${(z)_AURA_VARS}; do unset "$var"; done
    fi
    unset _AURA_DIR _AURA_VARS
  fi
}

autoload -U add-zsh-hook
add-zsh-hook chpwd _aura_hook
_aura_hook
`;
}

// ── Resolve (internal) ──

async function cmdResolve(): Promise<void> {
  let dir = process.cwd();
  let auraFile: string | null = null;
  while (true) {
    const candidate = path.join(dir, '.aura');
    if (fs.existsSync(candidate)) { auraFile = candidate; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (!auraFile) process.exit(1);

  const auraDir = path.dirname(auraFile);
  const auraHash = hashFile(auraFile);

  // Check whitelist
  const allowed = loadAllowed();
  const entry = allowed[auraDir];
  if (!entry) {
    console.error(`aura: ${auraDir} is not allowed. Run: aura shell-hook allow`);
    process.exit(1);
  }
  if (entry.hash !== auraHash) {
    console.error(`aura: .aura file changed in ${auraDir}. Run: aura shell-hook allow`);
    process.exit(1);
  }

  // Check cache
  const cached = getCache(auraDir, auraHash);
  if (cached) {
    outputExports(cached);
    return;
  }

  // Resolve from agent using shared module (audit finding #3)
  const { parseAuraFile } = await import('./env');
  const {
    generateEphemeralKeypair,
    bootstrapViaSocket,
    bootstrapViaAuthRequest,
    decryptWithPrivateKey,
    createReadToken,
  } = await import('../../lib/credential-transport');
  const { serverUrl } = await import('../lib/http');
  const { resolveMappings } = await import('../lib/credential-resolve');

  const keypair = generateEphemeralKeypair();
  const envToken = process.env.AURA_TOKEN;
  const token = envToken || await (async () => {
    try {
      return await bootstrapViaSocket('shell-hook', keypair);
    } catch (socketErr) {
      return bootstrapViaAuthRequest(serverUrl(), 'shell-hook', keypair, {
        onStatus: (message) => console.error(message),
      }).catch((authErr) => {
        throw new Error(`${getErrorMessage(socketErr)}\n${getErrorMessage(authErr)}`);
      });
    }
  })();
  const base = serverUrl();
  const readToken = await createReadToken(base, token, keypair, 'shell-hook-reader');

  const mappings = parseAuraFile(auraFile);
  const decryptFn = (encrypted: string) => decryptWithPrivateKey(encrypted, keypair.privateKeyPem);
  const { resolved } = await resolveMappings(mappings, base, token, readToken, decryptFn);

  const vars: Record<string, string> = Object.fromEntries(resolved);
  setCache(auraDir, vars, auraHash);
  outputExports(vars);
}

function outputExports(vars: Record<string, string>): void {
  const varNames: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    // Validate env var name to prevent injection via key (audit finding #6)
    validateEnvVarName(key);
    // Use ANSI-C $'...' quoting for safe shell escaping (audit finding #1)
    console.log(`export ${key}=${escapeForShell(value)}`);
    varNames.push(key);
  }
  if (varNames.length > 0) {
    console.log(`export _AURA_VARS=${escapeForShell(varNames.join(' '))}`);
  }
}

// ── Install ──

function cmdInstall(): void {
  const shell = path.basename(process.env.SHELL || 'bash');
  let rcFile: string;
  let hookCmd: string;

  switch (shell) {
    case 'zsh':
      rcFile = path.join(os.homedir(), '.zshrc');
      hookCmd = 'eval "$(aura shell-hook zsh)"';
      break;
    case 'bash':
      rcFile = path.join(os.homedir(), '.bashrc');
      hookCmd = 'eval "$(aura shell-hook bash)"';
      break;
    default:
      console.error(`Unsupported shell: ${shell}. Manually add the hook to your rc file.`);
      process.exit(1);
      return;
  }

  if (fs.existsSync(rcFile)) {
    const content = fs.readFileSync(rcFile, 'utf-8');
    if (content.includes('aura shell-hook')) {
      console.log(`Aura shell hook already installed in ${rcFile}`);
      return;
    }
  }

  fs.appendFileSync(rcFile, `\n# Aura shell hook — auto-load .aura env vars\n${hookCmd}\n`);
  console.log(`✓ Added shell hook to ${rcFile}`);
  console.log(`  Restart your shell or run: source ${rcFile}`);
}

// ── Allow / Deny / Status ──

function cmdAllow(dir?: string): void {
  const targetDir = dir ? path.resolve(dir) : process.cwd();
  const auraFile = path.join(targetDir, '.aura');

  if (!fs.existsSync(auraFile)) {
    console.error(`No .aura file found in ${targetDir}`);
    process.exit(1);
  }

  const allowed = loadAllowed();
  allowed[targetDir] = {
    allowedAt: new Date().toISOString(),
    hash: hashFile(auraFile),
  };
  saveAllowed(allowed);
  console.log(`✓ Allowed ${targetDir}`);
}

function cmdDeny(dir?: string): void {
  const targetDir = dir ? path.resolve(dir) : process.cwd();
  const allowed = loadAllowed();
  if (allowed[targetDir]) {
    delete allowed[targetDir];
    saveAllowed(allowed);
    console.log(`✓ Denied ${targetDir}`);
  } else {
    console.log(`${targetDir} was not in the whitelist.`);
  }
}

function cmdStatus(): void {
  const allowed = loadAllowed();
  const entries = Object.entries(allowed);

  if (entries.length === 0) {
    console.log('No directories whitelisted.');
    console.log('Run `aura shell-hook allow` in a directory with a .aura file.');
    return;
  }

  console.log('Whitelisted directories:\n');
  for (const [dir, entry] of entries) {
    const auraExists = fs.existsSync(path.join(dir, '.aura'));
    let status = auraExists ? '✓' : '✗ .aura missing';
    if (auraExists) {
      const currentHash = hashFile(path.join(dir, '.aura'));
      if (currentHash !== entry.hash) {
        status = '⚠ .aura changed (run allow again)';
      }
    }
    console.log(`  ${status} ${dir}`);
    console.log(`    Allowed: ${entry.allowedAt}`);
  }
}

// ── Help ──

function showHelp(): void {
  console.log(`
  auramaxx shell-hook — Auto-load .aura env vars on cd

  Usage:
    aura shell-hook bash       Output bash hook script
    aura shell-hook zsh        Output zsh hook script
    aura shell-hook install    Auto-detect shell, add to rc file
    aura shell-hook allow      Whitelist current directory
    aura shell-hook deny       Remove from whitelist
    aura shell-hook status     Show whitelist

  Quick start:
    aura shell-hook install    # One-time setup
    cd my-project              # Has .aura file
    aura shell-hook allow      # Whitelist this project
    cd ../ && cd my-project    # Env vars auto-loaded!
`);
}

// ── Main ──

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    showHelp();
    process.exit(0);
  }

  switch (subcommand) {
    case 'bash':
      process.stdout.write(bashHook());
      return;
    case 'zsh':
      process.stdout.write(zshHook());
      return;
    case 'install':
      return cmdInstall();
    case 'allow':
      return cmdAllow(args[1]);
    case 'deny':
      return cmdDeny(args[1]);
    case 'status':
      return cmdStatus();
    case 'resolve':
      return cmdResolve();
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${getErrorMessage(err)}`);
  process.exit(1);
});
