/**
 * auramaxx stop — Stop running servers
 *
 * - `auramaxx stop`         — kills processes, service stays registered (auto-starts on next login)
 * - `auramaxx stop --force` — kills processes AND uninstalls the service
 */

import { stopServer, cleanupTempFiles } from '../lib/process';
import { isServiceInstalled, stopServiceProcesses, uninstallService } from './service';

function main() {
  const force = process.argv.includes('--force');

  console.log('Stopping AuraMaxx...');

  // If an OS background service is registered, unload it first so it doesn't
  // immediately respawn the processes we're about to kill.
  if (isServiceInstalled()) {
    stopServiceProcesses();
  }

  stopServer();
  cleanupTempFiles();

  if (force && isServiceInstalled()) {
    uninstallService();
    console.log('Background service removed. AuraMaxx will not auto-start on login.');
  } else if (isServiceInstalled()) {
    console.log('Stopped. Service still registered — will auto-start on next login.');
    console.log('To fully remove: auramaxx stop --force');
  }

  console.log('Stopped.');
}

main();
