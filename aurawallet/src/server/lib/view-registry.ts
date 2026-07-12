/**
 * File-backed view registry for the experimental multi-view wallet shell.
 * Config stored at <project-root>/.aura/views.json (local, gitignored).
 * Gated behind the EXPERIMENTAL_WALLET feature flag.
 */

import fs from 'fs';
import path from 'path';
import { isEnabled } from './feature-flags';

export interface ViewConfig {
  id: string;
  label: string;
  icon: string;
  type: 'auth' | 'wallet' | 'audit' | 'custom';
  route: string;
  enabled: boolean;
}

const root = path.resolve(__dirname, '..', '..', '..');

function viewsPath(): string {
  return path.join(root, '.aura', 'views.json');
}

const DEFAULT_VIEWS: ViewConfig[] = [
  { id: 'main', label: 'Main', icon: '🏠', type: 'wallet', route: '/', enabled: true },
  { id: 'wallet', label: 'Wallet', icon: '💰', type: 'wallet', route: '/wallet', enabled: true },
];

export function readViews(): ViewConfig[] {
  if (!isEnabled('EXPERIMENTAL_WALLET')) return [];

  const filePath = viewsPath();
  if (!fs.existsSync(filePath)) return [];

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ViewConfig[];
  } catch {
    return [];
  }
}

export function writeViews(views: ViewConfig[]): void {
  const filePath = viewsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(views, null, 2) + '\n', 'utf-8');
}

export function upsertView(view: ViewConfig): ViewConfig[] {
  const views = readViews();
  const idx = views.findIndex(v => v.id === view.id);
  if (idx >= 0) {
    views[idx] = view;
  } else {
    views.push(view);
  }
  writeViews(views);
  return views;
}

/**
 * Seed default views (main + wallet) if the file doesn't exist
 * and EXPERIMENTAL_WALLET is enabled.
 */
export function seedDefaultViews(): void {
  if (!isEnabled('EXPERIMENTAL_WALLET')) return;

  const filePath = viewsPath();
  if (fs.existsSync(filePath)) return;

  try {
    writeViews(DEFAULT_VIEWS);
  } catch {
    // Best-effort; non-fatal during bootstrap.
  }
}
