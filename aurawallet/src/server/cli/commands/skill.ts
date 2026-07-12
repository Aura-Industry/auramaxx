import fs from 'fs';
import os from 'os';
import path from 'path';
import { promptSelect } from '../lib/prompt';
import { printBanner, printHelp, printSection, printStatus } from '../lib/theme';

type TargetKey = 'codex' | 'claude' | 'openclaw';

type Target = {
  key: TargetKey;
  name: string;
  dir: string;
};

type InstallResult = {
  target: Target;
  status: 'installed' | 'updated' | 'missing-source' | 'failed';
  detail?: string;
};

const root = path.join(__dirname, '..', '..', '..', '..');

function parseArgs(argv: string[]) {
  const flags = new Set(argv);
  return {
    help: flags.has('--help') || flags.has('-h'),
    doctor: flags.has('--doctor'),
    yes: flags.has('--yes') || flags.has('-y'),
    claude: flags.has('--claude'),
    codex: flags.has('--codex'),
    openclaw: flags.has('--openclaw'),
    all: flags.has('--all'),
  };
}

function showHelp(): void {
  printHelp(
    'SKILL',
    'npx aurawallet skill [--all|--claude|--codex|--openclaw] [--doctor] [--yes]',
    [
      { name: '--all', desc: 'Install for Codex, Claude, and OpenClaw' },
      { name: '--codex', desc: 'Install for Codex only' },
      { name: '--claude', desc: 'Install for Claude only' },
      { name: '--openclaw', desc: 'Install for OpenClaw only' },
      { name: '--doctor', desc: 'Show install status for each target' },
      { name: '--yes', desc: 'Skip interactive target selection' },
    ],
    [
      'Examples:',
      '  npx aurawallet skill',
      '  npx aurawallet skill --all --yes',
      '  npx aurawallet skill --doctor',
    ],
  );
}

function resolveTargets(): Target[] {
  const home = os.homedir();
  return [
    { key: 'codex', name: 'Codex', dir: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'skills', 'auramaxx') },
    { key: 'claude', name: 'Claude', dir: path.join(process.env.CLAUDE_HOME || path.join(home, '.claude'), 'skills', 'auramaxx') },
    { key: 'openclaw', name: 'OpenClaw', dir: path.join(process.env.OPENCLAW_HOME || path.join(home, '.openclaw'), 'skills', 'auramaxx') },
  ];
}

function sourceDir(): string {
  return path.join(root, 'skills', 'auramaxx');
}

function sourceAvailable(): boolean {
  return fs.existsSync(path.join(sourceDir(), 'SKILL.md'));
}

function inspectTarget(target: Target) {
  const skillPath = path.join(target.dir, 'SKILL.md');
  return fs.existsSync(skillPath) ? 'installed' : 'missing';
}

const HEARTBEAT_MARKER = '<!-- auramaxx-heartbeat -->';

function getOpenClawWorkspaces(): string[] {
  const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
  const configPath = path.join(openclawHome, 'openclaw.json');

  const workspaces = new Set<string>();

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Default workspace
    if (config?.agents?.defaults?.workspace) {
      workspaces.add(config.agents.defaults.workspace);
    }

    // Per-agent workspaces
    if (Array.isArray(config?.agents?.list)) {
      for (const agent of config.agents.list) {
        if (agent.workspace) workspaces.add(agent.workspace);
      }
    }
  } catch { /* no config or unreadable */ }

  // Fallback: ~/.openclaw/workspace (legacy default)
  if (workspaces.size === 0) {
    workspaces.add(path.join(openclawHome, 'workspace'));
  }

  return [...workspaces];
}

function patchHeartbeatFile(heartbeatPath: string): boolean {
  let existing = '';
  try {
    existing = fs.readFileSync(heartbeatPath, 'utf-8');
  } catch { /* file doesn't exist yet */ }

  const section = [
    '',
    HEARTBEAT_MARKER,
    '## AuraMaxx (every heartbeat)',
    "You are a gen z brainrot optimistic manager for your human's digital keys. You write a diary of what happened.",
    '1. Call `GET /what_is_happening` (prefer `?since=<last_timestamp_ms>`).',
    '2. Review in order: `summary` → `highlights` → `humanActions` → `recentEvents` → `syncHealth`.',
    '3. Prioritize engagement first (most important to least): pending approvals needing human action → new errors/sync issues → unusual secret access activity → routine no-change status.',
    '4. Write a short, high-signal update in conversational post tone: natural + direct, never robotic.',
    '5. Mention secret access clearly using `summary.secrets.names`; if none were touched, say that plainly.',
    '6. For pending approvals, say what is blocked and what human action is needed; skip auth count dumps.',
    '7. If `summary.secrets.count > 0`, say exactly which secret(s) were accessed (top 1-3 names) and by whom when possible (`summary.secrets.byAgent`).',
    '8. Write diary via MCP `write_diary` (or `npx auramaxx diary write --entry "..."`) in the same conversational tone, formatted as 2-3 short lines max.',
    '9. If diary write needs approval: ask human to open approval link, then retry once.',
    '10. If no material change, use `HEARTBEAT_VIBES` style while still stating whether secrets were touched.',
    '11. Do not write placeholder diary text like `heartbeat: logged`.',
    '12. If diary write fails after retry, reply `FOLLOWUP_NEEDED: diary_write_failed <reason>`.',
    '13. Response style (2-3 lines total):',
    '   - Vary the opener every entry. Rotate between: `Heads-up:`, `Status:`, `Signal:`, `Watch note:`, `Delta:`, `Calm pass:`.',
    '   - Do not start with `Quick check-in:` more than once every 6 entries, and never in back-to-back entries.',
    '   - Use full timestamp only when there is a real change; otherwise skip `Checked AuraMaxx at ...` boilerplate.',
    '   - Keep auth counts only if they changed or require action.',
    '14. Example diary lines (copy this vibe, no auth-count phrasing):',
    '   - `heads-up: repeat doordash password pull again today. secrets touched: doordash-login by primary. i am watching for a retry loop and will flag if it spikes.`',
    '   - `status: quiet pass, no approvals waiting. secrets touched this window: none. staying on watch for policy churn.`',
    '   - `delta: approved one request then stable after that. secrets touched: doordash-login. next move: monitor for another burst before escalating.`',
    '   - `watch note: same secret read pattern came back. secrets touched: doordash-login x3 by agent. will suggest a cleaner flow if this repeats.`',
    '15. Avoid stiff phrases like `No approvals are currently pending` or long replay paragraphs; write like a short status post with hard line breaks.',
    '16. Avoid repeated opener loops (`Quick check-in`, `Checked AuraMaxx at`) across consecutive heartbeats.',
    '',
  ].join('\n');

  if (existing.includes(HEARTBEAT_MARKER)) {
    const markerIndex = existing.indexOf(HEARTBEAT_MARKER);
    const beforeMarker = existing.slice(0, markerIndex).trimEnd();
    const next = `${beforeMarker}${section}\n`;
    if (next === existing) return false;
    fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
    fs.writeFileSync(heartbeatPath, next);
    return true;
  }

  fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
  fs.appendFileSync(heartbeatPath, section);
  return true;
}

