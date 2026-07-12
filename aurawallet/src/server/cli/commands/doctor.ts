/**
 * auramaxx doctor — deterministic onboarding/runtime diagnostics
 */

import fs from 'fs';
import path from 'path';
import net from 'net';
import os from 'os';
import { spawnSync } from 'child_process';
import { fetchJson, serverUrl, type SetupStatus } from '../lib/http';
import { parseAuraFile, type AuraMapping } from '../lib/aura-parser';
import { getErrorMessage } from '../../lib/error';
import { printBanner, checkBadge, printSection } from '../lib/theme';
import { resolveAuraSocketCandidates, resolveAuraSocketIdentity } from '../../lib/socket-path';

export type CheckStatus = 'pass' | 'warn' | 'fail';
export type CheckSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface DoctorCheck {
  id: string;
  code: string;
  severity: CheckSeverity;
  status: CheckStatus;
  finding: string;
  evidence: string;
  remediation: string;
}

interface DoctorResult {
  ok: boolean;
  mode: 'default' | 'strict';
  summary: { pass: number; warn: number; fail: number };
  checks: DoctorCheck[];
  fixes: string[];
}

interface DoctorOptions {
  json: boolean;
  strict: boolean;
  fix: boolean;
}

interface CredentialHealthSummary {
  totalAnalyzed: number;
  safe: number;
  weak: number;
  reused: number;
  breached: number;
  unknown: number;
  lastScanAt: string | null;
}

interface TokenValidateResponse {
  valid: boolean;
  error?: string;
  payload?: {
    permissions?: string[];
  };
}

interface AuthProbeState {
  socketViable: boolean;
  tokenPresent: boolean;
  tokenShapeValid: boolean;
  tokenMask: string;
  tokenValidate?: TokenValidateResponse;
}

const EXIT = {
  OK: 0,
  FAIL: 1,
  INTERNAL: 2,
  ARGS: 3,
} as const;

