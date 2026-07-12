/**
 * auramaxx cron — Run the cron server standalone
 * Useful for development or running cron separately from the main server.
 */

import { findProjectRoot } from '../lib/process';
import { execFileSync } from 'child_process';
import path from 'path';

const root = findProjectRoot();
const cronEntry = path.join(root, 'server', 'cron', 'index.ts');

console.log('Starting AuraMaxx Cron Server...\n');

try {
  execFileSync('npx', ['tsx', cronEntry], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
} catch (error: unknown) {
  const exitCode = (error as { status?: number }).status || 1;
  process.exit(exitCode);
}
