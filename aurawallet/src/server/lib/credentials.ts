/**
 * Credential CRUD — Encrypted Credential File Management
 * =======================================================
 *
 * Create, read, update, delete credential files in ~/.auramaxx/credentials/.
 * Sensitive fields are encrypted with the agent's derived credential key.
 * Non-sensitive metadata is stored as plaintext for search/filtering.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { DATA_PATHS } from './config';
import { getCredentialAgentKey } from './credential-agent';
import { encryptWithSeed, decryptWithSeed } from './encrypt';
import { CredentialType, CredentialField, CredentialFile, EncryptedData } from '../types';

export type CredentialLocation = 'active' | 'archive' | 'recently_deleted';
const CREDENTIAL_ID_PATTERN = /^cred-[a-z0-9]{8}$/;

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateCredentialId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(8);
  let id = 'cred-';
  for (let i = 0; i < 8; i++) {
    id += chars[bytes[i] % chars.length];
  }
  return id;
}

export function isValidCredentialId(id: string): boolean {
  return CREDENTIAL_ID_PATTERN.test(id);
}

function assertValidCredentialId(id: string): string {
  const normalized = id.trim();
  if (!isValidCredentialId(normalized)) {
    throw new Error(`Invalid credential id: ${id}`);
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function getCredentialsDir(location: CredentialLocation): string {
  if (location === 'archive') return DATA_PATHS.credentialsArchive;
  if (location === 'recently_deleted') return DATA_PATHS.credentialsRecentlyDeleted;
  return DATA_PATHS.credentials;
}

function getCredentialPath(id: string, location: CredentialLocation = 'active'): string {
  const safeId = assertValidCredentialId(id);
  const baseDir = path.resolve(getCredentialsDir(location));
  const resolved = path.resolve(baseDir, `${safeId}.json`);
  if (!resolved.startsWith(`${baseDir}${path.sep}`)) {
    throw new Error(`Resolved credential path escapes base directory for id: ${id}`);
  }
  return resolved;
}

function readCredentialFile(id: string, location: CredentialLocation = 'active'): CredentialFile | null {
  let filePath: string;
  try {
    filePath = getCredentialPath(id, location);
  } catch {
    return null;
  }
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeCredentialFile(cred: CredentialFile, location: CredentialLocation = 'active'): void {
  const dir = getCredentialsDir(location);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = getCredentialPath(cred.id, location);
  fs.writeFileSync(filePath, JSON.stringify(cred, null, 2));
}

function moveCredentialFile(
  id: string,
  from: CredentialLocation,
  to: CredentialLocation,
): CredentialFile | null {
  let sourcePath: string;
  let destinationPath: string;
  try {
    sourcePath = getCredentialPath(id, from);
    destinationPath = getCredentialPath(id, to);
  } catch {
    return null;
  }
  if (!fs.existsSync(sourcePath)) return null;

  const destinationDir = getCredentialsDir(to);
  if (!fs.existsSync(destinationDir)) {
    fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  }

  fs.renameSync(sourcePath, destinationPath);
  return readCredentialFile(id, to);
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Create a new credential.
 * Encrypts sensitive fields with the agent's derived credential key.
 */
export function createCredential(
  agentId: string,
  type: CredentialType,
  name: string,
  meta: Record<string, unknown>,
  sensitiveFields: CredentialField[]
): CredentialFile {
  const agentKey = getCredentialAgentKey(agentId);
  if (!agentKey) {
    throw new Error(`Credential agent for ${agentId} is locked`);
  }

  const id = generateCredentialId();
  const now = new Date().toISOString();

  const encrypted = encryptWithSeed(JSON.stringify(sensitiveFields), agentKey);

  // Store which sensitive keys exist so the UI can conditionally render fields
  meta.sensitive_field_keys = sensitiveFields.map(f => f.key);

  const cred: CredentialFile = {
    id,
    agentId,
    type,
    name,
    meta,
    encrypted,
    createdAt: now,
    updatedAt: now,
  };

  writeCredentialFile(cred);
  return cred;
}

