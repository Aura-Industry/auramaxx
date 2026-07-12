import fs from 'fs';
import path from 'path';
import { RunFingerprint } from './contracts';

export interface SummaryArtifact {
  runId: string;
  status: 'passed' | 'failed';
  scenarioId: string;
  runFingerprint: RunFingerprint;
}

export interface ReplayManifest {
  runId: string;
  scenarioId: string;
  runFingerprint: RunFingerprint;
  replayCommand: string;
}

export function writeArtifacts(baseDir: string, summary: SummaryArtifact): { summaryPath: string; manifestPath: string } {
  fs.mkdirSync(baseDir, { recursive: true });

  const summaryPath = path.join(baseDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  const manifest: ReplayManifest = {
    runId: summary.runId,
    scenarioId: summary.scenarioId,
    runFingerprint: summary.runFingerprint,
    replayCommand: `npx tsx src/server/tests/e2e-agent/runner.ts replay --run ${summary.runId}`,
  };

  const manifestPath = path.join(baseDir, 'replay.manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { summaryPath, manifestPath };
}
