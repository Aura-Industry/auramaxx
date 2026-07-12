/**
 * auramaxx release-check — pre-release guardrail checklist
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { getErrorMessage } from '../../lib/error';
import { printBanner } from '../lib/theme';

type ItemStatus = 'PASS' | 'WARN' | 'FAIL';
interface ChecklistItem {
  id: string;
  title: string;
  status: ItemStatus;
  details: string[];
  blocking?: boolean;
}

interface ReleaseReport {
  ok: boolean;
  baseRef: string;
  changed: { added: string[]; modified: string[]; deleted: string[] };
  checklist: ChecklistItem[];
}

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function run(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string; code: number } {
  const r = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  return {
    ok: (r.status ?? 1) === 0,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    code: r.status ?? 1,
  };
}

function parseArgs(argv: string[]): { json: boolean; base?: string } {
  const json = argv.includes('--json');
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : undefined;
  return { json, base };
}

function getLastReleaseRef(explicitBase?: string): string {
  if (explicitBase) return explicitBase;
  const tag = run('git', ['describe', '--tags', '--abbrev=0']);
  if (tag.ok) return tag.stdout.trim();
  const first = run('git', ['rev-list', '--max-parents=0', 'HEAD']);
  if (!first.ok) throw new Error('Unable to resolve release base ref');
  return first.stdout.trim().split('\n')[0];
}

function parseChangedFiles(baseRef: string): { added: string[]; modified: string[]; deleted: string[] } {
  const diff = run('git', ['diff', '--name-status', `${baseRef}..HEAD`]);
  if (!diff.ok) throw new Error(diff.stderr || 'git diff failed');
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const line of diff.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [status, file] = line.split(/\s+/, 2);
    if (!file) continue;
    if (status.startsWith('A')) added.push(file);
    else if (status.startsWith('D')) deleted.push(file);
    else modified.push(file);
  }
  return { added, modified, deleted };
}

function runSanityChecks(): ChecklistItem {
  const checks: Array<{ label: string; command: string; args: string[] }> = [
    { label: 'protected gate', command: 'npm', args: ['run', 'security:protected-gate'] },
    { label: 'job docs validation', command: 'node', args: ['scripts/validate-job-docs.mjs'] },
  ];

  const details: string[] = [];
  let failed = false;
  for (const check of checks) {
    const r = run(check.command, check.args);
    details.push(`${check.label}: ${r.ok ? 'ok' : `failed (exit ${r.code})`}`);
    if (!r.ok) failed = true;
  }

  return {
    id: 'sanity',
    title: 'Run existing sanity scripts',
    status: failed ? 'FAIL' : 'PASS',
    details,
    blocking: failed,
  };
}

function scanDoxxing(changedFiles: string[]): ChecklistItem {
  const patterns: Array<{ label: string; re: RegExp }> = [
    { label: 'private key', re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
    { label: 'api key token', re: /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/ },
    { label: 'jwt-like token', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}/ },
    { label: 'local absolute path', re: /\/Users\/[A-Za-z0-9._-]+\// },
    { label: 'email address', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  ];

  const findings: string[] = [];
  for (const file of changedFiles) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
    const content = fs.readFileSync(abs, 'utf8');
    for (const p of patterns) {
      if (p.re.test(content)) findings.push(`${file}: matched ${p.label}`);
    }
  }

  return {
    id: 'doxxing',
    title: 'Doxxing/privacy leak scan on changed files',
    status: findings.length ? 'WARN' : 'PASS',
    details: findings.length ? findings.slice(0, 20) : ['No obvious sensitive-pattern hits'],
    blocking: false,
  };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function verifySecurityRouteCoverage(changedFiles: string[]): ChecklistItem {
  const protectedFile = path.join(ROOT, 'docs/internal/PROTECTED_FILES.md');
  const indexFile = path.join(ROOT, 'src/server/index.ts');
  const details: string[] = [];

  if (!fs.existsSync(protectedFile)) {
    return { id: 'security-routes', title: 'Protected/security route coverage', status: 'FAIL', details: ['Missing docs/internal/PROTECTED_FILES.md'], blocking: true };
  }

  const globs = fs.readFileSync(protectedFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- `src/server/routes/'))
    .map((line) => line.replace(/^- `|`$/g, '').trim());

  const matchers = globs.map(globToRegex);
  const changedRoutes = changedFiles.filter((f) => f.startsWith('src/server/routes/'));
  const uncoveredChanged = changedRoutes.filter((f) => !matchers.some((re) => re.test(f)) && /(auth|lock|unlock|setup|security|passkey|credential-agents)/.test(path.basename(f)));

  if (uncoveredChanged.length) {
    details.push(`Sensitive route changes not covered by protected list: ${uncoveredChanged.join(', ')}`);
  } else {
    details.push('Sensitive route changes are covered by protected file list.');
  }

  if (fs.existsSync(indexFile)) {
    const indexText = fs.readFileSync(indexFile, 'utf8');
    if (!indexText.includes("import securityRoutes from './routes/security'")) {
      details.push('src/server/routes/security.ts is not imported by src/server/index.ts');
      return { id: 'security-routes', title: 'Protected/security route coverage', status: 'FAIL', details, blocking: true };
    }
  }

  return {
    id: 'security-routes',
    title: 'Protected/security route coverage',
    status: uncoveredChanged.length ? 'FAIL' : 'PASS',
    details,
    blocking: uncoveredChanged.length > 0,
  };
}

function printReport(report: ReleaseReport): void {
  printBanner('RELEASE CHECK');
  console.log(`Base ref: ${report.baseRef}`);
  console.log(`Changed files: +${report.changed.added.length} ~${report.changed.modified.length} -${report.changed.deleted.length}`);
  if (report.changed.added.length) {
    console.log(`New files (${report.changed.added.length}):`);
    for (const file of report.changed.added.slice(0, 20)) console.log(`  + ${file}`);
  }
  console.log('\nChecklist:');
  for (const item of report.checklist) {
    const marker = item.status === 'PASS' ? '✅' : item.status === 'WARN' ? '⚠️' : '❌';
    console.log(`- ${marker} ${item.title} [${item.status}]`);
    for (const line of item.details) console.log(`    - ${line}`);
    if (item.status !== 'PASS') {
      console.log(`    - Next step: ${item.blocking ? 'Fix before release.' : 'Review manually before release sign-off.'}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseRef = getLastReleaseRef(args.base);
  const changed = parseChangedFiles(baseRef);
  const changedAll = [...changed.added, ...changed.modified, ...changed.deleted];

  const checklist: ChecklistItem[] = [
    {
      id: 'diff-audit',
      title: 'Diff audit since last release',
      status: 'PASS',
      details: [
        `Added: ${changed.added.length}`,
        `Modified: ${changed.modified.length}`,
        `Deleted: ${changed.deleted.length}`,
      ],
    },
    runSanityChecks(),
    scanDoxxing([...changed.added, ...changed.modified]),
    verifySecurityRouteCoverage(changedAll),
  ];

  const ok = checklist.every((item) => item.status !== 'FAIL' || !item.blocking);
  const report: ReleaseReport = { ok, baseRef, changed, checklist };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('release-check failed:', getErrorMessage(error));
  process.exit(1);
});
