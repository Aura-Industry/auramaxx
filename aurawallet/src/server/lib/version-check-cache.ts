interface CachedVersionResult {
  current: string;
  latest: string;
  checkedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cachedResult: CachedVersionResult | null = null;

export function getCachedVersionResult(now: number = Date.now()): CachedVersionResult | null {
  if (!cachedResult) return null;
  if (now - cachedResult.checkedAt >= CACHE_TTL_MS) return null;
  return cachedResult;
}

export function setCachedVersionResult(current: string, latest: string, now: number = Date.now()): void {
  cachedResult = { current, latest, checkedAt: now };
}

export function clearVersionCheckCache(): void {
  cachedResult = null;
}

