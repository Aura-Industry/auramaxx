import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { printBanner, printComplete, paint, ANSI } from '../lib/theme';
import { promptSelect } from '../lib/prompt';

const COMMAND_DIR = path.dirname(fileURLToPath(import.meta.url));
const CREATE_COMMAND_PATH = path.join(COMMAND_DIR, 'create.ts');

async function main() {
  printBanner();

  const choice = await promptSelect(
    '  Ready to auramaxx?',
    [{ value: 'yes', label: 'Yes', aliases: ['y', '1'] }],
    'yes',
  );

  if (choice !== 'yes') return;

  console.log('');
  console.log('  Installing auramaxx globally...');
  console.log('');

  try {
    execFileSync('npm', ['install', '-g', 'auramaxx'], {
      stdio: 'inherit',
      timeout: 120000,
    });
  } catch (error: unknown) {
    console.error('');
    console.error('  Failed to install globally. Try manually: npm install -g auramaxx');
    process.exit((error as { status?: number }).status || 1);
  }

  printComplete('auramaxx installed. Launching AuraJS create...');
  console.log(`    ${paint('auramaxx create my-game', ANSI.fgAccent)}`);
  console.log('');

  try {
    execFileSync(process.execPath, ['--import', 'tsx', CREATE_COMMAND_PATH], {
      stdio: 'inherit',
      env: process.env,
    });
  } catch (error: unknown) {
    console.error('');
    console.error('  Create flow failed. Try manually: auramaxx create my-game');
    process.exit((error as { status?: number }).status || 1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
