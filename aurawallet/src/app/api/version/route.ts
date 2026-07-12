import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { isNewerVersion } from '@/server/lib/update-check';
import { getCachedVersionResult, setCachedVersionResult } from '@/server/lib/version-check-cache';

const execAsync = promisify(exec);
function normalizeVersion(value: string): string {
  const normalized = String(value || '').trim().replace(/^v/i, '');
  return normalized || 'unknown';
}

async function resolveCurrentVersion(): Promise<string> {
  try {
    const currentResult = await execAsync('npm list -g auramaxx --json');
    const parsed = JSON.parse(currentResult.stdout || '{}');
    const version = parsed?.dependencies?.auramaxx?.version;
    if (typeof version === 'string' && version.trim().length > 0) {
      return normalizeVersion(version);
    }
  } catch {
    // Fall through to package.json fallback.
  }

  try {
    const pkgResult = await execAsync('node -e "console.log(require(\'auramaxx/package.json\').version)"');
    return normalizeVersion(pkgResult.stdout);
  } catch {
    return 'unknown';
  }
}

function hasUpdate(current: string, latest: string): boolean {
  if (latest === 'unknown') return false;
  if (current === 'unknown') return true;
  return isNewerVersion(current, latest);
}

export async function GET() {
  try {
    const installedCurrent = await resolveCurrentVersion();
    const cachedResult = getCachedVersionResult();
    if (cachedResult) {
      const current = installedCurrent !== 'unknown'
        ? installedCurrent
        : normalizeVersion(cachedResult.current);
      const latest = normalizeVersion(cachedResult.latest);
      // Keep cache current in sync with actual installed version.
      if (current !== normalizeVersion(cachedResult.current) || latest !== cachedResult.latest) {
        setCachedVersionResult(current, latest, cachedResult.checkedAt);
      }
      return NextResponse.json({
        success: true,
        current,
        latest,
        updateAvailable: hasUpdate(current, latest),
      });
    }

    const latestResult = await execAsync('npm view auramaxx version').catch(() => ({ stdout: '' }));
    const current = installedCurrent;

    const latest = normalizeVersion(latestResult.stdout.trim() || 'unknown');

    setCachedVersionResult(current, latest);

    return NextResponse.json({
      success: true,
      current,
      latest,
      updateAvailable: hasUpdate(current, latest),
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message || 'Failed to check version' },
      { status: 500 },
    );
  }
}
