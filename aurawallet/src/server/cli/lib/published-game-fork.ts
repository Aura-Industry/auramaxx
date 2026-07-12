import { cpSync, existsSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';

import { promptSelect } from './prompt';

const FORK_EXCLUDED_TOP_LEVEL = new Set(['.aura', '.git', '.logs', 'build', 'dist', 'node_modules']);

function toPackageShortName(value: string): string {
  return String(value || '').trim().replace(/^@[^/]+\//, '') || 'aura-game';
}

export function normalizeForkDisplayPath(invocationCwd: string, targetPath: string): string {
  const resolvedPath = resolve(targetPath);
  const relativePath = relative(resolve(invocationCwd), resolvedPath).replaceAll('\\', '/');
  if (!relativePath) return '.';
  if (!relativePath.startsWith('.') && !relativePath.startsWith('/')) {
    return `./${relativePath}`;
  }
  return relativePath;
}

export function isSubpath(parentPath: string, childPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(childPath));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function resolveUniqueDestination(preferredPath: string): string {
  if (!existsSync(preferredPath)) {
    return preferredPath;
  }
  let attempt = 2;
  while (true) {
    const candidate = `${preferredPath}-${attempt}`;
    if (!existsSync(candidate)) {
      return candidate;
    }
    attempt += 1;
  }
}

export interface ParsedPublishedForkArgs {
  destination: string | null;
}

export function parsePublishedForkArgs(args: string[]): ParsedPublishedForkArgs {
  const parsed: ParsedPublishedForkArgs = {
    destination: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '');
    if (token === '--dest' || token === '--dir' || token === '--output') {
      if ((index + 1) >= args.length) {
        throw new Error('fork requires a destination path after --dest.');
      }
      parsed.destination = String(args[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (token.startsWith('--dest=')) {
      parsed.destination = token.slice('--dest='.length).trim();
      continue;
    }
    if (token.startsWith('--dir=')) {
      parsed.destination = token.slice('--dir='.length).trim();
      continue;
    }
    if (token.startsWith('--output=')) {
      parsed.destination = token.slice('--output='.length).trim();
      continue;
    }
    if (!parsed.destination && !token.startsWith('-')) {
      parsed.destination = token.trim();
      continue;
    }
    throw new Error(
      `Unexpected fork argument: ${token}\n`
      + 'Usage:\n'
      + '  fork [destination]\n'
      + '  fork --dest ./my-game-fork',
    );
  }

  return parsed;
}

export function resolveDefaultPublishedForkDestination({
  invocationCwd,
  packageRoot,
  packageName,
}: {
  invocationCwd: string;
  packageRoot: string;
  packageName: string;
}): string {
  const defaultBaseName = `${toPackageShortName(packageName)}-fork`;
  const baseDir = isSubpath(packageRoot, invocationCwd)
    ? dirname(packageRoot)
    : resolve(invocationCwd);
  return resolveUniqueDestination(resolve(baseDir, defaultBaseName));
}

export async function resolvePublishedForkDestination({
  commandArgs,
  invocationCwd,
  packageRoot,
  packageName,
}: {
  commandArgs: string[];
  invocationCwd: string;
  packageRoot: string;
  packageName: string;
}): Promise<string | null> {
  const parsed = parsePublishedForkArgs(commandArgs);
  if (parsed.destination) {
    return resolve(resolve(invocationCwd), parsed.destination);
  }

  const suggestedDestination = resolveDefaultPublishedForkDestination({
    invocationCwd,
    packageRoot,
    packageName,
  });
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return suggestedDestination;
  }

  const displayPath = normalizeForkDisplayPath(invocationCwd, suggestedDestination);
  const choice = await promptSelect(
    '  Choose fork target',
    [
      { value: 'confirm', label: `Fork into ${displayPath}` },
      { value: 'cancel', label: 'Cancel' },
    ],
    'confirm',
  );

  if (choice === 'cancel') {
    return null;
  }

  return suggestedDestination;
}

export function assertPublishedForkDestination({
  destinationRoot,
  packageRoot,
  invocationCwd,
}: {
  destinationRoot: string;
  packageRoot: string;
  invocationCwd: string;
}): void {
  if (resolve(destinationRoot) === resolve(packageRoot)) {
    throw new Error('fork destination must be different from the current package root.');
  }
  if (isSubpath(packageRoot, destinationRoot)) {
    throw new Error(
      'fork destination must live outside the current package root.\n'
      + `Choose a sibling or external path instead of ${normalizeForkDisplayPath(invocationCwd, destinationRoot)}.`,
    );
  }
  if (existsSync(destinationRoot)) {
    throw new Error(
      `fork destination already exists: ${normalizeForkDisplayPath(invocationCwd, destinationRoot)}\n`
      + 'Choose a new path or remove the existing directory first.',
    );
  }
}

function shouldCopyPublishedForkSource(packageRoot: string, sourcePath: string): boolean {
  const relativePath = relative(packageRoot, sourcePath).replaceAll('\\', '/');
  if (!relativePath) {
    return true;
  }
  const topLevel = relativePath.split('/')[0];
  return !FORK_EXCLUDED_TOP_LEVEL.has(topLevel);
}

export function copyPublishedForkProject({
  packageRoot,
  destinationRoot,
}: {
  packageRoot: string;
  destinationRoot: string;
}): void {
  mkdirSync(dirname(destinationRoot), { recursive: true });
  cpSync(packageRoot, destinationRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    filter: (sourcePath) => shouldCopyPublishedForkSource(packageRoot, sourcePath),
  });
}
