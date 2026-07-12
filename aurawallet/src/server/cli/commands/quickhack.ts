import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUICKHACK_NAMES = [
  'LASER_PENGUIN', 'MOON_TACO', 'NINJA_AVOCADO', 'ROBOT_MOCHI', 'COSMIC_WAFFLE',
  'PIXEL_TIGER', 'NEON_POTATO', 'GHOST_RAMEN', 'SOLAR_BURRITO', 'WIZARD_NOODLE',
];

export const QUICKHACK_VALUES = [
  'sk-live-rainbow-otter', 'ghp_plasma-squirrel', 'tok_midnight-boba', 'sec_hyper-lemur', 'key_quantum-kiwi',
  'api_orbit-panda', 'cred_ember-fox', 'agent_velvet-wolf', 'safe_zen-koala', 'core_nova-hawk',
];

export interface QuickhackPlan {
  name: string;
  value: string;
  setArgs: string[];
  injectArgs: string[];
}

export const pickFrom = (items: string[], rng: () => number = Math.random): string => {
  const idx = Math.max(0, Math.min(items.length - 1, Math.floor(rng() * items.length)));
  return items[idx];
};

export const buildQuickhackPlan = (rng: () => number = Math.random): QuickhackPlan => {
  const name = pickFrom(QUICKHACK_NAMES, rng);
  const value = pickFrom(QUICKHACK_VALUES, rng);
  return {
    name,
    value,
    setArgs: ['set', name, value, '--type', 'apikey'],
    injectArgs: ['inject', name, '--env', 'AURA_QUICKHACK'],
  };
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const auraBin = path.join(root, 'bin', 'auramaxx.js');

const runAura = (args: string[]): string =>
  execFileSync(process.execPath, [auraBin, ...args], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
  });

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: npx auramaxx quickhack [--dry-run]');
    return;
  }

  const dryRun = argv.includes('--dry-run');
  const plan = buildQuickhackPlan();

  const setCmd = `npx auramaxx ${plan.setArgs.join(' ')}`;
  const injectCmd = `npx auramaxx ${plan.injectArgs.join(' ')}`;

  console.log('Executed commands:');
  console.log(`- ${setCmd}`);
  console.log(`- ${injectCmd}`);

  let injectOutput = '# dry-run: command execution skipped';
  if (!dryRun) {
    runAura(plan.setArgs);
    injectOutput = runAura(plan.injectArgs).trim();
  }

  console.log('\nEnv output:');
  console.log(injectOutput);

  console.log('\n## Quickhack tutorial');
  console.log('```bash');
  console.log(setCmd);
  console.log(injectCmd);
  console.log('echo "$AURA_QUICKHACK"');
  console.log('```');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}
