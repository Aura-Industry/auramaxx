/**
 * auramaxx nuke — Destructive local reset
 *
 * Deletes all local Aura data from WALLET_DATA_DIR (or ~/.auramaxx),
 * including agent files, database, credentials, logs, and config.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { DATA_PATHS } from '../../lib/config';
import { getErrorMessage } from '../../lib/error';
import { promptConfirm } from '../lib/prompt';
import { printHelp, printBanner, printStatus } from '../lib/theme';
import { stopServer, cleanupTempFiles } from '../lib/process';
import { isServiceInstalled, stopServiceProcesses, uninstallService } from './service';

interface NukeResult {
  success: boolean;
  dataDir: string;
  entriesRemoved: number;
  serviceRemoved: boolean;
}

function writeNukeStateMarker(dataDir: string): void {
  const markerPath = DATA_PATHS.nukeStateMarker;
  try {
    fs.writeFileSync(
      markerPath,
      JSON.stringify(
        {
          version: 1,
          source: 'cli',
          at: new Date().toISOString(),
          dataDir,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    // Marker is best-effort; nuke should still succeed.
  }
}

function showHelp(): void {
  printHelp('NUKE', 'npx auramaxx nuke [--yes] [--json]', [
    { name: '--yes, -y', desc: 'Skip interactive confirmation prompt' },
    { name: '--json', desc: 'Print machine-readable output' },
  ], [
    'Examples:',
    '  npx auramaxx nuke',
    '  npx auramaxx nuke --yes',
  ]);
}

function canPromptForInput(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.CI !== 'true');
}

function assertSafeDataDir(dataDir: string): void {
  const resolved = path.resolve(dataDir);
  if (resolved === path.sep) {
    throw new Error(`Refusing to nuke root directory: ${resolved}`);
  }
  if (resolved === path.resolve(os.homedir())) {
    throw new Error(`Refusing to nuke home directory: ${resolved}`);
  }
}

function wipeDataDir(dataDir: string): number {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return 0;
  }

  const entries = fs.readdirSync(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return entries.length;
}

async function confirmNuke(dataDir: string): Promise<boolean> {
  if (!canPromptForInput()) {
    throw new Error('Non-interactive shell requires --yes for `auramaxx nuke`.');
  }

  printBanner('NUKE');
  console.log('  DANGER: This permanently removes local Aura data.');
  console.log(`  Target directory: ${dataDir}`);
  console.log('  Includes: agents, auramaxx.db, credentials, logs, and config.\n');

  return promptConfirm('  Continue with destructive reset?');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  const assumeYes = args.includes('--yes') || args.includes('-y');
  const json = args.includes('--json');
  const dataDir = DATA_PATHS.wallets;

  assertSafeDataDir(dataDir);

  if (!assumeYes) {
    const confirmed = await confirmNuke(dataDir);
    if (!confirmed) {
      if (!json) {
        console.log('Cancelled. No files were removed.');
      } else {
        console.log(JSON.stringify({ success: false, cancelled: true }, null, 2));
      }
      process.exit(0);
    }
  }

  const hadService = isServiceInstalled();
  if (hadService) {
    stopServiceProcesses();
  }
  stopServer();
  cleanupTempFiles();
  if (hadService) {
    uninstallService();
  }

  const entriesRemoved = wipeDataDir(dataDir);
  writeNukeStateMarker(dataDir);
  const result: NukeResult = {
    success: true,
    dataDir,
    entriesRemoved,
    serviceRemoved: hadService,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printBanner('NUKE');
  printStatus('Data dir', dataDir);
  printStatus('Entries removed', String(entriesRemoved), true);
  printStatus('Service removed', hadService ? 'yes' : 'no', true);
  console.log('\n  Local Aura state wiped. Run `npx auramaxx start` to re-initialize.\n');
}

main().catch((error) => {
  console.error(`Nuke command failed: ${getErrorMessage(error)}`);
  process.exit(1);
});
