import { Request, Response, NextFunction } from 'express';
import { AgentTokenPayload } from '../types';
import { EscalationRouteId } from './escalation-route-registry';
import { respondPermissionDenied, buildLegacyPermissionDeniedPayload } from './escalation-responder';

/**
 * PERMISSION SYSTEM
 * =================
 *
 * Permission strings control access to specific routes and operations.
 * Admin tokens bypass all permission checks.
 */

// All valid permission strings
export type Permission =
  // Wallet operations
  | 'wallet:list'           // List/view wallets
  | 'wallet:create:hot'     // Create hot wallets
  | 'wallet:create:temp'    // Create temp wallets
  | 'wallet:rename'         // Rename wallets
  | 'wallet:export'         // Export private keys
  | 'wallet:tx:add'         // Manually add transactions to wallet history
  | 'wallet:asset:add'      // Add assets to track for a wallet
  | 'wallet:asset:remove'   // Remove tracked assets from a wallet

  // Transaction operations
  | 'send:hot'              // Send from hot wallets
  | 'send:temp'             // Send from temp wallets
  | 'swap'                  // Execute swaps
  | 'fund'                  // Cold→hot transfers
  | 'launch'                // Execute token launches

  // API Key operations
  | 'apikey:get'            // Read API keys
  | 'apikey:set'            // Create/update/delete API keys

  // Workspace/UI operations
  | 'workspace:modify'      // Add/update/remove apps, modify workspaces

  // Strategy operations
  | 'strategy:read'         // View strategies and their state
  | 'strategy:manage'       // Enable/disable strategies, update config

  // App operations
  | 'app:storage'        // Read/write own app's storage via Express API
  | 'app:storage:all'    // Read/write ANY app's storage via Express API
  | 'app:accesskey'      // Read API keys from app storage

  // Action operations
  | 'action:create'          // Create human action requests (propose actions for approval)
  | 'action:read'            // Read/list pending actions
  | 'action:resolve'         // Approve or reject pending actions

  // Adapter operations
  | 'adapter:manage'         // Configure and restart approval adapters (Telegram, webhooks)

  // Address book & bookmark operations
  | 'addressbook:write'      // Create/update/delete address labels
  | 'bookmark:write'         // Create/delete token bookmarks

  // Credential agent operations
  | 'secret:read'            // Read credentials from the agent
  | 'secret:write'           // Create/update/delete credentials in the agent
  | 'totp:read'              // Generate TOTP codes from credential secrets

  // Social operations
  | 'social:read'            // Read feed, messages, followers, following, sync status
  | 'social:write'           // Create posts, reactions, follows, profile updates, removals

  // Verified credential operations
  | 'credential:read'        // View verified credentials and verification status
  | 'credential:write'       // Initiate new credential verifications

  // Compound permissions (expand to multiple permissions)
  | 'trade:all'             // All trading permissions + apikey:get + strategy:read
  | 'wallet:write'          // All wallet write operations
  | 'extension:*'           // Browser extension permissions

  // Admin (UI only)
  | 'admin:*';              // All permissions, bypass limits

/**
 * Compound permission mappings
 * These permissions expand to multiple underlying permissions
 */
const COMPOUND_PERMISSIONS: Record<string, Permission[]> = {
  'admin:*': [
    'swap', 'send:hot', 'send:temp', 'fund', 'launch',
    'wallet:create:hot', 'wallet:create:temp', 'wallet:export', 'wallet:list', 'wallet:rename',
    'wallet:tx:add', 'wallet:asset:add', 'wallet:asset:remove',
    'secret:read', 'secret:write', 'totp:read',
    'action:create', 'action:read', 'action:resolve',
    'apikey:get', 'apikey:set',
    'workspace:modify',
    'strategy:read', 'strategy:manage',
    'app:storage', 'app:storage:all', 'app:accesskey',
    'adapter:manage',
    'addressbook:write', 'bookmark:write',
    'social:read', 'social:write',
    'credential:read', 'credential:write',
  ],
  'trade:all': [
    'wallet:list',
    'wallet:create:hot',
    'wallet:create:temp',
    'send:hot',
    'send:temp',
    'swap',
    'fund',
    'launch',
    'apikey:get',
    'strategy:read'
  ],
  'extension:*': [
    'wallet:list',
    'secret:read',
    'action:read',
    'action:resolve'
  ],
  'wallet:write': [
    'wallet:create:hot',
    'wallet:create:temp',
    'wallet:rename',
    'wallet:tx:add',
    'wallet:asset:add',
    'wallet:asset:remove'
  ]
};

