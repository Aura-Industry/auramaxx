/**
 * App Token Registry
 * =====================
 * Central registry for all app tokens. Creates tokens on server start,
 * provides token lookup for strategy engine and REST endpoints.
 *
 * Token lifecycle:
 *   Server start → createAppTokens() for all installed apps
 *   Approve flow → createAppToken(id) creates/replaces token
 *   Revoke flow → revokeAppToken(id) removes token
 *   Strategy enable → getAppToken(id) reads from registry
 */

import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { createToken, getTokenHash } from './auth';
import { setToken, clearToken } from './strategy/state';
import { revokeToken } from './sessions';
import { getDefaultSync, onDefaultChanged } from './defaults';
import { prisma } from './db';

/** appId → raw token */
const tokens = new Map<string, string>();

/** appId → token hash */
const tokenHashes = new Map<string, string>();

interface AppManifest {
  id: string;
  permissions: string[];
  limits?: { fund?: number; send?: number };
  sources?: Array<{ key?: string }>;
}

/**
 * Load all app manifests from apps/ directory.
 * Returns ALL apps (not just strategies with ticker/jobs).
 */
function loadAllAppManifests(): AppManifest[] {
  const appsDir = path.join(process.cwd(), 'apps');
  if (!fs.existsSync(appsDir)) return [];

  const apps: AppManifest[] = [];

  for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mdPath = path.join(appsDir, entry.name, 'app.md');
    if (!fs.existsSync(mdPath)) continue;

    const raw = fs.readFileSync(mdPath, 'utf-8');
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;

    let manifest: Record<string, unknown>;
    try {
      manifest = parseYaml(match[1]);
    } catch (err) {
      console.error(`[app-tokens] Failed to parse ${mdPath}:`, err);
      continue;
    }

    if (!manifest) continue;

    apps.push({
      id: entry.name,
      permissions: (manifest.permissions as string[]) || [],
      limits: manifest.limits as AppManifest['limits'],
      sources: manifest.sources as AppManifest['sources'],
    });
  }

  return apps;
}

/**
 * Create tokens for all installed apps on startup.
 * - Apps with permissions/limits → require HumanAction approval → token with approved perms + app:storage
 * - Apps without declared permissions/limits → token uses default permissions
 * - Needs approval but missing → no token (log warning)
 */
export async function createAppTokens(): Promise<void> {
  const manifests = loadAllAppManifests();

  // Register built-in __system_chat__ app (system chat widget needs admin permissions)
  manifests.push({
    id: '__system_chat__',
    permissions: ['admin:*'],
  });

  if (manifests.length === 0) return;

  // Load all approvals
  const approvals = await prisma.humanAction.findMany({ where: { type: 'app:approve', status: 'approved' } });
  const approvalMap = new Map(approvals.map(a => {
    try {
      const meta = JSON.parse(a.metadata || '{}');
      return [meta.appId as string, { permissions: meta.permissions, limits: meta.limits }] as const;
    } catch { return null; }
  }).filter((x): x is [string, { permissions: unknown; limits: unknown }] => x !== null));

  for (const manifest of manifests) {
    const hasPermissionsOrLimits = manifest.permissions.length > 0 || manifest.limits;

    if (hasPermissionsOrLimits) {
      const approval = approvalMap.get(manifest.id);
      if (!approval) {
        console.warn(`[app-tokens] ${manifest.id}: needs approval, skipping token creation`);
        continue;
      }

      try {
        const approvedPermissions = (approval.permissions || []) as string[];
        const approvedLimits = approval.limits as { fund?: number; send?: number } | undefined;
        await createAppToken(manifest.id, approvedPermissions, manifest, approvedLimits);
      } catch (err) {
        console.error(`[app-tokens] ${manifest.id}: failed to create token:`, err);
      }
    } else {
      // App without declared permissions/limits
      try {
        await createAppToken(manifest.id, [], manifest);
      } catch (err) {
        console.error(`[app-tokens] ${manifest.id}: failed to create minimal token:`, err);
      }
    }
  }

  console.log(`[app-tokens] Created tokens for ${tokens.size}/${manifests.length} apps`);
}

/**
 * Create or replace token for a single app.
 * Returns the token string, or null if creation failed.
 */
export async function createAppToken(
  appId: string,
  permissions?: string[],
  manifest?: AppManifest,
  limits?: { fund?: number; send?: number },
): Promise<string | null> {
  // If no permissions provided, look up approval
  if (!permissions) {
    const approvalRecords = await prisma.humanAction.findMany({
      where: { type: 'app:approve', status: 'approved' },
    });
    const approval = approvalRecords.find(a => {
      try { return JSON.parse(a.metadata || '{}').appId === appId; } catch { return false; }
    });
    if (approval) {
      try {
        const meta = JSON.parse(approval.metadata || '{}');
        permissions = (meta.permissions || []) as string[];
        limits = meta.limits as { fund?: number; send?: number } | undefined;
      } catch {
        permissions = [];
      }
    } else {
      permissions = [];
    }
  }

  // agent-chat: respect permission tier setting
  if (appId === 'agent-chat') {
    const tier = getDefaultSync<string>('permissions.agent_tier', 'admin');
    if (tier === 'admin') {
      permissions = ['admin:*'];
    }
    // else: keep declared permissions (wallet:list, action:create)
  }

  // Apps that omit permissions inherit system defaults.
  if (!permissions || permissions.length === 0) {
    permissions = getDefaultSync<string[]>(
      'permissions.default',
      ['wallet:create:hot', 'send:hot', 'swap', 'fund', 'action:create'],
    );
  }

  // Always include app:storage
  const allPerms = new Set(permissions);
  allPerms.add('app:storage');

  // Auto-add app:accesskey if any source uses a key field
  if (manifest?.sources?.some(s => s.key)) {
    allPerms.add('app:accesskey');
  }

  try {
    const appTtl = getDefaultSync<number>('ttl.app', 86400);
    const token = await createToken(
      `app:${appId}`,
      limits?.fund || 0,
      Array.from(allPerms),
      appTtl,
      { limits },
    );

    const hash = getTokenHash(token);
    tokens.set(appId, token);
    tokenHashes.set(appId, hash);
    setToken(appId, token);

    console.log(`[app-tokens] ${appId}: token created (hash=${hash.slice(0, 8)}...)`);
    return token;
  } catch (err) {
    console.error(`[app-tokens] ${appId}: createToken failed:`, err);
    return null;
  }
}

/**
 * Revoke token for a app.
 * Removes from registry AND adds to revokedTokens set so the token
 * can no longer be used for API calls.
 */
export async function revokeAppToken(appId: string): Promise<void> {
  const hash = tokenHashes.get(appId);
  tokens.delete(appId);
  tokenHashes.delete(appId);
  clearToken(appId);
  if (hash) {
    await revokeToken(hash);
  }
  console.log(`[app-tokens] ${appId}: token revoked`);
}

/**
 * Get existing token for a app.
 */
export function getAppToken(appId: string): string | undefined {
  return tokens.get(appId);
}

/**
 * Get token hash for a app.
 */
export function getAppTokenHash(appId: string): string | undefined {
  return tokenHashes.get(appId);
}

// ─── Tier Change Listener ────────────────────────────────────────────
// When agent tier changes, revoke + recreate the agent-chat app token
onDefaultChanged('permissions.agent_tier', async () => {
  await revokeAppToken('agent-chat');
  await createAppToken('agent-chat');
});
