import { Router, Request, Response } from 'express';
import { requireWalletAuth } from '../middleware/auth';
import { requireAdmin } from '../lib/permissions';
import { readdir, stat, copyFile, unlink, rename } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, createReadStream } from 'fs';
import { DATA_PATHS, getDbPath, getBackupsDir } from '../lib/config';
import { logger } from '../lib/logger';
import Database from 'better-sqlite3';

const router = Router();

export { getBackupsDir } from '../lib/config';

export function ensureBackupsDir(): void {
  const dir = getBackupsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Run WAL checkpoint to flush all data to the main DB file.
 */
function walCheckpoint(dbPath: string): void {
  const db = new Database(dbPath, { readonly: false });
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

/**
 * Verify SQLite database integrity. Returns true if valid.
 */
export function verifyIntegrity(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const result = db.pragma('integrity_check') as { integrity_check: string }[];
    return result.length === 1 && result[0].integrity_check === 'ok';
  } finally {
    db.close();
  }
}

interface BackupInfo {
  filename: string;
  timestamp: string;
  size: number;
  date: string;
}

/**
 * GET /backup - List all backups
 * Requires: admin permission
 */
router.get('/', requireWalletAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const backupsDir = getBackupsDir();
    ensureBackupsDir();
    const files = await readdir(backupsDir);
    const backups: BackupInfo[] = [];

    for (const file of files) {
      if (file.startsWith('auramaxx.db.') && file.endsWith('.bak')) {
        const filePath = join(backupsDir, file);
        const fileStat = await stat(filePath);

        // Extract timestamp from filename: auramaxx.db.YYYYMMDD_HHMMSS.bak
        const match = file.match(/auramaxx\.db\.(\d{8}_\d{6})\.bak/);
        const timestamp = match ? match[1] : '';

        backups.push({
          filename: file,
          timestamp,
          size: fileStat.size,
          date: fileStat.mtime.toISOString(),
        });
      }
    }

    // Sort by date descending (newest first)
    backups.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.json({
      success: true,
      backups,
    });
  } catch (error) {
    console.error('[Backup] Failed to list backups:', error);
    res.status(500).json({ success: false, error: 'Failed to list backups' });
  }
});

/**
 * GET /backup/export - Download a fresh database snapshot
 * Requires: admin permission
 *
 * Creates a temporary snapshot (WAL checkpoint + atomic copy + integrity check),
 * streams it to the client as a file download, then removes the temp file.
 */
router.get('/export', requireWalletAuth, requireAdmin, async (_req: Request, res: Response) => {
  const dbFile = getDbPath();
  if (!existsSync(dbFile)) {
    res.status(404).json({ success: false, error: 'Database file not found' });
    return;
  }

  const backupsDir = getBackupsDir();
  ensureBackupsDir();

  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .slice(0, 15);

  const exportFilename = `auramaxx.db.${timestamp}.export`;
  const exportPath = join(backupsDir, exportFilename);

  try {
    // WAL checkpoint
    walCheckpoint(dbFile);

    // Atomic copy
    const tempPath = exportPath + '.tmp';
    await copyFile(dbFile, tempPath);
    await rename(tempPath, exportPath);

    // Integrity check
    if (!verifyIntegrity(exportPath)) {
      await unlink(exportPath).catch(() => {});
      res.status(500).json({ success: false, error: 'Export failed integrity check' });
      return;
    }

    const fileStat = await stat(exportPath);

    res.setHeader('Content-Type', 'application/x-sqlite3');
    res.setHeader('Content-Disposition', `attachment; filename="auramaxx-export-${timestamp}.db"`);
    res.setHeader('Content-Length', fileStat.size);

    const stream = createReadStream(exportPath);
    stream.pipe(res);
    stream.on('end', () => {
      unlink(exportPath).catch(() => {});
    });
    stream.on('error', () => {
      unlink(exportPath).catch(() => {});
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Export stream failed' });
      }
    });
  } catch (error) {
    await unlink(exportPath).catch(() => {});
    console.error('[Backup] Failed to export database:', error);
    res.status(500).json({ success: false, error: 'Failed to export database' });
  }
});

