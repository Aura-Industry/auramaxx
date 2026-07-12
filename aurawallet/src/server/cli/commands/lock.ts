/**
 * auramaxx lock — Lock agents from CLI
 */

import { type ProfileIssuanceSelection } from '../../lib/credential-transport';
import { getErrorMessage } from '../../lib/error';
import { parseProfileSelectionInput, resolveCliBearerToken } from '../lib/auth-bootstrap';
import { printHelp } from '../lib/theme';
import { fetchJson } from '../lib/http';

function showHelp(): void {
  printHelp('LOCK', 'npx auramaxx lock [all|agent <agentId>] [options]', [
    { name: 'all', desc: 'Lock all agents and revoke active sessions (default)' },
    { name: 'agent <agentId>', desc: 'Lock a specific agent id' },
  ], [
    'Options:',
    '  --token <token>             Bearer token (default: AURA_TOKEN or socket fallback)',
    '  --profile <id>              /auth fallback profile when socket bootstrap is blocked',
    '  --profile-version <v>       /auth fallback profile version',
    '  --profile-overrides <json>  Tighten-only profile override JSON',
    '  --json                      JSON output',
    '',
    'Examples:',
    '  npx auramaxx lock',
    '  npx auramaxx lock all',
    '  npx auramaxx lock agent primary',
  ]);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function parseProfileSelection(args: string[]): ProfileIssuanceSelection {
  return parseProfileSelectionInput({
    profile: getFlagValue(args, '--profile'),
    profileVersion: getFlagValue(args, '--profile-version'),
    profileOverridesRaw: getFlagValue(args, '--profile-overrides'),
  });
}

async function resolveBearerToken(args: string[]): Promise<string> {
  return resolveCliBearerToken({
    explicitToken: getFlagValue(args, '--token') || process.env.AURA_TOKEN,
    agentId: 'cli-lock',
    rerunCommand: 'npx auramaxx lock ...',
    selection: parseProfileSelection(args),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0] || 'all';

  if (subcommand === '--help' || subcommand === '-h') {
    showHelp();
    process.exit(0);
  }

  try {
    const json = args.includes('--json');
    const token = await resolveBearerToken(args);

    let data: Record<string, unknown>;
    if (subcommand === 'all') {
      data = await fetchJson<Record<string, unknown>>('/lock', {
        method: 'POST',
        token,
        timeoutMs: 10_000,
      });
    } else if (subcommand === 'agent') {
      const agentId = args[1];
      if (!agentId) {
        throw new Error('Usage: npx auramaxx lock agent <agentId>');
      }
      data = await fetchJson<Record<string, unknown>>(`/lock/${encodeURIComponent(agentId)}`, {
        method: 'POST',
        token,
        timeoutMs: 10_000,
      });
    } else {
      // Default shorthand: `lock <agentId>` locks that agent; `lock` already handled above.
      data = await fetchJson<Record<string, unknown>>(`/lock/${encodeURIComponent(subcommand)}`, {
        method: 'POST',
        token,
        timeoutMs: 10_000,
      });
    }

    if (json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(String((data as { message?: unknown }).message || 'Lock request completed.'));
    }

    process.exit((data as { success?: unknown }).success === false ? 1 : 0);
  } catch (error) {
    console.error(`Lock command failed: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Lock command failed: ${getErrorMessage(error)}`);
    process.exit(1);
  });
}
