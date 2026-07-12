import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { printBanner, printSection, printStatus, paint, ANSI } from '../lib/theme';
import { promptInput, promptSelect } from '../lib/prompt';

type AccessMode = 'public' | 'restricted';
type BumpKind = 'patch' | 'minor' | 'major';

interface ParsedArgs {
  help: boolean;
  yes: boolean;
  dryRun: boolean;
  name: string | null;
  version: string | null;
  access: AccessMode;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z-.]+)?$/;
const SCOPED_PACKAGE_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const UNSCOPED_PACKAGE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const COMMAND_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_AURAJS_CLI = path.resolve(
  COMMAND_DIR,
  '../../../../../packages/aurascript/src/cli/src/cli.mjs',
);

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    yes: false,
    dryRun: false,
    name: null,
    version: null,
    access: 'public',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--name') {
      if (!argv[i + 1]) throw new Error('Missing value for --name.');
      parsed.name = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--name=')) {
      parsed.name = arg.slice('--name='.length);
      continue;
    }
    if (arg === '--version') {
      if (!argv[i + 1]) throw new Error('Missing value for --version.');
      parsed.version = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--version=')) {
      parsed.version = arg.slice('--version='.length);
      continue;
    }
    if (arg === '--access') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --access.');
      if (value !== 'public' && value !== 'restricted') {
        throw new Error(`Invalid --access "${value}". Expected public or restricted.`);
      }
      parsed.access = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--access=')) {
      const value = arg.slice('--access='.length);
      if (value !== 'public' && value !== 'restricted') {
        throw new Error(`Invalid --access "${value}". Expected public or restricted.`);
      }
      parsed.access = value;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function resolveInvocationCwd(): string {
  const forwardedCwd = process.env.AURA_INVOKE_CWD;
  if (forwardedCwd && path.isAbsolute(forwardedCwd)) {
    return forwardedCwd;
  }
  const shellPwd = process.env.PWD;
  if (shellPwd && path.isAbsolute(shellPwd)) {
    return shellPwd;
  }
  return process.cwd();
}

