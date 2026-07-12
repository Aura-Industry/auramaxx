/**
 * Filesystem + Prisma setup steps for init command
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import { findProjectRoot } from './process';

function getDataDir(): string {
  return process.env.WALLET_DATA_DIR || path.join(os.homedir(), '.auramaxx');
}

/**
 * Create the ~/.auramaxx/ directory structure
 */
export function ensureDirectories(): void {
  const dataDir = getDataDir();
  const dirs = [
    dataDir,
    path.join(dataDir, 'hot'),
    path.join(dataDir, 'pending'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Root-level tmp/backups directories are no longer created here.
}

/**
 * Run Prisma migrations against ~/.auramaxx/auramaxx.db
 */
export function runMigrations(root?: string): void {
  const projectRoot = root || findProjectRoot();
  const dbUrl = process.env.DATABASE_URL || `file:${getDataDir()}/auramaxx.db`;
  const env = { ...process.env, DATABASE_URL: dbUrl };

  try {
    // Try deploy first (production-style, no prompts)
    execSync('npx prisma migrate deploy', {
      cwd: projectRoot,
      env,
      stdio: 'pipe',
    });
  } catch {
    // Fallback to dev migration (creates migration if needed)
    execSync('npx prisma migrate dev --name init', {
      cwd: projectRoot,
      env,
      stdio: 'pipe',
    });
  }
}

/**
 * Generate the Prisma client
 */
export function generatePrismaClient(root?: string): void {
  const projectRoot = root || findProjectRoot();
  execSync('npx prisma generate', {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}

/**
 * Check if a primary agent file already exists
 */
export function hasAgent(): boolean {
  return fs.existsSync(path.join(getDataDir(), 'agent-primary.json'));
}
