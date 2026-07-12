import { rmSync } from 'fs';
import { pathToFileURL } from 'url';

import { printBanner, printSection, paint, ANSI } from '../lib/theme';
import { resolveInvocationCwd } from '../lib/aurajs-project';
import {
  assertPublishedForkDestination,
  copyPublishedForkProject,
  normalizeForkDisplayPath,
  resolvePublishedForkDestination,
} from '../lib/published-game-fork';
import {
  installVerifiedGamePackage,
  parseArgs,
  resolveGameBin,
  resolvePackageName,
} from './play';

export interface ForkCommandPlan {
  help: boolean;
  name: string | null;
  gameArgs: string[];
  gameBin: string | null;
  packageName: string | null;
  forwardedArgs: string[];
}

export function buildForkPlan(argv: string[]): ForkCommandPlan {
  const parsed = parseArgs(argv);
  return {
    ...parsed,
    gameBin: parsed.name ? resolveGameBin(parsed.name) : null,
    packageName: parsed.name ? resolvePackageName(parsed.name) : null,
    forwardedArgs: ['fork', ...parsed.gameArgs],
  };
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const plan = buildForkPlan(argv);
  const invocationCwd = resolveInvocationCwd();

  if (plan.help || !plan.name) {
    printBanner('FORK');
    console.log(`  ${paint('Usage:', ANSI.bold)} auramaxx fork <game> [destination|wrapper fork options]`);
    console.log('');
    console.log(`  ${paint('Examples:', ANSI.dim)}`);
    console.log('    auramaxx fork aurasu');
    console.log('    auramaxx fork aurasu ./aurasu-local');
    console.log('    auramaxx fork @auraindustry/chess-dev-cli@1.2.3 --dest ./chess-local');
    console.log('');
    console.log(`  ${paint('Runs:', ANSI.dim)} verified signed temporary install -> local AuraMaxx-owned fork`);
    console.log('');
    if (!plan.name && !plan.help) {
      console.error('  Missing game name.');
      process.exit(1);
    }
    return;
  }

  printBanner(plan.name.toUpperCase());
  printSection(plan.name, 'Forking editable package into local project...');

  let install: Awaited<ReturnType<typeof installVerifiedGamePackage>> | null = null;
  try {
    install = await installVerifiedGamePackage(plan);
    const destinationRoot = await resolvePublishedForkDestination({
      commandArgs: plan.gameArgs,
      invocationCwd,
      packageRoot: install.packageRoot,
      packageName: install.packageName,
    });
    if (!destinationRoot) {
      printSection(plan.name, 'Fork cancelled.');
      return;
    }
    assertPublishedForkDestination({
      destinationRoot,
      packageRoot: install.packageRoot,
      invocationCwd,
    });
    printSection(plan.name, `Copying editable package files into ${normalizeForkDisplayPath(invocationCwd, destinationRoot)}...`);
    copyPublishedForkProject({
      packageRoot: install.packageRoot,
      destinationRoot,
    });
    console.log(`  Fork ready: ${normalizeForkDisplayPath(invocationCwd, destinationRoot)}`);
    console.log('');
    console.log('  Next steps:');
    console.log(`    cd ${normalizeForkDisplayPath(invocationCwd, destinationRoot)}`);
    console.log('    npm install');
    console.log('    npm run dev');
    console.log('');
  } finally {
    if (install?.installRoot) {
      rmSync(install.installRoot, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    const status = (err as { status?: number; exitCode?: number })?.status
      ?? (err as { status?: number; exitCode?: number })?.exitCode
      ?? 1;
    process.exit(Number.isInteger(status) ? status : 1);
  });
}
