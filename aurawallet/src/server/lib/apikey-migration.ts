import { prisma } from './db';
import { createCredential, deleteCredential, getCredential, listCredentials, readCredentialSecrets, updateCredential } from './credentials';
import { getPrimaryAgentId, isAgentUnlocked, listAgents } from './cold';
import { CredentialField, CredentialFile } from '../types';
import { normalizeScope } from './credential-scope';

const APIKEY_TYPE = 'apikey';
export const APIKEY_DB_PLACEHOLDER = '__AURAMAXX_AGENT_ONLY__';

let migrationInFlight: Promise<void> | null = null;
let migrationSettled = false;

export interface ApiKeyCredentialRecord {
  id: string;
  service: string;
  name: string;
  keyMasked: string;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

function getActiveAgentId(): string | null {
  const primary = getPrimaryAgentId();
  if (primary && isAgentUnlocked(primary)) {
    return primary;
  }
  const unlocked = listAgents().find(agent => agent.isUnlocked);
  return unlocked?.id || null;
}

function parseMetadata(metadata: string | null): unknown {
  if (!metadata) return null;
  try {
    return JSON.parse(metadata);
  } catch {
    return metadata;
  }
}

export function maskKey(key: string): string {
  if (key.length <= 8) {
    return '*'.repeat(key.length);
  }
  return `${key.slice(0, 4)}${'*'.repeat(key.length - 8)}${key.slice(-4)}`;
}

function listApiKeyCredentialsRaw(): CredentialFile[] {
  return listCredentials({ type: APIKEY_TYPE });
}

function findApiKeyCredential(service: string, name: string): CredentialFile | null {
  const normalizedService = normalizeScope(service);
  const normalizedName = normalizeScope(name);

  for (const credential of listApiKeyCredentialsRaw()) {
    const metaService = typeof credential.meta.service === 'string' ? normalizeScope(credential.meta.service) : '';
    const metaName = typeof credential.meta.name === 'string' ? normalizeScope(credential.meta.name) : '';
    if (metaService === normalizedService && metaName === normalizedName) {
      return credential;
    }
  }

  return null;
}

function findApiKeyCredentialsByService(service: string): CredentialFile[] {
  const normalizedService = normalizeScope(service);
  return listApiKeyCredentialsRaw().filter((credential) => {
    const metaService = typeof credential.meta.service === 'string' ? normalizeScope(credential.meta.service) : '';
    return metaService === normalizedService;
  });
}

function toApiKeyRecord(credential: CredentialFile): ApiKeyCredentialRecord {
  const service = typeof credential.meta.service === 'string' ? credential.meta.service : '';
  const name = typeof credential.meta.name === 'string' ? credential.meta.name : credential.name;
  const keyMasked = typeof credential.meta.keyMasked === 'string' ? credential.meta.keyMasked : '********';

  return {
    id: credential.id,
    service,
    name,
    keyMasked,
    metadata: credential.meta.metadata ?? null,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

function buildApiKeyMeta(service: string, name: string, key: string, metadata: unknown): Record<string, unknown> {
  return {
    service,
    name,
    tags: [normalizeScope(service)],
    keyMasked: maskKey(key),
    metadata: metadata ?? null,
  };
}

function apiKeySecretField(key: string): CredentialField[] {
  return [{ key: 'key', value: key, type: 'secret', sensitive: true }];
}

function isLegacyPlaintextKey(value: string): boolean {
  return value.trim().length > 0 && value !== APIKEY_DB_PLACEHOLDER;
}

export async function migrateApiKeysFromDatabase(): Promise<{
  migrated: number;
  skipped: number;
  reason?: string;
}> {
  const rows = await prisma.apiKey.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) {
    return { migrated: 0, skipped: 0 };
  }

  const agentId = getActiveAgentId();
  if (!agentId) {
    return { migrated: 0, skipped: rows.length, reason: 'No unlocked agent available for credential migration' };
  }

  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!isLegacyPlaintextKey(row.key)) {
      skipped++;
      continue;
    }
    const existing = findApiKeyCredential(row.service, row.name);
    const meta = buildApiKeyMeta(row.service, row.name, row.key, parseMetadata(row.metadata));
    if (existing) {
      updateCredential(existing.id, {
        meta,
        sensitiveFields: apiKeySecretField(row.key),
      });
    } else {
      createCredential(agentId, APIKEY_TYPE, `${row.service}:${row.name}`, meta, apiKeySecretField(row.key));
    }
    await prisma.apiKey.update({
      where: { id: row.id },
      data: {
        key: APIKEY_DB_PLACEHOLDER,
        updatedAt: new Date(),
      },
    });
    migrated++;
  }

  return { migrated, skipped };
}

export async function ensureApiKeysMigrated(): Promise<void> {
  if (migrationSettled) return;
  if (!migrationInFlight) {
    migrationInFlight = (async () => {
      const result = await migrateApiKeysFromDatabase();
      if (!result.reason) {
        migrationSettled = true;
      }
    })().finally(() => {
      migrationInFlight = null;
    });
  }
  await migrationInFlight;
}

export function listApiKeyCredentials(): ApiKeyCredentialRecord[] {
  return listApiKeyCredentialsRaw().map(toApiKeyRecord);
}

export function upsertApiKeyCredential(
  service: string,
  name: string,
  key: string,
  metadata: unknown,
): ApiKeyCredentialRecord {
  const agentId = getActiveAgentId();
  if (!agentId) {
    throw new Error('No unlocked agent available for API key credential storage');
  }

  const existing = findApiKeyCredential(service, name);
  const nextMeta = buildApiKeyMeta(service, name, key, metadata);

  const credential = existing
    ? updateCredential(existing.id, {
      meta: nextMeta,
      sensitiveFields: apiKeySecretField(key),
    })
    : createCredential(
      agentId,
      APIKEY_TYPE,
      `${service}:${name}`,
      nextMeta,
      apiKeySecretField(key),
    );

  return toApiKeyRecord(credential);
}

export function deleteApiKeyCredentialById(id: string): ApiKeyCredentialRecord | null {
  const credential = getCredential(id);
  if (!credential || credential.type !== APIKEY_TYPE) {
    return null;
  }
  const record = toApiKeyRecord(credential);
  deleteCredential(id);
  return record;
}

export function deleteApiKeyCredentialByServiceName(service: string, name: string): ApiKeyCredentialRecord | null {
  const credential = findApiKeyCredential(service, name);
  if (!credential) {
    return null;
  }
  const record = toApiKeyRecord(credential);
  deleteCredential(credential.id);
  return record;
}

export function readApiKeyValueByServiceName(service: string, name: string): string | null {
  const credential = findApiKeyCredential(service, name);
  if (!credential) return null;
  try {
    const fields = readCredentialSecrets(credential.id);
    const keyField = fields.find(field => normalizeScope(field.key) === 'key');
    return keyField?.value || null;
  } catch {
    return null;
  }
}

export function readApiKeyValueByService(service: string): string | null {
  const credentials = findApiKeyCredentialsByService(service);
  if (credentials.length === 0) return null;

  const preferred = credentials.find((credential) => {
    const metaName = typeof credential.meta.name === 'string' ? normalizeScope(credential.meta.name) : '';
    return metaName === 'default';
  }) || credentials[0];

  try {
    const fields = readCredentialSecrets(preferred.id);
    const keyField = fields.find(field => normalizeScope(field.key) === 'key');
    return keyField?.value || null;
  } catch {
    return null;
  }
}

export function hasActiveApiKeyCredential(service: string): boolean {
  return findApiKeyCredentialsByService(service).length > 0;
}
