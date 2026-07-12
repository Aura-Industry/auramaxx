/**
 * auramaxx init — First-time setup
 *
 * 1. Create directories + run migrations + generate Prisma client
 * 2. Bootstrap runtime (service-first by default, manual headless fallback)
 * 3. If agent exists → ensure dashboard, print "Already initialized", keep running
 * 4. Prompt: Dashboard or Terminal?
 *   a. Dashboard → start dashboard + open browser + poll until agent created
 *   b. Terminal  → interactive agent creation + optional config
 * 5. Print cold wallet address + funding guidance
 * 6. Keep servers running
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec, spawn, ChildProcess } from 'child_process';
import { fetchSetupStatus, fetchPublicKey, fetchJson, waitForServer, SetupStatus } from '../lib/http';
import { startServer, stopServer, findProjectRoot, startDashboardProcess } from '../lib/process';
import { ensureDirectories, runMigrations, generatePrismaClient } from '../lib/init-steps';
import { promptPassword, promptInput, promptConfirm, promptSelect } from '../lib/prompt';
import { encryptPassword, generateAgentKeypair } from '../transport-client';
import { getErrorMessage } from '../../lib/error';
import { printBanner, printSection, printSeedPhrase } from '../lib/theme';
import { migrateDotenv } from '../lib/dotenv-migrate';
import { parseAuraFile } from '../lib/aura-parser';
import { bootstrapViaSocket, generateEphemeralKeypair } from '../../lib/credential-transport';
import { createCredentialViaApi, getPrimaryAgentId } from '../lib/credential-create';
import { resolveLocalAgentModeChoice, persistLocalAgentTrustDefaults } from '../lib/local-agent-trust';
import {
  installService,
  isServiceInstalled,
  isServiceRunning,
  loadServiceIfNeeded,
  SERVICE_BOOTSTRAP_ENV,
} from './service';

let serverChildren: ChildProcess[] = [];
let runtimeMode: 'manual' | 'service' = 'manual';

// SIGINT handler — if launchd is managing the servers, just detach cleanly.
// Otherwise kill server processes.
function cleanup() {
  if (serverChildren.length > 0) {
    if (isServiceInstalled()) {
      // Service is registered — load it so servers keep running after we exit.
      loadServiceIfNeeded();
      console.log('\n\nServers will continue running in the background.');
      console.log('Use `auramaxx stop` to stop.');
    } else {
      console.log('\n\nShutting down...');
      stopServer();
    }
    serverChildren = [];
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

export type BrowserOpenInvocation =
  | { kind: 'spawn'; command: string; args: string[] }
  | { kind: 'exec'; command: string };

export function getBrowserOpenInvocation(url: string, platform: NodeJS.Platform = process.platform): BrowserOpenInvocation {
  if (platform === 'win32') {
    // `start` requires an empty title arg before the target URL.
    return { kind: 'spawn', command: 'cmd', args: ['/d', '/s', '/c', 'start', '', url] };
  }
  if (platform === 'darwin') {
    return { kind: 'exec', command: `open "${url}"` };
  }
  return { kind: 'exec', command: `xdg-open "${url}"` };
}

function openBrowser(url: string) {
  const invocation = getBrowserOpenInvocation(url);
  const onFailure = () => {
    // Don't fail — just tell the user to open manually
    console.log('  Could not open browser automatically.');
    console.log(`  Open this URL manually: ${url}\n`);
  };

  if (invocation.kind === 'spawn') {
    const child = spawn(invocation.command, invocation.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', onFailure);
    child.unref();
    return;
  }

  exec(invocation.command, (err) => {
    if (err) onFailure();
  });
}

const DASHBOARD_PORT = process.env.DASHBOARD_PORT || '4747';
const DASHBOARD_READY_TIMEOUT_MS = 30_000;
const DASHBOARD_POLL_MS = 1_000;

function startDashboard(debug = false, dev = false): ChildProcess {
  return startDashboardProcess({
    dashboardPort: DASHBOARD_PORT,
    env: { ...process.env, BYPASS_RATE_LIMIT: 'true' },
    debug,
    detached: true,
    dev,
  });
}

async function isDashboardReachable(): Promise<boolean> {
  const dashboardUrl = `http://localhost:${DASHBOARD_PORT}`;
  try {
    const res = await fetch(dashboardUrl, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDashboardReady(timeoutMs = DASHBOARD_READY_TIMEOUT_MS): Promise<boolean> {
  const dashboardUrl = `http://localhost:${DASHBOARD_PORT}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(dashboardUrl);
      if (res.ok) return true;
    } catch {
      // Not ready yet.
    }
    await new Promise((r) => setTimeout(r, DASHBOARD_POLL_MS));
  }
  return false;
}

async function ensureDashboardRunning(debug = false, dev = false): Promise<void> {
  if (await isDashboardReachable()) return;
  const dashboard = startDashboard(debug, dev);
  serverChildren.push(dashboard);
}

function shouldReportBackgroundService(): boolean {
  // Sandbox mode is intentionally foreground and cleaned up by scripts/sandbox.sh.
  if (process.env.SANDBOX_MODE === 'true') return false;
  return isServiceInstalled();
}

// ─── Mode selection ──────────────────────────────────────────────

async function promptSetupMode(): Promise<'dashboard' | 'terminal'> {
  printSection('Setup Mode', 'Choose how you would like to set up your agent.');

  const mode = await promptSelect(
    '  How would you like to set up your agent?',
    [
      { value: 'dashboard', label: 'dashboard', aliases: ['1', 'browser'] },
      { value: 'terminal', label: 'terminal', aliases: ['2', 'cli'] },
    ],
    'dashboard',
  );
  return mode as 'dashboard' | 'terminal';
}

// ─── Dashboard flow ──────────────────────────────────────────────

async function dashboardFlow(debug = false, dev = false, background = false) {
  printSection('Dashboard Setup', 'Browser-guided agent onboarding.');
  await ensureDashboardRunning(debug, dev);

  const dashboardUrl = `http://localhost:${DASHBOARD_PORT}`;
  console.log('  Waiting for dashboard to start...');

  // Wait for dashboard to be reachable before opening browser.
  const ready = await waitForDashboardReady();
  if (!ready) {
    console.log('  Dashboard is still starting; opening browser anyway...');
  }

  console.log('  Opening dashboard in browser...');
  openBrowser(dashboardUrl);
  console.log(`  Create your agent at ${dashboardUrl}\n`);
  console.log('  Waiting for agent creation...');

  // Poll until agent is created
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const check = await fetchSetupStatus();
      if (check.hasWallet) {
        console.log('');
        console.log('  Agent created!\n');
        // Agent is ready — activate the launchd service so servers survive Ctrl+C
        loadServiceIfNeeded();
        printBanner('TIME TO AURAMAXX');
        // Password-manager focus for now: hide wallet funding guidance in onboarding output.
        // console.log(`  Your cold wallet address: ${check.address}`);
        // console.log('  Send ETH on Base to this address to fund your wallet.\n');
        console.log(`  Dashboard ready at ${dashboardUrl}`);
        if (background || shouldReportBackgroundService()) {
          console.log('  Servers are running in the background. Use `auramaxx stop` to stop.\n');
        } else {
          console.log('  Servers are running. Press Ctrl+C to stop.\n');
        }
        break;
      }
    } catch {
      // Server might be briefly unavailable, keep polling
    }
  }
}

// ─── Terminal flow ───────────────────────────────────────────────

async function terminalFlow(background = false): Promise<string> {
  // Step 1: Password
  printSection('Terminal Setup', 'Local interactive agent onboarding.');
  const password = await promptPasswordWithConfirmation();

  // Step 2: Create agent
  console.log('\n  Creating agent...');
  const publicKey = await fetchPublicKey();
  const encrypted = encryptPassword(password, publicKey);
  const { publicKey: agentPubkey } = generateAgentKeypair();

  const agent = await fetchJson<{
    success: boolean;
    address: string;
    mnemonic: string;
    token: string;
  }>('/setup', { body: { encrypted, pubkey: agentPubkey } });

  console.log('  Agent created!\n');

  // Step 3: Display seed phrase
  printSeedPhrase(agent.mnemonic);

  let confirmed = await promptConfirm('  Have you saved your seed phrase?');
  while (!confirmed) {
    console.log('\n  Please save the phrase above, then confirm to continue.');
    confirmed = await promptConfirm('  Have you saved your seed phrase?');
  }

  const token = agent.token;

  await configureLocalSocketTrust(token);

  // Optional configuration is intentionally disabled for now.
  /*
    ── Optional Configuration ──

    Press Enter to skip any step.

    Anthropic API key (sk-ant-...):
    Alchemy API key:
    Telegram bot token:
  */
  // await configureApiKey(token, 'anthropic', 'Anthropic API key', 'sk-ant-...');
  // await configureApiKey(token, 'alchemy', 'Alchemy API key', '');
  // await configureTelegram(token);

  // Step 4: Summary
  loadServiceIfNeeded();
  printBanner('TIME TO AURAMAXX');
  // Password-manager focus for now: hide wallet funding/config summary in onboarding.
  // console.log(`  Cold wallet address: ${agent.address}`);
  // console.log('  Send ETH on Base to this address to fund your wallet.\n');
  // const status = await fetchSetupStatus();
  // printConfigSummary(status);

  if (background || shouldReportBackgroundService()) {
    console.log('  Servers are running in the background. Use `auramaxx stop` to stop.\n');
  } else {
    console.log('  Servers are running. Press Ctrl+C to stop.\n');
  }
  return token;
}

