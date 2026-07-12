/**
 * Shared credential resolution logic for env.ts and shell-hook.ts
 *
 * Consolidates search → read → decrypt flow to prevent drift between
 * the two consumers (audit finding #3).
 */

import { getErrorMessage } from '../../lib/error';
import {
  evaluateProjectScopeAccess,
  emitProjectScopeEvent,
  type ProjectScopeMode,
} from '../../lib/project-scope';

// ── Types ──

export interface CredentialMeta {
  id: string;
  name: string;
  type: string;
  agentId: string;
}

export interface DecryptedCredential {
  id: string;
  agentId: string;
  type: string;
  fields: Array<{ key: string; value: string }>;
}

export interface AuraMapping {
  envVar: string;
  agent: string | null;
  credentialName: string;
  field: string;
}

export interface ResolveResult {
  resolved: Map<string, string>;
  errors: string[];
  missing: AuraMapping[];
}

// ── Env var name validation (audit finding #6) ──

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvVarName(name: string): boolean {
  return ENV_VAR_NAME_RE.test(name);
}

export function validateEnvVarName(name: string): void {
  if (!isValidEnvVarName(name)) {
    throw new Error(
      `Invalid env var name '${name}': must match [A-Za-z_][A-Za-z0-9_]*`
    );
  }
}

// ── Shell escaping (audit finding #1) ──

/**
 * Escape a value for safe use in shell export statements.
 * Uses ANSI-C quoting ($'...') to safely handle newlines, tabs,
 * single quotes, backslashes, and other control characters.
 */
export function escapeForShell(value: string): string {
  // Use ANSI-C $'...' quoting which handles all special chars
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\0/g, '\\0')
    // Escape any other control characters
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (ch) => {
      return '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0');
    });
  return `$'${escaped}'`;
}

function normalizeProjectScopeMode(raw: unknown): ProjectScopeMode {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'strict') return 'strict';
  if (value === 'auto') return 'auto';
  if (value === 'off') return 'off';
  return 'off';
}