/**
 * POST /backup - Create a new backup
 * Requires: admin permission
 */
router.post('/', requireWalletAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const dbFile = getDbPath();
    const backupsDir = getBackupsDir();
    ensureBackupsDir();

    // Check if database exists
    if (!existsSync(dbFile)) {
      res.status(404).json({ success: false, error: 'Database file not found' });
      return;
    }

    // Generate timestamp
    const now = new Date();
    const timestamp = now.toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '_')
      .slice(0, 15);

    const backupFilename = `auramaxx.db.${timestamp}.bak`;
    const backupPath = join(backupsDir, backupFilename);
    let credentialsCopied = 0;

    // WAL checkpoint — flush all data to main DB file
    walCheckpoint(dbFile);

    // Atomic write: copy to temp file, then rename
    const tempPath = backupPath + '.tmp';
    await copyFile(dbFile, tempPath);
    await rename(tempPath, backupPath);

    // Verify backup integrity
    if (!verifyIntegrity(backupPath)) {
      await unlink(backupPath);
      res.status(500).json({ success: false, error: 'Backup failed integrity check' });
      return;
    }

    // Copy credential files alongside the DB backup.
    if (existsSync(DATA_PATHS.credentials)) {
      const credentialFiles = (await readdir(DATA_PATHS.credentials))
        .filter(file => file.startsWith('cred-') && file.endsWith('.json'));

      for (const file of credentialFiles) {
        await copyFile(
          join(DATA_PATHS.credentials, file),
          join(backupsDir, `credentials.${timestamp}.${file}`),
        );
      }
      credentialsCopied = credentialFiles.length;
    }

    // Clean up old backups (keep last 10)
    const files = await readdir(backupsDir);
    const backupFiles = files
      .filter(f => f.startsWith('auramaxx.db.') && f.endsWith('.bak'))
      .sort()
      .reverse();

    // Delete older backups beyond the 10th
    for (let i = 10; i < backupFiles.length; i++) {
      const oldBackup = backupFiles[i];
      await unlink(join(backupsDir, oldBackup));

      const match = oldBackup.match(/auramaxx\.db\.(\d{8}_\d{6})\.bak/);
      if (!match) continue;

      const oldTimestamp = match[1];
      const oldCredentialFiles = files.filter(f => f.startsWith(`credentials.${oldTimestamp}.cred-`) && f.endsWith('.json'));
      for (const oldCredentialFile of oldCredentialFiles) {
        await unlink(join(backupsDir, oldCredentialFile));
      }
    }

    const fileStat = await stat(backupPath);

    logger.backup(backupFilename);

    res.json({
      success: true,
      backup: {
        filename: backupFilename,
        timestamp,
        size: fileStat.size,
        date: fileStat.mtime.toISOString(),
        credentialsCopied,
      },
    });
  } catch (error) {
    console.error('[Backup] Failed to create backup:', error);
    res.status(500).json({ success: false, error: 'Failed to create backup' });
  }
});

/**
 * PUT /backup - Restore from a backup
 * Requires: admin permission
 *
 * Hardened to match CLI restore: atomic write, pre-restore backup,
 * integrity verification, schema migrations, and WAL cleanup.
 */