async function promptPasswordWithConfirmation(): Promise<string> {
  while (true) {
    const password = await promptPassword('  Enter agent password');
    if (password.length < 8) {
      console.log('  Password must be at least 8 characters. Try again.\n');
      continue;
    }

    const confirm = await promptPassword('  Confirm password');
    if (password !== confirm) {
      console.log('  Passwords do not match. Try again.\n');
      continue;
    }

    return password;
  }
}

async function readPasswordFromStdin(timeoutMs = 15_000): Promise<string> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let data = '';
    process.stdin.setEncoding('utf8');

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error('Timed out waiting for password on stdin')));
    }, timeoutMs);

    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      const password = data.trim();
      finish(() => {
        if (!password) {
          reject(new Error('No password provided on stdin'));
        } else {
          resolve(password);
        }
      });
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      finish(() => reject(err));
    });
  });
}

async function configureLocalSocketTrust(token: string): Promise<void> {
  printSection('Local Agent Trust', 'How much do you trust your agent?');

  const profile = resolveLocalAgentModeChoice(
    await promptSelect(
      '  How much do you trust your agent?',
      [
        { value: 'admin', label: 'maxx (admin)', aliases: ['1', 'default', 'maxx', 'work'] },
        { value: 'dev', label: 'mid (dev)', aliases: ['2', 'mid', 'dev', 'recommended'] },
        { value: 'strict', label: 'sus (local)', aliases: ['3', 'sus', 'local', 'strict'] },
      ],
      'admin',
    ),
  );
  await persistLocalAgentTrustDefaults(token, profile);

  if (profile === 'strict') {
    console.log('  ✓ Sus mode enabled. Local auto-approve is OFF; agent requests require manual approval.\n');
    return;
  }
  if (profile === 'admin') {
    console.log('  ✓ Maxx mode enabled. WARNING: local agents get broad access.\n');
    return;
  }
  console.log('  ✓ Mid mode enabled. Local auto-approve remains ON with scoped profile.\n');
}

