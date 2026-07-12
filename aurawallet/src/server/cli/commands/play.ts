import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { printBanner, printSection, paint, ANSI, createProgressDisplay, printComplete } from '../lib/theme';
import { promptSelect } from '../lib/prompt';
import { PublishedGameIntegrityError } from '../lib/published-game-integrity';
import { resolveAuraJsProjectRoot, resolveInvocationCwd, delegateToAuraJsCommand } from '../lib/aurajs-project';
import {
  assertPublishedForkDestination,
  copyPublishedForkProject,
  normalizeForkDisplayPath,
  resolvePublishedForkDestination,
} from '../lib/published-game-fork';
import {
  assertPublishedGameBinIntegrity,
  buildPublishedGameLaunchEnv,
  verifyPublishedGamePackageIntegrity,
} from '../lib/published-game-integrity';

export { buildPublishedGameLaunchEnv } from '../lib/published-game-integrity';

const FORWARDED_GAME_COMMANDS = new Set(['play', 'fork', 'join', 'publish', 'session', 'state', 'inspect', 'action']);

export interface PlayCommandArgs {
  help: boolean;
  name: string | null;
  gameArgs: string[];
}

export interface PlayCommandPlan extends PlayCommandArgs {
  gameBin: string | null;
  packageName: string | null;
  forwardedArgs: string[];
}

export function parseArgs(argv: string[]): PlayCommandArgs {
  const separatorIndex = argv.indexOf('--');
  const head = separatorIndex >= 0 ? argv.slice(0, separatorIndex) : argv;
  const tail = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : [];

  let help = false;
  let nameIndex = -1;
  for (let index = 0; index < head.length; index += 1) {
    const token = head[index];
    if (token === '--help' || token === '-h') {
      if (nameIndex === -1) {
        help = true;
        continue;
      }
    }
    if (!token.startsWith('-')) {
      nameIndex = index;
      break;
    }
  }

  const name = nameIndex >= 0 ? head[nameIndex] : null;
  const gameArgs = nameIndex >= 0
    ? [...head.slice(nameIndex + 1), ...tail]
    : [...tail];

  return { help, name, gameArgs };
}

export function resolvePackageName(spec: string): string {
  const trimmed = spec.trim();
  if (!trimmed) return trimmed;

  if (trimmed.startsWith('@')) {
    const match = trimmed.match(/^@[^/]+\/[^@/]+/);
    return match?.[0] || trimmed;
  }

  const atIndex = trimmed.indexOf('@');
  return atIndex === -1 ? trimmed : trimmed.slice(0, atIndex);
}

export function resolveGameBin(spec: string): string {
  const trimmed = spec.trim();
  if (!trimmed) return trimmed;

  if (trimmed.startsWith('@')) {
    const match = trimmed.match(/^@[^/]+\/([^@/]+)(?:@.+)?$/);
    return match?.[1] || trimmed;
  }

  const atIndex = trimmed.indexOf('@');
  return atIndex === -1 ? trimmed : trimmed.slice(0, atIndex);
}

export function resolveForwardedGameArgs(gameArgs: string[]): string[] {
  if (!Array.isArray(gameArgs) || gameArgs.length === 0) {
    return ['play'];
  }

  const first = String(gameArgs[0] || '').trim();
  if (FORWARDED_GAME_COMMANDS.has(first)) {
    return [...gameArgs];
  }

  return ['play', ...gameArgs];
}

export function buildPlayPlan(argv: string[]): PlayCommandPlan {
  const parsed = parseArgs(argv);
  return {
    ...parsed,
    gameBin: parsed.name ? resolveGameBin(parsed.name) : null,
    packageName: parsed.name ? resolvePackageName(parsed.name) : null,
    forwardedArgs: resolveForwardedGameArgs(parsed.gameArgs),
  };
}

function resolveNpmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function resolveAuramaxxCommand(): string {
  return process.platform === 'win32' ? 'auramaxx.cmd' : 'auramaxx';
}