router.put('/', requireWalletAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { filename } = req.body;

    if (!filename) {
      res.status(400).json({ success: false, error: 'Filename is required' });
      return;
    }

    // Validate filename format to prevent path traversal
    if (!filename.match(/^auramaxx\.db\.\d{8}_\d{6}\.bak$/)) {
      res.status(400).json({ success: false, error: 'Invalid backup filename' });
      return;
    }

    const backupsDir = getBackupsDir();
    const backupPath = join(backupsDir, filename);

    if (!existsSync(backupPath)) {
      res.status(404).json({ success: false, error: 'Backup file not found' });
      return;
    }

    // Verify backup integrity before restoring
    if (!verifyIntegrity(backupPath)) {
      res.status(400).json({ success: false, error: 'Backup failed integrity check' });
      return;
    }

    const dbPath = getDbPath();

    // Create pre-restore safety backup
    let preRestoreName = '';
    if (existsSync(dbPath)) {
      const now = new Date();
      const ts = now.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
      preRestoreName = `pre-restore.${ts}.bak`;
      await copyFile(dbPath, join(backupsDir, preRestoreName));
    }

    // Atomic write: copy to temp, then rename
    const tempPath = dbPath + '.restore-tmp';
    await copyFile(backupPath, tempPath);
    await rename(tempPath, dbPath);

    // Run schema migrations
    try {
      const { execSync } = await import('child_process');
      execSync('npx prisma migrate deploy', {
        cwd: join(dirname(dbPath), '..'),
        env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (migrationError: any) {
      const errMsg = migrationError.stderr || migrationError.message || 'Unknown migration error';
      logger.error(`[Backup] Migration failed after restore: ${errMsg}`);
      // Restore the pre-restore backup since migration failed
      if (preRestoreName && existsSync(join(backupsDir, preRestoreName))) {
        const revertTemp = dbPath + '.revert-tmp';
        await copyFile(join(backupsDir, preRestoreName), revertTemp);
        await rename(revertTemp, dbPath);
      }
      res.status(500).json({
        success: false,
        error: `Restore aborted: schema migration failed. Pre-restore backup restored. Details: ${errMsg}`,
      });
      return;
    }

    // Verify restored DB integrity
    if (!verifyIntegrity(dbPath)) {
      logger.error('[Backup] Restored DB failed integrity check');
      // Revert to pre-restore backup
      if (preRestoreName && existsSync(join(backupsDir, preRestoreName))) {
        const revertTemp = dbPath + '.revert-tmp';
        await copyFile(join(backupsDir, preRestoreName), revertTemp);
        await rename(revertTemp, dbPath);
      }
      res.status(500).json({
        success: false,
        error: 'Restored database failed integrity check. Pre-restore backup restored.',
      });
      return;
    }

    // Restore credential files from matching timestamp, if present.
    const timestampMatch = filename.match(/auramaxx\.db\.(\d{8}_\d{6})\.bak$/);
    let credentialsRestored = 0;
    if (timestampMatch) {
      const timestamp = timestampMatch[1];
      const allBackupFiles = await readdir(backupsDir);
      const credentialBackups = allBackupFiles
        .filter(file => file.startsWith(`credentials.${timestamp}.cred-`) && file.endsWith('.json'));

      if (credentialBackups.length > 0) {
        if (!existsSync(DATA_PATHS.credentials)) {
          mkdirSync(DATA_PATHS.credentials, { recursive: true });
        }

        const existingCredentialFiles = await readdir(DATA_PATHS.credentials);
        for (const file of existingCredentialFiles) {
          if (file.startsWith('cred-') && file.endsWith('.json')) {
            await unlink(join(DATA_PATHS.credentials, file));
          }
        }

        for (const backupFile of credentialBackups) {
          const destName = backupFile.replace(`credentials.${timestamp}.`, '');
          await copyFile(join(backupsDir, backupFile), join(DATA_PATHS.credentials, destName));
        }
        credentialsRestored = credentialBackups.length;
      }
    }

    // Clean up old pre-restore backups (keep last 3)
    const allFiles = await readdir(backupsDir);
    const preRestoreFiles = allFiles
      .filter(f => f.startsWith('pre-restore.') && f.endsWith('.bak'))
      .sort()
      .reverse();
    for (let i = 3; i < preRestoreFiles.length; i++) {
      await unlink(join(backupsDir, preRestoreFiles[i]));
    }

    res.json({
      success: true,
      message: 'Database restored successfully',
      preRestoreBackup: preRestoreName,
      credentialsRestored,
    });
  } catch (error) {
    console.error('[Backup] Failed to restore backup:', error);
    res.status(500).json({ success: false, error: 'Failed to restore backup' });
  }
});

export default router;