/**
 * Expand and normalize permissions array
 * - Expands compound permissions (e.g., 'trade:all' → multiple permissions)
 * - Deduplicates the result
 */
export function expandPermissions(permissions: string[]): Permission[] {
  const expanded = new Set<Permission>();

  for (const perm of permissions) {
    // Check if this is a compound permission
    if (COMPOUND_PERMISSIONS[perm]) {
      for (const subPerm of COMPOUND_PERMISSIONS[perm]) {
        expanded.add(subPerm);
      }
    }
    // Always add the original permission too
    expanded.add(perm as Permission);
  }

  return Array.from(expanded);
}

/**
 * Get the list of compound permissions and what they expand to
 */
export function getCompoundPermissions(): Record<string, Permission[]> {
  return { ...COMPOUND_PERMISSIONS };
}

/**
 * Check if token has ANY of the required permissions
 * Automatically expands compound permissions before checking
 */
export function hasAnyPermission(
  tokenPermissions: string[],
  requiredPermissions: string[]
): boolean {
  // Admin bypass
  if (tokenPermissions.includes('admin:*')) {
    return true;
  }

  // Expand compound permissions
  const expanded = expandPermissions(tokenPermissions);

  for (const required of requiredPermissions) {
    if (expanded.includes(required as Permission)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if token has ALL of the required permissions
 * Automatically expands compound permissions before checking
 */
export function hasAllPermissions(
  tokenPermissions: string[],
  requiredPermissions: string[]
): boolean {
  // Admin bypass
  if (tokenPermissions.includes('admin:*')) {
    return true;
  }

  // Expand compound permissions
  const expanded = expandPermissions(tokenPermissions);

  for (const required of requiredPermissions) {
    if (!expanded.includes(required as Permission)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a token is an admin token (has admin:* permission)
 */
export function isAdmin(auth: { token: { permissions: string[] } }): boolean {
  return auth.token.permissions.includes('admin:*');
}

/**
 * Middleware factory that requires specific permissions
 *
 * Usage:
 *   router.post('/create', requireWalletAuth, requirePermission('wallet:create:hot'), handler)
 *   router.post('/send', requireWalletAuth, requirePermission('send:hot', 'send:temp'), handler)
 */
export function requirePermission(...permissions: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Check if token has any of the required permissions (admin:* bypasses via hasAnyPermission)
    if (!hasAnyPermission(req.auth.token.permissions, permissions)) {
      res.status(403).json(buildLegacyPermissionDeniedPayload({
        error: 'Insufficient permissions',
        required: permissions,
        have: req.auth.token.permissions,
      }));
      return;
    }

    next();
  };
}

/**
 * Middleware that requires admin permission specifically
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!isAdmin(req.auth)) {
    res.status(403).json(buildLegacyPermissionDeniedPayload({
      error: 'Admin access required',
      required: ['admin:*'],
      have: req.auth.token.permissions,
    }));
    return;
  }

  next();
}

/**
 * Get the permission required for a wallet tier operation
 */
export function getWalletCreatePermission(tier: 'hot' | 'temp'): Permission {
  return tier === 'hot' ? 'wallet:create:hot' : 'wallet:create:temp';
}

/**
 * Get the permission required for sending from a wallet tier
 */
export function getSendPermission(tier: 'hot' | 'temp'): Permission {
  return tier === 'hot' ? 'send:hot' : 'send:temp';
}

/**
 * Build a 403 response body with escalation info.
 * Use this instead of bare `{ error: '...' }` for permission denials
 * so that agents (MCP, CLI, SDK) know how to self-escalate.
 */
export function buildPermissionDenied(error: string, required: string[], have?: string[]): Record<string, unknown> {
  return buildLegacyPermissionDeniedPayload({ error, required, have });
}

/**
 * Route-aware permission middleware that emits canonical escalation payloads.
 * Use this for migrated non-wallet routes in the escalation rollout.
 */
export function requirePermissionForRoute(routeId: EscalationRouteId, ...permissions: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!hasAnyPermission(req.auth.token.permissions, permissions)) {
      await respondPermissionDenied({
        req,
        res,
        routeId,
        error: 'Insufficient permissions',
        required: permissions,
        have: req.auth.token.permissions,
      });
      return;
    }

    next();
  };
}

/**
 * Route-aware admin middleware that emits canonical escalation payloads.
 * Use this for migrated non-wallet routes in the escalation rollout.
 */
export function requireAdminForRoute(routeId: EscalationRouteId) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!isAdmin(req.auth)) {
      await respondPermissionDenied({
        req,
        res,
        routeId,
        error: 'Admin access required',
        required: ['admin:*'],
        have: req.auth.token.permissions,
      });
      return;
    }

    next();
  };
}
