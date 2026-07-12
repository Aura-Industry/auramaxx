#!/usr/bin/env tsx
/**
 * npx auramaxx restore — Restore from a backup
 *
 * Usage:
 *   npx auramaxx restore --list              # List available backups
 *   npx auramaxx restore --latest            # Restore most recent backup
 *   npx auramaxx restore <filename>          # Restore specific backup
 *   npx auramaxx restore --dry-run <file>    # Preview without modifying
 *   npx auramaxx restore --dry-run --latest  # Preview latest restore
 */

import { readdir, stat, copyFile, unlink, rename } from 'fs/promises';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { createServer } from 'net';
import { getDbPath, getBackupsDir } from '../../lib/config';
import { ensureBackupsDir, verifyIntegrity } from '../../routes/backup';

const DATA_DIR = join(getDbPath(), '..');
const CREDENTIALS_DIR = join(DATA_DIR, 'credentials');

interface BackupEntry {
  filename: string;
  timestamp: string;
  size: number;
  date: Date;
}

async function listBackups(): Promise<BackupEntry[]> {
  const backupsDir = getBackupsDir();
  ensureBackupsDir();

  const files = await readdir(backupsDir);
  const backups: BackupEntry[] = [];

  for (const file of files) {
    if (file.startsWith('auramaxx.db.') && file.endsWith('.bak')) {
      const match = file.match(/auramaxx\.db\.(\d{8}_\d{6})\.bak/);
      if (!match) continue;
      const filePath = join(backupsDir, file);
      const fileStat = await stat(filePath);
      backups.push({
        filename: file,
        timestamp: match[1],
        size: fileStat.size,
        date: fileStat.mtime,
      });
    }
  }

  backups.sort((a, b) => b.date.getTime() - a.date.getTime());
  return backups;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(ts: string): string {
  // YYYYMMDD_HHMMSS -> YYYY-MM-DD HH:MM:SS
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}`;
}

async function checkServerRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(4242, '127.0.0.1');
  });
}

async function createPreRestoreBackup(): Promise<string> {
  const dbFile = getDbPath();
  if (!existsSync(dbFile)) return '';

  const backupsDir = getBackupsDir();
  ensureBackupsDir();

  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0];
  const filename = `pre-restore.${timestamp}.bak`;
  const backupPath = join(backupsDir, filename);

  await copyFile(dbFile, backupPath);
  return filename;
}

async function restoreCredentials(backupsDir: string, timestamp: string): Promise<number> {
  const allFiles = await readdir(backupsDir);
  const credBackups = allFiles.filter(
    (f) => f.startsWith(`credentials.${timestamp}.cred-`) && f.endsWith('.json')
  );

  if (credBackups.length === 0) return 0;

  if (!existsSync(CREDENTIALS_DIR)) {
    mkdirSync(CREDENTIALS_DIR, { recursive: true });
  }

  // Remove existing credentials
  if (existsSync(CREDENTIALS_DIR)) {
    const existing = await readdir(CREDENTIALS_DIR);
    for (const f of existing) {
      if (f.startsWith('cred-') && f.endsWith('.json')) {
        await unlink(join(CREDENTIALS_DIR, f));
      }
    }
  }

  // Copy from backup
  for (const f of credBackups) {
    const destName = f.replace(`credentials.${timestamp}.`, '');
    await copyFile(join(backupsDir, f), join(CREDENTIALS_DIR, destName));
  }

  return credBackups.length;
}

async function runMigrations(): Promise<number> {
  try {
    const output = execSync('npx prisma migrate deploy', {
      cwd: join(__dirname, '..', '..', '..', '..'),
      env: { ...process.env, DATABASE_URL: `file:${getDbPath()}` },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Count applied migrations from output
    const matches = output.match(/(\d+) migration/);
    return matches ? parseInt(matches[1], 10) : 0;
  } catch (error: any) {
    const errMsg = error.stderr || error.message || 'Unknown error';
    console.error(`\n  ✗ Migration FAILED: ${errMsg}`);
    console.error('  This is a critical error — the restored DB may have an incompatible schema.');
    throw new Error(`Migration failed: ${errMsg}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const listFlag = args.includes('--list');
  const latestFlag = args.includes('--latest');
  const dryRun = args.includes('--dry-run');
  const filename = args.find((a) => !a.startsWith('--'));

  if (!listFlag && !latestFlag && !filename) {
    console.log(`
  auramaxx restore — Restore from a backup

  Usage:
    npx auramaxx restore --list              List available backups
    npx auramaxx restore --latest            Restore most recent backup
    npx auramaxx restore <filename>          Restore specific backup
    npx auramaxx restore --dry-run --latest  Preview without modifying
`);
    process.exit(0);
  }

  // --list: show backups and exit
  if (listFlag) {
    const backups = await listBackups();
    if (backups.length === 0) {
      console.log('No backups found.');
      process.exit(0);
    }

    console.log(`\n  Available backups (${backups.length}):\n`);
    for (const b of backups) {
      console.log(`    ${b.filename}  ${formatTimestamp(b.timestamp)}  ${formatSize(b.size)}`);
    }
    console.log();
    process.exit(0);
  }

  // Determine which backup to restore
  let targetFilename: string;
  if (latestFlag) {
    const backups = await listBackups();
    if (backups.length === 0) {
      console.error('No backups found.');
      process.exit(1);
    }
    targetFilename = backups[0].filename;
  } else {
    targetFilename = filename!;
  }

  // Validate filename
  if (!targetFilename.match(/^auramaxx\.db\.\d{8}_\d{6}\.bak$/)) {
    console.error(`Invalid backup filename: ${targetFilename}`);
    process.exit(1);
  }

  const backupsDir = getBackupsDir();
  const backupPath = join(backupsDir, targetFilename);

  if (!existsSync(backupPath)) {
    console.error(`Backup not found: ${targetFilename}`);
    process.exit(1);
  }

  const backupStat = await stat(backupPath);
  const tsMatch = targetFilename.match(/auramaxx\.db\.(\d{8}_\d{6})\.bak/)!;
  const timestamp = tsMatch[1];

  // Count matching credential backups
  const allFiles = await readdir(backupsDir);
  const credCount = allFiles.filter(
    (f) => f.startsWith(`credentials.${timestamp}.cred-`) && f.endsWith('.json')
  ).length;

  console.log(`\n  Restore target: ${targetFilename}`);
  console.log(`  Created:        ${formatTimestamp(timestamp)}`);
  console.log(`  Size:           ${formatSize(backupStat.size)}`);
  console.log(`  Credentials:    ${credCount} file(s)`);

  // Verify backup integrity
  console.log('\n  Verifying backup integrity...');
  if (!verifyIntegrity(backupPath)) {
    console.error('  ✗ Backup FAILED integrity check. Aborting.');
    process.exit(1);
  }
  console.log('  ✓ Backup integrity OK');

  if (dryRun) {
    console.log('\n  --dry-run: No changes made.\n');
    process.exit(0);
  }

  // Check if server is running
  const serverRunning = await checkServerRunning();
  if (serverRunning) {
    console.log('\n  ⚠️  WARNING: Server appears to be running on port 4242.');
    console.log('  Stop it first with `npx auramaxx stop` for clean restore.');
    console.log('  Proceeding anyway...\n');
  }

  // Pre-restore safety backup
  const preRestoreName = await createPreRestoreBackup();
  if (preRestoreName) {
    console.log(`  Pre-restore backup: ${preRestoreName}`);
  }

  // Restore DB
  const dbPath = getDbPath();
  const tempPath = dbPath + '.restore-tmp';
  await copyFile(backupPath, tempPath);
  await rename(tempPath, dbPath);
  console.log('  ✓ Database restored');

  // Restore credentials
  const restoredCreds = await restoreCredentials(backupsDir, timestamp);
  console.log(`  ✓ Credentials restored: ${restoredCreds} file(s)`);

  // Run migrations
  console.log('  Running schema migrations...');
  let migrationsApplied: number;
  try {
    migrationsApplied = await runMigrations();
  } catch {
    if (preRestoreName) {
      console.error(`\n  Reverting to pre-restore backup: ${preRestoreName}`);
      const revertTemp = dbPath + '.revert-tmp';
      await copyFile(join(backupsDir, preRestoreName), revertTemp);
      await rename(revertTemp, dbPath);
      console.error('  ✓ Reverted to pre-restore state.');
    }
    process.exit(1);
  }
  console.log(`  ✓ Migrations applied: ${migrationsApplied}`);

  // Final integrity check
  console.log('  Verifying restored database...');
  if (!verifyIntegrity(dbPath)) {
    console.error('  ✗ Restored DB FAILED integrity check!');
    console.error(`  Safety backup available: ${preRestoreName}`);
    process.exit(1);
  }
  console.log('  ✓ Restored database integrity OK');

  // Clean up old pre-restore backups (keep last 3)
  const allBackupFiles = await readdir(backupsDir);
  const preRestoreFiles = allBackupFiles
    .filter(f => f.startsWith('pre-restore.') && f.endsWith('.bak'))
    .sort()
    .reverse();
  if (preRestoreFiles.length > 3) {
    for (let i = 3; i < preRestoreFiles.length; i++) {
      await unlink(join(backupsDir, preRestoreFiles[i]));
    }
    console.log(`  ✓ Cleaned up ${preRestoreFiles.length - 3} old pre-restore backup(s)`);
  }

  console.log(`\n  ✅ Restore complete!\n`);
}

main().catch((err) => {
  console.error('Restore failed:', err.message || err);
  process.exit(1);
});
