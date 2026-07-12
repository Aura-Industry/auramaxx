/**
 * auramaxx start — Start wallet servers
 */

import { isServerRunning, waitForServer } from '../lib/http';
import {
  acquireStartLock,
  ensurePrismaClientGenerated,
  findProjectRoot,
  getRuntimeLogPaths,
  startServer,
  stopServer,
} from '../lib/process';
import { getErrorMessage } from '../../lib/error';
import { printBanner, printStatus, printHelp } from '../lib/theme';
import {
  installService,
  isServiceInstalled,
  isServiceRunning,
  loadServiceIfNeeded,
  stopServiceProcesses,
  SERVICE_BOOTSTRAP_ENV,
} from './service';
import * as fs from 'fs';

export interface StartCliArgs {
  headless: boolean;
  background: boolean;
  debug: boolean;
  dev: boolean;
  help: boolean;
}

export function parseStartArgs(argv: string[]): StartCliArgs {
  const args = new Set(argv);
  return {
    headless: args.has('--headless') || args.has('--terminal'),
    background: args.has('--background') || args.has('--daemon') || args.has('-d'),
    debug: args.has('--debug'),
    dev: args.has('--dev'),
    help: args.has('--help') || args.has('-h'),
  };
}

function showHelp(): void {
  printHelp('START', 'npx auramaxx start [options]', [], [
    'Options:',
    '  --terminal               Start in terminal mode (API only, no dashboard)',
    '  --headless               Alias for --terminal',
    '  --background, --daemon   Start detached in background mode',
    '  -d                       Short alias for --background',
    '  --debug                  Stream runtime logs in console (foreground only)',
    '  --dev                    Force next dev (hot reload) even if a production build exists',
  ]);
}

function printRunningStatus(headless: boolean, serviceInstalled: boolean): void {
  printBanner('RUNNING');
  const modeLabel = serviceInstalled ? 'BACKGROUND SERVICE' : 'BACKGROUND PROCESS';
  printStatus('Mode', modeLabel);
  printStatus('API (server)', 'http://localhost:4242');
  printStatus('Dashboard', headless ? 'disabled' : 'http://localhost:4747');
  printStatus('Stop', 'auramaxx stop');
  console.log('');
}

function hasPrismaClientMissingCrash(logPath: string): boolean {
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    return content.includes("Cannot find module '.prisma/client/default'");
  } catch {
    return false;
  }
}

