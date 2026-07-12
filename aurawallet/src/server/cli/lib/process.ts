/**
 * Process management for CLI commands
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { resolveAuraSocketPath } from '../../lib/socket-path';
import { getErrorMessage } from '../../lib/error';

const CLI_PROJECT_PACKAGE_NAMES = new Set(['aurawallet', 'auramaxx']);

/**
 * Find the project root by walking up from __dirname to find the package.json.
 */
export function findProjectRoot(startDir: string = __dirname): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (CLI_PROJECT_PACKAGE_NAMES.has(pkg.name)) return dir;
      } catch {
        // Not valid JSON, keep going
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not find Aura CLI project root (expected package.json name aurawallet or auramaxx)');
}

export interface RuntimeLogPaths {
  dir: string;
  server: string;
  cron: string;
  dashboard: string;
}

export function getRuntimeLogPaths(root: string = findProjectRoot()): RuntimeLogPaths {
  const dir = path.join(root, '.logs');
  return {
    dir,
    server: path.join(dir, 'server.log'),
    cron: path.join(dir, 'cron.log'),
    dashboard: path.join(dir, 'dashboard.log'),
  };
}

export interface PrismaBootstrapResult {
  ok: boolean;
  generated: boolean;
  clientPath: string;
  error?: string;
}

export function getGeneratedPrismaClientPath(root: string = findProjectRoot()): string {
  return path.join(root, 'node_modules', '.prisma', 'client', 'default.js');
}

/**
 * Ensure generated Prisma runtime client exists for @prisma/client imports.
 * This can be missing in some global-install/update paths.
 */
export function ensurePrismaClientGenerated(
  root: string = findProjectRoot(),
  env: NodeJS.ProcessEnv = process.env,
): PrismaBootstrapResult {
  const clientPath = getGeneratedPrismaClientPath(root);
  if (fs.existsSync(clientPath)) {
    return { ok: true, generated: false, clientPath };
  }

  try {
    execSync('npx prisma generate --schema prisma/schema.prisma', {
      cwd: root,
      env,
      stdio: 'pipe',
    });
  } catch (error) {
    return {
      ok: false,
      generated: false,
      clientPath,
      error: getErrorMessage(error),
    };
  }

  if (!fs.existsSync(clientPath)) {
    return {
      ok: false,
      generated: false,
      clientPath,
      error: `Prisma client is still missing after generate at: ${clientPath}`,
    };
  }

  return { ok: true, generated: true, clientPath };
}

