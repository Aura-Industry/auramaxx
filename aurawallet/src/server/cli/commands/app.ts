/**
 * auramaxx app — Manage installed apps
 *
 * Usage:
 *   npx auramaxx app install <source> [--name <id>] [--force]
 *   npx auramaxx app remove <id> [--yes]
 *   npx auramaxx app list
 *   npx auramaxx app update <id>
 */

import {
  installApp,
  removeApp,
  listApps,
  updateApp,
} from '../../lib/app-installer';
import { promptConfirm } from '../lib/prompt';
import { getErrorMessage } from '../../lib/error';

const args = process.argv.slice(2);

function getFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function getFlagValue(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function showHelp() {
  console.log(`
  auramaxx app — Manage installed apps

  Usage:
    npx auramaxx app install <source> [--name <id>] [--force]
    npx auramaxx app remove <id> [--yes]
    npx auramaxx app list
    npx auramaxx app update <id>

  Sources:
    Local path       ./path/to/app or /absolute/path
    Git repo         github.com/user/repo
    Tarball          https://example.com/app.tar.gz
    Zip              https://example.com/app.zip
    Subdirectory     github.com/user/repo#path=apps/my-app

  Options:
    --name <id>      Override the app folder name
    --force          Overwrite existing app with same ID
    --yes            Skip removal confirmation

  Examples:
    npx auramaxx app install github.com/user/my-app
    npx auramaxx app install ./my-local-app --name custom-id
    npx auramaxx app list
    npx auramaxx app remove my-app
    npx auramaxx app update my-app
`);
}

async function main() {
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    showHelp();
    process.exit(0);
  }

  switch (subcommand) {
    case 'install': {
      const source = args[1];
      if (!source || source.startsWith('--')) {
        console.error('  Error: Missing source argument\n');
        console.error('  Usage: npx auramaxx app install <source> [--name <id>] [--force]');
        process.exit(1);
      }

      const name = getFlagValue('name');
      const force = getFlag('force');

      console.log(`\n  Installing app from: ${source}`);
      if (name) console.log(`  App ID: ${name}`);
      if (force) console.log(`  Force: overwrite existing`);
      console.log('');

      try {
        const result = installApp(source, { name, force });
        console.log(`  ┌─────────────────────────────────────────┐`);
        console.log(`  │ App installed successfully            │`);
        console.log(`  ├─────────────────────────────────────────┤`);
        console.log(`  │ ID:     ${result.id.padEnd(32)}│`);
        console.log(`  │ Name:   ${result.name.padEnd(32)}│`);
        console.log(`  │ Source: ${result.source.type.padEnd(32)}│`);
        console.log(`  │ Path:   apps/${result.id.padEnd(23)}│`);
        console.log(`  └─────────────────────────────────────────┘`);
        console.log('');
        console.log('  App will appear in the App Store under INSTALLED.');
        console.log('  Restart the server or use the dashboard to load it.\n');
      } catch (err) {
        const msg = getErrorMessage(err);
        console.error(`  Error: ${msg}\n`);
        process.exit(1);
      }
      break;
    }

    case 'remove': {
      const id = args[1];
      if (!id || id.startsWith('--')) {
        console.error('  Error: Missing app ID\n');
        console.error('  Usage: npx auramaxx app remove <id> [--yes]');
        process.exit(1);
      }

      const skipConfirm = getFlag('yes');

      if (!skipConfirm) {
        const confirmed = await promptConfirm(`  Remove app "${id}"?`);
        if (!confirmed) {
          console.log('  Cancelled.\n');
          process.exit(0);
        }
      }

      try {
        removeApp(id);
        console.log(`\n  App "${id}" removed.\n`);
        console.log('  Note: App token will be revoked on next server restart.\n');
      } catch (err) {
        const msg = getErrorMessage(err);
        console.error(`  Error: ${msg}\n`);
        process.exit(1);
      }
      break;
    }

    case 'list': {
      const apps = listApps();

      if (apps.length === 0) {
        console.log('\n  No apps installed.\n');
        console.log('  Install a app:');
        console.log('    npx auramaxx app install <source>\n');
        process.exit(0);
      }

      console.log(`\n  Installed Apps (${apps.length})\n`);

      for (const w of apps) {
        const sourceLabel = w.source
          ? `${w.source.type} — ${w.source.url}`
          : 'local (no .source.json)';
        const perms = w.permissions.length > 0
          ? w.permissions.join(', ')
          : 'none';

        console.log(`  ┌ ${w.name} (${w.id})`);
        console.log(`  │ ${w.description || '(no description)'}`);
        console.log(`  │ Permissions: ${perms}`);
        console.log(`  │ Source: ${sourceLabel}`);
        if (w.source?.installedAt) {
          console.log(`  │ Installed: ${w.source.installedAt}`);
        }
        console.log(`  └──`);
        console.log('');
      }
      break;
    }

    case 'update': {
      const id = args[1];
      if (!id || id.startsWith('--')) {
        console.error('  Error: Missing app ID\n');
        console.error('  Usage: npx auramaxx app update <id>');
        process.exit(1);
      }

      console.log(`\n  Updating app "${id}"...\n`);

      try {
        const result = updateApp(id);
        console.log(`  App "${result.id}" updated from ${result.source.type} source.`);
        console.log(`  Restart the server to load changes.\n`);
      } catch (err) {
        const msg = getErrorMessage(err);
        console.error(`  Error: ${msg}\n`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`  Unknown subcommand: ${subcommand}\n`);
      showHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error:', getErrorMessage(error));
  process.exit(1);
});