/**
 * Get credential metadata (no decryption).
 */
export function getCredential(id: string, location: CredentialLocation = 'active'): CredentialFile | null {
  return readCredentialFile(id, location);
}

export function findCredentialLocation(id: string): CredentialLocation | null {
  if (readCredentialFile(id, 'active')) return 'active';
  if (readCredentialFile(id, 'archive')) return 'archive';
  if (readCredentialFile(id, 'recently_deleted')) return 'recently_deleted';
  return null;
}

/**
 * Decrypt and return the sensitive fields of a credential.
 */
export function readCredentialSecrets(id: string, location: CredentialLocation = 'active'): CredentialField[] {
  const cred = readCredentialFile(id, location);
  if (!cred) {
    throw new Error(`Credential not found: ${id}`);
  }

  const agentKey = getCredentialAgentKey(cred.agentId);
  if (!agentKey) {
    throw new Error(`Credential agent for ${cred.agentId} is locked`);
  }

  const decrypted = decryptWithSeed(cred.encrypted, agentKey);
  return JSON.parse(decrypted) as CredentialField[];
}

/**
 * Update a credential's metadata and/or sensitive fields.
 */
export function updateCredential(
  id: string,
  updates: {
    name?: string;
    meta?: Record<string, unknown>;
    sensitiveFields?: CredentialField[];
  }
): CredentialFile {
  const cred = readCredentialFile(id, 'active');
  if (!cred) {
    throw new Error(`Credential not found: ${id}`);
  }

  if (updates.name !== undefined) {
    cred.name = updates.name;
  }

  if (updates.meta !== undefined) {
    cred.meta = updates.meta;
  }

  if (updates.sensitiveFields !== undefined) {
    const agentKey = getCredentialAgentKey(cred.agentId);
    if (!agentKey) {
      throw new Error(`Credential agent for ${cred.agentId} is locked`);
    }
    cred.encrypted = encryptWithSeed(JSON.stringify(updates.sensitiveFields), agentKey);
    // Update which sensitive keys exist so the UI can conditionally render fields
    cred.meta.sensitive_field_keys = updates.sensitiveFields.map(f => f.key);
  }

  cred.updatedAt = new Date().toISOString();
  writeCredentialFile(cred, 'active');
  return cred;
}

/**
 * Duplicate an existing credential.
 * Decrypts the source credential's sensitive fields and re-encrypts them into a new credential.
 */
export function duplicateCredential(
  id: string,
  overrides?: { name?: string; agentId?: string },
): CredentialFile {
  const source = readCredentialFile(id, 'active');
  if (!source) {
    throw new Error(`Credential not found: ${id}`);
  }

  const sourceAgentKey = getCredentialAgentKey(source.agentId);
  if (!sourceAgentKey) {
    throw new Error(`Credential agent for ${source.agentId} is locked`);
  }

  const decrypted = decryptWithSeed(source.encrypted, sourceAgentKey);
  const sensitiveFields: CredentialField[] = JSON.parse(decrypted);

  const targetAgentId = overrides?.agentId ?? source.agentId;
  const targetAgentKey = getCredentialAgentKey(targetAgentId);
  if (!targetAgentKey) {
    throw new Error(`Credential agent for ${targetAgentId} is locked`);
  }

  const newId = generateCredentialId();
  const now = new Date().toISOString();
  const newName = overrides?.name ?? `${source.name} (copy)`;
  const meta = JSON.parse(JSON.stringify(source.meta));
  const encrypted = encryptWithSeed(JSON.stringify(sensitiveFields), targetAgentKey);

  const cred: CredentialFile = {
    id: newId,
    agentId: targetAgentId,
    type: source.type,
    name: newName,
    meta,
    encrypted,
    createdAt: now,
    updatedAt: now,
  };

  writeCredentialFile(cred);
  return cred;
}

/**
 * Permanently delete a credential file in the given location.
 */
