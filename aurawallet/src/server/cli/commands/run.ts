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
    printBanner('RUN');
    console.log(`  ${paint('Usage:', ANSI.bold)} auramaxx run [options]`);
    console.log('');
    console.log('  Public wrapper around AuraJS lower-level launch/session flow.');
    console.log('  Run it from inside an AuraJS game project.');
    console.log('');
    return;
  }

  delegateToAuraJsProjectCommand('run', parsed.passthrough);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
