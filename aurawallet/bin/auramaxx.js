#!/usr/bin/env node
/**
 * AuraMaxx CLI entry point
 *
 * Routes subcommands to server/cli/commands/<cmd>.ts via tsx.
 * Works with: npx auramaxx <command> [args]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const readline = require('readline');

const root = path.join(__dirname, '..');
let cmd = process.argv[2];
const invokedCommand = process.argv[2];
const args = process.argv.slice(3);
let inferredCommand = false;
const cliFlavor = String(process.env.AURA_CLI_FLAVOR || '').trim().toLowerCase();
const invokedBinaryName = path.basename(process.argv[1] || '').replace(/\.(cmd|exe|js)$/i, '').toLowerCase();
const FULL_CLI_MODE = cliFlavor === 'aurawallet' || cliFlavor === 'wallet' || invokedBinaryName === 'aurawallet';
const PRIMARY_CLI_NAME = FULL_CLI_MODE ? 'aurawallet' : 'auramaxx';
const PRIMARY_CLI_INVOKE = FULL_CLI_MODE ? 'aurawallet' : 'aura';
const INSTALL_CLI_INVOKE = FULL_CLI_MODE ? 'aurawallet' : 'auramaxx';
const CLI_BRAND_LINE = FULL_CLI_MODE ? 'A U R A W A L L E T' : 'M A X X . S H';
const CLI_HELP_HINT = FULL_CLI_MODE
  ? `Run '${PRIMARY_CLI_NAME} --help' to see available commands.`
  : `Run 'aura --help' or 'npx auramaxx --help' to see available commands.`;

const BASE_COMMANDS = {
  init: 'Advanced/compat setup flow (most users should run start)',
  start: 'Canonical startup: includes bootstrap/setup checks + runtime start',
  restart: 'Restart running servers (stop + start)',
  stop: 'Stop running servers',
  nuke: 'Destructive local reset (wipe agents + database + local state)',
  status: 'Show server and wallet status',
  doctor: 'Run deterministic onboarding/runtime diagnostics',
  'release-check': 'Run release diff/sanity/privacy/security checklist guardrail',
  unlock: 'Unlock the agent interactively',
  lock: 'Lock all agents or a specific agent',
  restore: 'Restore from a backup (--list, --latest, --dry-run)',
  api: 'Call any wallet API endpoint from CLI (auth + JSON wrapper)',
  auth: 'Request/poll agent auth approvals from CLI',
  'register-agent': 'Create/register a subsequent local agent (non-primary)',
  actions: 'Create/list/resolve human actions and manage action tokens',
  approve: 'Approve a pending human action by ID (admin only)',
  app: 'Manage installed apps (install, remove, list, update)',
  mcp: 'Start MCP server (stdio) for Claude Code, Cursor, etc.',
  cron: 'Run the cron server standalone (balance sync, price sync)',
  experimental: 'Toggle dev feature flags (list, enable, disable)',
  skill: 'Install AuraMaxx skills for Claude/Codex/OpenClaw and run install doctor',
  wallet: 'Wallet API wrappers (status, assets, transactions, swap, send, fund, launch)',
  // social: 'Social API wrappers (register, unregister, post, feed, follow, notifications, status)', // Temporarily disabled at root CLI.
  service: 'Manage background service (install, uninstall, status)',
  token: 'Preview profile-based token policy before issuance',
  'shell-hook': 'Auto-load .aura env vars on cd (like direnv)',
  play: 'Play an AuraJS game from npm (auramaxx play <game>)',
  fork: 'Fork a published AuraJS game into a local editable project (auramaxx fork <game>)',
  create: 'Scaffold a new AuraJS game (2d/3d/multiplayer) via AuraJS CLI',
  dev: 'Run the AuraJS local dev loop in the current project',
  build: 'Build the current AuraJS project',
  make: 'Generate authored AuraJS project files via AuraJS CLI',
  explain: 'Explain the current AuraJS project surface',
  check: 'Validate the current AuraJS project surface',
  publish: 'Publish current AuraJS game package to npm with guided prompts',
  'external-assets': 'Stage self-hosted external asset manifests for the current AuraJS project',
  run: 'Run the current AuraJS project with lower-level launch/session control',
  clean: 'Clean generated AuraJS project output',
  test: 'Run AuraJS project tests',
  conformance: 'Run AuraJS project conformance checks',
  state: 'Run AuraJS project state tools',
  inspect: 'Run AuraJS project inspect tools',
  action: 'Run AuraJS project action tools',
  session: 'Run AuraJS project session tools',
};

const FULL_CLI_ONLY_COMMANDS = {
  // social: 'Social API wrappers (register, unregister, post, feed, follow, notifications, status)',
  diary: 'Append daily diary entries via authenticated CLI path',
  apikey: 'List/validate/set/delete API keys',
  quickhack: 'Generate random tutorial secret, run set+inject, and print copyable commands',
  agent: 'Retrieve/manage credentials (get, set, share via secret gist, delete, list)',
  env: 'Load env vars from agent via .aura file (run, inject, check, list, init)',
};

const COMMANDS = FULL_CLI_MODE
  ? { ...BASE_COMMANDS, ...FULL_CLI_ONLY_COMMANDS }
  : BASE_COMMANDS;

const AGENT_ALIASES = FULL_CLI_MODE
  ? {
    get: 'get',
    set: 'set',
    share: 'share',
    del: 'delete',
    delete: 'delete',
    list: 'list',
    health: 'health',
    getsecret: 'get',
    'get-secret': 'get',
    readsecret: 'get',
    'read-secret': 'get',
    listsecrets: 'list',
    'list-secrets': 'list',
    secretlist: 'list',
    'secret-list': 'list',
    secrethealth: 'health',
    'secret-health': 'health',
    secret: 'secret',
    inject: 'inject',
    use: 'use',
  }
  : {};

const SOCIAL_ALIASES = FULL_CLI_MODE
  ? {
    // Social shortcuts are temporarily disabled for the wallet-facing CLI.
  }
  : {};

const COMMAND_ALIASES = {
  'create-agent': 'register-agent',
  'agent-register': 'register-agent',
};

const SHORTCUT_COMMANDS = FULL_CLI_MODE
  ? [
    { name: 'get <name>', desc: 'Read primary credential value (--json for full payload)' },
    { name: 'set <name> <value>', desc: 'Create or update a secret (default type: api key)' },
    { name: 'list', desc: 'List credential names' },
    { name: 'share <name>', desc: 'Create a GitHub secret gist share for a credential' },
    { name: 'inject <name> [-- <cmd>]', desc: 'Save primary secret to env var and optionally run command' },
    { name: 'del <name>', desc: 'Delete a credential' },
  ]
  : [];

const DEFAULT_ADMIN = FULL_CLI_MODE
  ? ['start', 'status', 'agent', 'env', 'mcp', 'skill', 'auth']
  : ['start', 'status', 'init', 'mcp', 'skill', 'auth'];
const AURAJS_COMMANDS = [
  'create',
  'dev',
  'build',
  'play',
  'make',
  'explain',
  'check',
  'publish',
  'external-assets',
  'run',
  'clean',
  'test',
  'conformance',
  'state',
  'inspect',
  'action',
  'session',
  'fork',
];
const HIDDEN_HELP_COMMANDS = FULL_CLI_MODE ? new Set() : new Set(['wallet']);

const COMMON_EXAMPLES = FULL_CLI_MODE
  ? [
    { cmd: 'aurawallet start', note: 'Run the full wallet/admin runtime' },
    { cmd: 'aurawallet status', note: 'Check if services are running' },
    { cmd: 'aurawallet agent list --name prod', note: 'List credentials by name filter' },
    { cmd: 'aurawallet get OURSECRET', note: 'Read a credential through the top-level shortcut' },
    { cmd: 'aurawallet env check', note: 'Validate .aura mappings in the current project' },
    { cmd: 'aurawallet make scene Scene1', note: 'Generate a scene in the current AuraJS project' },
  ]
  : [
    { cmd: 'aura status', note: 'Check if services are running' },
    { cmd: 'aura doctor', note: 'Run local diagnostics' },
    { cmd: 'aura skill --doctor', note: 'Check skill installation status' },
    { cmd: 'aura mcp --install', note: 'Install MCP config for supported clients' },
    { cmd: 'auramaxx make scene Scene1', note: 'Generate a scene in the current AuraJS project' },
    { cmd: 'auramaxx check', note: 'Validate the current AuraJS project from any project subdirectory' },
    { cmd: 'auramaxx external-assets generate --public-base-url https://cdn.example.com/my-game', note: 'Stage self-hosted asset manifests for the current AuraJS project' },
    { cmd: 'auramaxx fork aurasu ./aurasu-local', note: 'Fork a published AuraJS game into a local editable project' },
  ];

let localTsxCliPath;
let localTsxCliResolved = false;
const AURA_RC_BLOCK_START = '# >>> Aura CLI managed fallback >>>';
const AURA_RC_BLOCK_END = '# <<< Aura CLI managed fallback <<<';

function escapeForDoubleQuotedShell(value) {
  return value.replace(/(["\\$`])/g, '\\$1');
}

function resolveLocalCliEntrypoint() {
  const entrypoint = path.join(root, 'bin', 'auramaxx.js');
  if (!fs.existsSync(entrypoint)) return null;
  if (isTransientPathEntry(entrypoint)) return null;
  return entrypoint;
}

function resolvePreferredCliInvocation() {
  const localEntrypoint = resolveLocalCliEntrypoint();
  if (!localEntrypoint) {
    return {
      mode: 'npx',
      localEntrypoint: null,
      runCommand: 'npx auramaxx',
      aliasValue: 'npx auramaxx',
    };
  }

  const escapedEntrypoint = escapeForDoubleQuotedShell(localEntrypoint);
  return {
    mode: 'local',
    localEntrypoint,
    runCommand: `node "${escapedEntrypoint}"`,
    aliasValue: `node "${escapedEntrypoint}"`,
  };
}

function resolvePortableCliInvocation() {
  return {
    mode: 'npx',
    localEntrypoint: null,
    runCommand: 'npx auramaxx',
    aliasValue: 'npx auramaxx',
  };
}

function renderFunctionLine(aliasName, runCommand) {
  return `${aliasName}() { ${runCommand} "$@"; }`;
}

function renderManagedRcFallbackBlock() {
  const portable = resolvePortableCliInvocation();
  return [
    AURA_RC_BLOCK_START,
    '# Ensures aura/auramaxx work across restarts without global install.',
    renderFunctionLine('aura', portable.runCommand),
    renderFunctionLine('auramaxx', portable.runCommand),
    AURA_RC_BLOCK_END,
  ].join('\n');
}

function resolveLocalTsxCliPath() {
  if (localTsxCliResolved) return localTsxCliPath;
  localTsxCliResolved = true;
  try {
    localTsxCliPath = require.resolve('tsx/dist/cli.mjs', { paths: [root] });
  } catch {
    localTsxCliPath = null;
  }
  return localTsxCliPath;
}

function commandFilePath(commandName) {
  return path.join(root, 'src', 'server', 'cli', 'commands', `${commandName}.ts`);
}

function isCommandAvailable(commandName) {
  if (!COMMANDS[commandName]) return false;
  return fs.existsSync(commandFilePath(commandName));
}

function showHelp(showAll = false) {
  // Inline Tyvek theme (bin/ is plain CJS - cannot import TS theme module)
  const isTTY = process.stdout.isTTY && !process.env.NO_COLOR && process.env.CI !== 'true' && process.env.TERM !== 'dumb';
  const RST = isTTY ? '\x1b[0m' : '';
  const BOLD = isTTY ? '\x1b[1m' : '';
  const DIM = isTTY ? '\x1b[2m' : '';
  const CYAN = isTTY ? '\x1b[38;5;154m' : '';
  const GRAY = isTTY ? '\x1b[90m' : '';

  const W = 62;
  const TL = `${GRAY}.-${RST}`;
  const TR = `${GRAY}-.${RST}`;
  const BL = `${GRAY}'-${RST}`;
  const BR = `${GRAY}-'${RST}`;
  const PIPE = `${GRAY}|${RST}`;
  const SEP = '  ' + '- '.repeat(Math.floor(W / 2));

  // Banner - three diagonal stripes in a square (aura_logo.svg)
  const LP = `${GRAY}|${RST}`;
  const LT = `${GRAY}.${RST}${DIM}----------${RST}${GRAY}.${RST}`;
  const LB = `${GRAY}'${RST}${DIM}----------${RST}${GRAY}'${RST}`;

  console.log('');
  console.log(`  ${TL}${DIM}${' '.repeat(W - 4)}${RST}${TR}`);
  console.log(`  ${PIPE}   ${LT}${' '.repeat(W - 19)}${PIPE}`);
  console.log(`  ${PIPE}   ${LP}${BOLD}\\\\${RST}  ${BOLD}\\\\${RST}  ${BOLD}\\\\${RST}${LP}    ${BOLD}A U R A${RST}${' '.repeat(W - 30)}${PIPE}`);
  console.log(`  ${PIPE}   ${LP}${BOLD}\\\\${RST}  ${BOLD}\\\\${RST}  ${BOLD}\\\\${RST}${LP}    ${DIM}${CLI_BRAND_LINE}${RST}${' '.repeat(Math.max(0, W - 25 - CLI_BRAND_LINE.length))}${PIPE}`);
  console.log(`  ${PIPE}   ${LP}${BOLD}\\\\${RST}  ${BOLD}\\\\${RST}  ${BOLD}\\\\${RST}${LP}    ${CYAN}COMMAND REFERENCE${RST}${' '.repeat(W - 40)}${PIPE}`);
  console.log(`  ${PIPE}   ${LB}${' '.repeat(W - 19)}${PIPE}`);
  console.log(`  ${BL}${DIM}${' '.repeat(W - 4)}${RST}${BR}`);
  console.log('');

  console.log(`  ${BOLD}Usage:${RST} ${PRIMARY_CLI_NAME} [command] [options]`);
  if (!FULL_CLI_MODE) {
    console.log(`         ${DIM}aura [command] [options] (alias)${RST}`);
    console.log(`         ${DIM}npx auramaxx [command] [options]${RST}`);
  } else {
    console.log(`         ${DIM}node ./bin/aurawallet.js [command] [options]${RST}`);
  }
  console.log('');

  console.log(SEP);
  console.log(`  ${BOLD}[ AURAJS ]${RST}`);
  console.log('');
  for (const name of AURAJS_COMMANDS) {
    if (isCommandAvailable(name)) {
      console.log(`    ${CYAN}${name.padEnd(16)}${RST}${COMMANDS[name]}`);
    }
  }
  console.log('');

  console.log(SEP);
  console.log(`  ${BOLD}[ ADMIN ]${RST}`);
  console.log('');

  if (showAll || FULL_CLI_MODE) {
    for (const [name, desc] of Object.entries(COMMANDS)) {
      if (HIDDEN_HELP_COMMANDS.has(name) || !isCommandAvailable(name)) continue;
      console.log(`    ${CYAN}${name.padEnd(16)}${RST}${desc}`);
    }
  } else {
    for (const name of DEFAULT_ADMIN) {
      if (isCommandAvailable(name) && !HIDDEN_HELP_COMMANDS.has(name)) {
        console.log(`    ${CYAN}${name.padEnd(16)}${RST}${COMMANDS[name]}`);
      }
    }
    console.log('');
    console.log(`  ${DIM}Run auramaxx --help --all to see all commands${RST}`);
  }
  console.log('');
}

function getHelpMetadata() {
  return {
    cli: PRIMARY_CLI_NAME,
    usage: FULL_CLI_MODE
      ? [
        'aurawallet [command] [options]',
        'node ./bin/aurawallet.js [command] [options]',
      ]
      : [
        'auramaxx [command] [options]',
        'aura [command] [options] (alias)',
        'npx auramaxx [command] [options]',
      ],
    options: [
      { flag: '--help', aliases: ['-h'], description: 'Show this help message' },
      { flag: '--json', description: 'Output full command metadata as JSON' },
      ...(FULL_CLI_MODE
        ? [
          { flag: '--env', description: 'Save secret output into default env var when supported' },
          { flag: '--env <name>', description: 'Save secret output into a named env var when supported' },
        ]
        : []),
    ],
    commands: Object.entries(COMMANDS)
      .filter(([name]) => !HIDDEN_HELP_COMMANDS.has(name) && isCommandAvailable(name))
      .map(([name, description]) => ({
        name,
        description,
        entrypoint: `src/server/cli/commands/${name}.ts`,
      })),
    commandShortcuts: SHORTCUT_COMMANDS.map((entry) => ({ ...entry })),
    aurajsCommands: AURAJS_COMMANDS
      .filter((name) => isCommandAvailable(name))
      .map((name) => ({
        name,
        description: COMMANDS[name],
        entrypoint: `src/server/cli/commands/${name}.ts`,
      })),
    agentAliases: Object.entries(AGENT_ALIASES).map(([alias, subcommand]) => ({
      alias,
      command: 'agent',
      subcommand,
    })),
    examples: COMMON_EXAMPLES.map((entry) => ({ ...entry })),
  };
}

function showHelpJson() {
  console.log(JSON.stringify(getHelpMetadata(), null, 2));
}

function resolveDefaultCommand() {
  if (FULL_CLI_MODE && isCommandAvailable('start')) return 'start';
  if (isCommandAvailable('create')) return 'create';
  if (isCommandAvailable('start')) return 'start';
  return 'help';
}

function getDataDirState(dataDir) {
  try {
    if (!fs.existsSync(dataDir)) {
      return {
        dataDir,
        exists: false,
        files: [],
        hasDb: false,
        hasAgentFiles: false,
        hasNukeStateMarker: false,
        brokenState: false,
      };
    }

    const files = fs.readdirSync(dataDir);
    const hasDb = files.includes('auramaxx.db');
    const hasAgentFiles = files.some((file) =>
      file === 'agent-primary.json' || file === 'cold.json' || /^agent-.*\.json$/i.test(file)
    );
    const hasNukeStateMarker = files.includes('.nuke-state.json');

    return {
      dataDir,
      exists: true,
      files,
      hasDb,
      hasAgentFiles,
      hasNukeStateMarker,
      brokenState: hasDb && !hasAgentFiles && !hasNukeStateMarker,
    };
  } catch {
    return {
      dataDir,
      exists: false,
      files: [],
      hasDb: false,
      hasAgentFiles: false,
      hasNukeStateMarker: false,
      brokenState: false,
    };
  }
}

function wipeDataDirContents(dataDir) {
  if (!fs.existsSync(dataDir)) return;
  for (const entry of fs.readdirSync(dataDir)) {
    fs.rmSync(path.join(dataDir, entry), { recursive: true, force: true });
  }
}

function canPromptForInput() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.CI !== 'true');
}

const CLI_USE_COLOR = Boolean(
  process.stdout.isTTY
  && !process.env.NO_COLOR
  && process.env.CI !== 'true'
  && process.env.TERM !== 'dumb'
);

const CLI_ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  fgAccent: '\x1b[38;5;154m',
  fgGray: '\x1b[90m',
};

function cliPaint(text, ...codes) {
  if (!CLI_USE_COLOR) return text;
  return `${codes.join('')}${text}${CLI_ANSI.reset}`;
}

function printCliBanner(subtitle) {
  const W = 62;
  const safeSubtitle = String(subtitle || '').trim().toUpperCase();
  const cornerTl = cliPaint('.-', CLI_ANSI.fgGray);
  const cornerTr = cliPaint('-.', CLI_ANSI.fgGray);
  const cornerBl = cliPaint("'-", CLI_ANSI.fgGray);
  const cornerBr = cliPaint("-'", CLI_ANSI.fgGray);
  const pipe = cliPaint('|', CLI_ANSI.fgGray);
  const logoPipe = cliPaint('|', CLI_ANSI.fgGray);
  const stripe = (value) => cliPaint(value, CLI_ANSI.bold);
  const logoTop = cliPaint('.', CLI_ANSI.fgGray) + cliPaint('----------', CLI_ANSI.dim) + cliPaint('.', CLI_ANSI.fgGray);
  const logoBottom = cliPaint("'", CLI_ANSI.fgGray) + cliPaint('----------', CLI_ANSI.dim) + cliPaint("'", CLI_ANSI.fgGray);
  const stripeRow = `${logoPipe}${stripe('\\\\')}  ${stripe('\\\\')}  ${stripe('\\\\')}${logoPipe}`;

  console.log('');
  console.log(`  ${cornerTl}${cliPaint(' '.repeat(W - 4), CLI_ANSI.dim)}${cornerTr}`);
  console.log(`  ${pipe}   ${logoTop}${' '.repeat(W - 19)}${pipe}`);
  console.log(`  ${pipe}   ${stripeRow}    ${cliPaint('A U R A', CLI_ANSI.bold)}${' '.repeat(W - 30)}${pipe}`);
  console.log(`  ${pipe}   ${stripeRow}    ${cliPaint(CLI_BRAND_LINE, CLI_ANSI.dim)}${' '.repeat(Math.max(0, W - 25 - CLI_BRAND_LINE.length))}${pipe}`);
  console.log(`  ${pipe}   ${stripeRow}    ${safeSubtitle ? cliPaint(safeSubtitle, CLI_ANSI.fgAccent) : ''}${' '.repeat(Math.max(0, W - 23 - safeSubtitle.length))}${pipe}`);
  console.log(`  ${pipe}   ${logoBottom}${' '.repeat(W - 19)}${pipe}`);
  console.log(`  ${cornerBl}${cliPaint(' '.repeat(W - 4), CLI_ANSI.dim)}${cornerBr}`);
  console.log('');
}

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function resolveSelectedValue(answer, options, defaultValue) {
  const normalized = String(answer || '').trim().toLowerCase();
  if (!normalized && defaultValue) return defaultValue;

  for (const option of options) {
    const candidates = [option.value, option.label, ...(option.aliases || [])]
      .map((value) => String(value).toLowerCase());
    if (candidates.includes(normalized)) return option.value;
  }

  return defaultValue || options[0].value;
}

function renderSelectLines(message, options, selectedIndex, defaultValue) {
  const lines = [
    `  ${message}`,
    cliPaint('  Use up/down arrows and Enter to confirm.', CLI_ANSI.dim),
  ];

  for (let i = 0; i < options.length; i += 1) {
    const option = options[i];
    const isDefault = defaultValue && option.value === defaultValue;
    const suffix = isDefault ? ' [default]' : '';
    if (i === selectedIndex) {
      lines.push(`  ${cliPaint('//', CLI_ANSI.fgAccent, CLI_ANSI.bold)} ${cliPaint(option.label + suffix, CLI_ANSI.bold)}`);
    } else {
      lines.push(`     ${cliPaint(option.label + suffix, CLI_ANSI.dim)}`);
    }
  }

  return lines;
}

async function promptSelect(message, options, defaultValue) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('promptSelect requires at least one option');
  }

  const canUseRawPrompt = Boolean(
    process.stdin.isTTY
    && process.stdout.isTTY
    && typeof process.stdin.setRawMode === 'function'
  );

  if (canUseRawPrompt) {
    return new Promise((resolve, reject) => {
      const stdin = process.stdin;
      const stdout = process.stdout;
      const defaultIndex = Math.max(0, options.findIndex((option) => option.value === defaultValue));
      let selectedIndex = defaultIndex;
      let renderedLines = 0;
      let settled = false;
      const wasRaw = Boolean(stdin.isRaw);

      const cleanup = () => {
        if (settled) return;
        settled = true;
        stdin.removeListener('data', onData);
        stdin.removeListener('error', onError);
        if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
          stdin.setRawMode(wasRaw);
        }
        stdin.pause();
      };

      const render = () => {
        const lines = renderSelectLines(message, options, selectedIndex, defaultValue);
        if (renderedLines > 0) {
          stdout.write(`\u001b[${renderedLines}A`);
        }
        for (const line of lines) {
          stdout.write('\u001b[2K');
          stdout.write(`${line}\n`);
        }
        renderedLines = lines.length;
      };

      const moveSelection = (delta) => {
        if (delta === 0) return;
        selectedIndex = (selectedIndex + delta + options.length) % options.length;
        render();
      };

      const onError = (error) => {
        cleanup();
        reject(error);
      };

      const onData = (chunk) => {
        const input = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let delta = 0;

        for (let i = 0; i < input.length; i += 1) {
          const c = input[i];
          if (c === '\u0003') {
            cleanup();
            stdout.write('\n');
            process.exit(1);
          }
          if (c === '\r' || c === '\n') {
            cleanup();
            stdout.write('\n');
            resolve(options[selectedIndex].value);
            return;
          }
          if (input.startsWith('\u001b[A', i)) {
            delta -= 1;
            i += 2;
            continue;
          }
          if (input.startsWith('\u001b[B', i)) {
            delta += 1;
            i += 2;
            continue;
          }
        }

        if (delta !== 0) {
          moveSelection(delta);
        }
      };

      try {
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', onData);
        stdin.on('error', onError);
        render();
      } catch (error) {
        onError(error);
      }
    });
  }

  const optionLine = options
    .map((option) => (defaultValue && option.value === defaultValue ? `${option.label} [default]` : option.label))
    .join(' | ');

  const answer = await promptLine(`  ${message} (${optionLine}): `);
  return resolveSelectedValue(answer, options, defaultValue);
}

async function maybeHandleBrokenLocalState() {
  const dataDir = process.env.WALLET_DATA_DIR || path.join(os.homedir(), '.auramaxx');
  const state = getDataDirState(dataDir);
  if (!state.brokenState) return null;

  printCliBanner('Local State Recovery');
  console.log('  ⚠️  Detected partial local state: database exists but agent files are missing.');
  console.log(`     Data directory: ${state.dataDir}`);
  console.log('     This can happen after deleting agent files but keeping auramaxx.db.');
  console.log('     Setup cannot decrypt old encrypted records without the old agent.');
  console.log('');

  if (!canPromptForInput()) {
    console.log("  Non-interactive shell: keeping files and continuing with 'start'.");
    console.log('  WARNING: old encrypted data cannot be decrypted without the old agent files.');
    return 'start';
  }

  console.log('  DANGER: Wipe removes local Aura data in this directory (DB, credentials, logs, config).');
  const action = await promptSelect(
    'Choose recovery action:',
    [
      {
        value: 'keep',
        label: "Keep files and continue with 'start'",
        aliases: ['n', 'no', 'start'],
      },
      {
        value: 'wipe',
        label: "Wipe local Aura data and continue with 'init'",
        aliases: ['y', 'yes', 'wipe', 'init'],
      },
    ],
    'keep',
  );

  if (action === 'wipe') {
    wipeDataDirContents(state.dataDir);
    console.log('  Local Aura data wiped.');
    return 'init';
  }

  console.log("  Keeping existing files and continuing with 'start'.");
  console.log('  WARNING: old encrypted data cannot be decrypted without the old agent files.');
  return 'start';
}

function parseSemverParts(version) {
  const cleaned = String(version || '').trim().replace(/^v/i, '');
  const [core, pre = ''] = cleaned.split('-', 2);
  const coreParts = core.split('.').map((v) => parseInt(v, 10) || 0);
  const preParts = pre ? pre.split('.').map((v) => (/^\d+$/.test(v) ? Number(v) : v)) : [];
  return { coreParts, preParts };
}

function compareVersions(a, b) {
  const av = parseSemverParts(a);
  const bv = parseSemverParts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (av.coreParts[i] || 0) - (bv.coreParts[i] || 0);
    if (diff !== 0) return diff;
  }
  if (av.preParts.length === 0 && bv.preParts.length > 0) return 1;
  if (av.preParts.length > 0 && bv.preParts.length === 0) return -1;
  const len = Math.max(av.preParts.length, bv.preParts.length);
  for (let i = 0; i < len; i++) {
    const left = av.preParts[i];
    const right = bv.preParts[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
  }
  return 0;
}

function getUpdateCachePath() {
  const dataDir = process.env.WALLET_DATA_DIR || path.join(os.homedir(), '.auramaxx');
  const key = crypto.createHash('sha1').update(root).digest('hex').slice(0, 8);
  return path.join(dataDir, `update-check-${key}.json`);
}

function resolveNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function resolveAuramaxxCommand() {
  return process.platform === 'win32' ? 'auramaxx.cmd' : 'auramaxx';
}

function getGlobalInstalledAuramaxxVersion() {
  const timeoutMs = Number(process.env.AURA_UPDATE_CHECK_TIMEOUT_MS || '1200');
  try {
    const out = execFileSync(resolveNpmCommand(), ['list', '-g', 'auramaxx', '--json'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
    }).toString('utf8').trim();
    const parsed = JSON.parse(out || '{}');
    const version = parsed && parsed.dependencies && parsed.dependencies.auramaxx && parsed.dependencies.auramaxx.version;
    if (!version || !String(version).trim()) return 'unknown';
    return String(version).trim();
  } catch {
    return 'unknown';
  }
}

function normalizeVersionString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/^v/i, '');
}

function formatUpdateAvailableLine(current, latest) {
  const normalizedCurrent = normalizeVersionString(current) || 'unknown';
  const normalizedLatest = normalizeVersionString(latest);
  if (!normalizedLatest) return '';
  if (normalizedCurrent === 'unknown') {
    return `⚠️  Update available: aura${normalizedLatest}`;
  }
  return `⚠️  Update available: aura${normalizedCurrent} → aura${normalizedLatest}`;
}

function resolveUpdateNoticeState() {
  if (FULL_CLI_MODE) return null;
  if (process.env.AURA_NO_UPDATE_CHECK === '1' || process.env.CI === 'true') return;

  const now = Date.now();
  const throttleMs = Number(process.env.AURA_UPDATE_CHECK_CACHE_MINUTES || '360') * 60 * 1000;
  const cachePath = getUpdateCachePath();
  const installedCurrent = normalizeVersionString(
    process.env.AURA_UPDATE_CHECK_MOCK_CURRENT || getGlobalInstalledAuramaxxVersion()
  ) || 'unknown';

  let cache = null;
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {}

  if (!process.env.AURA_UPDATE_CHECK_FORCE && cache && typeof cache.checkedAt === 'number' && now - cache.checkedAt < throttleMs) {
    const cachedCurrent = normalizeVersionString(cache.current) || 'unknown';
    const cachedLatest = normalizeVersionString(cache.latest);
    const effectiveCurrent = installedCurrent !== 'unknown' ? installedCurrent : cachedCurrent;

    if (cachedLatest && effectiveCurrent !== cachedCurrent) {
      try {
        fs.writeFileSync(cachePath, JSON.stringify({
          checkedAt: cache.checkedAt,
          current: effectiveCurrent,
          latest: cachedLatest,
        }, null, 2));
      } catch {}
    }

    if (cachedLatest && compareVersions(cachedLatest, effectiveCurrent || '') > 0) {
      return { current: effectiveCurrent, latest: cachedLatest };
    }
    return null;
  }

  let latest = process.env.AURA_UPDATE_CHECK_MOCK_LATEST || null;
  const current = installedCurrent;

  if (!latest) {
    try {
      const out = execFileSync(resolveNpmCommand(), ['view', 'auramaxx', 'version', '--json'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: Number(process.env.AURA_UPDATE_CHECK_TIMEOUT_MS || '1200'),
      }).toString('utf8').trim();
      latest = JSON.parse(out);
    } catch {
      return null;
    }
  }
  latest = normalizeVersionString(latest);
  if (!latest) return null;

  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ checkedAt: now, current, latest }, null, 2));
  } catch {}

  if (latest && compareVersions(latest, current) > 0) {
    return { current, latest };
  }

  return null;
}

function reinstallLatestAuramaxx() {
  try {
    execFileSync(resolveNpmCommand(), ['uninstall', '-g', 'auramaxx'], {
      stdio: 'inherit',
      timeout: 120000,
    });
  } catch {
    // Ignore uninstall failures for missing or partially-installed global packages.
  }

  execFileSync(resolveNpmCommand(), ['install', '-g', 'auramaxx@latest', '--foreground-scripts'], {
    stdio: 'inherit',
    timeout: 180000,
  });
}

function relaunchUpdatedAuramaxx(argv, latestVersion) {
  const installedVersion = normalizeVersionString(getGlobalInstalledAuramaxxVersion()) || 'unknown';
  const useNpxLatest = installedVersion === 'unknown' || compareVersions(latestVersion, installedVersion) > 0;
  const command = useNpxLatest ? 'npx' : resolveAuramaxxCommand();
  const args = useNpxLatest
    ? ['--yes', 'auramaxx@latest', ...argv]
    : argv;

  execFileSync(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      AURA_NO_UPDATE_CHECK: '1',
    },
  });
  process.exit(0);
}

async function maybeHandleUpdateNotice() {
  const update = resolveUpdateNoticeState();
  if (!update) return;

  const noticeLine = formatUpdateAvailableLine(update.current, update.latest);
  if (!canPromptForInput()) {
    console.log(`\n${noticeLine}`);
    console.log('   Run: npm uninstall -g auramaxx && npm install -g auramaxx --foreground-scripts  (fallback: npx --yes auramaxx@latest start)\n');
    return;
  }

  console.log(`\n${noticeLine}`);
  const choice = await promptSelect(
    'Update AuraMaxx now?',
    [
      { value: 'continue', label: 'No, continue', aliases: ['n', 'no', 'continue', '2'] },
      { value: 'update', label: 'Yes, update and relaunch', aliases: ['y', 'yes', 'update', '1'] },
    ],
    'continue',
  );

  if (choice !== 'update') {
    console.log('');
    return;
  }

  console.log('');
  console.log('  Reinstalling latest AuraMaxx...');
  console.log('');

  try {
    reinstallLatestAuramaxx();
  } catch (error) {
    console.log('');
    console.error(`  Failed to update AuraMaxx automatically: ${error?.message || String(error)}`);
    console.error('  Manual fallback: npm uninstall -g auramaxx && npm install -g auramaxx --foreground-scripts');
    console.error('  Fallback: npx --yes auramaxx@latest start');
    console.log('');
    return;
  }

  console.log('');
  console.log('  [ok] AuraMaxx updated. Relaunching command...');
  console.log('');
  relaunchUpdatedAuramaxx(process.argv.slice(2), update.latest);
}

function buildRunner(commandName, commandArgs = []) {
  const commandFile = path.join(root, 'src', 'server', 'cli', 'commands', `${commandName}.ts`);
  const useNodeTsxLoader = process.env.SANDBOX_MODE === 'true' || process.env.AURA_FORCE_NODE_TSX === '1' || process.env.CODEX_SANDBOX;
  if (useNodeTsxLoader) {
    return { command: process.execPath, args: ['--import', 'tsx', commandFile, ...commandArgs] };
  }

  const forceNpxTsx = process.env.AURA_FORCE_NPX_TSX === '1';
  if (!forceNpxTsx) {
    const tsxCliPath = resolveLocalTsxCliPath();
    if (tsxCliPath) {
      return { command: process.execPath, args: [tsxCliPath, commandFile, ...commandArgs] };
    }
  }

  return { command: 'npx', args: ['tsx', commandFile, ...commandArgs] };
}

function runCommand(commandName, commandArgs = [], allowFailure = false, quiet = false) {
  const runner = buildRunner(commandName, commandArgs);
  try {
    execFileSync(runner.command, runner.args, {
      cwd: root,
      stdio: quiet ? 'ignore' : 'inherit',
      env: {
        ...process.env,
        AURA_INVOKE_CWD: process.env.AURA_INVOKE_CWD || process.cwd(),
      },
    });
    return true;
  } catch (error) {
    if (allowFailure) return false;
    process.exit(error.status || 1);
  }
}

function isCliAgentEnvironment() {
  return Boolean(
    process.env.CODEX_CI ||
    process.env.CODEX_SANDBOX ||
    process.env.CLAUDE_CODE ||
    process.env.CLAUDECODE ||
    process.env.AURA_CLI_AGENT
  );
}

function shouldRunOnboardingAutoconfig() {
  const inferredInitOrStart = inferredCommand && (cmd === 'init' || cmd === 'start');
  const explicitInitOrStart = !inferredCommand && (cmd === 'init' || cmd === 'start');
  return inferredInitOrStart || explicitInitOrStart;
}

function shouldRunBootstrapInstall() {
  const inferredInitOrStart = inferredCommand && (cmd === 'init' || cmd === 'start');
  const explicitStart = !inferredCommand && invokedCommand === 'start';
  return inferredInitOrStart || explicitStart;
}

function shouldLogBootstrapDetails() {
  if (process.env.AURA_BOOTSTRAP_VERBOSE === '1') return true;
  return args.includes('--debug');
}

function logProgress(message) {
  if (!shouldRunOnboardingAutoconfig()) return;
  if (shouldLogBootstrapDetails()) return; // verbose mode prints its own details
  console.log(message);
}

function getPathEntries() {
  return (process.env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isTransientPathEntry(entry) {
  const normalized = entry.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.npm/_npx/')) return true;
  if (normalized.includes('/_npx/')) return true;
  if (normalized.includes('/.codex/tmp/')) return true;
  if (normalized.includes('/node_modules/.bin')) return true;
  if (normalized.includes('/pnpm/dlx')) return true;
  return false;
}

function isGloballyInstalled() {
  try {
    const bin = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(bin, ['auramaxx'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).toString('utf8').trim();
    // Ignore npx/transient paths — only count stable global installs
    return result && !isTransientPathEntry(result);
  } catch {
    return false;
  }
}

// npx onboarding: route to TS command via buildRunner (same as start/init/etc.)
function runOnboardingFlow() {
  const runner = buildRunner('onboard', []);
  try {
    execFileSync(runner.command, runner.args, {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        AURA_INVOKE_CWD: process.env.AURA_INVOKE_CWD || process.cwd(),
      },
    });
  } catch (error) {
    process.exit(error.status || 1);
  }
}

function getStablePathEntries() {
  return getPathEntries().filter((entry) => !isTransientPathEntry(entry));
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findCommandInPath(commandName) {
  const pathEntries = getStablePathEntries();
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

      if (fs.existsSync(candidate) && isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function canWriteExecutableInDir(dirPath) {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function orderedPathEntriesForAuraShim() {
  const seen = new Set();
  const unique = [];
  for (const entry of getStablePathEntries()) {
    if (!seen.has(entry)) {
      seen.add(entry);
      unique.push(entry);
    }
  }

  const homeDir = os.homedir();
  const localPreferred = [
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, 'bin'),
  ];

  const preferred = [];
  const rest = [];

  for (const entry of unique) {
    if (localPreferred.includes(entry) || entry.startsWith(`${homeDir}${path.sep}`)) {
      preferred.push(entry);
    } else {
      rest.push(entry);
    }
  }

  return [...preferred, ...rest];
}

function installCommandShim(commandName) {
  const shimName = process.platform === 'win32' ? `${commandName}.cmd` : commandName;
  const preferredCli = resolvePreferredCliInvocation();
  const shimBody = process.platform === 'win32'
    ? preferredCli.mode === 'local'
      ? `@echo off\r\nnode "${preferredCli.localEntrypoint.replace(/"/g, '""')}" %*\r\n`
      : '@echo off\r\nnpx auramaxx %*\r\n'
    : `#!/usr/bin/env sh\n# Aura CLI shim for ${commandName} (auto-installed by auramaxx)\nexec ${preferredCli.runCommand} "$@"\n`;

  for (const dir of orderedPathEntriesForAuraShim()) {
    if (!fs.existsSync(dir) || !canWriteExecutableInDir(dir)) {
      continue;
    }

    const shimPath = path.join(dir, shimName);
    if (fs.existsSync(shimPath)) {
      try {
        const existing = fs.readFileSync(shimPath, 'utf8');
        const ours = existing.includes('Aura CLI shim (auto-installed by auramaxx)') || existing.includes('npx auramaxx') || existing.includes('bin/auramaxx.js');
        if (!ours) {
          continue;
        }
      } catch {
        continue;
      }
    }

    try {
      fs.writeFileSync(shimPath, shimBody, { mode: 0o755 });
      if (process.platform !== 'win32') {
        fs.chmodSync(shimPath, 0o755);
      }
      return shimPath;
    } catch {
      // Keep searching PATH candidates.
    }
  }

  return null;
}

function resolveShellAliasTarget() {
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

function stripAuraLegacyAliasLines(content) {
  const lines = content.split(/\r?\n/);
  const kept = [];
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

function removeManagedRcFallbackBlock(content) {
  const start = content.indexOf(AURA_RC_BLOCK_START);
  const end = content.indexOf(AURA_RC_BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    return { content, removed: false };
  }

  const endWithMarker = end + AURA_RC_BLOCK_END.length;
  const nextChar = content[endWithMarker] === '\n' ? endWithMarker + 1 : endWithMarker;
  const stripped = `${content.slice(0, start)}${content.slice(nextChar)}`;
  return {
    content: stripped.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, ''),
    removed: true,
  };
}

function installManagedRcFallback() {
  const rcFile = resolveShellAliasTarget();
  if (!rcFile) return { state: 'unsupported-shell' };
  const managedBlock = renderManagedRcFallbackBlock();

  let content = '';
  try {
    if (fs.existsSync(rcFile)) {
      content = fs.readFileSync(rcFile, 'utf-8');
    }
  } catch {
    return { state: 'read-failed', rcFile };
  }

  const legacyCleanup = stripAuraLegacyAliasLines(content);
  const withoutLegacy = legacyCleanup.content;
  const start = withoutLegacy.indexOf(AURA_RC_BLOCK_START);
  const end = withoutLegacy.indexOf(AURA_RC_BLOCK_END);

  let nextContent = withoutLegacy;
  let wroteManagedBlock = false;
  if (start !== -1 && end !== -1 && end > start) {
    const endWithMarker = end + AURA_RC_BLOCK_END.length;
    const nextChar = withoutLegacy[endWithMarker] === '\n' ? endWithMarker + 1 : endWithMarker;
    nextContent = `${withoutLegacy.slice(0, start)}${managedBlock}${withoutLegacy.slice(nextChar)}`;
    wroteManagedBlock = true;
  } else {
    nextContent = `${withoutLegacy}${withoutLegacy.trim() ? '\n\n' : ''}${managedBlock}`;
    wroteManagedBlock = true;
  }

  nextContent = `${nextContent.replace(/\n+$/, '')}\n`;
  const originalNormalized = `${content.replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n`;
  if (nextContent === originalNormalized) {
    return { state: 'already-present', rcFile };
  }

  try {
    fs.writeFileSync(rcFile, nextContent);
    if (wroteManagedBlock && legacyCleanup.removed) {
      return { state: 'installed-and-migrated', rcFile };
    }
    return { state: 'installed', rcFile };
  } catch {
    return { state: 'write-failed', rcFile };
  }
}

function cleanupRcFallbacksInRc() {
  const rcFile = resolveShellAliasTarget();
  if (!rcFile) return { state: 'unsupported-shell' };

  let content = '';
  try {
    if (fs.existsSync(rcFile)) {
      content = fs.readFileSync(rcFile, 'utf-8');
    } else {
      return { state: 'not-found', rcFile };
    }
  } catch {
    return { state: 'read-failed', rcFile };
  }

  const strippedLegacy = stripAuraLegacyAliasLines(content);
  const strippedBlock = removeManagedRcFallbackBlock(strippedLegacy.content);
  const removed = strippedLegacy.removed || strippedBlock.removed;

  if (!removed) return { state: 'not-found', rcFile };

  const nextContent = `${strippedBlock.content.replace(/\n+$/, '')}\n`;
  try {
    fs.writeFileSync(rcFile, nextContent);
    return { state: 'removed', rcFile };
  } catch {
    return { state: 'write-failed', rcFile };
  }
}

function maybeAutoInstallAuraAlias() {
  if (FULL_CLI_MODE) return;
  if (!shouldRunOnboardingAutoconfig()) return;

  const forceAutoInstall = process.env.AURA_AUTO_ALIAS_INSTALL_FORCE === '1';
  const verbose = shouldLogBootstrapDetails();
  const preferredCli = resolvePreferredCliInvocation();
  const portableCli = resolvePortableCliInvocation();
  const auraAliasLine = renderFunctionLine('aura', portableCli.runCommand);
  const auramaxxAliasLine = renderFunctionLine('auramaxx', portableCli.runCommand);
  const isInteractiveShell = process.stdout.isTTY && process.env.CI !== 'true';
  if (isCliAgentEnvironment() && !forceAutoInstall && !isInteractiveShell) return;

  if (process.env.AURA_AUTO_ALIAS_INSTALL === '0') {
    if (verbose) {
      console.log('Aura command auto-setup skipped (AURA_AUTO_ALIAS_INSTALL=0).');
      console.log(`Use \`${preferredCli.runCommand}\` directly or add shell fallback functions:`);
      console.log(`  ${auraAliasLine}`);
      console.log(`  ${auramaxxAliasLine}\n`);
    }
    return;
  }

  const auraPathBefore = findCommandInPath('aura');
  const auramaxxPathBefore = findCommandInPath('auramaxx');
  let auraPath = auraPathBefore;
  let auramaxxPath = auramaxxPathBefore;
  let auraShimInstalledPath = null;
  let auramaxxShimInstalledPath = null;

  if (!auraPath) {
    auraShimInstalledPath = installCommandShim('aura');
    auraPath = findCommandInPath('aura');
  }

  if (!auramaxxPath) {
    auramaxxShimInstalledPath = installCommandShim('auramaxx');
    auramaxxPath = findCommandInPath('auramaxx');
  }

  const interactiveShell = forceAutoInstall || isInteractiveShell;

  if (auraShimInstalledPath || auramaxxShimInstalledPath) {
    logProgress('CLI… ✓');
  }

  if (verbose && auraShimInstalledPath) {
    console.log(`Installed Aura command shim: ${auraShimInstalledPath}`);
  }

  if (verbose && auramaxxShimInstalledPath) {
    console.log(`Installed AuraMaxx command shim: ${auramaxxShimInstalledPath}`);
  }

  const hadCommandsBefore = Boolean(auraPathBefore && auramaxxPathBefore);
  const hasCommandsNow = Boolean(auraPath && auramaxxPath);
  if (auraPath && auramaxxPath) {
    const cleanupResult = interactiveShell ? cleanupRcFallbacksInRc() : { state: 'not-interactive' };
    if (verbose && cleanupResult.state === 'removed') {
      console.log(`Removed shell fallback aliases/functions from ${cleanupResult.rcFile}.`);
    } else if (verbose && cleanupResult.state === 'write-failed') {
      console.log(`Failed to clean shell fallback aliases/functions in ${cleanupResult.rcFile}.`);
    }
    if (verbose && hadCommandsBefore) {
      console.log('Aura commands already available on PATH; skipped shell fallback install.');
    }
    return;
  }

  const aliasResult = interactiveShell ? installManagedRcFallback() : { state: 'not-interactive' };

  if (verbose && (aliasResult.state === 'installed' || aliasResult.state === 'installed-and-migrated')) {
    if (aliasResult.state === 'installed-and-migrated') {
      console.log(`Updated ${aliasResult.rcFile} with managed Aura fallback block and cleaned legacy aliases.`);
    } else {
      console.log(`Installed managed Aura fallback block in ${aliasResult.rcFile}.`);
    }
    console.log(`Run 'source ${aliasResult.rcFile}' or open a new shell to activate it.`);
  } else if (verbose && aliasResult.state === 'already-present') {
    console.log(`Aura shell fallback block already configured in ${aliasResult.rcFile}.`);
  } else if (verbose && aliasResult.state === 'unsupported-shell') {
    console.log('Aura shell fallback auto-install skipped (unsupported shell).');
  } else if (aliasResult.state === 'write-failed' || aliasResult.state === 'read-failed') {
    console.log(`Aura shell fallback auto-install failed for ${aliasResult.rcFile}.`);
  } else if (verbose && aliasResult.state === 'not-interactive') {
    console.log('Aura shell fallback auto-install skipped (non-interactive shell).');
  }

  if (verbose) {
    console.log('To use Aura immediately in this shell, run:');
    console.log(`  ${auraAliasLine}`);
    console.log(`  ${auramaxxAliasLine}`);
    console.log(`If PATH install is blocked, use \`${portableCli.runCommand}\` directly.\n`);
  }
}

function maybeAutoInstallSkills() {
  if (!shouldRunBootstrapInstall()) return;

  // Delegate to skill.ts — single source of truth for install + heartbeat patching
  const verbose = shouldLogBootstrapDetails();
  const ok = runCommand('skill', ['--all', '--yes'], true, !verbose);
  if (!ok && !verbose) {
    logProgress('Skills… ✗');
  } else if (!verbose) {
    logProgress('Skills… ✓');
  }
}

function maybeAutoInstallService() {
  if (process.env.AURA_AUTO_SERVICE_INSTALL === '0') return;
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;

  const inferredInitOrStart = inferredCommand && (cmd === 'init' || cmd === 'start');
  const explicitStart = !inferredCommand && cmd === 'start';
  if (!inferredInitOrStart && !explicitStart) return;

  // Check if plist/unit already exists — skip if so
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.auramaxx.server.plist');
  const systemdPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'auramaxx.service');
  const serviceFilePath = process.platform === 'darwin' ? plistPath : systemdPath;
  if (fs.existsSync(serviceFilePath)) return;

  // If no agent yet (first-run init), write the plist but don't load it.
  // RunAtLoad:true means launchd will pick it up on next login, by which
  // time the agent will exist. If agent exists, activate immediately.
  const dataDir = process.env.WALLET_DATA_DIR || path.join(os.homedir(), '.auramaxx');
  const state = getDataDirState(dataDir);
  const installArgs = state.hasAgentFiles ? ['install'] : ['install', '--no-activate'];

  const verbose = shouldLogBootstrapDetails();
  const ok = runCommand('service', installArgs, true, !verbose);
  if (ok) {
    logProgress('Service… ✓');
  } else if (verbose) {
    console.log('Service auto-install skipped or failed.');
  }
}

function maybeInitFeatureFlags() {
  if (!shouldRunOnboardingAutoconfig()) return;
  const flagsPath = path.join(root, '.aura', 'features.json');
  if (fs.existsSync(flagsPath)) return;
  try {
    fs.mkdirSync(path.join(root, '.aura'), { recursive: true });
    fs.writeFileSync(flagsPath, JSON.stringify({ DEMO_FEATURE: false }, null, 2) + '\n');
  } catch {}
}

function maybeAutoInstallMcp() {
  if (!shouldRunBootstrapInstall()) return;
  const verbose = shouldLogBootstrapDetails();

  if (verbose) {
    console.log('Auto-configuring MCP integrations (best effort)...');
  }
  const ok = runCommand('mcp', ['--install'], true, !verbose);
  if (ok) {
    logProgress('MCP… ✓');
  } else {
    console.log('MCP auto-config skipped. Run `npx auramaxx mcp --install` manually.');
  }
}

async function main() {
  if (!cmd) {
    // npx onboarding: if not globally installed and no command, show install flow
    if (!isGloballyInstalled()) {
      runOnboardingFlow();
      return;
    }

    inferredCommand = true;
    cmd = resolveDefaultCommand();
    if (cmd === 'start') {
      const repaired = await maybeHandleBrokenLocalState();
      if (repaired) cmd = repaired;
    }
    if (cmd !== 'start' && cmd !== 'create') {
      console.log(`No command provided; running '${cmd}'.`);
    }
  }

  const inferredStartFlags = new Set(['--debug', '--terminal', '--headless', '--background', '--daemon', '-d']);
  if (cmd && inferredStartFlags.has(cmd)) {
    if (isCommandAvailable('start')) {
      inferredCommand = true;
      args.unshift(cmd);
      cmd = 'start';
    }
  }

  if (
    cmd === '--json'
    || ((cmd === '--help' || cmd === '-h' || cmd === 'help') && args.includes('--json'))
  ) {
    showHelpJson();
    process.exit(0);
  }

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    const showAll = args.includes('--all');
    showHelp(showAll);
    process.exit(0);
  }

  if (cmd && AGENT_ALIASES[cmd]) {
    args.unshift(AGENT_ALIASES[cmd]);
    cmd = 'agent';
  }

  if (cmd && SOCIAL_ALIASES[cmd]) {
    args.unshift(SOCIAL_ALIASES[cmd]);
    cmd = 'social';
  }

  if (cmd && COMMAND_ALIASES[cmd]) {
    cmd = COMMAND_ALIASES[cmd];
  }

  if (!COMMANDS[cmd]) {
    console.error(`Unknown command: ${cmd}\n`);
    console.error(CLI_HELP_HINT);
    process.exit(1);
  }

  if (!isCommandAvailable(cmd)) {
    console.error(`Command '${cmd}' is not included in this ${PRIMARY_CLI_NAME} package build right now.\n`);
    console.error(CLI_HELP_HINT);
    process.exit(1);
  }

  // Start is canonical: if no wallet exists yet, transparently route through init/setup.
  if (cmd === 'start') {
    const dataDir = process.env.WALLET_DATA_DIR || path.join(os.homedir(), '.auramaxx');
    const state = getDataDirState(dataDir);
    if (!state.hasAgentFiles) {
      cmd = 'init';
      // Preserve `start` semantics on first run:
      // background by default unless user requested debug/foreground.
      const hasBackgroundFlag = args.includes('--background') || args.includes('--daemon') || args.includes('-d');
      const hasDebugFlag = args.includes('--debug');
      if (!hasBackgroundFlag && !hasDebugFlag) {
        args.push('--background');
      }
    }
  }

  await maybeHandleUpdateNotice();
  if (!FULL_CLI_MODE) {
    maybeAutoInstallAuraAlias();
    maybeAutoInstallSkills();
    maybeAutoInstallMcp();
    maybeAutoInstallService();
  }
  maybeInitFeatureFlags();

  const runner = buildRunner(cmd, args);
  const invokeCwd = process.env.AURA_INVOKE_CWD || process.cwd();

  try {
    execFileSync(runner.command, runner.args, {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        AURA_INVOKE_CWD: invokeCwd,
      },
    });
  } catch (error) {
    // tsx already printed the error, just exit with its code
    process.exit(error.status || 1);
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