async function configureApiKey(
  token: string,
  service: string,
  label: string,
  placeholder: string,
): Promise<boolean> {
  const prompt = placeholder ? `  ${label} (${placeholder})` : `  ${label}`;
  const key = await promptInput(prompt);

  if (!key) return false;

  // Validate
  try {
    const result = await fetchJson<{ valid?: boolean; error?: string }>(
      '/apikeys/validate',
      { body: { service, key }, token },
    );

    if (result.valid) {
      console.log(`  ✓ Valid\n`);
    } else {
      console.log(`  ✗ Invalid: ${result.error || 'unknown error'}`);
      const retry = await promptConfirm('  Try again?');
      if (retry) return configureApiKey(token, service, label, placeholder);
      const saveAnyway = await promptConfirm('  Save anyway?');
      if (!saveAnyway) {
        console.log('  Skipped.\n');
        return false;
      }
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    console.log(`  ⚠ Could not validate: ${msg}`);
    const saveAnyway = await promptConfirm('  Save anyway?');
    if (!saveAnyway) {
      console.log('  Skipped.\n');
      return false;
    }
  }

  // Save
  await fetchJson('/apikeys', {
    body: { service, name: 'default', key },
    token,
  });
  console.log(`  Saved.\n`);
  return true;
}

async function configureTelegram(token: string): Promise<boolean> {
  const botToken = await promptInput('  Telegram bot token');
  if (!botToken) return false;

  // Validate bot token
  try {
    const result = await fetchJson<{ valid?: boolean; error?: string; info?: { botUsername?: string } }>(
      '/apikeys/validate',
      { body: { service: 'adapter:telegram', key: botToken }, token },
    );

    if (result.valid) {
      const username = result.info?.botUsername || 'unknown';
      console.log(`  ✓ Bot: @${username}\n`);
    } else {
      console.log(`  ✗ Invalid bot token: ${result.error || 'unknown error'}`);
      const retry = await promptConfirm('  Try again?');
      if (retry) return configureTelegram(token);
      console.log('  Skipped.\n');
      return false;
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    console.log(`  ⚠ Could not validate bot token: ${msg}`);
    const skip = await promptConfirm('  Skip Telegram setup?');
    if (skip) {
      console.log('  Skipped.\n');
      return false;
    }
  }

  // Auto-detect chat ID via deep link
  let chatId = '';
  try {
    const linkResult = await fetchJson<{ success?: boolean; link?: string; setupToken?: string; botUsername?: string; error?: string }>(
      '/adapters/telegram/setup-link',
      { body: { botToken }, token },
    );

    if (linkResult.success && linkResult.link && linkResult.setupToken) {
      console.log(`  Open this link and press Start: ${linkResult.link}\n`);
      process.stdout.write('  Waiting for /start...');

      // Poll detect-chat (up to 2 attempts ~50s)
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const detectResult = await fetchJson<{ chatId?: string | null; firstName?: string; username?: string; verified?: boolean; timeout?: boolean }>(
            '/adapters/telegram/detect-chat',
            { body: { setupToken: linkResult.setupToken }, token },
          );

          if (detectResult.chatId) {
            chatId = detectResult.chatId;
            const name = detectResult.username ? `@${detectResult.username}` : detectResult.firstName || '';
            console.log('');
            console.log(`  ✓ Detected chat ID: ${chatId}${name ? ` (${name})` : ''}\n`);
            break;
          }
          // timeout — try again
        } catch {
          break;
        }
      }

      if (!chatId) {
        console.log(' timed out.');
      }
    }
  } catch {
    // setup-link failed, fall through to manual
  }

  // Fall back to manual input if auto-detection didn't work
  if (!chatId) {
    chatId = await promptInput('  Telegram chat ID');
    if (!chatId) {
      console.log('  Skipped (no chat ID).\n');
      return false;
    }
  }

  // Save bot token
  await fetchJson('/apikeys', {
    body: { service: 'adapter:telegram', name: 'botToken', key: botToken },
    token,
  });

  // Save adapter config
  await fetchJson('/adapters', {
    body: { type: 'telegram', enabled: true, config: { chatId } },
    token,
  });

  // Restart adapters
  try {
    await fetchJson('/adapters/restart', { method: 'POST', token });
  } catch {
    // Non-fatal
  }

  // Test
  try {
    const testResult = await fetchJson<{ success?: boolean; error?: string }>(
      '/adapters/test',
      { body: { type: 'telegram' }, token },
    );
    if (testResult.success) {
      console.log('  ✓ Test message sent to Telegram.\n');
    } else {
      console.log(`  ⚠ Test failed: ${testResult.error || 'unknown'}. Telegram saved but may need configuration.\n`);
    }
  } catch {
    console.log('  ⚠ Could not send test message. Telegram saved but may need configuration.\n');
  }

  return true;
}