function resolveInstalledGlobalAuramaxxVersion(): string | null {
  try {
    const root = execFileSync(resolveNpmCommand(), ['root', '-g'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30000,
    }).trim();
    if (!root) {
      return null;
    }
    const packageJsonPath = join(root, 'auramaxx', 'package.json');
    if (!existsSync(packageJsonPath)) {
      return null;
    }
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim().length > 0 ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

function normalizeRelativePath(pathLike: string): string {
  return String(pathLike || '')
    .trim()
    .replace(/^[.][\\/]/, '')
    .replaceAll('\\', '/');
}

function resolveInstalledPackageRoot(installRoot: string, packageName: string): string {
  return resolve(installRoot, 'node_modules', ...packageName.split('/'));
}

function resolvePublishedGameTrustRoot(source: NodeJS.ProcessEnv): string {
  const walletDataDir = typeof source.WALLET_DATA_DIR === 'string' && source.WALLET_DATA_DIR.trim().length > 0
    ? source.WALLET_DATA_DIR.trim()
    : null;
  return walletDataDir || join(homedir(), '.auramaxx');
}

function readInstalledPackageJson(packageRoot: string) {
  const packagePath = join(packageRoot, 'package.json');
  if (!existsSync(packagePath)) {
    throw new Error(`Could not read installed package metadata at ${packagePath}.`);
  }
  return JSON.parse(readFileSync(packagePath, 'utf8'));
}

function resolveInstalledBinRelativePath(
  gamePackage: Record<string, unknown>,
  expectedBinName: string | null,
): string {
  if (typeof gamePackage?.bin === 'string' && gamePackage.bin.trim().length > 0) {
    return normalizeRelativePath(gamePackage.bin);
  }

  const binEntries = Object.entries((gamePackage?.bin || {}) as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([name, value]) => ({
      name,
      relativePath: normalizeRelativePath(String(value)),
    }));

  if (expectedBinName) {
    const matched = binEntries.find((entry) => entry.name === expectedBinName);
    if (matched) {
      return matched.relativePath;
    }
  }

  if (binEntries.length === 1) {
    return binEntries[0].relativePath;
  }

  throw new Error(
    `Published game package did not expose the expected bin "${expectedBinName || '<unknown>'}".`,
  );
}

export function buildSecureInstallArgs(packageSpec: string, installRoot: string): string[] {
  return ['install', '--ignore-scripts', '--no-save', '--prefix', installRoot, '--legacy-peer-deps', packageSpec];
}

function formatInstallError(error: unknown, packageSpec: string): Error {
  const stderr = typeof (error as { stderr?: unknown })?.stderr === 'string'
    ? (error as { stderr: string }).stderr.trim()
    : '';
  const stdout = typeof (error as { stdout?: unknown })?.stdout === 'string'
    ? (error as { stdout: string }).stdout.trim()
    : '';
  const message = stderr || stdout || (error instanceof Error ? error.message : String(error));
  return new Error(`Refusing to run ${packageSpec}: ${message}`);
}

function isUnsupportedAurajsWrapperError(error: unknown): error is PublishedGameIntegrityError {
  return error instanceof PublishedGameIntegrityError
    && error.reasonCode === 'published_game_aurajs_version_unsupported';
}

async function promptUpgradeAuramaxx(expectedAurajsVersion: string): Promise<boolean> {
  console.log('');
  console.log(`  ${paint('AuraMaxx update required', ANSI.bold)}`);
  console.log(`  ${paint(`This game uses @auraindustry/aurajs ${expectedAurajsVersion}.`, ANSI.dim)}`);
  console.log(`  ${paint('Your installed AuraMaxx does not recognize that play wrapper yet.', ANSI.dim)}`);
  console.log('');

  const choice = await promptSelect(
    '  Update AuraMaxx now?',
    [
      { value: 'update', label: 'Yes, update and retry', aliases: ['y', 'yes', '1'] },
      { value: 'cancel', label: 'No, cancel', aliases: ['n', 'no', '2'] },
    ],
    'update',
  );

  return choice === 'update';
}

function installLatestAuramaxx(): void {
  console.log('');
  console.log(`  ${paint('Reinstalling latest AuraMaxx...', ANSI.bold)}`);
  console.log('');
  try {
    execFileSync(resolveNpmCommand(), ['uninstall', '-g', 'auramaxx'], {
      stdio: 'inherit',
      timeout: 120000,
    });
  } catch {
    // Ignore missing-package uninstall failures and continue with a clean install.
  }
  execFileSync(resolveNpmCommand(), ['install', '-g', 'auramaxx@latest', '--foreground-scripts'], {
    stdio: 'inherit',
    timeout: 180000,
  });

  const installedVersion = resolveInstalledGlobalAuramaxxVersion();
  if (installedVersion) {
    console.log('');
    console.log(`  ${paint(`Installed AuraMaxx ${installedVersion}`, ANSI.dim)}`);
  }
}

function relaunchWithUpdatedAuramaxx(argv: string[]): never {
  printComplete('AuraMaxx updated. Relaunching play...');
  execFileSync(resolveAuramaxxCommand(), ['play', ...argv], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(0);
}

export async function installVerifiedGamePackage(
  plan: PlayCommandPlan,
  {
    execFileSyncImpl = execFileSync,
    env = process.env,
    onProgress,
  }: {
    execFileSyncImpl?: typeof execFileSync;
    env?: NodeJS.ProcessEnv;
    onProgress?: (step: number, label: string, detail?: string) => void;
  } = {},
) {
  if (!plan.name || !plan.packageName) {
    throw new Error('installVerifiedGamePackage requires a resolved package spec.');
  }

  onProgress?.(1, 'Resolving package', plan.packageName);
  const installRoot = mkdtempSync(join(tmpdir(), 'auramaxx-play-'));
  try {
    onProgress?.(2, 'Installing verified wrapper', plan.name);
    execFileSyncImpl(resolveNpmCommand(), buildSecureInstallArgs(plan.name, installRoot), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        npm_config_ignore_scripts: 'true',
      },
      encoding: 'utf8',
    });

    const packageRoot = resolveInstalledPackageRoot(installRoot, plan.packageName);
    if (!existsSync(packageRoot)) {
      throw new Error(`Installed package root was not found at ${packageRoot}.`);
    }

    const gamePackage = readInstalledPackageJson(packageRoot);
    const dependencySpec = String(gamePackage?.dependencies?.['@auraindustry/aurajs'] || '').trim();
    onProgress?.(3, 'Verifying package integrity', dependencySpec || plan.packageName);
    const integrity = assertPublishedGameBinIntegrity({
      packageRoot,
      projectPackage: gamePackage,
      packageName: plan.packageName,
      expectedAurajsVersion: dependencySpec,
    });
    const packageIntegrity = verifyPublishedGamePackageIntegrity({
      packageRoot,
      expectedPackageName: plan.packageName,
      trustRoot: resolvePublishedGameTrustRoot(env),
    });

    const binRelativePath = resolveInstalledBinRelativePath(
      gamePackage,
      plan.gameBin || resolveGameBin(plan.name),
    );
    const binAbsolutePath = resolve(packageRoot, binRelativePath);
    if (!existsSync(binAbsolutePath)) {
      throw new Error(`Published game bin target "${binRelativePath}" is missing from the installed package.`);
    }

    return {
      installRoot,
      packageRoot,
      packageName: plan.packageName,
      gamePackage,
      binRelativePath,
      binAbsolutePath,
      integrity,
      packageIntegrity,
    };
  } catch (error: unknown) {
    rmSync(installRoot, { recursive: true, force: true });
    if (error instanceof PublishedGameIntegrityError) {
      throw error;
    }
    throw formatInstallError(error, plan.name);
  }
}

function describeForwardedCommand(command: string): string {
  switch (command) {
    case 'fork':
      return 'Forking editable package into local project...';
    case 'join':
      return 'Joining multiplayer room...';
    case 'session':
      return 'Starting game session...';
    case 'state':
      return 'Delegating to game state...';
    case 'inspect':
      return 'Delegating to game inspect...';
    case 'action':
      return 'Delegating to game action...';
    case 'publish':
      return 'Delegating to game publish...';
    case 'play':
    default:
      return 'Starting game...';
  }
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const plan = buildPlayPlan(argv);
  const invocationCwd = resolveInvocationCwd();
  const auraJsProjectRoot = resolveAuraJsProjectRoot(invocationCwd);

  if (!plan.name && auraJsProjectRoot) {
    delegateToAuraJsCommand(['play', ...argv], auraJsProjectRoot);
  }

  if (plan.help || !plan.name) {
    printBanner('PLAY');
    console.log(`  ${paint('Usage:', ANSI.bold)} auramaxx play <game> [play|fork|join|session|state|inspect|action|publish]`);
    console.log('');
    console.log(`  ${paint('Examples:', ANSI.dim)}`);
    console.log('    auramaxx play aurasu');
    console.log('    auramaxx play aurasu fork ./aurasu-local');
    console.log('    auramaxx play local-room-game join AURA2P');
    console.log('    auramaxx play aurasu session start');
    console.log('    auramaxx play aurasu state export --compact');
    console.log('');
    console.log(`  ${paint('Runs:', ANSI.dim)} verified signed temporary install -> local game wrapper`);
    console.log('');
    if (!plan.name && !plan.help) {
      console.error('  Missing game name.');
      process.exit(1);
    }
    return;
  }

  printBanner(plan.name.toUpperCase());
  printSection(plan.name, describeForwardedCommand(plan.forwardedArgs[0] || 'play'));
  const progress = createProgressDisplay(4);

  let install: Awaited<ReturnType<typeof installVerifiedGamePackage>> | null = null;
  try {
    install = await installVerifiedGamePackage(plan, {
      onProgress(step, label, detail) {
        progress.update(step, label, detail);
      },
    });
    if ((plan.forwardedArgs[0] || 'play') === 'fork') {
      const destinationRoot = await resolvePublishedForkDestination({
        commandArgs: plan.forwardedArgs.slice(1),
        invocationCwd,
        packageRoot: install.packageRoot,
        packageName: install.packageName,
      });
      if (!destinationRoot) {
        printSection(plan.name, 'Fork cancelled.');
        return;
      }
      assertPublishedForkDestination({
        destinationRoot,
        packageRoot: install.packageRoot,
        invocationCwd,
      });
      progress.update(4, 'Copying editable package', normalizeForkDisplayPath(invocationCwd, destinationRoot));
      copyPublishedForkProject({
        packageRoot: install.packageRoot,
        destinationRoot,
      });
      console.log(`  Fork ready: ${normalizeForkDisplayPath(invocationCwd, destinationRoot)}`);
      console.log('');
      console.log('  Next steps:');
      console.log(`    cd ${normalizeForkDisplayPath(invocationCwd, destinationRoot)}`);
      console.log('    npm install');
      console.log('    npm run dev');
      console.log('');
      return;
    }
    const env = buildPublishedGameLaunchEnv(
      process.env,
      {
        ...(plan.forwardedArgs[0] === 'join' ? { AURA_GAME_JOIN_MODE: 'play' } : {}),
        AURAMAXX_CLI_AVAILABLE: '1',
        AURA_INVOKE_CWD: invocationCwd,
      },
    );
    progress.update(4, 'Launching game', plan.forwardedArgs[0] || 'play');
    execFileSync(process.execPath, [install.binAbsolutePath, ...plan.forwardedArgs], {
      stdio: 'inherit',
      cwd: install.packageRoot,
      env,
    });
  } finally {
    if (install?.installRoot) {
      rmSync(install.installRoot, { recursive: true, force: true });
    }
  }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cliArgv = process.argv.slice(2);
  main(cliArgv).catch((err) => {
    if (isUnsupportedAurajsWrapperError(err)) {
      const expectedAurajsVersion = String(err.details.expectedAurajsVersion || '').trim() || '<unknown>';
      (async () => {
        const shouldUpdate = await promptUpgradeAuramaxx(expectedAurajsVersion);
        if (!shouldUpdate) {
          console.error(err.message);
          process.exit(1);
        }

        try {
          installLatestAuramaxx();
          relaunchWithUpdatedAuramaxx(cliArgv);
        } catch (updateError) {
          console.error('');
          console.error(
            updateError instanceof Error
              ? updateError.message
              : String(updateError),
          );
          console.error('  Manual fallback: npm uninstall -g auramaxx && npm install -g auramaxx@latest');
          process.exit(1);
        }
      })().catch((promptError) => {
        console.error(promptError instanceof Error ? promptError.message : String(promptError));
        process.exit(1);
      });
      return;
    }
    console.error(err instanceof Error ? err.message : String(err));
    const status = (err as { status?: number; exitCode?: number })?.status
      ?? (err as { status?: number; exitCode?: number })?.exitCode
      ?? 1;
    process.exit(Number.isInteger(status) ? status : 1);
  });
}