const MAX_SECURITY_ENTRIES = 200;
const SECURITY_TIME_BUDGET_MS = 2000;
const MAX_AURA_MAPPINGS = 100;
const MAX_UNIQUE_CREDENTIAL_PROBES = 25;
const HTTP_TIMEOUT_MS = 1500;
const AURA_RC_BLOCK_START = '# >>> Aura CLI managed fallback >>>';
const AURA_RC_BLOCK_END = '# <<< Aura CLI managed fallback <<<';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}-timeout`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function parseArgs(argv: string[]): DoctorOptions {
  const flags = new Set(argv);
  for (const flag of flags) {
    if (!['--json', '--strict', '--fix', '--help', '-h'].includes(flag)) {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }

  if (flags.has('--help') || flags.has('-h')) {
    console.log('Usage: npx auramaxx doctor [--json] [--strict] [--fix]');
    process.exit(EXIT.OK);
  }

  return {
    json: flags.has('--json'),
    strict: flags.has('--strict'),
    fix: flags.has('--fix'),
  };
}

function findCommandInPath(commandName: string): string | null {
  const pathEntries = (process.env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const extCandidates = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((ext) => ext.trim())
      .filter(Boolean)
    : [''];

  for (const dir of pathEntries) {
    for (const ext of extCandidates) {
      const candidate = process.platform === 'win32'
        ? path.join(dir, `${commandName}${ext}`)
        : path.join(dir, commandName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // continue searching
      }
    }
  }

  return null;
}

function resolveShellRcTarget(): string | null {
  const shell = path.basename(process.env.SHELL || '');
  switch (shell) {
    case 'zsh':
      return path.join(os.homedir(), '.zshrc');
    case 'bash':
      return path.join(os.homedir(), '.bashrc');
    default:
      return null;
  }
}

function renderManagedFallbackBlock(): string {
  return [
    AURA_RC_BLOCK_START,
    '# Ensures aura/auramaxx work across restarts without global install.',
    'aura() { npx auramaxx "$@"; }',
    'auramaxx() { npx auramaxx "$@"; }',
    AURA_RC_BLOCK_END,
  ].join('\n');
}

function stripLegacyAuraAliasLines(content: string): { content: string; removed: boolean } {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let removed = false;

  for (const line of lines) {
    const isAuraNpxAlias = /^\s*alias\s+aura=.+\bnpx\s+auramaxx\b.*$/.test(line);
    const isAuramaxxNpxAlias = /^\s*alias\s+auramaxx=.+\bnpx\s+auramaxx\b.*$/.test(line);
    const isAuraAliasComment = /^\s*#\s*Aura CLI shorthand\s*$/.test(line);
    if (isAuraNpxAlias || isAuramaxxNpxAlias || isAuraAliasComment) {
      removed = true;
      continue;
    }
    kept.push(line);
  }

  return {
    content: kept.join('\n').replace(/\n+$/, ''),
    removed,
  };
}

function upsertManagedFallbackBlock(content: string): string {
  const block = renderManagedFallbackBlock();
  const start = content.indexOf(AURA_RC_BLOCK_START);
  const end = content.indexOf(AURA_RC_BLOCK_END);

  if (start !== -1 && end !== -1 && end > start) {
    const endWithMarker = end + AURA_RC_BLOCK_END.length;
    const nextChar = content[endWithMarker] === '\n' ? endWithMarker + 1 : endWithMarker;
    return `${content.slice(0, start)}${block}${content.slice(nextChar)}`;
  }

  return `${content}${content.trim() ? '\n\n' : ''}${block}`;
}

function fixShellFallback(): {
  ok: boolean;
  rcFile?: string;
  message: string;
} {
  const rcFile = resolveShellRcTarget();
  if (!rcFile) {
    return {
      ok: false,
      message: 'unsupported-shell',
    };
  }

  let original = '';
  try {
    if (fs.existsSync(rcFile)) {
      original = fs.readFileSync(rcFile, 'utf-8');
    }
  } catch {
    return {
      ok: false,
      rcFile,
      message: 'read-failed',
    };
  }

  const stripped = stripLegacyAuraAliasLines(original);
  const updated = `${upsertManagedFallbackBlock(stripped.content).replace(/\n+$/, '')}\n`;
  const originalNormalized = `${original.replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n`;
  if (updated === originalNormalized) {
    return {
      ok: true,
      rcFile,
      message: 'already-present',
    };
  }

  try {
    fs.writeFileSync(rcFile, updated);
    return {
      ok: true,
      rcFile,
      message: stripped.removed ? 'installed-and-migrated' : 'installed',
    };
  } catch {
    return {
      ok: false,
      rcFile,
      message: 'write-failed',
    };
  }
}

function maskToken(token?: string): string {
  if (!token) return 'absent';
  const trimmed = token.trim();
  if (!trimmed) return 'present-empty';
  return `tok_****${trimmed.slice(-4)}`;
}

function checkTokenShape(token?: string): boolean {
  if (!token) return false;
  return token.trim().length >= 16;
}

async function probeSocketPath(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const client = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, 500);

    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.destroy();
      resolve(value);
    };

    client.once('connect', () => {
      client.write('{"type":"ping"}\n');
    });
    client.once('data', (buf) => {
      const msg = buf.toString('utf8');
      finish(msg.includes('pong'));
    });
    client.once('error', () => finish(false));
    client.once('close', () => finish(false));
  });
}

export async function probeSocketViability(options: {
  platform?: NodeJS.Platform;
  socketPaths?: string[];
} = {}): Promise<{ viable: boolean; evidence: string }> {
  const platform = options.platform || process.platform;
  const uid = resolveAuraSocketIdentity();
  const socketPaths = options.socketPaths || resolveAuraSocketCandidates({
    uid,
    serverUrl: serverUrl(),
    serverPort: process.env.WALLET_SERVER_PORT,
  });

  if (platform === 'win32') {
    let lastFailure = 'socket-missing';
    for (const socketPath of socketPaths) {
      const connectOk = await probeSocketPath(socketPath);
      if (connectOk) {
        return { viable: true, evidence: `socket-connect-ping-ok:${socketPath}` };
      }
      lastFailure = `socket-connect-failed:${socketPath}`;
    }
    return { viable: false, evidence: lastFailure };
  }

  let sawExistingSocket = false;
  let lastFailure = 'socket-missing';

  for (const socketPath of socketPaths) {
    let st: fs.Stats;
    try {
      st = fs.statSync(socketPath);
    } catch {
      continue;
    }

    sawExistingSocket = true;

    if (!st.isSocket()) {
      lastFailure = 'socket-path-not-unix-socket';
      continue;
    }
    if (typeof uid === 'number' && st.uid !== uid) {
      lastFailure = 'socket-owner-mismatch';
      continue;
    }
    if ((st.mode & 0o777) > 0o600) {
      lastFailure = 'socket-perms-too-open';
      continue;
    }

    const connectOk = await probeSocketPath(socketPath);
    if (connectOk) {
      return { viable: true, evidence: `socket-connect-ping-ok:${socketPath}` };
    }
    lastFailure = `socket-connect-failed:${socketPath}`;
  }

  if (!sawExistingSocket) return { viable: false, evidence: 'socket-missing' };
  return { viable: false, evidence: lastFailure };
}

function normalizeStatus(status: number): CheckStatus {
  if (status >= 500) return 'fail';
  if (status >= 400) return 'warn';
  return 'pass';
}

export function evaluateCredentialHealthSeverity(summary: CredentialHealthSummary): {
  status: CheckStatus;
  severity: CheckSeverity;
  code: string;
  finding: string;
  remediation: string;
  evidence: string;
} {
  if (summary.breached > 0) {
    return {
      status: 'fail',
      severity: 'high',
      code: 'AURA_DOCTOR_CREDENTIAL_HEALTH_BREACHED',
      finding: 'Credential health check found breached credentials.',
      remediation: 'Rotate breached credentials immediately and rerun scan',
      evidence: `breached=${summary.breached},weak=${summary.weak},reused=${summary.reused},unknown=${summary.unknown}`,
    };
  }

  if (summary.weak > 0 || summary.reused > 0 || summary.unknown > 0) {
    const unknownRemediation = summary.unknown > 0
      ? ' Retry health scan with HEALTH_BREACH_CHECK=true to resolve unknown breach status.'
      : '';
    return {
      status: 'warn',
      severity: 'medium',
      code: summary.unknown > 0
        ? 'AURA_DOCTOR_CREDENTIAL_HEALTH_WARN_UNKNOWN'
        : 'AURA_DOCTOR_CREDENTIAL_HEALTH_WARN_RISK',
      finding: 'Credential health check found weak/reused/unknown-risk credentials.',
      remediation: `Fix weak/reused credentials and rerun scan.${unknownRemediation}`.trim(),
      evidence: `breached=${summary.breached},weak=${summary.weak},reused=${summary.reused},unknown=${summary.unknown}`,
    };
  }

  return {
    status: 'pass',
    severity: 'info',
    code: 'AURA_DOCTOR_CREDENTIAL_HEALTH_PASS',
    finding: 'Credential health check found no weak/reused/breached/unknown credentials.',
    remediation: 'none',
    evidence: `breached=0,weak=0,reused=0,unknown=0`,
  };
}

async function fetchWithStatus(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await withTimeout(fetch(url, init), HTTP_TIMEOUT_MS, 'http');
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

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

function listLikelySecretFiles(cwd: string): { checked: number; matches: string[]; timedOut: boolean } {
  const started = Date.now();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  let checked = 0;
  const matches: string[] = [];

  while (queue.length > 0) {
    if (Date.now() - started > SECURITY_TIME_BUDGET_MS) {
      return { checked, matches, timedOut: true };
    }
    const { dir, depth } = queue.shift()!;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      checked += 1;
      if (checked > MAX_SECURITY_ENTRIES) {
        return { checked, matches, timedOut: false };
      }

      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 2 && entry.name !== 'node_modules' && !entry.name.startsWith('.git')) {
        queue.push({ dir: full, depth: depth + 1 });
        continue;
      }

      if (!entry.isFile()) continue;
      if (/\.env($|\.)/i.test(entry.name) || /token/i.test(entry.name)) {
        matches.push(path.relative(cwd, full));
      }
    }
  }

  return { checked, matches, timedOut: false };
}

async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const fixes: string[] = [];

  const addCheck = (check: DoctorCheck) => checks.push(check);

  // cli.command.persistence
  const auraPath = findCommandInPath('aura');
  const auramaxxPath = findCommandInPath('auramaxx');
  const commandsAvailable = Boolean(auraPath && auramaxxPath);
  if (commandsAvailable) {
    addCheck({
      id: 'cli.command.persistence',
      code: 'AURA_DOCTOR_CLI_COMMANDS_AVAILABLE',
      severity: 'info',
      status: 'pass',
      finding: 'Aura CLI commands are available on PATH.',
      evidence: `aura=${auraPath};auramaxx=${auramaxxPath}`,
      remediation: 'none',
    });
  } else if (options.fix) {
    const fixResult = fixShellFallback();
    if (fixResult.ok) {
      const rcEvidence = fixResult.rcFile ? `rc=${fixResult.rcFile}` : 'rc=unknown';
      addCheck({
        id: 'cli.command.persistence',
        code: 'AURA_DOCTOR_CLI_FALLBACK_INSTALLED',
        severity: 'info',
        status: 'pass',
        finding: 'Installed persistent shell fallback for aura/auramaxx commands.',
        evidence: `${fixResult.message};${rcEvidence}`,
        remediation: fixResult.rcFile ? `Run: source ${fixResult.rcFile}` : 'Open a new shell',
      });
      fixes.push(
        fixResult.rcFile
          ? `Installed/updated Aura fallback block in ${fixResult.rcFile}.`
          : 'Installed/updated Aura fallback block.'
      );
    } else {
      addCheck({
        id: 'cli.command.persistence',
        code: fixResult.message === 'unsupported-shell'
          ? 'AURA_DOCTOR_CLI_FALLBACK_UNSUPPORTED_SHELL'
          : 'AURA_DOCTOR_CLI_FALLBACK_INSTALL_FAILED',
        severity: fixResult.message === 'unsupported-shell' ? 'medium' : 'high',
        status: 'warn',
        finding: 'Aura CLI commands are missing and shell fallback auto-fix did not complete.',
        evidence: `fix-error=${fixResult.message}${fixResult.rcFile ? `;rc=${fixResult.rcFile}` : ''}`,
        remediation: 'Install globally: npm install -g auramaxx (fallback: npx --yes auramaxx@latest start)',
      });
    }
  } else {
    addCheck({
      id: 'cli.command.persistence',
      code: 'AURA_DOCTOR_CLI_COMMANDS_MISSING',
      severity: 'medium',
      status: 'warn',
      finding: 'Aura CLI commands are not available on PATH.',
      evidence: 'command-not-found',
      remediation: 'Run: npm install -g auramaxx (fallback: npx --yes auramaxx@latest doctor --fix)',
    });
  }

  // runtime.api.health
  let apiHealthy = false;
  try {
    const health = await fetchWithStatus(`${serverUrl()}/health`);
    apiHealthy = health.ok;
    addCheck({
      id: 'runtime.api.health',
      code: health.ok ? 'AURA_DOCTOR_RUNTIME_API_HEALTHY' : 'AURA_DOCTOR_RUNTIME_API_UNREACHABLE',
      severity: health.ok ? 'info' : 'critical',
      status: health.ok ? 'pass' : 'fail',
      finding: health.ok ? 'Aura API is reachable.' : 'Aura API is unreachable.',
      evidence: health.ok ? `health-status-${health.status}` : `health-status-${health.status}`,
      remediation: health.ok ? 'none' : 'Run: npx auramaxx',
    });
  } catch (err) {
    addCheck({
      id: 'runtime.api.health',
      code: 'AURA_DOCTOR_RUNTIME_API_UNREACHABLE',
      severity: 'critical',
      status: 'fail',
      finding: 'Aura API is unreachable.',
      evidence: `health-error-${getErrorMessage(err)}`,
      remediation: 'Run: npx auramaxx',
    });
  }

  // runtime.api.setup + agent checks
  let setup: SetupStatus | null = null;
  try {
    setup = await fetchJson<SetupStatus>('/setup');
    addCheck({
      id: 'runtime.api.setup',
      code: 'AURA_DOCTOR_RUNTIME_SETUP_OK',
      severity: 'info',
      status: 'pass',
      finding: 'Setup endpoint responded.',
      evidence: 'setup-response-valid',
      remediation: 'none',
    });
  } catch (err) {
    addCheck({
      id: 'runtime.api.setup',
      code: 'AURA_DOCTOR_RUNTIME_SETUP_ERROR',
      severity: 'high',
      status: 'fail',
      finding: 'Setup endpoint check failed.',
      evidence: `setup-error-${getErrorMessage(err)}`,
      remediation: 'Run: npx auramaxx',
    });
  }

  // runtime.dashboard.reachability (never fail)
  if (!apiHealthy) {
    addCheck({
      id: 'runtime.dashboard.reachability',
      code: 'AURA_DOCTOR_DASHBOARD_SKIPPED_API_UNHEALTHY',
      severity: 'low',
      status: 'warn',
      finding: 'Dashboard check skipped while API is unhealthy.',
      evidence: 'api-unhealthy-dashboard-check-skipped',
      remediation: 'Run: npx auramaxx',
    });
  } else {
    try {
      const dashboard = await withTimeout(fetch('http://localhost:4747'), 1500, 'dashboard');
      const reachable = dashboard.ok || (dashboard.status >= 300 && dashboard.status < 400);
      addCheck({
        id: 'runtime.dashboard.reachability',
        code: reachable ? 'AURA_DOCTOR_DASHBOARD_REACHABLE' : 'AURA_DOCTOR_DASHBOARD_UNREACHABLE',
        severity: reachable ? 'info' : 'low',
        status: reachable ? 'pass' : 'warn',
        finding: reachable ? 'Dashboard endpoint is reachable.' : 'Dashboard endpoint is not reachable in current mode.',
        evidence: reachable ? 'dashboard-reachable' : 'headless-or-dashboard-not-running',
        remediation: reachable ? 'none' : 'If UI needed: npx auramaxx',
      });
    } catch {
      addCheck({
        id: 'runtime.dashboard.reachability',
        code: 'AURA_DOCTOR_DASHBOARD_UNREACHABLE',
        severity: 'low',
        status: 'warn',
        finding: 'Dashboard endpoint is not reachable in current mode.',
        evidence: 'headless-or-dashboard-not-running',
        remediation: 'If UI needed: npx auramaxx',
      });
    }
  }

  const hasWallet = !!setup?.hasWallet;
  const unlocked = !!setup?.unlocked;
  const hasAddress = !!setup?.address;

  // agent.exists
  addCheck({
    id: 'agent.exists',
    code: hasWallet ? 'AURA_DOCTOR_AGENT_EXISTS' : 'AURA_DOCTOR_AGENT_MISSING',
    severity: hasWallet ? 'info' : 'high',
    status: hasWallet ? 'pass' : 'fail',
    finding: hasWallet ? 'Primary agent exists.' : 'No agent found.',
    evidence: hasWallet ? 'hasWallet=true' : 'hasWallet=false',
    remediation: hasWallet ? 'none' : 'Run: npx auramaxx',
  });

  // agent.unlock_state
  addCheck({
    id: 'agent.unlock_state',
    code: unlocked ? 'AURA_DOCTOR_AGENT_UNLOCKED' : 'AURA_DOCTOR_AGENT_LOCKED',
    severity: unlocked ? 'info' : 'medium',
    status: unlocked ? 'pass' : 'warn',
    finding: unlocked ? 'Agent is unlocked.' : 'Agent is locked.',
    evidence: `unlocked=${unlocked}`,
    remediation: unlocked ? 'none' : 'Run: npx auramaxx unlock',
  });

  // agent.primary.address tuple
  let addressStatus: CheckStatus = 'pass';
  let addressSeverity: CheckSeverity = 'info';
  let addressEvidence = 'wallet-locked-address-not-required';
  let addressCode = 'AURA_DOCTOR_AGENT_PRIMARY_ADDRESS_NA_LOCKED';
  let addressFinding = 'Primary address is not required while locked.';
  let addressRemediation = 'none';

  if (!hasWallet) {
    addressStatus = 'fail';
    addressSeverity = 'high';
    addressEvidence = 'no-wallet';
    addressCode = 'AURA_DOCTOR_AGENT_NO_WALLET';
    addressFinding = 'Primary address unavailable because no agent exists.';
    addressRemediation = 'Run: npx auramaxx';
  } else if (unlocked && hasAddress) {
    addressStatus = 'pass';
    addressSeverity = 'info';
    addressEvidence = 'primary-address-present';
    addressCode = 'AURA_DOCTOR_AGENT_PRIMARY_ADDRESS_PRESENT';
    addressFinding = 'Primary address is present.';
    addressRemediation = 'none';
  } else if (unlocked && !hasAddress) {
    addressStatus = 'warn';
    addressSeverity = 'medium';
    addressEvidence = 'unlocked-without-primary-address';
    addressCode = 'AURA_DOCTOR_AGENT_PRIMARY_ADDRESS_MISSING';
    addressFinding = 'Agent is unlocked but primary address is missing.';
    addressRemediation = 'Run: npx auramaxx';
  }

  addCheck({
    id: 'agent.primary.address',
    code: addressCode,
    severity: addressSeverity,
    status: addressStatus,
    finding: addressFinding,
    evidence: addressEvidence,
    remediation: addressRemediation,
  });

  // auth.socket.path
  const socketProbe = await probeSocketViability();
  addCheck({
    id: 'auth.socket.path',
    code: socketProbe.viable ? 'AURA_DOCTOR_AUTH_SOCKET_VIABLE' : 'AURA_DOCTOR_AUTH_SOCKET_NOT_VIABLE',
    severity: socketProbe.viable ? 'info' : 'low',
    status: socketProbe.viable ? 'pass' : 'warn',
    finding: socketProbe.viable ? 'Unix socket auth is viable.' : 'Unix socket auth is not viable.',
    evidence: socketProbe.evidence,
    remediation: socketProbe.viable ? 'none' : 'Run: npx auramaxx',
  });

  // auth.token.env
  const envToken = process.env.AURA_TOKEN;
  const tokenPresent = !!envToken;
  const tokenShapeValid = checkTokenShape(envToken);
  addCheck({
    id: 'auth.token.env',
    code: tokenPresent ? (tokenShapeValid ? 'AURA_DOCTOR_AUTH_TOKEN_PRESENT' : 'AURA_DOCTOR_AUTH_TOKEN_INVALID_SHAPE') : 'AURA_DOCTOR_AUTH_TOKEN_MISSING',
    severity: tokenPresent ? (tokenShapeValid ? 'info' : 'medium') : 'low',
    status: tokenPresent ? (tokenShapeValid ? 'pass' : 'warn') : 'warn',
    finding: tokenPresent ? (tokenShapeValid ? 'AURA_TOKEN is present.' : 'AURA_TOKEN is present but malformed.') : 'AURA_TOKEN is not set.',
    evidence: maskToken(envToken),
    remediation: tokenPresent ? (tokenShapeValid ? 'none' : 'Export a valid AURA_TOKEN') : 'Export AURA_TOKEN or rely on socket auth',
  });

  // auth.mode.viability matrix
  const tokenViable = tokenPresent && tokenShapeValid;
  const authViable = socketProbe.viable || tokenViable;
  addCheck({
    id: 'auth.mode.viability',
    code: authViable ? 'AURA_DOCTOR_AUTH_MODE_VIABLE' : 'AURA_DOCTOR_AUTH_MODE_UNAVAILABLE',
    severity: authViable ? 'info' : 'critical',
    status: authViable ? 'pass' : 'fail',
    finding: authViable ? 'At least one auth bootstrap mode is viable.' : 'No viable auth bootstrap mode found.',
    evidence: authViable
      ? (socketProbe.viable && tokenViable ? 'socket-and-token-available' : socketProbe.viable ? 'socket-available' : 'token-available')
      : 'no-viable-auth-bootstrap',
    remediation: authViable ? 'none' : 'Start daemon for socket (npx auramaxx) or export AURA_TOKEN',
  });

  const authProbeState: AuthProbeState = {
    socketViable: socketProbe.viable,
    tokenPresent,
    tokenShapeValid,
    tokenMask: maskToken(envToken),
  };

  // token introspection (only if env token present + shape valid)
  if (tokenViable) {
    try {
      const validate = await fetchJson<TokenValidateResponse>('/auth/validate', {
        body: { token: envToken },
      });
      authProbeState.tokenValidate = validate;
    } catch (err) {
      authProbeState.tokenValidate = {
        valid: false,
        error: getErrorMessage(err),
      };
    }
  }

  // credential.list.readiness (read-only)
  if (!tokenViable) {
    addCheck({
      id: 'credential.list.readiness',
      code: 'AURA_DOCTOR_CREDENTIAL_LIST_TOKEN_UNAVAILABLE',
      severity: 'medium',
      status: 'warn',
      finding: 'Credential list readiness requires explicit token audit mode.',
      evidence: 'socket-mode-no-explicit-token',
      remediation: 'Export AURA_TOKEN for explicit credential-read checks',
    });
  } else {
    try {
      const response = await fetchWithStatus(`${serverUrl()}/credentials`, {
        headers: {
          Authorization: `Bearer ${envToken}`,
        },
      });

      const status = normalizeStatus(response.status);
      const code = response.ok
        ? 'AURA_DOCTOR_CREDENTIAL_LIST_READY'
        : response.status === 401 || response.status === 403
          ? 'AURA_DOCTOR_CREDENTIAL_LIST_UNAUTHORIZED'
          : 'AURA_DOCTOR_CREDENTIAL_LIST_ERROR';

      addCheck({
        id: 'credential.list.readiness',
        code,
        severity: status === 'pass' ? 'info' : status === 'warn' ? 'medium' : 'high',
        status,
        finding: response.ok ? 'Credential list endpoint is readable.' : 'Credential list endpoint is not readable.',
        evidence: `credentials-list-http-${response.status}`,
        remediation: response.ok ? 'none' : 'Grant secret:read scope or refresh token',
      });
    } catch (err) {
      addCheck({
        id: 'credential.list.readiness',
        code: 'AURA_DOCTOR_CREDENTIAL_LIST_ERROR',
        severity: 'high',
        status: 'fail',
        finding: 'Credential list endpoint check failed.',
        evidence: `credentials-list-error-${getErrorMessage(err)}`,
        remediation: 'Verify Aura API health and token scope',
      });
    }
  }

  // credential.scope.sanity
  if (!tokenViable) {
    addCheck({
      id: 'credential.scope.sanity',
      code: 'AURA_DOCTOR_SCOPE_TOKEN_INTROSPECTION_UNAVAILABLE',
      severity: 'low',
      status: 'warn',
      finding: 'Token scope introspection unavailable without explicit token.',
      evidence: 'socket-mode-no-explicit-token',
      remediation: 'Export AURA_TOKEN for explicit scope audit',
    });
  } else if (!authProbeState.tokenValidate?.valid) {
    addCheck({
      id: 'credential.scope.sanity',
      code: 'AURA_DOCTOR_SCOPE_TOKEN_INVALID',
      severity: 'high',
      status: 'fail',
      finding: 'Provided token failed validation.',
      evidence: 'token-validation-failed',
      remediation: 'Export a valid AURA_TOKEN with secret:read permissions',
    });
  } else {
    const permissions = authProbeState.tokenValidate.payload?.permissions || [];
    const hasSecretRead = permissions.includes('admin:*') || permissions.includes('secret:read');
    addCheck({
      id: 'credential.scope.sanity',
      code: hasSecretRead ? 'AURA_DOCTOR_SCOPE_OK' : 'AURA_DOCTOR_SCOPE_MISSING_SECRET_READ',
      severity: hasSecretRead ? 'info' : 'high',
      status: hasSecretRead ? 'pass' : 'fail',
      finding: hasSecretRead ? 'Token scope includes secret read access.' : 'Token scope is missing secret:read access.',
      evidence: hasSecretRead ? 'required-scope-present' : 'required-scope-missing-secret-read',
      remediation: hasSecretRead ? 'none' : 'Issue token with secret:read (or admin:*) permission',
    });
  }

  // credential.health.summary
  if (!tokenViable) {
    addCheck({
      id: 'credential.health.summary',
      code: 'AURA_DOCTOR_CREDENTIAL_HEALTH_TOKEN_UNAVAILABLE',
      severity: 'low',
      status: 'warn',
      finding: 'Credential health summary requires explicit token mode.',
      evidence: 'socket-mode-no-explicit-token',
      remediation: 'Export AURA_TOKEN for credential health summary check',
    });
  } else {
    try {
      const response = await fetchWithStatus(`${serverUrl()}/credentials/health/summary`, {
        headers: { Authorization: `Bearer ${envToken}` },
      });

      if (!response.ok) {
        addCheck({
          id: 'credential.health.summary',
          code: response.status === 401 || response.status === 403
            ? 'AURA_DOCTOR_CREDENTIAL_HEALTH_UNAUTHORIZED'
            : 'AURA_DOCTOR_CREDENTIAL_HEALTH_ERROR',
          severity: response.status === 401 || response.status === 403 ? 'medium' : 'high',
          status: normalizeStatus(response.status),
          finding: 'Credential health summary endpoint is not readable.',
          evidence: `credential-health-summary-http-${response.status}`,
          remediation: 'Grant secret:read scope or refresh token',
        });
      } else {
        const data = JSON.parse(response.text) as { summary?: CredentialHealthSummary };
        if (!data.summary) {
          addCheck({
            id: 'credential.health.summary',
            code: 'AURA_DOCTOR_CREDENTIAL_HEALTH_MALFORMED',
            severity: 'high',
            status: 'fail',
            finding: 'Credential health summary payload is malformed.',
            evidence: 'summary-missing',
            remediation: 'Upgrade Aura server and rerun doctor',
          });
        } else {
          const evaluated = evaluateCredentialHealthSeverity(data.summary);
          addCheck({
            id: 'credential.health.summary',
            code: evaluated.code,
            severity: evaluated.severity,
            status: evaluated.status,
            finding: evaluated.finding,
            evidence: evaluated.evidence,
            remediation: evaluated.remediation,
          });
        }
      }
    } catch (err) {
      addCheck({
        id: 'credential.health.summary',
        code: 'AURA_DOCTOR_CREDENTIAL_HEALTH_ERROR',
        severity: 'high',
        status: 'fail',
        finding: 'Credential health summary check failed.',
        evidence: `credential-health-summary-error-${getErrorMessage(err)}`,
        remediation: 'Verify Aura API health and token scope',
      });
    }
  }

  // .aura checks
  const auraFile = findAuraFile();
  if (!auraFile) {
    addCheck({
      id: 'aura_file.discovery',
      code: 'AURA_DOCTOR_AURA_FILE_MISSING',
      severity: 'low',
      status: 'warn',
      finding: 'No .aura file found in current/parent directories.',
      evidence: 'aura-file-not-found',
      remediation: 'Run: npx auramaxx env init',
    });

    addCheck({
      id: 'aura_file.parse',
      code: 'AURA_DOCTOR_AURA_FILE_PARSE_SKIPPED',
      severity: 'info',
      status: 'pass',
      finding: '.aura parse check skipped.',
      evidence: 'no-aura-file',
      remediation: 'none',
    });

    addCheck({
      id: 'aura_file.mapping_resolution',
      code: 'AURA_DOCTOR_AURA_MAPPING_SKIPPED',
      severity: 'info',
      status: 'pass',
      finding: '.aura mapping resolution skipped.',
      evidence: 'no-aura-file',
      remediation: 'none',
    });
  } else {
    addCheck({
      id: 'aura_file.discovery',
      code: 'AURA_DOCTOR_AURA_FILE_FOUND',
      severity: 'info',
      status: 'pass',
      finding: '.aura file discovered.',
      evidence: path.relative(process.cwd(), auraFile) || '.aura',
      remediation: 'none',
    });

    let mappings: AuraMapping[] = [];
    let parseOk = false;
    try {
      mappings = parseAuraFile(auraFile);
      parseOk = true;
      addCheck({
        id: 'aura_file.parse',
        code: 'AURA_DOCTOR_AURA_FILE_PARSE_OK',
        severity: 'info',
        status: 'pass',
        finding: '.aura file parsed successfully.',
        evidence: `mappings=${mappings.length}`,
        remediation: 'none',
      });
    } catch (err) {
      addCheck({
        id: 'aura_file.parse',
        code: 'AURA_DOCTOR_AURA_FILE_PARSE_FAILED',
        severity: 'high',
        status: 'fail',
        finding: '.aura file parse failed.',
        evidence: getErrorMessage(err),
        remediation: 'Fix .aura syntax and rerun npx auramaxx doctor',
      });
    }

    if (!parseOk) {
      addCheck({
        id: 'aura_file.mapping_resolution',
        code: 'AURA_DOCTOR_AURA_MAPPING_SKIPPED_PARSE_FAIL',
        severity: 'info',
        status: 'pass',
        finding: '.aura mapping resolution skipped due to parse failure.',
        evidence: 'parse-failed',
        remediation: 'none',
      });
    } else if (!tokenViable) {
      addCheck({
        id: 'aura_file.mapping_resolution',
        code: 'AURA_DOCTOR_AURA_MAPPING_TOKEN_UNAVAILABLE',
        severity: 'medium',
        status: 'warn',
        finding: '.aura mapping resolution requires explicit token mode.',
        evidence: 'socket-mode-no-explicit-token',
        remediation: 'Export AURA_TOKEN for mapping resolution audit',
      });
    } else {
      const cappedMappings = mappings.slice(0, MAX_AURA_MAPPINGS);
      const uniqueCredentialNames = [...new Set(cappedMappings.map((m) => m.credentialName))].slice(0, MAX_UNIQUE_CREDENTIAL_PROBES);
      const credIdByName = new Map<string, string>();
      const failures = new Set<string>();

      for (const credName of uniqueCredentialNames) {
        try {
          const resp = await fetchWithStatus(`${serverUrl()}/credentials?q=${encodeURIComponent(credName)}`, {
            headers: { Authorization: `Bearer ${envToken}` },
          });

          if (!resp.ok) {
            failures.add(`lookup:${credName}`);
            continue;
          }

          const data = JSON.parse(resp.text) as { credentials?: Array<{ id: string; name: string }> };
          const list = data.credentials || [];
          const exact = list.find((c) => c.name.toLowerCase() === credName.toLowerCase()) || list[0];
          if (!exact) failures.add(`missing-credential:${credName}`);
          else credIdByName.set(credName, exact.id);
        } catch {
          failures.add(`lookup:${credName}`);
        }
      }

      for (const mapping of cappedMappings) {
        const id = credIdByName.get(mapping.credentialName);
        if (!id) {
          failures.add(`${mapping.envVar}->${mapping.credentialName}.${mapping.field}`);
          continue;
        }

        try {
          const resp = await fetchWithStatus(`${serverUrl()}/credentials/${id}/read`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${envToken}` },
          });

          if (!resp.ok) {
            failures.add(`${mapping.envVar}->${mapping.credentialName}.${mapping.field}`);
          }
        } catch {
          failures.add(`${mapping.envVar}->${mapping.credentialName}.${mapping.field}`);
        }
      }

      const failureList = [...failures];
      const limitedEvidence = failureList.slice(0, 10);
      const more = failureList.length > 10 ? ` (+${failureList.length - 10} more)` : '';

      addCheck({
        id: 'aura_file.mapping_resolution',
        code: failureList.length === 0 ? 'AURA_DOCTOR_AURA_MAPPING_OK' : 'AURA_DOCTOR_AURA_MAPPING_FAILED',
        severity: failureList.length === 0 ? 'info' : 'high',
        status: failureList.length === 0 ? 'pass' : 'fail',
        finding: failureList.length === 0 ? '.aura mappings are resolvable.' : 'One or more .aura mappings are not resolvable.',
        evidence: failureList.length === 0 ? `checked=${cappedMappings.length}` : `${limitedEvidence.join(', ')}${more}`,
        remediation: failureList.length === 0 ? 'none' : 'Fix missing credentials/fields or token scope',
      });
    }
  }

  // MCP checks (read-only)
  const mcpHelp = spawnSync('npx', ['auramaxx', 'mcp', '--help'], {
    encoding: 'utf8',
    timeout: 1500,
  });
  const mcpAvailable = !mcpHelp.error && mcpHelp.status === 0;
  addCheck({
    id: 'mcp.command.available',
    code: mcpAvailable ? 'AURA_DOCTOR_MCP_COMMAND_AVAILABLE' : 'AURA_DOCTOR_MCP_COMMAND_UNAVAILABLE',
    severity: mcpAvailable ? 'info' : 'medium',
    status: mcpAvailable ? 'pass' : 'warn',
    finding: mcpAvailable ? 'MCP command is invokable.' : 'MCP command is not invokable.',
    evidence: mcpAvailable ? 'mcp-help-ok:auramaxx' : `mcp-help-failed-${mcpHelp.status ?? 'error'}`,
    remediation: mcpAvailable ? 'none' : 'Install dependencies and ensure npx auramaxx mcp is available',
  });

  const mcpConfigs = [
    path.join(process.cwd(), '.mcp.json'),
    path.join(process.cwd(), '.vscode', 'mcp.json'),
    path.join(os.homedir(), '.cursor', 'mcp.json'),
    path.join(os.homedir(), '.windsurf', 'mcp.json'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  ];

  const existingConfigs = mcpConfigs.filter((p) => fs.existsSync(p));
  let parseFailures = 0;
  for (const file of existingConfigs) {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      parseFailures += 1;
    }
  }

  addCheck({
    id: 'mcp.config.footprint',
    code: parseFailures > 0 ? 'AURA_DOCTOR_MCP_CONFIG_INVALID' : existingConfigs.length > 0 ? 'AURA_DOCTOR_MCP_CONFIG_PRESENT' : 'AURA_DOCTOR_MCP_CONFIG_ABSENT',
    severity: parseFailures > 0 ? 'medium' : existingConfigs.length > 0 ? 'info' : 'low',
    status: parseFailures > 0 ? 'warn' : existingConfigs.length > 0 ? 'pass' : 'warn',
    finding: parseFailures > 0
      ? 'One or more MCP config files are invalid JSON.'
      : existingConfigs.length > 0
        ? 'MCP config footprint detected.'
        : 'No MCP config footprint detected.',
    evidence: parseFailures > 0
      ? `invalid-json-count=${parseFailures}`
      : existingConfigs.length > 0
        ? `configs=${existingConfigs.length}`
        : 'no-known-mcp-config-files',
    remediation: parseFailures > 0
      ? 'Fix malformed MCP config JSON files'
      : existingConfigs.length > 0
        ? 'none'
        : 'Run: npx auramaxx mcp --install',
  });

  addCheck({
    id: 'mcp.auth.forecast',
    code: authViable ? 'AURA_DOCTOR_MCP_AUTH_FORECAST_READY' : 'AURA_DOCTOR_MCP_AUTH_FORECAST_BLOCKED',
    severity: authViable ? 'info' : 'high',
    status: authViable ? 'pass' : 'fail',
    finding: authViable ? 'MCP auth bootstrap appears ready.' : 'MCP auth bootstrap is blocked.',
    evidence: authViable ? 'auth-bootstrap-viable' : 'no-viable-auth-bootstrap',
    remediation: authViable ? 'none' : 'Start daemon socket or export AURA_TOKEN before MCP use',
  });

  // Extension check
  addCheck({
    id: 'extension.detectability.cli_mode',
    code: 'AURA_DOCTOR_EXTENSION_NOT_DETECTABLE_CLI_MODE',
    severity: 'low',
    status: 'warn',
    finding: 'Extension session state is not detectable in CLI mode.',
    evidence: 'not-detectable-in-this-mode',
    remediation: 'Use extension UI diagnostics for handshake details',
  });

  // Security checks
  if (!tokenViable) {
    addCheck({
      id: 'security.token_scope.breadth',
      code: 'AURA_DOCTOR_SECURITY_TOKEN_INTROSPECTION_UNAVAILABLE',
      severity: 'low',
      status: 'warn',
      finding: 'Cannot evaluate token scope breadth without explicit token.',
      evidence: 'socket-mode-no-explicit-token',
      remediation: 'Export AURA_TOKEN for explicit scope audit',
    });
  } else {
    const permissions = authProbeState.tokenValidate?.payload?.permissions || [];
    const broad = permissions.some((p) => p === 'admin:*' || p === '*' || p.endsWith(':*'));
    addCheck({
      id: 'security.token_scope.breadth',
      code: broad ? 'AURA_DOCTOR_SECURITY_SCOPE_BROAD' : 'AURA_DOCTOR_SECURITY_SCOPE_LEAST_PRIVILEGE',
      severity: broad ? 'medium' : 'info',
      status: broad ? 'warn' : 'pass',
      finding: broad ? 'Token includes broad wildcard/admin scope.' : 'Token scope appears least-privilege oriented.',
      evidence: broad ? 'broad-scope-detected' : 'no-broad-scope-detected',
      remediation: broad ? 'Issue a narrower token for routine automation' : 'none',
    });
  }

  const scan = listLikelySecretFiles(process.cwd());
  addCheck({
    id: 'security.plaintext_token.artifacts',
    code: scan.timedOut
      ? 'AURA_DOCTOR_SECURITY_SCAN_TIME_BUDGET_EXCEEDED'
      : scan.matches.length > 0
        ? 'AURA_DOCTOR_SECURITY_ARTIFACT_HINTS_FOUND'
        : 'AURA_DOCTOR_SECURITY_ARTIFACT_HINTS_NONE',
    severity: scan.timedOut ? 'low' : scan.matches.length > 0 ? 'medium' : 'info',
    status: scan.timedOut ? 'warn' : scan.matches.length > 0 ? 'warn' : 'pass',
    finding: scan.timedOut
      ? 'Security artifact scan hit time budget.'
      : scan.matches.length > 0
        ? 'Potential plaintext secret artifacts detected.'
        : 'No obvious plaintext secret artifacts detected.',
    evidence: scan.timedOut
      ? `scan-time-budget-exceeded checked=${scan.checked}`
      : scan.matches.length > 0
        ? `matches=${scan.matches.slice(0, 10).join(',')}${scan.matches.length > 10 ? ' (+more)' : ''}`
        : `checked=${scan.checked}`,
    remediation: scan.matches.length > 0
      ? 'Move secrets to Aura agent and remove plaintext files'
      : scan.timedOut
        ? 'Rerun in a smaller working directory for complete scan'
        : 'none',
  });

  const stalenessHours = process.env.AURA_TOKEN_ISSUED_AT
    ? Math.floor((Date.now() - new Date(process.env.AURA_TOKEN_ISSUED_AT).getTime()) / (1000 * 60 * 60))
    : null;
  const stale = stalenessHours !== null && Number.isFinite(stalenessHours) && stalenessHours > 24;
  addCheck({
    id: 'security.auth_artifact.staleness',
    code: stale ? 'AURA_DOCTOR_SECURITY_AUTH_ARTIFACT_STALE' : 'AURA_DOCTOR_SECURITY_AUTH_ARTIFACT_FRESH_OR_UNKNOWN',
    severity: stale ? 'low' : 'info',
    status: stale ? 'warn' : 'pass',
    finding: stale ? 'Auth artifact appears stale.' : 'Auth artifact freshness is acceptable or unavailable.',
    evidence: stale ? `token-age-hours=${stalenessHours}` : 'no-staleness-metadata',
    remediation: stale ? 'Rotate token to reduce exposure window' : 'none',
  });

  const summary = checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 }
  );

  const hasBlocking = summary.fail > 0 || (options.strict && summary.warn > 0);

  return {
    ok: !hasBlocking,
    mode: options.strict ? 'strict' : 'default',
    summary,
    checks,
    fixes,
  };
}