function resolveAuraJsProjectRoot(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const auraConfigPath = path.join(current, 'aura.config.json');
    const packageJsonPath = path.join(current, 'package.json');
    if (existsSync(auraConfigPath) && existsSync(packageJsonPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function delegateToAuraJsPublish(rawArgs: string[], projectRoot: string): never {
  const auraArgs = ['publish', ...rawArgs];

  try {
    if (existsSync(LOCAL_AURAJS_CLI)) {
      execFileSync(process.execPath, [LOCAL_AURAJS_CLI, ...auraArgs], {
        cwd: projectRoot,
        stdio: 'inherit',
        env: process.env,
      });
    } else {
      execFileSync(
        'npm',
        ['exec', '--yes', '--package', '@auraindustry/aurajs', '--', 'aura', ...auraArgs],
        {
          cwd: projectRoot,
          stdio: 'inherit',
          env: process.env,
        },
      );
    }
    process.exit(0);
  } catch (error: unknown) {
    const status = (error as { status?: number }).status;
    process.exit(status || 1);
  }
}

function sanitizePackageSlug(value: string): string {
  const compact = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  if (!compact) {
    throw new Error(`Cannot derive package slug from "${value}".`);
  }
  return compact;
}

function ensureScopedPackageName(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error('Package name cannot be empty.');
  }
  if (/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(trimmed)) {
    return `@${trimmed}`;
  }
  return trimmed;
}

function validatePackageName(value: string): void {
  const normalized = ensureScopedPackageName(value);
  if (!SCOPED_PACKAGE_RE.test(normalized) && !UNSCOPED_PACKAGE_RE.test(normalized)) {
    throw new Error(`Invalid npm package name "${value}".`);
  }
}

function normalizeVersion(value: string): string {
  return String(value || '').trim().replace(/^v/i, '');
}

function validateVersion(value: string): void {
  if (!SEMVER_RE.test(value)) {
    throw new Error(`Invalid version "${value}". Expected semver like 1.2.3 or 1.2.3-beta.1`);
  }
}

function bumpVersion(currentVersion: string, bumpKind: BumpKind): string {
  const match = normalizeVersion(currentVersion).match(SEMVER_RE);
  if (!match) {
    throw new Error(`Current version "${currentVersion}" is not semver.`);
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  const prerelease = match[4] || '';

  if (bumpKind === 'major') return `${major + 1}.0.0${prerelease}`;
  if (bumpKind === 'minor') return `${major}.${minor + 1}.0${prerelease}`;
  return `${major}.${minor}.${patch + 1}${prerelease}`;
}

function readPackageJson(pkgPath: string): Record<string, unknown> {
  const source = readFileSync(pkgPath, 'utf8');
  const parsed = JSON.parse(source) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid package.json at ${pkgPath}`);
  }
  return parsed;
}

function writePackageJson(pkgPath: string, pkg: Record<string, unknown>): void {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

async function resolvePackageName(options: {
  explicitName: string | null;
  yes: boolean;
  packageJsonName: string | null;
  invocationCwd: string;
}): Promise<string> {
  const folderSlug = sanitizePackageSlug(path.basename(options.invocationCwd));
  const generatedDefault = `@aurajs/${folderSlug}`;
  const defaultName = options.packageJsonName || generatedDefault;
  const defaultDisplay = defaultName.startsWith('@') ? defaultName.slice(1) : defaultName;

  if (options.explicitName) {
    const fromArg = ensureScopedPackageName(options.explicitName);
    validatePackageName(fromArg);
    return fromArg;
  }
  if (options.yes) {
    validatePackageName(defaultName);
    return defaultName;
  }

  const input = await promptInput(`  Package name (default: ${defaultDisplay})`);
  const chosen = ensureScopedPackageName(input || defaultDisplay);
  validatePackageName(chosen);
  return chosen;
}

async function resolveVersion(options: {
  explicitVersion: string | null;
  yes: boolean;
  currentVersion: string;
}): Promise<string> {
  if (options.explicitVersion) {
    const normalized = normalizeVersion(options.explicitVersion);
    validateVersion(normalized);
    return normalized;
  }
  if (options.yes) return options.currentVersion;

  const choice = await promptSelect(
    '  Version selection',
    [
      { value: 'current', label: `Current (${options.currentVersion})`, aliases: ['c', 'keep'] },
      { value: 'bump', label: 'Bump version', aliases: ['b'] },
      { value: 'custom', label: 'Custom version', aliases: ['x'] },
    ],
    'current',
  );

  if (choice === 'current') {
    return options.currentVersion;
  }

  if (choice === 'bump') {
    const bumpKind = await promptSelect(
      '  Bump type',
      [
        { value: 'patch', label: `Patch (${bumpVersion(options.currentVersion, 'patch')})`, aliases: ['p'] },
        { value: 'minor', label: `Minor (${bumpVersion(options.currentVersion, 'minor')})`, aliases: ['m'] },
        { value: 'major', label: `Major (${bumpVersion(options.currentVersion, 'major')})`, aliases: ['M'] },
      ],
      'patch',
    ) as BumpKind;

    return bumpVersion(options.currentVersion, bumpKind);
  }

  while (true) {
    const input = normalizeVersion(await promptInput('  Custom version (semver)'));
    if (!input) {
      console.error('  Version is required.');
      continue;
    }
    if (!SEMVER_RE.test(input)) {
      console.error('  Invalid version format. Use semver like 1.2.3 or 1.2.3-beta.1');
      continue;
    }
    return input;
  }
}

async function main() {
  const invocationCwd = resolveInvocationCwd();
  const rawArgs = process.argv.slice(2);
  const auraJsProjectRoot = resolveAuraJsProjectRoot(invocationCwd);

  if (auraJsProjectRoot) {
    delegateToAuraJsPublish(rawArgs, auraJsProjectRoot);
  }

  const parsed = parseArgs(rawArgs);
  const packageJsonPath = path.join(invocationCwd, 'package.json');

  if (parsed.help) {
    printBanner('PUBLISH');
    console.log(`  ${paint('Usage:', ANSI.bold)} auramaxx publish [options]`);
    console.log('');
    console.log(`  ${paint('Options:', ANSI.bold)}`);
    console.log('    --name <package>       Package name to publish (default: aurajs/<folder>)');
    console.log('    --version <semver>     Publish version');
    console.log('    --access <mode>        npm access mode: public | restricted (default: public)');
    console.log('    --dry-run              Run npm publish with --dry-run');
    console.log('    --yes, -y              Accept defaults (current name/version)');
    console.log('');
    return;
  }

  if (!existsSync(packageJsonPath)) {
    throw new Error(`No package.json found in ${invocationCwd}`);
  }

  const pkg = readPackageJson(packageJsonPath);
  const packageJsonName = typeof pkg.name === 'string' && pkg.name.trim().length > 0 ? pkg.name.trim() : null;
  const currentVersion = typeof pkg.version === 'string' && pkg.version.trim().length > 0
    ? normalizeVersion(pkg.version)
    : '0.1.0';
  validateVersion(currentVersion);

  printBanner('PUBLISH');
  printSection('Package', 'Publish current repo to npm');
  printStatus('Directory', invocationCwd);
  printStatus('Current name', packageJsonName || '(unset)');
  printStatus('Current version', currentVersion);

  const targetName = await resolvePackageName({
    explicitName: parsed.name,
    yes: parsed.yes,
    packageJsonName,
    invocationCwd,
  });
  const targetVersion = await resolveVersion({
    explicitVersion: parsed.version,
    yes: parsed.yes,
    currentVersion,
  });

  let changed = false;
  if (pkg.name !== targetName) {
    pkg.name = targetName;
    changed = true;
  }
  if (pkg.version !== targetVersion) {
    pkg.version = targetVersion;
    changed = true;
  }
  if (changed) {
    writePackageJson(packageJsonPath, pkg);
  }

  printSection('Publishing', `${targetName}@${targetVersion}`);
  printStatus('Access', parsed.access);
  printStatus('Dry run', parsed.dryRun ? 'yes' : 'no');

  const publishArgs = ['publish', '--access', parsed.access];
  if (parsed.dryRun) publishArgs.push('--dry-run');

  try {
    execFileSync('npm', publishArgs, {
      cwd: invocationCwd,
      stdio: 'inherit',
      env: process.env,
    });
  } catch (error: unknown) {
    const status = (error as { status?: number }).status;
    if (status) process.exit(status);
    throw error;
  }

  printSection('Done', `Published ${targetName}@${targetVersion}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