function printConfigSummary(status: SetupStatus) {
  const check = (val: boolean | undefined) => val ? '✓' : '–';
  console.log('  Configuration:');
  console.log(`    Agent:     ✓`);
  console.log(`    Anthropic: ${check(status.apiKeys?.anthropic)}`);
  console.log(`    Alchemy:   ${check(status.apiKeys?.alchemy)}`);
  console.log(`    Telegram:  ${check(status.adapters?.telegram)}`);
  console.log('');
}

function maybeInstallShellHook(): void {
  if (!process.stdout.isTTY || process.env.CI === 'true') {
    return;
  }

  const shell = path.basename(process.env.SHELL || 'bash');
  let rcFile: string;
  let hookCmd: string;

  switch (shell) {
    case 'zsh':
      rcFile = path.join(os.homedir(), '.zshrc');
      hookCmd = 'eval "$(aura shell-hook zsh)"';
      break;
    case 'bash':
      rcFile = path.join(os.homedir(), '.bashrc');
      hookCmd = 'eval "$(aura shell-hook bash)"';
      break;
    default:
      return;
  }

  try {
    if (fs.existsSync(rcFile)) {
      const content = fs.readFileSync(rcFile, 'utf-8');
      if (content.includes('aura shell-hook')) {
        return;
      }
    }

    fs.appendFileSync(rcFile, `\n# Aura shell hook — auto-load .aura env vars\n${hookCmd}\n`);
    console.log(`  ✓ Installed shell hook in ${rcFile}`);
    console.log(`  Restart your shell or run: source ${rcFile}\n`);
  } catch {
    // Non-fatal: init should succeed even if shell hook install fails.
  }
}

