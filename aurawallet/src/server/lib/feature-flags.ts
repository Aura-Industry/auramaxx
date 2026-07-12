/**
 * Lightweight file-backed feature flags for dev/experimental toggles.
 * Config stored at <project-root>/.aura/features.json (local, gitignored).
 */

import fs from 'fs';
import path from 'path';

export interface FeatureFlags {
  DEMO_FEATURE: boolean;
  [key: string]: boolean;
}

const DEFAULT_FLAGS: FeatureFlags = {
  DEMO_FEATURE: false,
  EXPERIMENTAL_WALLET: false,
  SOCIAL: false,
  SHOW_DISCOVER_HUB: false,
  CREDENTIALS: false,
};

const root = path.resolve(__dirname, '..', '..', '..');

function configPath(): string {
  return path.join(root, '.aura', 'features.json');
}

export function getDefaultFlags(): FeatureFlags {
  return { ...DEFAULT_FLAGS };
}

export function getKnownFlagNames(): string[] {
  return Object.keys(DEFAULT_FLAGS);
}

export function readFlags(): FeatureFlags {
  const defaults = getDefaultFlags();
  const filePath = configPath();

  if (!fs.existsSync(filePath)) {
    return defaults;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return defaults;
    }
    // Merge: defaults first, then file overrides (only known keys)
    const merged = { ...defaults };
    for (const key of Object.keys(defaults)) {
      if (typeof parsed[key] === 'boolean') {
        merged[key] = parsed[key];
      }
    }
    return merged;
  } catch {
    return defaults;
  }
}

export function writeFlag(name: string, value: boolean): { ok: boolean; error?: string } {
  const known = getKnownFlagNames();
  if (!known.includes(name)) {
    return { ok: false, error: `Unknown flag: ${name}. Known flags: ${known.join(', ')}` };
  }

  const current = readFlags();
  current[name] = value;

  const filePath = configPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(current, null, 2) + '\n', 'utf-8');
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function isEnabled(name: string): boolean {
  const flags = readFlags();
  return !!flags[name];
}

export function ensureDefaults(): void {
  const filePath = configPath();
  if (fs.existsSync(filePath)) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(getDefaultFlags(), null, 2) + '\n', 'utf-8');
  } catch {
    // Best-effort; non-fatal during bootstrap.
  }
}
