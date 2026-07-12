#!/usr/bin/env node
/**
 * Aura Wallet CLI - Headless mode for programmatic wallet control
 *
 * Security Design:
 * - Admin token stored in-process memory only (never touches disk)
 * - Main wallet server hosts Unix socket IPC for local agent connections
 * - Crash = re-auth required (aligns with server restart security model)
 *
 * Usage:
 *   npx tsx server/cli/index.ts                    # Interactive password prompt
 *   npx tsx server/cli/index.ts --password-stdin   # Read password from stdin (CI/automation)
 *   npx tsx server/cli/index.ts --auto-approve     # Auto-approve all requests (DANGEROUS)
 */

import * as readline from 'readline';
import * as path from 'path';
import * as os from 'os';
import { encryptPassword, generateAgentKeypair } from './transport-client';
import { ApprovalManager } from './approval';
import * as fs from 'fs';
import { getErrorMessage } from '../lib/error';
import { printBanner, printBox, printStatus } from './lib/theme';
import { resolveAuraSocketPath } from '../lib/socket-path';
import { promptPassword } from './lib/prompt';

const SERVER_URL = process.env.WALLET_SERVER_URL || 'http://localhost:4242';
const LOCK_FILE = path.join(
  process.platform === 'win32' ? os.tmpdir() : '/tmp',
  `aura-cli-${process.getuid?.() ?? 'unknown'}.lock`,
);

// In-process memory only - never persisted
let adminToken: string | null = null;
let coldWalletAddress: string | null = null;

// Parse command line arguments
const args = process.argv.slice(2);
const passwordStdin = args.includes('--password-stdin');
const autoApprove = args.includes('--auto-approve');

/**
 * Check if another CLI instance is running
 */
function checkLockFile(): boolean {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
      // Check if process is still running
      try {
        process.kill(pid, 0); // Signal 0 tests if process exists
        return true; // Process exists, lock is valid
      } catch {
        // Process doesn't exist, stale lock file
        fs.unlinkSync(LOCK_FILE);
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Create lock file with our PID
 */
function createLockFile(): void {
  fs.writeFileSync(LOCK_FILE, process.pid.toString(), { mode: 0o600 });
}

/**
 * Remove lock file on exit
 */
function removeLockFile(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
      if (pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Fetch the server's RSA public key for password encryption
 */
async function fetchPublicKey(): Promise<string> {
  const response = await fetch(`${SERVER_URL}/auth/connect`);
  if (!response.ok) {
    throw new Error(`Failed to connect to wallet server: ${response.status}`);
  }
  const data = await response.json() as { publicKey: string };
  return data.publicKey;
}

/**
 * Unlock the wallet with encrypted password
 */
async function unlockWallet(encryptedPassword: string, pubkey: string): Promise<{ token: string; address: string }> {
  const response = await fetch(`${SERVER_URL}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted: encryptedPassword, pubkey })
  });

  const data = await response.json() as { success?: boolean; token?: string; address?: string; error?: string };

  if (!response.ok || !data.success) {
    throw new Error(data.error || 'Failed to unlock wallet');
  }

  return { token: data.token!, address: data.address! };
}

/**
 * Read password from stdin (for automation)
 */
async function readPasswordFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      const password = data.trim();
      if (!password) {
        reject(new Error('No password provided on stdin'));
      } else {
        resolve(password);
      }
    });
    process.stdin.on('error', reject);

    // Set a timeout for stdin read
    setTimeout(() => {
      if (!data) {
        reject(new Error('Timeout waiting for password on stdin'));
      }
    }, 5000);
  });
}

/**
 * Get the admin token (for use by other modules)
 */
export function getAdminToken(): string | null {
  return adminToken;
}

/**
 * Get the cold wallet address
 */
export function getColdWalletAddress(): string | null {
  return coldWalletAddress;
}

/**
 * Get the server URL
 */
export function getServerUrl(): string {
  return SERVER_URL;
}

/**
 * Main entry point
 */
async function main() {
  printBanner('CLI MODE');

  // Check for existing instance
  if (checkLockFile()) {
    console.error('ERROR: Another CLI instance is already running.');
    console.error('If this is incorrect, remove the lock file:', LOCK_FILE);
    process.exit(1);
  }

  // Auto-approve warning
  if (autoApprove) {
    console.log('⚠️  WARNING: --auto-approve is enabled!');
    console.log('   All agent requests will be automatically approved.');
    console.log('   This is DANGEROUS in production environments.\n');
  }

  try {
    // 1. Fetch server's public key
    console.log('Connecting to wallet server...');
    const publicKey = await fetchPublicKey();
    console.log('Connected. Server RSA key received.\n');

    // 2. Get password
    let password: string;
    if (passwordStdin) {
      console.log('Reading password from stdin...');
      password = await readPasswordFromStdin();
    } else {
      password = await promptPassword();
    }

    // 3. Encrypt and unlock
    console.log('Unlocking wallet...');
    const encryptedPassword = encryptPassword(password, publicKey);
    const { publicKey: agentPubkey } = generateAgentKeypair();
    const { token, address } = await unlockWallet(encryptedPassword, agentPubkey);

    // Clear password from memory
    password = '';

    // Store token in memory only
    adminToken = token;
    coldWalletAddress = address;

    console.log(`\n✓ Wallet unlocked successfully`);
    console.log(`  Address: ${address}`);
    console.log('  Token: [HIDDEN]');

    // Create lock file
    createLockFile();

    // 4. Start approval manager (WebSocket listener)
    console.log('\nStarting approval listener...');
    const approvalManager = new ApprovalManager({
      serverUrl: SERVER_URL,
      getToken: () => adminToken,
      autoApprove,
      headless: passwordStdin // Skip terminal interface when using stdin
    });
    await approvalManager.start();

    // 5. Socket broker now runs in the main wallet server process.
    const socketPath = resolveAuraSocketPath({
      serverUrl: SERVER_URL,
      serverPort: process.env.WALLET_SERVER_PORT,
    });

    console.log('');
    printBox([
      'CLI Ready — Listening for agent requests',
      '',
      `Socket: ${socketPath}`,
      'Press Ctrl+C to exit',
    ]);

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log('\n\nShutting down...');
      approvalManager.stop();
      removeLockFile();

      // Clear sensitive data
      adminToken = null;
      coldWalletAddress = null;

      console.log('Goodbye.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('exit', removeLockFile);

    // Keep process alive
    await new Promise(() => {
      // Never resolves - keeps CLI running
    });

  } catch (error) {
    const message = getErrorMessage(error);
    console.error(`\nERROR: ${message}`);
    removeLockFile();
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  removeLockFile();
  process.exit(1);
});
