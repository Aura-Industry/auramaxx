/**
 * One-time boot migration: agent-profiles.json → Prisma AgentProfile table.
 *
 * Runs on server startup. If the JSON file exists, reads all entries,
 * inserts them into the AgentProfile table, then deletes the JSON file.
 * Idempotent: if the file doesn't exist, this is a no-op.
 */
import fs from 'fs';
import path from 'path';
import { prisma } from './db';
import { DATA_PATHS } from './config';
import { log } from './pino';

const AGENT_PROFILES_FILE = 'agent-profiles.json';

interface LegacyProfileRecord {
  agentId: string;
  email?: string;
  phone?: string;
  address?: string;
  profileImage?: string;
  attributes?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

interface LegacyProfilesFile {
  version: number;
  profiles: Record<string, LegacyProfileRecord>;
}

export async function migrateAgentProfilesToPrisma(): Promise<void> {
  const filePath = path.join(DATA_PATHS.wallets, AGENT_PROFILES_FILE);

  if (!fs.existsSync(filePath)) {
    return; // Nothing to migrate
  }

  let store: LegacyProfilesFile;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    store = JSON.parse(raw) as LegacyProfilesFile;
  } catch (err) {
    log.warn({ err, filePath }, 'Failed to read agent-profiles.json for migration, skipping');
    return;
  }

  if (!store || typeof store !== 'object' || !store.profiles || typeof store.profiles !== 'object') {
    log.warn({ filePath }, 'agent-profiles.json has unexpected format, skipping migration');
    return;
  }

  const entries = Object.values(store.profiles);
  if (entries.length === 0) {
    // Empty file, just delete it
    fs.unlinkSync(filePath);
    log.info('Deleted empty agent-profiles.json');
    return;
  }

  let migrated = 0;
  for (const entry of entries) {
    if (!entry.agentId) continue;
    try {
      await prisma.agentProfile.upsert({
        where: { agentId: entry.agentId },
        create: {
          agentId: entry.agentId,
          email: entry.email ?? null,
          phone: entry.phone ?? null,
          address: entry.address ?? null,
          profileImage: entry.profileImage ?? null,
          attributes: entry.attributes ? JSON.stringify(entry.attributes) : null,
        },
        update: {
          email: entry.email ?? null,
          phone: entry.phone ?? null,
          address: entry.address ?? null,
          profileImage: entry.profileImage ?? null,
          attributes: entry.attributes ? JSON.stringify(entry.attributes) : null,
        },
      });
      migrated++;
    } catch (err) {
      log.error({ err, agentId: entry.agentId }, 'Failed to migrate agent profile');
    }
  }

  // Delete the JSON file after successful migration
  try {
    fs.unlinkSync(filePath);
    log.info({ migrated, total: entries.length }, 'Migrated agent profiles from JSON to Prisma');
  } catch (err) {
    log.warn({ err, filePath }, 'Failed to delete agent-profiles.json after migration');
  }
}
