/**
 * Shared dotenv → agent migration logic.
 * Used by both `aura init --from-dotenv` and `aura env init`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseDotenv, groupByPrefix, noGrouping, generateAuraFile, type CredentialGroup } from './dotenv-parser';
import { createCredentialViaApi, getPrimaryAgentId } from './credential-create';

export interface MigrateOptions {
  token: string;
  envPath: string;
  noGroup?: boolean;
  dryRun?: boolean;
}

export interface MigrateResult {
  groups: CredentialGroup[];
  created: number;
  failed: number;
  auraPath: string;
}

/**
 * Migrate a .env file into the agent and generate a .aura file.
 * Returns summary of what was done.
 */
export async function migrateDotenv(opts: MigrateOptions): Promise<MigrateResult> {
  const { token, envPath, noGroup, dryRun } = opts;

  if (!fs.existsSync(envPath)) {
    throw new Error(`No .env file found at ${envPath}`);
  }

  const auraPath = path.join(path.dirname(envPath), '.aura');
  const shouldWriteAura = !fs.existsSync(auraPath);

  if (!shouldWriteAura && !dryRun) {
    console.log(`\n  Note: existing .aura file found at ${auraPath} — skipping overwrite.`);
  }

  const envContent = fs.readFileSync(envPath, 'utf-8');
  const vars = parseDotenv(envContent);

  if (vars.size === 0) {
    throw new Error('No variables found in .env file.');
  }

  const groups = noGroup ? noGrouping(vars) : groupByPrefix(vars);

  if (dryRun) {
    console.log(`\n  .env → .aura migration plan (${vars.size} variables → ${groups.length} credentials)\n`);
    for (const group of groups) {
      console.log(`  📦 ${group.name} (${group.fields.length} field${group.fields.length > 1 ? 's' : ''})`);
      for (const field of group.fields) {
        const preview = field.value.length > 20 ? field.value.substring(0, 20) + '...' : field.value;
        console.log(`     ${field.envVar} → ${group.name}/${field.key}  (${preview})`);
      }
    }
    console.log(`\n  Run without --dry-run to execute.\n`);
    return { groups, created: 0, failed: 0, auraPath };
  }

  const agentId = await getPrimaryAgentId(token);

  console.log(`\n  Migrating ${vars.size} variables → ${groups.length} credentials\n`);

  let created = 0;
  let failed = 0;

  for (const group of groups) {
    const result = await createCredentialViaApi({
      token,
      agentId,
      name: group.name,
      fields: group.fields.map(f => ({ key: f.key, value: f.value })),
    });

    if (result.success) {
      console.log(`  ✓ Created credential: ${group.name} (${group.fields.length} field${group.fields.length > 1 ? 's' : ''})`);
      created++;
    } else if (result.error?.includes('already exists') || result.error?.includes('duplicate')) {
      console.log(`  ⚠ Skipped credential: ${group.name} (already exists)`);
    } else {
      console.error(`  ✗ Failed to create ${group.name}: ${result.error}`);
      failed++;
    }
  }

  // Generate .aura file when needed
  if (shouldWriteAura) {
    const auraContent = generateAuraFile(groups);
    fs.writeFileSync(auraPath, auraContent, 'utf-8');
    console.log(`\n  ✓ Generated .aura file (${groups.length} credential${groups.length > 1 ? 's' : ''})`);
  }

  // Add .env to .gitignore
  const gitignorePath = path.join(path.dirname(envPath), '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    if (!gitignore.includes('.env')) {
      fs.appendFileSync(gitignorePath, '\n.env\n');
      console.log('  ✓ Added .env to .gitignore');
    }
  }

  console.log(`\n  Summary: ${created} created, ${failed} failed`);
  if (created > 0) {
    console.log('  Your .env variables are now in the agent.');
    console.log('  Use `aura env -- <cmd>` to run commands with agent-injected env vars.');
    console.log('  You can safely delete your .env file.\n');
  }

  return { groups, created, failed, auraPath };
}
