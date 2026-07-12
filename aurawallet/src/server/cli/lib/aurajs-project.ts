import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_AURAJS_CLI = path.resolve(
  LIB_DIR,
  '../../../../../packages/aurascript/src/cli/src/cli.mjs',
);

export function resolveInvocationCwd(): string {
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

export function resolveAuraJsProjectRoot(startDir: string): string | null {
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

export function requireAuraJsProjectRoot(startDir: string): string {
  const projectRoot = resolveAuraJsProjectRoot(startDir);
  if (projectRoot) {
    return projectRoot;
  }

  throw new Error('Not an AuraJS project. Run `auramaxx create my-game` first.');
}

export function delegateToAuraJsCommand(auraArgs: string[], cwd: string): never {
  try {
    if (existsSync(LOCAL_AURAJS_CLI)) {
      execFileSync(process.execPath, [LOCAL_AURAJS_CLI, ...auraArgs], {
        cwd,
        stdio: 'inherit',
        env: process.env,
      });
    } else {
      execFileSync(
        'npm',
        ['exec', '--yes', '--package', '@auraindustry/aurajs', '--', 'aura', ...auraArgs],
        {
          cwd,
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

export function delegateToAuraJsProjectCommand(commandName: string, commandArgs: string[] = []): never {
  const invocationCwd = resolveInvocationCwd();
  const projectRoot = requireAuraJsProjectRoot(invocationCwd);
  delegateToAuraJsCommand([commandName, ...commandArgs], projectRoot);
}
