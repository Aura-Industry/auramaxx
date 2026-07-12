/**
 * auramaxx restart — Restart wallet servers
 */

import { getErrorMessage } from '../../lib/error';
import { printBanner, printHelp } from '../lib/theme';
import { stopServer, cleanupTempFiles } from '../lib/process';
import { isServiceInstalled, isServiceRunning, stopServiceProcesses } from './service';
import { runStartCli } from './start';

interface RestartCliArgs {
  help: boolean;
  startArgs: string[];
}

export function parseRestartArgs(argv: string[]): RestartCliArgs {
  const help = argv.includes('--help') || argv.includes('-h');
  const startArgs = argv.filter((arg) => arg !== '--help' && arg !== '-h');
  return { help, startArgs };
}

function showHelp(): void {
  printHelp('RESTART', 'npx auramaxx restart [options]', [], [
    'Options:',
    '  --headless               Start server only (no dashboard)',
    '  --background, --daemon   Start detached in background mode',
    '  -d                       Short alias for --background',
    '  --debug                  Stream runtime logs in console (foreground only)',
    '  --dev                    Force next dev (hot reload) even if a production build exists',
  ]);
}

export async function runRestartCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseRestartArgs(argv);
  if (parsed.help) {
    showHelp();
    return 0;
  }

  printBanner('RESTART');

  if (isServiceInstalled() && isServiceRunning()) {
    stopServiceProcesses();
  }

  stopServer();
  cleanupTempFiles();

  return runStartCli(parsed.startArgs);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRestartCli().then((code) => {
    if (typeof code === 'number' && code !== 0) {
      process.exit(code);
    }
  }).catch((error) => {
    console.error('Error:', getErrorMessage(error));
    process.exit(1);
  });
}
