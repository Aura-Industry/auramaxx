/**
 * Shared diary helpers used by heartbeat + MCP flows.
 */

const LEGACY_DIARY_ENTRY_HEADER_REGEX = /^--- \d{2}:\d{2} UTC ---$/gm;
export const DIARY_ENTRY_COUNT_KEY = 'entry_count';
const DIARY_ENTRY_SEPARATOR = '\n\n';

export function resolveDiaryDate(value: string | undefined): string | null {
  if (!value) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

export function getDiaryCredentialName(date: string): string {
  return `${date}_LOGS`;
}

export function getLegacyDiaryCredentialName(date: string): string {
  return `diary-${date}`;
}

export function formatDiaryEntry(entry: string): string {
  return entry.trim();
}

export function appendDiaryEntry(previousText: string, entryBlock: string): string {
  if (previousText.trim().length === 0) return entryBlock;
  return `${previousText.trimEnd()}${DIARY_ENTRY_SEPARATOR}${entryBlock}`;
}

export function countDiaryEntries(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;

  // Backward compatibility for legacy entries that used time headers.
  const legacyMatches = trimmed.match(LEGACY_DIARY_ENTRY_HEADER_REGEX);
  if (legacyMatches && legacyMatches.length > 0) return legacyMatches.length;

  // New format uses a blank-line separator between entry blocks.
  if (trimmed.includes(DIARY_ENTRY_SEPARATOR)) {
    return trimmed
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter((block) => block.length > 0)
      .length;
  }

  // Fallback for older plain-note content where one non-empty line mapped to one entry.
  return trimmed.split('\n').filter((line) => line.trim().length > 0).length;
}

export function resolveDiaryEntryCount(meta: unknown, content: string): number {
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const raw = (meta as Record<string, unknown>)[DIARY_ENTRY_COUNT_KEY];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      return Math.floor(raw);
    }
  }
  return countDiaryEntries(content);
}