function getBackgroundLogStdio(logFilePath: string): { stdio: 'ignore' | ['ignore', number, number]; close: () => void } {
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    const fd = fs.openSync(logFilePath, 'a');
    return {
      stdio: ['ignore', fd, fd],
      close: () => {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore descriptor cleanup errors
        }
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[AuraMaxx] Could not open runtime log file ${logFilePath}: ${message}. Falling back to silent stdio.`);
    return { stdio: 'ignore', close: () => {} };
  }
}

function resolveProcessStdio(opts: { debug: boolean; detached: boolean; logFilePath: string }): {
  stdio: 'ignore' | 'inherit' | ['ignore', number, number];
  close: () => void;
} {
  if (opts.debug) {
    return { stdio: 'inherit', close: () => {} };
  }
  if (!opts.detached) {
    return { stdio: 'ignore', close: () => {} };
  }
  return getBackgroundLogStdio(opts.logFilePath);
}

interface StartLockPayload {
  pid: number;
  createdAt: number;
}

export interface AcquireStartLockOptions {
  waitMs?: number;
  pollMs?: number;
  staleMs?: number;
  lockPath?: string;
}

function getRuntimeTempDir(): string {
  return process.platform === 'win32' ? os.tmpdir() : '/tmp';
}

function getCliLockPath(uid?: number | string): string {
  const resolvedUid = uid ?? (process.getuid?.() ?? 'unknown');
  return path.join(getRuntimeTempDir(), `aura-cli-${resolvedUid}.lock`);
}

function getStartLockPath(): string {
  const uid = process.getuid?.() ?? 'unknown';
  const port = process.env.WALLET_SERVER_PORT || '4242';
  return path.join(getRuntimeTempDir(), `auramaxx-start-${uid}-${port}.lock`);
}

function killWindowsListeners(port: string): void {
  let output = '';
  try {
    output = execSync('netstat -ano -p tcp', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  } catch {
    return;
  }

  const pids = new Set<number>();
  const lines = output.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('TCP')) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 5) continue;
    const localAddress = cols[1] || '';
    const state = (cols[3] || '').toUpperCase();
    const pid = Number(cols[4]);
    if (state !== 'LISTENING' || !Number.isFinite(pid) || pid <= 0) continue;
    if (localAddress.endsWith(`:${port}`)) {
      pids.add(pid);
    }
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // Ignore taskkill failures
    }
  }
}

function readStartLock(lockPath: string): StartLockPayload | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StartLockPayload>;
    const pid = parsed.pid;
    const createdAt = parsed.createdAt;
    if (!Number.isInteger(pid) || !Number.isFinite(createdAt)) return null;
    return { pid: pid as number, createdAt: createdAt as number };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire a cross-process startup lock used by both CLI and MCP start paths.
 * Returns a release function when acquired, or null on timeout.
 */
export async function acquireStartLock(opts: AcquireStartLockOptions = {}): Promise<(() => void) | null> {
  const waitMs = opts.waitMs ?? 30_000;
  const pollMs = opts.pollMs ?? 250;
  const staleMs = opts.staleMs ?? 120_000;
  const lockPath = opts.lockPath ?? getStartLockPath();
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        const payload: StartLockPayload = { pid: process.pid, createdAt: Date.now() };
        fs.writeFileSync(fd, JSON.stringify(payload), { encoding: 'utf8' });
      } finally {
        fs.closeSync(fd);
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const current = readStartLock(lockPath);
          if (current?.pid === process.pid) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          // Ignore cleanup errors
        }
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;

      const current = readStartLock(lockPath);
      const staleByMissingPayload = !current;
      const staleByDeadPid = current ? !isProcessAlive(current.pid) : false;
      const staleByAge = current ? (Date.now() - current.createdAt > staleMs) : false;

      if (staleByMissingPayload || staleByDeadPid || staleByAge) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {
          // Another process may have replaced it; keep waiting.
        }
      }

      if (Date.now() >= deadline) {
        return null;
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

function resolveStopPorts(): string[] {
  const walletPort = process.env.WALLET_SERVER_PORT || '4242';
  const dashboardPort = process.env.DASHBOARD_PORT || '4747';
  const wsPort = process.env.WS_PORT || '4748';
  const ports = [walletPort, dashboardPort, wsPort];

  const dashboardPortNumber = Number(dashboardPort);
  if (Number.isInteger(dashboardPortNumber) && dashboardPortNumber > 0) {
    // Next.js may auto-bump one port when the requested dashboard port is occupied.
    ports.push(String(dashboardPortNumber + 1));
  }

  return [...new Set(ports)];
}

/**
 * Stop any running AuraMaxx server processes
 */
export function stopServer(): void {
  // In sandbox mode, don't kill other processes — the sandbox script manages its own
  if (process.env.SANDBOX_MODE) return;

  if (process.platform === 'win32') {
    const ports = resolveStopPorts();
    for (const port of ports) {
      killWindowsListeners(port);
    }
    return;
  }

  // Kill by command-line pattern (catches tsx shim + npx wrapper)
  const patterns = [
    'tsx src/server/index.ts',
    'tsx watch src/server/index.ts',
    'tsx src/server/cron/index.ts',
    'next dev -p',
    'next start -p',
  ];

  for (const pattern of patterns) {
    try {
      execSync(`pkill -f "${pattern}" 2>/dev/null`, { stdio: 'ignore' });
    } catch {
      // Process not found, that's fine
    }
  }

  // Also kill by port — catches node worker processes that tsx spawns
  // (the worker command line doesn't contain "tsx server/index.ts")
  const ports = resolveStopPorts();
  for (const port of ports) {
    try {
      execSync(`lsof -ti TCP:${port} -s TCP:LISTEN | xargs kill 2>/dev/null`, { stdio: 'ignore' });
      execSync(`lsof -ti TCP:${port} -s TCP:LISTEN | xargs kill -9 2>/dev/null`, { stdio: 'ignore' });
    } catch {
      // Nothing listening, that's fine
    }
  }

  // Give processes a moment to die
  try {
    execSync('sleep 0.5', { stdio: 'ignore' });
  } catch {
    // Ignore
  }
}

export interface StartDashboardProcessOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  debug?: boolean;
  detached?: boolean;
  dev?: boolean;
  dashboardPort?: string;
}

/**
 * Start the Next.js dashboard process.
 * Prefers `next start` when a production build exists, with one-time build recovery.
 */
export function startDashboardProcess(opts: StartDashboardProcessOptions = {}): ChildProcess {
  const root = opts.root ?? findProjectRoot();
  const env = opts.env ?? process.env;
  const dashboardPort = opts.dashboardPort ?? process.env.DASHBOARD_PORT ?? '4747';
  const buildStdioMode: 'ignore' | 'inherit' = opts.debug ? 'inherit' : 'ignore';
  const detached = opts.detached === true;
  const runtimeLogs = getRuntimeLogPaths(root);

  // Use `next start` when a production build exists, `next dev` otherwise.
  // `next build` writes a `BUILD_ID` file; `next dev` does not.
  const buildIdPath = path.join(root, '.next', 'BUILD_ID');
  let hasProductionBuild = fs.existsSync(buildIdPath);

  // If build artifacts are missing, recover once by rebuilding in place.
  // Use the package build script so prebuild cleanup runs and avoids stale chunk graphs.
  if (!opts.dev && !hasProductionBuild) {
    console.warn(`[AuraMaxx] Missing production dashboard build (${buildIdPath}); attempting one-time dashboard build.`);
    try {
      execSync('npm run build', { cwd: root, env, stdio: buildStdioMode });
    } catch {
      // Fall back to next dev below so local workflows remain usable if build fails.
    }
    hasProductionBuild = fs.existsSync(buildIdPath);
  }

  const nextCmd = opts.dev ? 'dev' : (hasProductionBuild ? 'start' : 'dev');
  if (!opts.dev && !hasProductionBuild) {
    console.warn(`[AuraMaxx] Missing production dashboard build (${buildIdPath}); falling back to next dev.`);
  }

  const dashboardStdio = resolveProcessStdio({
    debug: opts.debug === true,
    detached,
    logFilePath: runtimeLogs.dashboard,
  });
  const dashboard = (() => {
    try {
      return spawn('npx', ['next', nextCmd, '-p', dashboardPort], {
        cwd: root,
        env,
        stdio: dashboardStdio.stdio,
        detached,
      });
    } finally {
      dashboardStdio.close();
    }
  })();
  if (detached) dashboard.unref();
  return dashboard;
}

/**
 * Start the AuraMaxx server processes
 * Returns child processes for cleanup
 */
export interface StartServerOptions {
  headless?: boolean;
  debug?: boolean;
  background?: boolean;
  dev?: boolean;
  /**
   * When false, do not auto-spawn cron.
   * Default: true.
   */
  startCron?: boolean;
}

export function startServer(opts: StartServerOptions = {}): ChildProcess[] {
  const root = findProjectRoot();
  const children: ChildProcess[] = [];
  const runtimeLogs = getRuntimeLogPaths(root);

  // Set BYPASS_RATE_LIMIT for local dev
  // Generate a shared secret so the cron server can authenticate with the wallet server's internal endpoints.
  // Regenerated every start, so it's ephemeral like the SIGNING_KEY.
  const cronSecret = randomBytes(32).toString('hex');
  const env = { ...process.env, BYPASS_RATE_LIMIT: 'true', STRATEGY_CRON_SHARED_SECRET: cronSecret };
  const useNodeTsxLoader = process.env.SANDBOX_MODE === 'true' || process.env.AURA_FORCE_NODE_TSX === '1';
  const tsRunnerCmd = useNodeTsxLoader ? process.execPath : 'npx';
  const tsRunnerArgs = (entryFile: string) =>
    useNodeTsxLoader ? ['--import', 'tsx', entryFile] : ['tsx', entryFile];
  const shouldStartCron = opts.startCron !== false;
  const debug = opts.debug === true;
  // Only detach children in background mode. In foreground mode, children stay
  // in the same process group so they die together with the parent on Cmd+C.
  const detached = opts.background === true;

  const serverStdio = resolveProcessStdio({
    debug,
    detached,
    logFilePath: runtimeLogs.server,
  });
  // Start Express server
  const server = (() => {
    try {
      return spawn(tsRunnerCmd, tsRunnerArgs('src/server/index.ts'), {
        cwd: root,
        env,
        stdio: serverStdio.stdio,
        detached,
      });
    } finally {
      serverStdio.close();
    }
  })();
  if (detached) server.unref();
  children.push(server);

  if (shouldStartCron) {
    const cronStdio = resolveProcessStdio({
      debug,
      detached,
      logFilePath: runtimeLogs.cron,
    });
    // Start cron server
    const cron = (() => {
      try {
        return spawn(tsRunnerCmd, tsRunnerArgs('src/server/cron/index.ts'), {
          cwd: root,
          env,
          stdio: cronStdio.stdio,
          detached,
        });
      } finally {
        cronStdio.close();
      }
    })();
    if (detached) cron.unref();
    children.push(cron);
  }

  // Start Next.js dashboard unless headless
  if (!opts.headless) {
    const dashboard = startDashboardProcess({
      root,
      env,
      debug,
      detached,
      dev: opts.dev === true,
      dashboardPort: process.env.DASHBOARD_PORT || '4747',
    });
    children.push(dashboard);
  }

  return children;
}

/**
 * Clean up temp files (lock files, socket files)
 */
export function cleanupTempFiles(): void {
  const uid = process.getuid?.() ?? 'unknown';
  const socketPath = resolveAuraSocketPath({
    uid,
    serverPort: process.env.WALLET_SERVER_PORT,
    serverUrl: process.env.WALLET_SERVER_URL,
  });
  const files = [
    getCliLockPath(uid),
    socketPath,
  ];

  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