export function deleteCredential(id: string, location: CredentialLocation = 'active'): boolean {
  let filePath: string;
  try {
    filePath = getCredentialPath(id, location);
  } catch {
    return false;
  }
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function archiveCredential(id: string): CredentialFile | null {
  const moved = moveCredentialFile(id, 'active', 'archive');
  if (!moved) return null;

  const now = new Date().toISOString();
  moved.archivedAt = now;
  delete moved.deletedAt;
  moved.updatedAt = now;
  writeCredentialFile(moved, 'archive');
  return moved;
}

export function deleteArchivedCredential(id: string): CredentialFile | null {
  const moved = moveCredentialFile(id, 'archive', 'recently_deleted');
  if (!moved) return null;

  const now = new Date().toISOString();
  moved.archivedAt = moved.archivedAt || now;
  moved.deletedAt = now;
  moved.updatedAt = now;
  writeCredentialFile(moved, 'recently_deleted');
  return moved;
}

export function restoreArchivedCredential(id: string): CredentialFile | null {
  const moved = moveCredentialFile(id, 'archive', 'active');
  if (!moved) return null;

  delete moved.archivedAt;
  delete moved.deletedAt;
  moved.updatedAt = new Date().toISOString();
  writeCredentialFile(moved, 'active');
  return moved;
}

export function restoreDeletedCredential(id: string): CredentialFile | null {
  const moved = moveCredentialFile(id, 'recently_deleted', 'archive');
  if (!moved) return null;

  moved.archivedAt = moved.archivedAt || new Date().toISOString();
  delete moved.deletedAt;
  moved.updatedAt = new Date().toISOString();
  writeCredentialFile(moved, 'archive');
  return moved;
}

export function purgeDeletedCredentials(retentionDays = 30): {
  scanned: number;
  purged: number;
  errors: Array<{ id: string; error: string }>;
} {
  const dir = getCredentialsDir('recently_deleted');
  if (!fs.existsSync(dir)) {
    return { scanned: 0, purged: 0, errors: [] };
  }

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(dir).filter(file => file.startsWith('cred-') && file.endsWith('.json'));
  const errors: Array<{ id: string; error: string }> = [];
  let purged = 0;

  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    try {
      const cred = readCredentialFile(id, 'recently_deleted');
      if (!cred) continue;

      const deletedAt = cred.deletedAt || cred.updatedAt || cred.createdAt;
      const deletedMs = Date.parse(deletedAt);
      if (Number.isNaN(deletedMs)) continue;

      if (deletedMs <= cutoffMs) {
        deleteCredential(id, 'recently_deleted');
        purged += 1;
      }
    } catch (error) {
      errors.push({
        id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return {
    scanned: files.length,
    purged,
    errors,
  };
}

/**
 * List credentials with optional filters.
 * Returns metadata only (no decryption).
 */
export function listCredentials(filters?: {
  agentId?: string;
  type?: CredentialType;
  tag?: string;
  query?: string;
}, location: CredentialLocation = 'active'): CredentialFile[] {
  const dir = getCredentialsDir(location);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir);
  const results: CredentialFile[] = [];

  for (const file of files) {
    if (!file.startsWith('cred-') || !file.endsWith('.json')) continue;

    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const cred: CredentialFile = JSON.parse(raw);

      // Apply filters
      if (filters?.agentId && cred.agentId !== filters.agentId) continue;
      if (filters?.type && cred.type !== filters.type) continue;
      if (filters?.tag) {
        const tags = (cred.meta.tags as string[] | undefined) || [];
        if (!tags.some(t => t.toLowerCase() === filters.tag!.toLowerCase())) continue;
      }
      if (filters?.query) {
        const q = filters.query.toLowerCase();
        if (!cred.name.toLowerCase().includes(q) && !cred.id.toLowerCase().includes(q)) continue;
      }

      results.push(cred);
    } catch {
      // skip corrupt files
    }
  }

  // Sort by updatedAt descending
  results.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return results;
}
