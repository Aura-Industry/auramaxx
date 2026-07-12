/**
 * Credential Scope — Matching & Field Exclusion Resolution
 * ========================================================
 *
 * Handles scope normalization, credential-to-scope matching for access control,
 * and resolution of which sensitive fields to exclude from reads.
 */

import { CredentialFile } from '../types';
import { getDefaultSync } from './defaults';

/**
 * Normalize a scope string for consistent matching.
 * Trims whitespace, applies NFKC normalization, and lowercases.
 */
export function normalizeScope(scope: string): string {
  return scope.trim().normalize('NFKC').toLowerCase();
}

/**
 * Check if a credential matches any of the given scopes.
 *
 * Scope types:
 * - `*` — matches everything
 * - `cred-xxxxx` — exact credential ID match
 * - `tag:X` — matches if credential's meta.tags contains X
 * - `agent:X` — matches if credential's agentId equals X
 *
 * Selector wildcards:
 * - `tag:*` / `agent:*` — match any tag / any agent
 * - trailing `*` in tag/agent selectors — prefix wildcard
 *   (e.g. `tag:generated/*`, `agent:pri*`)
 *
 * All comparisons use normalized values.
 * Empty scopes array matches nothing.
 */
function matchesSelector(value: string, selector: string): boolean {
  if (selector === '*') return true;
  if (selector.endsWith('*')) {
    const prefix = selector.slice(0, -1);
    return value.startsWith(prefix);
  }
  return value === selector;
}

export function matchesScope(credential: CredentialFile, scopes: string[]): boolean {
  if (scopes.length === 0) return false;

  const normalizedScopes = scopes.map(normalizeScope);

  for (const scope of normalizedScopes) {
    // Wildcard
    if (scope === '*') return true;

    // Exact ID match
    if (scope === normalizeScope(credential.id)) return true;

    // Tag match
    if (scope.startsWith('tag:')) {
      const tagValue = scope.slice(4);
      const tags = (credential.meta.tags as string[] | undefined) || [];
      if (tagValue === '*' && tags.length > 0) return true;
      if (tags.some(t => matchesSelector(normalizeScope(t), tagValue))) return true;
    }

    // Agent match
    if (scope.startsWith('agent:')) {
      const agentValue = scope.slice(6);
      if (matchesSelector(normalizeScope(credential.agentId), agentValue)) return true;
    }
  }

  return false;
}

/**
 * Resolve which fields to exclude from a credential read.
 *
 * Resolution order:
 * 1. Token's explicit excludeFields (even if empty array []) → use as-is
 * 2. Type default from `defaults.credential.excludeFields.{type}` → use if found
 * 3. Fall back to empty array (exclude nothing)
 */
export function resolveExcludeFields(
  tokenExcludes: string[] | undefined,
  credentialType: string
): string[] {
  // Token explicitly set excludeFields (even [] means "show everything")
  if (tokenExcludes !== undefined) {
    if (Array.isArray(tokenExcludes) && tokenExcludes.length === 0) {
      console.warn('[credential-scope] Token has excludeFields: [] — all sensitive fields will be exposed. Ensure this is intentional.');
    }
    return tokenExcludes;
  }

  // Type default
  const typeDefault = getDefaultSync<string[]>(
    `defaults.credential.excludeFields.${credentialType}`,
    []
  );
  return typeDefault;
}
