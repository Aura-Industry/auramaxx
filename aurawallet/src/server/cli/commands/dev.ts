import { printBanner, paint, ANSI } from '../lib/theme';
import { delegateToAuraJsProjectCommand } from '../lib/aurajs-project';

function parseArgs(argv: string[]) {
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      return { help: true, passthrough: [] as string[] };
    }
  }
  return { help: false, passthrough: [...argv] };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printBanner('DEV');
    console.log(`  ${paint('Usage:', ANSI.bold)} auramaxx dev [options]`);
    console.log('');
    console.log('  Public wrapper around the AuraJS local dev loop.');
    console.log('  Run it from inside an AuraJS game project.');
    console.log('');
    return;
  }

  delegateToAuraJsProjectCommand('dev', parsed.passthrough);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
