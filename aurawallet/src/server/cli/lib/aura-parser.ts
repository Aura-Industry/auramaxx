/**
 * .aura file parser — shared between env.ts and init.ts
 */

import * as fs from 'fs';
import {
  type AuraMapping,
  validateEnvVarName,
} from './credential-resolve';

export { type AuraMapping } from './credential-resolve';

/**
 * Parse a .aura file into an array of env-var → credential mappings.
 */
export function parseAuraFile(filePath: string): AuraMapping[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const mappings: AuraMapping[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      throw new Error(`Invalid line in .aura (missing '='): ${line}`);
    }

    const envVar = line.substring(0, eqIdx).trim();
    const ref = line.substring(eqIdx + 1).trim();

    if (!envVar || !ref) {
      throw new Error(`Invalid line in .aura: ${line}`);
    }

    // Validate env var name (audit finding #6)
    validateEnvVarName(envVar);

    let agent: string | null = null;
    let credentialName: string;
    let field: string;

    if (ref.startsWith('@')) {
      const parts = ref.substring(1).split('/');
      if (parts.length < 3) {
        throw new Error(`Invalid agent reference (expected @agent/credential/field): ${ref}`);
      }
      agent = parts[0];
      credentialName = parts[1];
      field = parts.slice(2).join('/');
    } else {
      const parts = ref.split('/');
      if (parts.length < 2) {
        throw new Error(`Invalid reference (expected credential/field): ${ref}`);
      }
      credentialName = parts[0];
      field = parts.slice(1).join('/');
    }

    mappings.push({ envVar, agent, credentialName, field });
  }

  return mappings;
}
