#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const { version } = require('../package.json');

const HELP = `AuraOS — open-source software suite for your agents

Apps:
  wallet    available — aura wallet --help
  chess     coming soon
  launcher  coming soon
  registry  coming soon
  pm        coming soon`;

const COMING_SOON_APPS = new Set(['chess', 'launcher', 'registry', 'pm']);

function printHelp(stream = process.stdout) {
  stream.write(`${HELP}\n`);
}

function runWallet(args) {
  const walletEntry = path.join(__dirname, 'aurawallet.js');
  const child = spawn(process.execPath, [walletEntry, ...args], {
    detached: true,
    stdio: 'inherit',
    windowsHide: true,
  });

  const forwardSignal = (signal) => {
    if (child.killed) {
      return;
    }

    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error;
        }
      }
    } else {
      child.kill(signal);
    }
  };

  const handleSigint = () => forwardSignal('SIGINT');
  const handleSigterm = () => forwardSignal('SIGTERM');
  const cleanup = () => {
    process.removeListener('SIGINT', handleSigint);
    process.removeListener('SIGTERM', handleSigterm);
  };

  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);

  child.once('error', (error) => {
    cleanup();
    process.stderr.write(`Unable to start AuraWallet: ${error.message}\n`);
    process.exitCode = 1;
  });

  child.once('exit', (code, signal) => {
    cleanup();

    if (code !== null) {
      process.exitCode = code;
      return;
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exitCode = 1;
  });
}

const args = process.argv.slice(2);
const app = args[0];

if (!app || app === 'help' || app === '--help') {
  printHelp();
} else if (app === '--version' || app === '-v') {
  process.stdout.write(`${version}\n`);
} else if (app === 'wallet') {
  runWallet(args.slice(1));
} else if (COMING_SOON_APPS.has(app)) {
  process.stderr.write(`${app} is coming soon to AuraOS.\n`);
  process.exitCode = 1;
} else {
  process.stderr.write(`Unknown app: ${app}\n`);
  printHelp(process.stderr);
  process.exitCode = 1;
}