export async function runStartCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseStartArgs(argv);
  if (parsed.help) {
    showHelp();
    return 0;
  }

  const streamLogs = parsed.debug && !parsed.background;
  let serviceInstalled = isServiceInstalled();
  const prefersServiceStart = !parsed.dev
    && !parsed.headless
    && !streamLogs
    && !parsed.background
    && process.env[SERVICE_BOOTSTRAP_ENV] !== '1';
  const serviceStartWaitMs = Math.max(1_000, Number(process.env.AURA_SERVICE_START_WAIT_MS || '30000'));
  // If server is already running, print status and exit quickly.
  let alreadyRunning = await isServerRunning();
  if (alreadyRunning && !parsed.dev) {
    printRunningStatus(parsed.headless, serviceInstalled);
    return 0;
  }

  const root = findProjectRoot();
  const prismaBootstrap = ensurePrismaClientGenerated(root);
  if (!prismaBootstrap.ok) {
    console.error('Prisma runtime client is missing and automatic recovery failed.');
    if (prismaBootstrap.error) {
      console.error(`Details: ${prismaBootstrap.error}`);
    }
    console.error('Run the following, then retry:');
    console.error(`  cd "${root}"`);
    console.error('  npx prisma generate --schema prisma/schema.prisma');
    return 1;
  }
  if (prismaBootstrap.generated) {
    printStatus('Prisma Client', 'regenerated');
  }

  // Canonical start path: install + launch the background service and rely on it.
  // Avoid recursive service bootstrapping when already inside service-launched `start --background`.
  if (prefersServiceStart) {
    let installedThisRun = false;
    if (!serviceInstalled) {
      const install = installService({ activate: false });
      if (install.installed && !install.error) {
        serviceInstalled = true;
        installedThisRun = true;
      } else {
        const reason = install.error || 'unknown install failure';
        console.warn(`Background service install failed (${reason}); falling back to direct start.`);
      }
    }

    if (serviceInstalled) {
      const running = isServiceRunning();
      const launched = loadServiceIfNeeded();
      if (!running && !launched) {
        if (installedThisRun) {
          console.warn('Background service launch failed after install; falling back to direct start.');
        } else {
          console.error('Background service is installed but failed to launch. Run `auramaxx service status` and check service logs.');
          return 1;
        }
      } else {
        try {
          await waitForServer(serviceStartWaitMs);
          printRunningStatus(false, true);
          return 0;
        } catch {
          if (installedThisRun) {
            console.warn('Background service did not become ready in time; falling back to direct start.');
          } else {
            console.error(`Background service did not become ready within ${Math.ceil(serviceStartWaitMs / 1000)}s.`);
            console.error('Run `auramaxx service status` and inspect service logs.');
            return 1;
          }
        }
      }
    }
  }

  // Manual/direct start path is lock-protected to avoid competing process spawns.
  const releaseStartLock = await acquireStartLock({ waitMs: 30_000 });
  if (!releaseStartLock) {
    if (await isServerRunning()) {
      printRunningStatus(parsed.headless, serviceInstalled);
      return 0;
    }
    console.error('Another `auramaxx start` is already in progress. Try again in a few seconds.');
    return 1;
  }

  try {
    // Re-check right before manual spawn to avoid races with another caller that just started it.
    alreadyRunning = await isServerRunning();
    if (!parsed.dev && alreadyRunning) {
      printRunningStatus(parsed.headless, serviceInstalled);
      return 0;
    }

    // Always start in background when detached.
    // Use `--debug` for foreground streaming.
    const background = !streamLogs;

    printBanner(parsed.headless ? 'HEADLESS' : 'STARTING');

    // `--dev` requests an explicit manual restart path and should not race
    // against a loaded background service.
    if (parsed.dev && serviceInstalled && isServiceRunning()) {
      stopServiceProcesses();
    }

    // Non-dev start is non-destructive: never stop an existing runtime.
    if (parsed.dev) {
      stopServer();
    }

    // Start servers (background by default so CLI returns immediately)
    startServer({
      headless: parsed.headless,
      debug: streamLogs,
      background,
      dev: parsed.dev,
      startCron: true,
    });

    // Wait for Express server
    try {
      await waitForServer(15000);
    } catch {
      const runtimeLogs = getRuntimeLogPaths(root);
      if (hasPrismaClientMissingCrash(runtimeLogs.server)) {
        console.error('Server failed to boot: generated Prisma client is missing.');
        console.error('Run: npx prisma generate --schema prisma/schema.prisma');
      } else {
        console.error('Server failed to start within 15 seconds.');
        console.error('Check for port conflicts on :4242');
      }
      if (parsed.dev) {
        stopServer();
      }
      return 1;
    }

    const modeLabel = parsed.headless ? 'HEADLESS (API only)' : 'FULL (API + dashboard)';
    const dashboardLabel = parsed.headless ? 'disabled (headless mode)' : 'http://localhost:4747';
    printStatus('Mode', modeLabel);
    printStatus('API (server)', 'http://localhost:4242');
    printStatus('Dashboard', dashboardLabel);
    printStatus('Stop', 'auramaxx stop');
    console.log('');

    if (background) {
      return 0;
    }

    // Debug/foreground mode — keep alive, clean shutdown on Cmd+C.
    const shutdown = () => {
      console.log('\nShutting down...');
      stopServer();
      console.log('Goodbye.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep event loop alive so Ctrl+C works
    setInterval(() => {}, 60_000);
    return 0;
  } finally {
    releaseStartLock();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStartCli().then((code) => {
    if (typeof code === 'number' && code !== 0) {
      process.exit(code);
    }
  }).catch((error) => {
    console.error('Error:', getErrorMessage(error));
    process.exit(1);
  });
}
