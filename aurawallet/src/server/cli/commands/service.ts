/**
 * auramaxx service — Manage background service (install, uninstall, status)
 */

import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findProjectRoot } from '../lib/process';
import { printBanner, printStatus, printHelp } from '../lib/theme';

const PLIST_LABEL = 'com.auramaxx.server';
const PLIST_FILENAME = `${PLIST_LABEL}.plist`;
const SYSTEMD_UNIT = 'auramaxx.service';
const WINDOWS_STARTUP_FILENAME = 'auramaxx-startup.cmd';

export const SERVICE_BOOTSTRAP_ENV = 'AURA_SERVICE_BOOTSTRAP';

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', PLIST_FILENAME);
}

function systemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

function windowsStartupScriptPath(): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', WINDOWS_STARTUP_FILENAME);
}

function logsDir(): string {
  const dataDir = process.env.WALLET_DATA_DIR || path.join(os.homedir(), '.auramaxx');
  return path.join(dataDir, 'logs');
}

function darwinLaunchctlTarget(): string {
  const uid = process.getuid?.();
  return uid == null ? PLIST_LABEL : `gui/${uid}/${PLIST_LABEL}`;
}

function ensureLogsDir(): void {
  fs.mkdirSync(logsDir(), { recursive: true });
}

function isWindowsPortListening(port: string): boolean {
  try {
    const output = execSync('netstat -ano -p tcp', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split(/\r?\n/).some((rawLine) => {
      const line = rawLine.trim();
      if (!line || !line.startsWith('TCP')) return false;
      const cols = line.split(/\s+/);
      if (cols.length < 4) return false;
      const localAddress = cols[1] || '';
      const state = (cols[3] || '').toUpperCase();
      return state === 'LISTENING' && localAddress.endsWith(`:${port}`);
    });
  } catch {
    return false;
  }
}

function startWindowsBackgroundService(root: string, entrypoint: string): boolean {
  try {
    const child = spawn(process.execPath, [entrypoint, 'start', '--background'], {
      cwd: root,
      env: { ...process.env, [SERVICE_BOOTSTRAP_ENV]: '1' },
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the OS background registration exists on disk.
 */
export function isServiceInstalled(): boolean {
  if (process.platform === 'darwin') {
    return fs.existsSync(plistPath());
  }
  if (process.platform === 'linux') {
    return fs.existsSync(systemdUnitPath());
  }
  if (process.platform === 'win32') {
    return fs.existsSync(windowsStartupScriptPath());
  }
  return false;
}

/**
 * Check if the service is currently loaded/active.
 */
export function isServiceRunning(): boolean {
  try {
    if (process.platform === 'darwin') {
      const out = execSync(`launchctl print ${darwinLaunchctlTarget()}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const lastExitMatch = out.match(/^\s*last exit code = (\d+)\s*$/m);
      if (lastExitMatch) {
        return Number(lastExitMatch[1]) === 0;
      }
      return out.includes(`state = running`);
    }
    if (process.platform === 'linux') {
      execSync(`systemctl --user is-active ${SYSTEMD_UNIT}`, { stdio: 'ignore' });
      return true;
    }
    if (process.platform === 'win32') {
      const port = process.env.WALLET_SERVER_PORT || '4242';
      return isWindowsPortListening(port);
    }
  } catch {
    // Not loaded / not active
  }
  return false;
}

/**
 * Install the background service (launchd on macOS, systemd on Linux, Startup folder on Windows).
 * @param activate - If true, load/enable the service immediately. If false, just write the file
 *                   (activates on next login/reboot). Default: true.
 */
export function installService(opts: { activate?: boolean } = {}): { installed: boolean; error?: string } {
  const activate = opts.activate !== false;
  const root = findProjectRoot();
  const nodePath = process.execPath;
  const nodeDir = path.dirname(nodePath);
  const entrypoint = path.join(root, 'bin', 'auramaxx.js');

  ensureLogsDir();

  if (process.platform === 'win32') {
    const dest = windowsStartupScriptPath();
    const startupScript = [
      '@echo off',
      'setlocal',
      `cd /d "${root}"`,
      `"${nodePath}" "${entrypoint}" start --background >> "${path.join(logsDir(), 'startup-stdout.log')}" 2>> "${path.join(logsDir(), 'startup-stderr.log')}"`,
      '',
    ].join('\r\n');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, startupScript, 'utf8');

    if (activate && !startWindowsBackgroundService(root, entrypoint)) {
      return { installed: true, error: 'Startup script written but immediate start failed' };
    }
    return { installed: true };
  }

  if (process.platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entrypoint}</string>
    <string>start</string>
    <string>--background</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>${root}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${nodeDir}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${path.join(logsDir(), 'launchd-stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logsDir(), 'launchd-stderr.log')}</string>
</dict>
</plist>
`;

    const dest = plistPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, plist);

    if (activate) {
      try {
        execSync(`launchctl load -w "${dest}"`, { stdio: 'ignore' });
      } catch {
        return { installed: true, error: 'Plist written but launchctl load failed' };
      }
    }

    return { installed: true };
  }

  if (process.platform === 'linux') {
    const unit = `[Unit]
Description=AuraMaxx Wallet Server
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${entrypoint} start --background
WorkingDirectory=${root}
Environment=PATH=${nodeDir}:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5
StandardOutput=append:${path.join(logsDir(), 'launchd-stdout.log')}
StandardError=append:${path.join(logsDir(), 'launchd-stderr.log')}

[Install]
WantedBy=default.target
`;

    const dest = systemdUnitPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, unit);

    if (activate) {
      try {
        execSync(`systemctl --user enable --now ${SYSTEMD_UNIT}`, { stdio: 'ignore' });
      } catch {
        return { installed: true, error: 'Unit written but systemctl enable failed' };
      }
    } else {
      try {
        execSync(`systemctl --user enable ${SYSTEMD_UNIT}`, { stdio: 'ignore' });
      } catch {
        // enable without --now just registers for next boot
      }
    }

    return { installed: true };
  }

  return { installed: false, error: `Unsupported platform: ${process.platform}` };
}

/**
 * Load the service if the plist/unit exists but isn't currently loaded.
 * No-op if already loaded or if the file doesn't exist.
 */
export function loadServiceIfNeeded(): boolean {
  if (!isServiceInstalled()) return false;

  try {
    if (process.platform === 'darwin') {
      try {
        execSync(`launchctl kickstart -k ${darwinLaunchctlTarget()}`, { stdio: 'ignore' });
      } catch {
        execSync(`launchctl load -w "${plistPath()}"`, { stdio: 'ignore' });
      }
      return true;
    }

    if (isServiceRunning()) return false;

    if (process.platform === 'win32') {
      const root = findProjectRoot();
      const entrypoint = path.join(root, 'bin', 'auramaxx.js');
      return startWindowsBackgroundService(root, entrypoint);
    }
    if (process.platform === 'linux') {
      execSync(`systemctl --user start ${SYSTEMD_UNIT}`, { stdio: 'ignore' });
      return true;
    }
  } catch {
    // Load failed — caller should fall through to manual start
  }
  return false;
}

/**
 * Stop service processes without unregistering the service.
 * Service will auto-start again on next login.
 */
export function stopServiceProcesses(): void {
  try {
    if (process.platform === 'darwin') {
      execSync(`launchctl unload "${plistPath()}"`, { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      execSync(`systemctl --user stop ${SYSTEMD_UNIT}`, { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      // Startup-folder registration only controls login-time launch.
      // Runtime stop is handled by stopServer() in process.ts.
    }
  } catch {
    // Service might not be loaded — that's fine
  }
}

/**
 * Fully uninstall the service (stop + remove registration + delete file).
 */
export function uninstallService(): void {
  if (process.platform === 'darwin') {
    const dest = plistPath();
    try {
      execSync(`launchctl unload -w "${dest}"`, { stdio: 'ignore' });
    } catch {
      // Already unloaded
    }
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    } catch {
      // Ignore
    }
  } else if (process.platform === 'linux') {
    const dest = systemdUnitPath();
    try {
      execSync(`systemctl --user disable --now ${SYSTEMD_UNIT}`, { stdio: 'ignore' });
    } catch {
      // Already disabled
    }
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    } catch {
      // Ignore
    }
  } else if (process.platform === 'win32') {
    const dest = windowsStartupScriptPath();
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    } catch {
      // Ignore
    }
  }
}

/**
 * Print service status info.
 */
export function serviceStatus(): void {
  const installed = isServiceInstalled();
  const running = isServiceRunning();

  printBanner('SERVICE');
  printStatus('Installed', installed ? 'yes' : 'no', installed);
  printStatus('Running', running ? 'yes' : 'no', running);

  if (process.platform === 'darwin') {
    printStatus('Plist', installed ? plistPath() : 'not installed');
  } else if (process.platform === 'linux') {
    printStatus('Unit', installed ? systemdUnitPath() : 'not installed');
  } else if (process.platform === 'win32') {
    printStatus('Startup Script', installed ? windowsStartupScriptPath() : 'not installed');
  } else {
    printStatus('Platform', `${process.platform} (not supported)`);
  }

  printStatus('Logs', logsDir());
  console.log('');

  if (!installed) {
    console.log('  To install: auramaxx service install');
  } else if (!running) {
    console.log('  To start: auramaxx start');
  }
  console.log('');
}

// --- CLI entry ---

function showHelp(): void {
  printHelp('SERVICE', 'npx auramaxx service <command>', [
    { name: 'install', desc: 'Install background service (auto-start on login)' },
    { name: 'uninstall', desc: 'Remove background service' },
    { name: 'status', desc: 'Show service install + running state' },
  ]);
}

function main(): void {
  const subcmd = process.argv.find((a, i) => i >= 2 && !a.startsWith('-')) || '';

  if (process.argv.includes('--help') || process.argv.includes('-h') || !subcmd) {
    showHelp();
    return;
  }

  switch (subcmd) {
    case 'install': {
      const activate = !process.argv.includes('--no-activate');
      const result = installService({ activate });
      if (result.installed) {
        console.log('Background service installed.');
        if (result.error) console.log(`  Warning: ${result.error}`);
        console.log('  AuraMaxx will auto-start on login.');
      } else {
        console.error(`Failed to install service: ${result.error}`);
        process.exit(1);
      }
      break;
    }
    case 'uninstall': {
      uninstallService();
      console.log('Background service removed. AuraMaxx will not auto-start on login.');
      break;
    }
    case 'status': {
      serviceStatus();
      break;
    }
    default: {
      console.error(`Unknown service command: ${subcmd}`);
      showHelp();
      process.exit(1);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
