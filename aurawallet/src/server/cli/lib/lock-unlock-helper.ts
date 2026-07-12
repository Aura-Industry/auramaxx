import { spawnSync } from 'child_process';
import { promptSelect } from './prompt';
import { getErrorMessage } from '../../lib/error';

export interface LockUnlockHelperInput {
  context: string;
  error?: unknown;
  statusCode?: number;
  payload?: unknown;
}

function dashboardUrl(): string {
  const port = process.env.DASHBOARD_PORT || '4747';
  return `http://localhost:${port}`;
}

function unlockCommand(): string {
  const flavor = String(process.env.AURA_CLI_FLAVOR || '').trim().toLowerCase();
  return flavor === 'aurawallet' || flavor === 'wallet' ? 'aurawallet unlock' : 'auramaxx unlock';
}

function toSearchableText(input: LockUnlockHelperInput): string {
  const parts: string[] = [];
  if (input.error) parts.push(getErrorMessage(input.error));
  if (typeof input.payload === 'string') parts.push(input.payload);
  if (input.payload && typeof input.payload === 'object') {
    try {
      parts.push(JSON.stringify(input.payload));
    } catch {
      // ignore
    }
  }
  return parts.join(' ').toLowerCase();
}

function isLikelyLockError(input: LockUnlockHelperInput): boolean {
  if (input.statusCode === 423) return true;
  const text = toSearchableText(input);
  const hasLockWord = text.includes('locked') || text.includes('unlock');
  const hasAgentContext = text.includes('agent') || text.includes('wallet') || text.includes('daemon');
  return hasLockWord && hasAgentContext;
}

function printSharedGuidance(context: string): void {
  console.error(`\nAgent is locked (${context}).`);
  console.error(`1) Unlock in dashboard: ${dashboardUrl()}`);
  console.error(`2) Unlock in terminal now (hidden password): ${unlockCommand()}`);
}

export async function maybeHandleLockError(input: LockUnlockHelperInput): Promise<boolean> {
  if (!isLikelyLockError(input)) return false;

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  printSharedGuidance(input.context);

  if (!interactive) {
    console.error(`Non-interactive shell detected; run \`${unlockCommand()}\` and retry.`);
    return true;
  }

  const choice = await promptSelect('Choose unlock path:', [
    { value: 'dashboard', label: 'dashboard', aliases: ['1', 'open'] },
    { value: 'terminal', label: 'terminal (unlock now)', aliases: ['2', 'cli'] },
  ], 'terminal');

  if (choice === 'terminal') {
    const useAurawallet = unlockCommand() === 'aurawallet unlock';
    const result = spawnSync('npx', [useAurawallet ? 'aurawallet' : 'auramaxx', 'unlock'], { stdio: 'inherit', env: process.env });
    if (result.status !== 0) {
      console.error('Terminal unlock did not complete successfully.');
    }
  } else {
    console.error(`Open ${dashboardUrl()} and unlock, then retry your command.`);
  }

  return true;
}