// ─── Post-setup: detect .aura file and offer credential entry ───

async function postSetupAuraDetection(): Promise<void> {
  const auraPath = path.join(process.cwd(), '.aura');
  if (!fs.existsSync(auraPath)) return;

  let mappings;
  try {
    mappings = parseAuraFile(auraPath);
  } catch {
    return; // Invalid .aura file, skip
  }

  if (mappings.length === 0) return;

  console.log(`\n  Found .aura file with ${mappings.length} credential(s) needed:\n`);
  for (const m of mappings) {
    const ref = m.agent ? `@${m.agent}/${m.credentialName}/${m.field}` : `${m.credentialName}/${m.field}`;
    console.log(`    ${m.envVar} → ${ref}`);
  }
  console.log('');

  const answer = await promptInput('  Ask your team for access, or enter values manually? (team/manual) [team]');
  const choice = answer?.trim().toLowerCase() || 'team';

  if (choice === 'manual') {
    // Get auth token via socket
    const kp = generateEphemeralKeypair();
    const token = await bootstrapViaSocket('cli-init', kp);
    const agentId = await getPrimaryAgentId(token);

    // Group by credential name
    const byCredential = new Map<string, typeof mappings>();
    for (const m of mappings) {
      const list = byCredential.get(m.credentialName) || [];
      list.push(m);
      byCredential.set(m.credentialName, list);
    }

    for (const [credName, fields] of byCredential) {
      const fieldValues: Array<{ key: string; value: string }> = [];

      for (const m of fields) {
        const value = await promptInput(`  Enter value for ${m.envVar} (→ ${credName}/${m.field})`);
        if (value) {
          fieldValues.push({ key: m.field, value });
        } else {
          console.log(`  Skipped ${m.envVar}`);
        }
      }

      if (fieldValues.length > 0) {
        const result = await createCredentialViaApi({
          token,
          agentId,
          name: credName,
          fields: fieldValues,
        });
        if (result.success) {
          console.log(`  ✓ Created credential: ${credName}`);
        } else {
          console.error(`  ✗ Failed to create ${credName}: ${result.error}`);
        }
      }
    }
    console.log('');
  } else {
    console.log('  Ask your team admin to share these credentials.');
    console.log('  Once they\'re in your agent, run: aura env -- <your-command>\n');
  }
}