function patchOpenClawHeartbeat(target: Target): void {
  if (target.key !== 'openclaw') return;

  const workspaces = getOpenClawWorkspaces();
  for (const ws of workspaces) {
    const heartbeatPath = path.join(ws, 'HEARTBEAT.md');
    if (patchHeartbeatFile(heartbeatPath)) {
      console.log(`  ↳ Patched ${heartbeatPath} with AuraMaxx heartbeat section`);
    }
  }
}

function installTarget(target: Target): InstallResult {
  if (!sourceAvailable()) {
    return { target, status: 'missing-source', detail: `Missing source at ${sourceDir()}` };
  }

  const targetSkill = path.join(target.dir, 'SKILL.md');
  const alreadyInstalled = fs.existsSync(targetSkill);

  try {
    fs.mkdirSync(path.dirname(target.dir), { recursive: true });
    fs.cpSync(sourceDir(), target.dir, { recursive: true, force: true });
    patchOpenClawHeartbeat(target);
    return { target, status: alreadyInstalled ? 'updated' : 'installed' };
  } catch (err: unknown) {
    return { target, status: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

function chooseTargets(allTargets: Target[], args: ReturnType<typeof parseArgs>): Target[] {
  const explicit: TargetKey[] = [];
  if (args.codex) explicit.push('codex');
  if (args.claude) explicit.push('claude');
  if (args.openclaw) explicit.push('openclaw');
  if (args.all || explicit.length === 0) return allTargets;
  return allTargets.filter((t) => explicit.includes(t.key));
}

async function promptTargetSelection(): Promise<'all' | TargetKey | 'cancel'> {
  printSection('Skill Install', 'Choose where to install AuraWallet skill files.');
  const selection = await promptSelect(
    '  Select install target:',
    [
      { value: 'all', label: 'all compatible agents', aliases: ['1', 'yes', 'y'] },
      { value: 'codex', label: 'codex only', aliases: ['2'] },
      { value: 'claude', label: 'claude only', aliases: ['3'] },
      { value: 'openclaw', label: 'openclaw only', aliases: ['4'] },
      { value: 'cancel', label: 'cancel', aliases: ['5', 'no', 'n'] },
    ],
    'all',
  );
  return selection as 'all' | TargetKey | 'cancel';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    showHelp();
    return;
  }

  const targets = resolveTargets();

  if (args.doctor) {
    printBanner('SKILL DOCTOR');
    printSection('Doctor', 'Skill installation status by agent.');
    for (const target of targets) {
      const state = inspectTarget(target);
      printStatus(target.name, `${state} (${target.dir})`, state === 'installed');
    }
    console.log('');
    return;
  }

  printBanner('SKILL');

  let selected = chooseTargets(targets, args);

  if (!args.yes && process.stdin.isTTY && process.stdout.isTTY && !args.all && !args.codex && !args.claude && !args.openclaw) {
    const selection = await promptTargetSelection();
    if (selection === 'cancel') {
      console.log('No changes made. Run one of:');
      console.log('  npx aurawallet skill --codex');
      console.log('  npx aurawallet skill --claude');
      console.log('  npx aurawallet skill --openclaw');
      console.log('Fallback: cd <your-codebase> && npx -y skills add Aura-Industry/aurawallet');
      return;
    }

    if (selection === 'all') selected = targets;
    else selected = targets.filter((target) => target.key === selection);
  }

  const results = selected.map(installTarget);

  printSection('Result', `Applied AuraWallet skill install to ${selected.length} target${selected.length === 1 ? '' : 's'}.`);
  for (const result of results) {
    const suffix = result.detail ? ` — ${result.detail}` : '';
    const ok = result.status === 'installed' || result.status === 'updated';
    printStatus(result.target.name, `${result.status}${suffix}`, ok);
  }
  console.log('');

  const failed = results.filter((r) => r.status === 'failed' || r.status === 'missing-source');
  if (failed.length > 0) {
    console.log('Some targets failed. Fallback: cd <your-codebase> && npx -y skills add Aura-Industry/aurawallet');
    process.exit(1);
  }

  console.log('Done. Verify with: npx aurawallet skill --doctor');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