async function fetchProjectScopeMode(baseUrl: string): Promise<ProjectScopeMode> {
  try {
    const res = await fetch(`${baseUrl}/setup`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 'off';
    const data = await res.json() as { projectScopeMode?: unknown };
    return normalizeProjectScopeMode(data.projectScopeMode);
  } catch {
    return 'off';
  }
}

// ── Credential search with exact-match preference (audit finding #4) ──

export async function searchCredential(
  baseUrl: string,
  token: string,
  name: string,
): Promise<CredentialMeta | null> {
  for (const param of [
    `q=${encodeURIComponent(name)}`,
    `tag=${encodeURIComponent(name)}`,
  ]) {
    const res = await fetch(`${baseUrl}/credentials?${param}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) continue;

    const data = (await res.json()) as { credentials: CredentialMeta[] };
    const creds = data.credentials;
    if (!creds || creds.length === 0) continue;

    // Prefer exact name match (audit finding #4: ambiguous matching)
    const exact = creds.find(
      (c) => c.name.toLowerCase() === name.toLowerCase(),
    );
    if (exact) return exact;

    // Warn if multiple non-exact matches
    if (creds.length > 1) {
      console.error(
        `aura: warning: '${name}' matched ${creds.length} credentials, using first. ` +
          `Matches: ${creds.map((c) => c.name).join(', ')}`,
      );
    }
    return creds[0];
  }
  return null;
}

// ── Credential read + decrypt ──

export async function readCredential(
  baseUrl: string,
  readToken: string,
  credentialId: string,
  decryptFn: (encrypted: string) => string,
  requestedFields?: string[],
): Promise<DecryptedCredential> {
  const normalizedRequestedFields = Array.from(new Set(
    (requestedFields || [])
      .map((value) => String(value || '').trim())
      .filter((value) => value.length > 0),
  ));
  const requestBody = normalizedRequestedFields.length > 0
    ? JSON.stringify({ requestedFields: normalizedRequestedFields })
    : undefined;
  const res = await fetch(`${baseUrl}/credentials/${credentialId}/read`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${readToken}`,
      ...(requestBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(requestBody ? { body: requestBody } : {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Read failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { encrypted: string };
  const plaintext = decryptFn(data.encrypted);
  return JSON.parse(plaintext);
}

// ── Resolve mappings to env vars ──

export async function resolveMappings(
  mappings: AuraMapping[],
  baseUrl: string,
  token: string,
  readToken: string,
  decryptFn: (encrypted: string) => string,
): Promise<ResolveResult> {
  const resolved = new Map<string, string>();
  const errors: string[] = [];
  const missing: AuraMapping[] = [];

  const credentialCache = new Map<string, DecryptedCredential | null>();
  const CONCURRENCY = 5;

  let agentNameById = new Map<string, string>();
  const projectScopeMode = await fetchProjectScopeMode(baseUrl);
  try {
    const agentRes = await fetch(`${baseUrl}/setup/agents`, { signal: AbortSignal.timeout(5000) });
    if (agentRes.ok) {
      const agentData = await agentRes.json() as { agents?: Array<{ id: string; name: string }> };
      agentNameById = new Map((agentData.agents || []).map((v) => [v.id, v.name]));
    }
  } catch {
    // best effort only
  }

  const uniqueTargets = new Map<string, AuraMapping>();
  const requestedFieldsByTarget = new Map<string, Set<string>>();
  for (const mapping of mappings) {
    const key = `${(mapping.agent || '').toLowerCase()}::${mapping.credentialName.toLowerCase()}`;
    if (!uniqueTargets.has(key)) uniqueTargets.set(key, mapping);
    const requested = requestedFieldsByTarget.get(key) || new Set<string>();
    requested.add(mapping.field);
    requestedFieldsByTarget.set(key, requested);
  }

  const targetList = [...uniqueTargets.values()];

  for (let i = 0; i < targetList.length; i += CONCURRENCY) {
    const batch = targetList.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (mapping) => {
        const cacheKey = `${(mapping.agent || '').toLowerCase()}::${mapping.credentialName.toLowerCase()}`;
        const meta = await searchCredential(baseUrl, token, mapping.credentialName);
        if (!meta) {
          credentialCache.set(cacheKey, null);
          return;
        }

        const decision = evaluateProjectScopeAccess({
          surface: 'cli_env',
          requested: { agentName: mapping.agent, credentialName: mapping.credentialName },
          candidates: [{ id: meta.id, name: meta.name, agentName: agentNameById.get(meta.agentId) || null }],
          actor: 'cli-env',
          projectScopeMode,
        });
        emitProjectScopeEvent({
          actor: 'cli-env',
          surface: 'cli_env',
          requestedCredential: { agentName: mapping.agent, credentialName: mapping.credentialName },
          decision,
        });
        if (!decision.allowed) {
          credentialCache.set(cacheKey, null);
          errors.push(`credential '${mapping.credentialName}': ${decision.code}: ${decision.remediation}`);
          return;
        }

        try {
          const requestedFields = Array.from(requestedFieldsByTarget.get(cacheKey) || []);
          const decrypted = await readCredential(
            baseUrl,
            readToken,
            meta.id,
            decryptFn,
            requestedFields,
          );
          credentialCache.set(cacheKey, decrypted);
        } catch (err) {
          credentialCache.set(cacheKey, null);
          errors.push(`credential '${mapping.credentialName}': ${getErrorMessage(err)}`);
        }
      }),
    );
  }

  for (const mapping of mappings) {
    const cacheKey = `${(mapping.agent || '').toLowerCase()}::${mapping.credentialName.toLowerCase()}`;
    const cred = credentialCache.get(cacheKey);
    if (!cred) {
      if (
        !errors.some((e) =>
          e.startsWith(`credential '${mapping.credentialName}'`),
        )
      ) {
        errors.push(
          `${mapping.envVar}: credential '${mapping.credentialName}' not found`,
        );
      } else {
        errors.push(
          `${mapping.envVar}: credential '${mapping.credentialName}' failed to resolve`,
        );
      }
      missing.push(mapping);
      continue;
    }
    const field = cred.fields.find(
      (f) => f.key.toLowerCase() === mapping.field.toLowerCase(),
    );
    if (!field) {
      const available = cred.fields.map((f) => f.key).join(', ');
      errors.push(
        `${mapping.envVar}: field '${mapping.field}' not found in '${mapping.credentialName}' (available: ${available})`,
      );
      continue;
    }
    resolved.set(mapping.envVar, field.value);
  }

  return { resolved, errors, missing };
}
