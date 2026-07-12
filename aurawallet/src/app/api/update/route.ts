import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { buildUpdateCommand, buildUpdateForceCommand } from '@/server/lib/update-check';
import { clearVersionCheckCache } from '@/server/lib/version-check-cache';

type UpdateLock = {
  requestId: string;
  startedAt: number;
  pid: number | null;
  status: 'launching' | 'running';
};

const UPDATE_LOCK_TTL_MS = 30 * 60 * 1000;
function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readUpdateLock(lockPath: string): UpdateLock | null {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UpdateLock>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.requestId !== 'string' || parsed.requestId.length === 0) return null;
    if (typeof parsed.startedAt !== 'number' || !Number.isFinite(parsed.startedAt)) return null;
    const status = parsed.status === 'running' ? 'running' : 'launching';
    const pid = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : null;
    return {
      requestId: parsed.requestId,
      startedAt: parsed.startedAt,
      pid,
      status,
    };
  } catch {
    return null;
  }
}

function writeUpdateLock(lockPath: string, lock: UpdateLock): void {
  writeFileSync(lockPath, `${JSON.stringify(lock)}\n`, 'utf8');
}

function releaseUpdateLockIfOwned(lockPath: string, requestId: string): void {
  try {
    const existing = readUpdateLock(lockPath);
    if (!existing || existing.requestId !== requestId) return;
    unlinkSync(lockPath);
  } catch {
    // Best-effort cleanup only.
  }
}

function acquireUpdateLock(lockPath: string): { acquired: true; lock: UpdateLock } | { acquired: false; existing: UpdateLock | null } {
  const now = Date.now();
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nextLock: UpdateLock = {
      requestId: randomUUID(),
      startedAt: now,
      pid: null,
      status: 'launching',
    };

    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, `${JSON.stringify(nextLock)}\n`, 'utf8');
      } finally {
        closeSync(fd);
      }
      return { acquired: true, lock: nextLock };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw error;
      }

      const existing = readUpdateLock(lockPath);
      const ageMs = existing ? now - existing.startedAt : Number.POSITIVE_INFINITY;
      const active = !!existing && ageMs < UPDATE_LOCK_TTL_MS && (existing.pid === null || isProcessAlive(existing.pid));
      if (active) {
        return { acquired: false, existing };
      }

      try {
        unlinkSync(lockPath);
      } catch {
        // Ignore unlink races; next attempt will re-check.
      }
    }
  }

  return { acquired: false, existing: readUpdateLock(lockPath) };
}

export async function POST() {
  let lockPath = '';
  let lockRequestId = '';
  try {
    const primaryCommand = buildUpdateCommand();
    const forceCommand = buildUpdateForceCommand();
    const projectRoot = process.cwd();

    const logDir = join(homedir(), '.auramaxx', 'logs');
    const logPath = join(logDir, 'update-workflow.log');
    mkdirSync(logDir, { recursive: true });
    lockPath = join(logDir, 'update-workflow.lock.json');

    const acquired = acquireUpdateLock(lockPath);
    if (!acquired.acquired) {
      return NextResponse.json({
        success: false,
        inProgress: true,
        deferred: true,
        error: 'Update already in progress. Wait for it to finish, then retry.',
        lock: acquired.existing,
      }, { status: 409 });
    }
    lockRequestId = acquired.lock.requestId;

    // Detached worker allows update install to continue even if the request lifecycle ends.
    const workerScript = `
const { execSync } = require('child_process');
const fs = require('fs');
const logPath = process.env.AURA_UPDATE_LOG;
const primaryCommand = process.env.AURA_UPDATE_PRIMARY;
const forceCommand = process.env.AURA_UPDATE_FORCE;
const lockPath = process.env.AURA_UPDATE_LOCK;
const lockRequestId = process.env.AURA_UPDATE_LOCK_REQUEST_ID;

function now() {
  return new Date().toISOString();
}

function append(line) {
  try {
    fs.appendFileSync(logPath, line + '\\n');
  } catch {
    // Ignore logging failures; keep workflow running.
  }
}

function clearOwnLock() {
  if (!lockPath || !lockRequestId) return;
  try {
    if (!fs.existsSync(lockPath)) return;
    const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (current && current.requestId === lockRequestId) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Best-effort cleanup only.
  }
}

process.on('exit', clearOwnLock);
process.on('SIGTERM', () => {
  clearOwnLock();
  process.exit(1);
});
process.on('SIGINT', () => {
  clearOwnLock();
  process.exit(1);
});

function run(command, { allowFailure = false } = {}) {
  append(\`[\${now()}] $ \${command}\`);
  try {
    const out = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (out && out.trim()) append(out.trim());
    append(\`[\${now()}] ok\`);
    return true;
  } catch (error) {
    const stdout = error && error.stdout ? String(error.stdout).trim() : '';
    const stderr = error && error.stderr ? String(error.stderr).trim() : '';
    const status = error && typeof error.status !== 'undefined' ? String(error.status) : 'unknown';
    if (stdout) append(stdout);
    if (stderr) append(stderr);
    append(\`[\${now()}] fail (code=\${status})\`);
    if (allowFailure) return false;
    throw error;
  }
}

async function main() {
  append(\`[\${now()}] update workflow started\`);

  if (run(primaryCommand, { allowFailure: true })) {
    append(\`[\${now()}] update workflow completed (primary install, manual restart required)\`);
    return 0;
  }

  append(\`[\${now()}] primary install failed; retrying forced install\`);
  if (run(forceCommand, { allowFailure: true })) {
    append(\`[\${now()}] update workflow completed (forced install, manual restart required)\`);
    return 0;
  }

  append(\`[\${now()}] update workflow failed after primary + forced install attempts\`);
  return 1;
}

main()
  .then((code) => {
    clearOwnLock();
    process.exit(code);
  })
  .catch((error) => {
    append(\`[\${now()}] unhandled error: \${error && error.message ? error.message : String(error)}\`);
    clearOwnLock();
    process.exit(1);
  });
`;

    const worker = spawn(process.execPath, ['-e', workerScript], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AURA_UPDATE_LOG: logPath,
        AURA_UPDATE_PRIMARY: primaryCommand,
        AURA_UPDATE_FORCE: forceCommand,
        AURA_UPDATE_LOCK: lockPath,
        AURA_UPDATE_LOCK_REQUEST_ID: lockRequestId,
      },
      detached: true,
      stdio: 'ignore',
    });
    if (!worker.pid) {
      releaseUpdateLockIfOwned(lockPath, lockRequestId);
      throw new Error('Failed to start update worker process.');
    }
    writeUpdateLock(lockPath, {
      requestId: lockRequestId,
      startedAt: acquired.lock.startedAt,
      pid: worker.pid,
      status: 'running',
    });
    worker.unref();

    clearVersionCheckCache();
    return NextResponse.json({
      success: true,
      inProgress: true,
      deferred: true,
      message: 'Update install started in background. Restart manually after it finishes.',
      output: `Installing in background (no auto-restart). Log: ${logPath}`,
      logPath,
      pid: worker.pid,
    });
  } catch (err) {
    if (lockPath && lockRequestId) {
      releaseUpdateLockIfOwned(lockPath, lockRequestId);
    }
    return NextResponse.json(
      { success: false, error: (err as Error).message || 'Failed to run update' },
      { status: 500 },
    );
  }
}
