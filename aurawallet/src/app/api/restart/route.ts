import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const RESTART_DELAY_MS = 1250;

export async function POST() {
  try {
    const projectRoot = process.cwd();
    const cliEntrypoint = join(projectRoot, 'bin', 'auramaxx.js');
    const logDir = join(homedir(), '.auramaxx', 'logs');
    const logPath = join(logDir, 'restart-workflow.log');
    const requestId = randomUUID();
    mkdirSync(logDir, { recursive: true });

    // Detached worker allows this request to return before restart tears down runtime services.
    const workerScript = `
const { execFileSync } = require('child_process');
const fs = require('fs');
const delayMs = Number(process.env.AURA_RESTART_DELAY_MS || '0');
const cliEntrypoint = process.env.AURA_RESTART_ENTRYPOINT;
const projectRoot = process.env.AURA_RESTART_CWD;
const logPath = process.env.AURA_RESTART_LOG;
const requestId = process.env.AURA_RESTART_REQUEST_ID || 'unknown';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  append(\`[\${now()}] restart workflow started request=\${requestId}\`);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    append(\`[\${now()}] delaying restart by \${Math.floor(delayMs)}ms to allow HTTP response flush\`);
    await sleep(Math.floor(delayMs));
  }

  try {
    execFileSync(process.execPath, [cliEntrypoint, 'restart'], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    append(\`[\${now()}] restart workflow completed\`);
    process.exit(0);
  } catch (error) {
    const stdout = error && error.stdout ? String(error.stdout).trim() : '';
    const stderr = error && error.stderr ? String(error.stderr).trim() : '';
    const status = error && typeof error.status !== 'undefined' ? String(error.status) : 'unknown';
    if (stdout) append(stdout);
    if (stderr) append(stderr);
    append(\`[\${now()}] restart workflow failed (code=\${status})\`);
    process.exit(1);
  }
}

main().catch((error) => {
  append(\`[\${now()}] restart worker unhandled error: \${error && error.message ? error.message : String(error)}\`);
  process.exit(1);
});
`;

    const child = spawn(process.execPath, ['-e', workerScript], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AURA_RESTART_ENTRYPOINT: cliEntrypoint,
        AURA_RESTART_CWD: projectRoot,
        AURA_RESTART_LOG: logPath,
        AURA_RESTART_REQUEST_ID: requestId,
        AURA_RESTART_DELAY_MS: String(RESTART_DELAY_MS),
      },
      detached: true,
      stdio: 'ignore',
    });
    if (!child.pid) {
      throw new Error('Failed to start restart worker process.');
    }
    child.unref();

    return NextResponse.json({
      success: true,
      deferred: true,
      message: 'Restart requested in background.',
      output: `Running in background. Log: ${logPath}`,
      logPath,
      requestId,
      pid: child.pid,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message || 'Failed to restart AuraMaxx' },
      { status: 500 },
    );
  }
}
