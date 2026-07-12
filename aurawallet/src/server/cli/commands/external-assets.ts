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
    printBanner('EXTERNAL ASSETS');
    console.log(`  ${paint('Usage:', ANSI.bold)} auramaxx external-assets [generate] [options]`);
    console.log('');
    console.log('  Public wrapper around AuraJS external asset staging.');
    console.log('  Run it from inside an AuraJS game project.');
    console.log(`  ${paint('Examples:', ANSI.dim)}`);
    console.log('    auramaxx external-assets generate --public-base-url https://cdn.example.com/my-game');
    console.log('');
    console.log('  `generate` is the default action when no subcommand is supplied.');
    console.log('');
    return;
  }

  delegateToAuraJsProjectCommand('external-assets', parsed.passthrough);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