// ─── Post-setup: --from-dotenv migration ────────────────────────

async function resolveDotenvMigrationToken(existingToken?: string): Promise<string> {
  if (existingToken) return existingToken;

  const envToken = process.env.AURA_TOKEN?.trim();
  if (envToken) return envToken;

  const kp = generateEphemeralKeypair();
  try {
    return await bootstrapViaSocket('cli-init', kp);
  } catch (socketErr) {
    if (!process.stdin.isTTY) {
      throw new Error(
        `${getErrorMessage(socketErr)}\n` +
        'Set AURA_TOKEN or run `aura unlock` in another terminal, then retry `aura init --from-dotenv`.',
      );
    }

    console.log('  Socket auth unavailable. Unlocking agent to continue .env migration...');
    const password = await promptPassword('  Agent password');
    const publicKey = await fetchPublicKey();
    const encrypted = encryptPassword(password, publicKey);
    const { publicKey: agentPubkey } = generateAgentKeypair();
    const unlock = await fetchJson<{ token: string }>('/unlock', {
      body: { encrypted, pubkey: agentPubkey },
    });
    return unlock.token;
  }
}

async function postSetupDotenvMigration(existingToken?: string): Promise<void> {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf('--from');
  const fromPath = fromIdx >= 0 && fromIdx + 1 < args.length ? args[fromIdx + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  const noGroup = args.includes('--no-group');

  const envPath = fromPath || path.join(process.cwd(), '.env');

  const token = await resolveDotenvMigrationToken(existingToken);

  await migrateDotenv({
    token,
    envPath,
    noGroup,
    dryRun,
  });
}

// ─── Headless password flow ─────────────────────────────────────

async function passwordFlow(password: string, background = false): Promise<string> {
  if (password.length < 8) {
    console.log('  Error: Password must be at least 8 characters.');
    process.exit(1);
  }

  console.log('  Creating agent...');
  const publicKey = await fetchPublicKey();
  const encrypted = encryptPassword(password, publicKey);
  const { publicKey: agentPubkey } = generateAgentKeypair();

  const agent = await fetchJson<{
    success: boolean;
    address: string;
    mnemonic: string;
    token: string;
  }>('/setup', { body: { encrypted, pubkey: agentPubkey } });

  console.log('  Agent created!\n');

  printSeedPhrase(agent.mnemonic);
  loadServiceIfNeeded();

  printBanner('TIME TO AURAMAXX');
  console.log(`  Cold wallet address: ${agent.address}`);
  console.log('  Admin token: [HIDDEN]\n');
  console.log('  IMPORTANT: Save the seed phrase above. It cannot be recovered.\n');
  if (background || shouldReportBackgroundService()) {
    console.log('  Servers are running in the background. Use `auramaxx stop` to stop.\n');
  } else {
    console.log('  Servers are running. Press Ctrl+C to stop.\n');
  }
  return agent.token;
}

export interface InitRuntimeBootstrapOptions {
  debugMode: boolean;
  devMode: boolean;
  backgroundAfterSetup: boolean;
}

export async function bootstrapInitRuntime(options: InitRuntimeBootstrapOptions): Promise<'manual' | 'service'> {
  const prefersServiceStart = !options.devMode
    && !options.debugMode
    && !options.backgroundAfterSetup
    && process.env[SERVICE_BOOTSTRAP_ENV] !== '1';
  const serviceStartWaitMs = Math.max(1_000, Number(process.env.AURA_SERVICE_START_WAIT_MS || '30000'));

  if (prefersServiceStart) {
    let serviceInstalled = isServiceInstalled();
    let installedThisRun = false;

    if (!serviceInstalled) {
      const install = installService({ activate: false });
      if (install.installed && !install.error) {
        serviceInstalled = true;
        installedThisRun = true;
      } else {
        const reason = install.error || 'unknown install failure';
        console.warn(`Background service install failed (${reason}); falling back to direct start.`);
      }
    }

    if (serviceInstalled) {
      const running = isServiceRunning();
      const launched = loadServiceIfNeeded();

      if (!running && !launched) {
        if (installedThisRun) {
          console.warn('Background service launch failed after install; falling back to direct start.');
        } else {
          throw new Error('Background service is installed but failed to launch. Run `auramaxx service status` and check service logs.');
        }
      } else {
        try {
          await waitForServer(serviceStartWaitMs);
          return 'service';
        } catch {
          if (installedThisRun) {
            console.warn('Background service did not become ready in time; falling back to direct start.');
          } else {
            throw new Error(
              `Background service did not become ready within ${Math.ceil(serviceStartWaitMs / 1000)}s.\n`
              + 'Run `auramaxx service status` and inspect service logs.',
            );
          }
        }
      }
    }
  }

  // Manual fallback/direct mode: keep existing init behavior (headless API first, dashboard later).
  if (options.debugMode) console.log('  Starting...');
  stopServer();
  serverChildren = startServer({
    headless: true,
    debug: options.debugMode,
    background: options.backgroundAfterSetup,
    startCron: false,
  });

  try {
    await waitForServer(15000);
    if (options.debugMode) console.log('  Starting... complete\n');
  } catch {
    stopServer();
    throw new Error(
      `Server failed to start within 15 seconds.\n`
      + `Check for port conflicts on :${process.env.WALLET_SERVER_PORT || '4242'}`,
    );
  }

  return 'manual';
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  printBanner('AURAMAXX.SH BOOTING');

  const root = findProjectRoot();
  const args = process.argv.slice(2);
  const debugMode = process.argv.includes('--debug');
  const fromDotenv = args.includes('--from-dotenv');
  const devMode = args.includes('--dev');
  const backgroundAfterSetup = args.includes('--background') || args.includes('--daemon') || args.includes('-d');

  // Keep boot output concise before runtime startup.
  ensureDirectories();

  // Step 1: Migrations
  try {
    runMigrations(root);
    if (debugMode) console.log('  Migrating... complete');
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`  Migration failed: ${msg}`);
    console.error('  Try running: npx prisma migrate deploy');
    process.exit(1);
  }

  // Step 2: Prisma client
  try {
    generatePrismaClient(root);
    if (debugMode) console.log('  Database... complete');
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`  Prisma generate failed: ${msg}`);
    process.exit(1);
  }

  // Step 3: Bootstrap runtime (service-first by default, manual fallback on first-install failure).
  runtimeMode = await bootstrapInitRuntime({
    debugMode,
    devMode,
    backgroundAfterSetup,
  });

  // Step 5: Check if agent already exists
  const status = await fetchSetupStatus();

  let setupToken: string | undefined;

  if (status.hasWallet) {
    if (fromDotenv) {
      printSection('Existing Agent', 'Agent already initialized. Running dotenv migration.');
      // Agent exists, just do the dotenv migration
      console.log('  Agent already exists. Running .env migration...\n');
      await postSetupDotenvMigration();
    } else {
      printSection('Already Initialized', 'Agent already exists. Starting dashboard.');
      await ensureDashboardRunning(debugMode, devMode);

      console.log('  Agent already exists — already initialized.\n');
      console.log(`  Cold wallet: ${status.address}`);
      console.log(`  Dashboard:   http://localhost:${DASHBOARD_PORT}\n`);

      // TODO(v2): .env-to-agent migration
      // const envPath = path.join(process.cwd(), '.env');
      // if (fs.existsSync(envPath)) {
      //   console.log('  💡 Found .env file. Run `aura init --from-dotenv` to migrate secrets to the agent.\n');
      // }
    }

    if (fromDotenv) {
      await postSetupAuraDetection();
    }

    maybeInstallShellHook();
    // Activate launchd service if plist was written during bootstrap
    loadServiceIfNeeded();
    if (backgroundAfterSetup || shouldReportBackgroundService()) {
      console.log('  Servers are running in the background.');
      console.log('  Use `auramaxx stop` to stop.\n');
      return;
    }
    console.log('  Servers are running. Press Ctrl+C to stop.\n');
    // Keep event loop alive (detached children don't keep it running)
    setInterval(() => {}, 60_000);
    return;
  }

  // Step 6: Choose setup mode
  const dashboardFlag = args.includes('--dashboard');
  const passwordStdin = args.includes('--password-stdin');
  const passwordIdx = args.indexOf('--password');
  if (passwordIdx >= 0) {
    throw new Error('`--password` is disabled for security. Use `--password-stdin`.');
  }
  const passwordValue = passwordStdin ? await readPasswordFromStdin() : undefined;

  if (passwordValue) {
    if (fromDotenv) {
      setupToken = await passwordFlow(passwordValue, backgroundAfterSetup);
    } else {
      await passwordFlow(passwordValue, backgroundAfterSetup);
    }
  } else if (dashboardFlag) {
    await dashboardFlow(debugMode, devMode, backgroundAfterSetup);
  } else {
    const mode = await promptSetupMode();
    if (mode === 'dashboard') {
      await dashboardFlow(debugMode, devMode, backgroundAfterSetup);
    } else {
      if (fromDotenv) {
        setupToken = await terminalFlow(backgroundAfterSetup);
      } else {
        await terminalFlow(backgroundAfterSetup);
      }
    }
  }

  // Step 7: Post-setup — handle --from-dotenv or detect .aura
  if (fromDotenv) {
    try {
      await postSetupDotenvMigration(setupToken);
    } finally {
      setupToken = undefined;
    }
  } else {
    // Suggest --from-dotenv if .env exists but no .aura
    // TODO(v2): .env-to-agent migration
    // const envPath = path.join(process.cwd(), '.env');
    // const auraPath = path.join(process.cwd(), '.aura');
    // if (fs.existsSync(envPath) && !fs.existsSync(auraPath)) {
    //   console.log('  💡 Found .env file. Run `aura init --from-dotenv` to migrate secrets to the agent.\n');
    // }

    // Detect .aura file and offer credential entry
    await postSetupAuraDetection();
  }

  maybeInstallShellHook();
  if (backgroundAfterSetup) {
    console.log('  Aura services are running in background mode.');
    console.log('  Use `npx auramaxx status` to check health and `npx auramaxx stop` to stop.\n');
    return;
  }
  // Keep event loop alive (detached children don't keep it running)
  setInterval(() => {}, 60_000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('\nError:', getErrorMessage(error));
    if (runtimeMode === 'manual') {
      stopServer();
    }
    process.exit(1);
  });
}
