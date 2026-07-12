/**
 * auramaxx mcp — Start the MCP server (stdio transport)
 *
 * Spawned by MCP clients (Codex CLI, Claude Code/Desktop, Cursor, VS Code, Windsurf, etc.) via config:
 *   { "command": "npx", "args": ["aurawallet", "mcp"], "env": { "AURA_TOKEN": "<token>" } }
 *
 * Flags:
 *   --install  Auto-detect local client MCP config entries (does not start server)
 *   --run      Start MCP server after processing install/setup flags
 *   --setup    Install MCP config entries, then start MCP server
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { getErrorMessage } from '../../lib/error';

const args = process.argv.slice(2);
const RELEASE_MCP_NAME = 'aurawallet';
const DEV_MCP_NAME = 'aurawalletdev';
const LEGACY_MCP_NAMES = ['auramaxx', 'auramaxxdev'];

const shouldInstall = args.includes('--install') || args.includes('--setup');
const shouldRun = args.includes('--run') || args.includes('--setup') || !shouldInstall;

if (shouldInstall) {
  installMcpConfigs();
}
if (shouldRun) {
  // The MCP server runs on import — connects stdio transport and registers tools
  import('../../mcp/server.js');
}

interface IdeTarget {
  name: string;
  configPath: string;
  global: boolean;
}

type InstallStatus = 'configured' | 'already-configured' | 'not-found' | 'error';

interface InstallResult {
  status: InstallStatus;
  detail?: string;
}

function resolveLocalCliBinPath(): string {
  return path.resolve(__dirname, '../../../../bin/aurawallet.js');
}

function installMcpConfigs(): void {
  const home = os.homedir();
  const walletBase = process.env.WALLET_SERVER_URL?.trim() || undefined;
  const localCliBinPath = resolveLocalCliBinPath();

  const targets: IdeTarget[] = [
    {
      name: 'Claude Code',
      configPath: path.join(process.cwd(), '.mcp.json'),
      global: false,
    },
    {
      name: 'Claude Desktop',
      configPath: path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      global: true,
    },
    {
      name: 'Cursor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      global: true,
    },
    {
      name: 'VS Code',
      configPath: path.join(process.cwd(), '.vscode', 'mcp.json'),
      global: false,
    },
    {
      name: 'Windsurf',
      configPath: path.join(home, '.windsurf', 'mcp.json'),
      global: true,
    },
  ];

  console.log('\n  AuraMaxx MCP Installer');
  console.log('  ───────────────────────\n');

  let updated = 0;
  let skipped = 0;
  let notFound = 0;
  let errors = 0;

  for (const target of targets) {
    const configDir = path.dirname(target.configPath);

    // Only touch configs for IDEs that are actually present.
    // Do not create new IDE directories implicitly.
    if (!fs.existsSync(configDir)) {
      console.log(`  ${target.name}: not found (${configDir} not found)`);
      notFound++;
      continue;
    }

    // Read existing config or start fresh. If the file is malformed, skip it
    // instead of overwriting user data with {}.
    let config: Record<string, unknown> = {};
    if (fs.existsSync(target.configPath)) {
      try {
        const raw = fs.readFileSync(target.configPath, 'utf-8');
        config = JSON.parse(raw);
      } catch (error) {
        const message = getErrorMessage(error);
        console.log(`  ${target.name}: skipped (invalid JSON in ${target.configPath}: ${message})`);
        errors++;
        continue;
      }
    }

    // Check if canonical entry already exists
    if (
      config.mcpServers !== undefined &&
      (typeof config.mcpServers !== 'object' || config.mcpServers === null || Array.isArray(config.mcpServers))
    ) {
      console.log(`  ${target.name}: skipped (mcpServers must be an object in ${target.configPath})`);
      errors++;
      continue;
    }

    const mcpServers = (config.mcpServers || {}) as Record<string, unknown>;
    const existingReleaseEntry = isPlainObject(mcpServers[RELEASE_MCP_NAME])
      ? mcpServers[RELEASE_MCP_NAME] as Record<string, unknown>
      : undefined;
    const existingDevEntry = isPlainObject(mcpServers[DEV_MCP_NAME])
      ? mcpServers[DEV_MCP_NAME] as Record<string, unknown>
      : undefined;
    const nextReleaseEntry = buildJsonMcpEntry(existingReleaseEntry, walletBase);
    const nextDevEntry = buildJsonDevMcpEntry(existingDevEntry, walletBase, localCliBinPath);
    const hasLegacyEntries = LEGACY_MCP_NAMES.some((name) => name in mcpServers);

    if (
      existingReleaseEntry
      && existingDevEntry
      && sameJson(existingReleaseEntry, nextReleaseEntry)
      && sameJson(existingDevEntry, nextDevEntry)
      && !hasLegacyEntries
    ) {
      console.log(`  ${target.name}: already configured`);
      skipped++;
      continue;
    }

    // Merge canonical entry.
    mcpServers[RELEASE_MCP_NAME] = nextReleaseEntry;
    mcpServers[DEV_MCP_NAME] = nextDevEntry;
    for (const legacyName of LEGACY_MCP_NAMES) {
      delete mcpServers[legacyName];
    }
    config.mcpServers = mcpServers;

    fs.writeFileSync(target.configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`  ${target.name}: configured (${target.configPath})`);
    updated++;
  }

  const codexResult = installCodexMcp(home, walletBase);
  if (codexResult.status === 'configured') {
    const detail = codexResult.detail ? ` (${codexResult.detail})` : '';
    console.log(`  Codex CLI: configured (${path.join(home, '.codex', 'config.toml')})${detail}`);
    updated++;
  } else if (codexResult.status === 'already-configured') {
    console.log('  Codex CLI: already configured');
    skipped++;
  } else if (codexResult.status === 'not-found') {
    const detail = codexResult.detail ? ` (${codexResult.detail})` : '';
    console.log(`  Codex CLI: not found${detail}`);
    notFound++;
  } else {
    const detail = codexResult.detail ? ` (${codexResult.detail})` : '';
    console.log(`  Codex CLI: skipped due to error${detail}`);
    errors++;
  }

  console.log('');
  console.log(`  Done: ${updated} updated, ${skipped} already configured, ${notFound} not found, ${errors} skipped due to errors`);
  console.log('');
}

function buildJsonMcpEntry(existing: Record<string, unknown> | undefined, walletBase: string | undefined): Record<string, unknown> {
  const next: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
  next.command = 'npx';
  next.args = ['aurawallet', 'mcp'];

  const env = isPlainObject(existing?.env) ? { ...(existing?.env as Record<string, unknown>) } : {};
  if (walletBase) {
    env.WALLET_SERVER_URL = walletBase;
  } else {
    delete env.WALLET_SERVER_URL;
  }
  if (Object.keys(env).length > 0) {
    next.env = env;
  } else {
    delete next.env;
  }

  return next;
}

function buildJsonDevMcpEntry(
  existing: Record<string, unknown> | undefined,
  walletBase: string | undefined,
  cliBinPath: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
  next.command = 'node';
  next.args = [cliBinPath, 'mcp'];

  const env = isPlainObject(existing?.env) ? { ...(existing?.env as Record<string, unknown>) } : {};
  if (walletBase) {
    env.WALLET_SERVER_URL = walletBase;
  } else {
    delete env.WALLET_SERVER_URL;
  }
  if (Object.keys(env).length > 0) {
    next.env = env;
  } else {
    delete next.env;
  }

  return next;
}

function installCodexMcp(home: string, walletBase: string | undefined): InstallResult {
  const localCliBinPath = resolveLocalCliBinPath();
  const probe = spawnSync('codex', ['mcp', 'list'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (probe.error) {
    const code = (probe.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { status: 'not-found', detail: 'codex not in PATH' };
    }
    return { status: 'error', detail: getErrorMessage(probe.error) };
  }
  if ((probe.status ?? 1) !== 0) {
    return { status: 'error', detail: sanitizeCommandOutput(probe.stderr || probe.stdout) };
  }

  const desiredEntries = [
    { name: RELEASE_MCP_NAME, command: 'npx', args: ['aurawallet', 'mcp'] },
    { name: DEV_MCP_NAME, command: 'node', args: [localCliBinPath, 'mcp'] },
  ] as const;

  let needsUpdate = false;
  for (const desired of desiredEntries) {
    const existing = spawnSync('codex', ['mcp', 'get', desired.name, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (existing.error) {
      return { status: 'error', detail: getErrorMessage(existing.error) };
    }
    if ((existing.status ?? 1) !== 0) {
      needsUpdate = true;
      continue;
    }

    try {
      const parsed = JSON.parse(existing.stdout) as {
        transport?: {
          type?: string;
          command?: string;
          args?: unknown;
          env?: Record<string, unknown> | null;
        };
      };
      const transportArgs = parsed.transport?.args;
      const args = Array.isArray(transportArgs) ? transportArgs : [];
      const env = parsed.transport?.env || {};
      const currentWalletBase = typeof env.WALLET_SERVER_URL === 'string' ? env.WALLET_SERVER_URL : undefined;
      const argsMatch = args.length === desired.args.length && args.every((value, index) => value === desired.args[index]);
      if (parsed.transport?.type !== 'stdio' || parsed.transport?.command !== desired.command || !argsMatch || currentWalletBase !== walletBase) {
        needsUpdate = true;
      }
    } catch {
      needsUpdate = true;
    }
  }

  for (const legacyName of LEGACY_MCP_NAMES) {
    const existingLegacy = spawnSync('codex', ['mcp', 'get', legacyName, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!existingLegacy.error && (existingLegacy.status ?? 1) === 0) {
      needsUpdate = true;
      break;
    }
  }

  if (!needsUpdate) {
    return { status: 'already-configured' };
  }

  for (const name of [...desiredEntries.map((entry) => entry.name), ...LEGACY_MCP_NAMES]) {
    const remove = spawnSync('codex', ['mcp', 'remove', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (remove.error) {
      return { status: 'error', detail: getErrorMessage(remove.error) };
    }
    if ((remove.status ?? 0) !== 0) {
      const stderr = remove.stderr || '';
      const notFound = stderr.includes(`No MCP server named '${name}' found`);
      if (!notFound) {
        return { status: 'error', detail: sanitizeCommandOutput(remove.stderr || remove.stdout) };
      }
    }
  }

  for (const desired of desiredEntries) {
    const addArgs = ['mcp', 'add', desired.name];
    if (walletBase) {
      addArgs.push('--env', `WALLET_SERVER_URL=${walletBase}`);
    }
    addArgs.push('--', desired.command, ...desired.args);

    const add = spawnSync('codex', addArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (add.error) {
      return { status: 'error', detail: getErrorMessage(add.error) };
    }
    if ((add.status ?? 1) !== 0) {
      return { status: 'error', detail: sanitizeCommandOutput(add.stderr || add.stdout) };
    }
  }

  const detail = walletBase ? `WALLET_SERVER_URL=${walletBase}` : undefined;
  return { status: 'configured', detail };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameJson(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sanitizeCommandOutput(text?: string): string | undefined {
  if (!text) return undefined;
  const cleaned = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('WARNING: proceeding, even though we could not update PATH'))
    .join(' | ');
  return cleaned || undefined;
}
