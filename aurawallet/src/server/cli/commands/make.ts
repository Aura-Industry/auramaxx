import { printBanner, paint, ANSI } from '../lib/theme';
import { delegateToAuraJsProjectCommand } from '../lib/aurajs-project';

function parseArgs(argv: string[]) {
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      return { help: true, passthrough: [] as string[] };
    }
  }
  return {
    help: false,
    passthrough: [...argv],
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    printBanner('MAKE');
    console.log(`  ${paint('Usage:', ANSI.bold)} auramaxx make [kind] [name] [--role <custom|enemy|pickup|player|world>]`);
    console.log('');
    console.log('  Public wrapper around AuraJS project file generation.');
    console.log('  Run it from inside an AuraJS game project.');
    console.log(`  ${paint('Examples:', ANSI.dim)}`);
    console.log('    auramaxx make');
    console.log('    auramaxx make scene Scene1');
    console.log('    auramaxx make ui-screen PauseMenu');
    console.log('    auramaxx make prefab EnemyShip --role enemy');
    console.log('    auramaxx make list');
    console.log('');
    console.log('  When no arguments are passed in a TTY, AuraJS opens an interactive make flow.');
    console.log('');
    return;
  }

  delegateToAuraJsProjectCommand('make', parsed.passthrough);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