function formatHuman(checks: DoctorCheck[]): string {
  return checks
    .map((c) => `${checkBadge(c.status)} ${c.id}\n   ${c.finding}\n   evidence: ${c.evidence}\n   remediation: ${c.remediation}`)
    .join('\n');
}

export function mapExitCode(result: DoctorResult): number {
  return result.ok ? EXIT.OK : EXIT.FAIL;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runDoctor(options);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printBanner('DOCTOR');
      console.log(formatHuman(result.checks));
      if (result.fixes.length > 0) {
        printSection('Fixes Applied');
        for (const fix of result.fixes) {
          console.log(`    - ${fix}`);
        }
      }
      printSection('Summary');
      console.log(`    pass=${result.summary.pass}  warn=${result.summary.warn}  fail=${result.summary.fail}`);
      if (options.strict) console.log('Mode: strict');
    }

    process.exit(mapExitCode(result));
  } catch (err) {
    const message = getErrorMessage(err);
    if (message.toLowerCase().startsWith('unknown flag:')) {
      console.error(message);
      process.exit(EXIT.ARGS);
    }

    console.error(`Doctor internal error: ${message}`);
    process.exit(EXIT.INTERNAL);
  }
}

if (require.main === module) {
  main();
}

export { runDoctor, parseArgs };
