/**
 * npx auramaxx experimental — toggle dev feature flags
 *
 * Usage:
 *   npx auramaxx experimental                     List all flags
 *   npx auramaxx experimental <FLAG> <on|off>      Toggle a flag
 */

import { readFlags, writeFlag, getKnownFlagNames, ensureDefaults } from '../../lib/feature-flags';

function usage() {
  console.log('Usage: npx auramaxx experimental [FLAG] [on|off]');
  console.log('');
  console.log('  No args     List all feature flags and current values');
  console.log('  FLAG on     Enable a feature flag');
  console.log('  FLAG off    Disable a feature flag');
  console.log('');
  console.log(`Known flags: ${getKnownFlagNames().join(', ')}`);
}

function listFlags() {
  const flags = readFlags();
  console.log('Feature flags:');
  for (const [name, value] of Object.entries(flags)) {
    console.log(`  ${name}: ${value ? 'on' : 'off'}`);
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  // Ensure config file exists
  ensureDefaults();

  if (args.length === 0) {
    listFlags();
    process.exit(0);
  }

  if (args.length === 1) {
    console.error(`Missing value. Usage: npx auramaxx experimental ${args[0]} <on|off>`);
    process.exit(1);
  }

  const flagName = args[0];
  const rawValue = args[1].toLowerCase();

  if (rawValue !== 'on' && rawValue !== 'off') {
    console.error(`Invalid value "${args[1]}". Use "on" or "off".`);
    process.exit(1);
  }

  const value = rawValue === 'on';
  const result = writeFlag(flagName, value);

  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }

  console.log(`${flagName}: ${value ? 'on' : 'off'}`);
}

main();
