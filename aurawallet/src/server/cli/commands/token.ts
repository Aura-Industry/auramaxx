/**
 * auramaxx token — Profile-first token tooling
 *
 * Usage:
 *   npx auramaxx token preview --profile dev
 *   npx auramaxx token preview --profile dev --profile-version v1 --json
 *   npx auramaxx token preview --profile dev --overrides '{"ttlSeconds":900}'
 *
 * Auth:
 *   Requires admin token in AURA_TOKEN (or --token <token>)
 */

import { fetchJson } from '../lib/http';
import { getErrorMessage } from '../../lib/error';

type Json = Record<string, unknown>;

interface PolicyPreviewResponse {
  version: string;
  profile: { id: string; version: string; displayName?: string; rationale?: string };
  request: {
    profile: string;
    profileVersion?: string;
    profileOverrides?: Json;
  };
  effectivePolicy: {
    permissions: string[];
    credentialAccess: { read: string[]; write: string[] };
    excludeFields: string[];
    ttlSeconds: number;
    maxReads: number | null;
    rateBudget: {
      state: 'none' | 'inherited' | 'explicit';
      requests: number | null;
      windowSeconds: number | null;
      source: 'none' | 'profile' | 'override';
    };
  };
  effectivePolicyHash: string;
  warnings: string[];
  denyExamples: Array<{ code: string; message: string }>;
}

export interface TokenCliArgs {
  subcommand?: string;
  profile?: string;
  profileVersion?: string;
  overridesRaw?: string;
  token?: string;
  json: boolean;
}

export function parseTokenArgs(args: string[]): TokenCliArgs {
  const getValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  return {
    subcommand: args[0],
    profile: getValue('--profile'),
    profileVersion: getValue('--profile-version'),
    overridesRaw: getValue('--overrides'),
    token: getValue('--token'),
    json: args.includes('--json'),
  };
}

function parseOverrides(raw?: string): Json | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--overrides must be a JSON object');
  }
  return parsed as Json;
}

export function formatPolicyPreview(preview: PolicyPreviewResponse): string {
  const lines: string[] = [];
  lines.push(`Profile: ${preview.profile.id}@${preview.profile.version}`);
  lines.push(`Hash: ${preview.effectivePolicyHash}`);
  lines.push(`Permissions: ${preview.effectivePolicy.permissions.join(', ') || '(none)'}`);
  lines.push(`Credential read scope: ${preview.effectivePolicy.credentialAccess.read.join(', ') || '(none)'}`);
  lines.push(`Credential write scope: ${preview.effectivePolicy.credentialAccess.write.join(', ') || '(none)'}`);
  lines.push(`Excluded fields: ${preview.effectivePolicy.excludeFields.join(', ') || '(none)'}`);
  lines.push(`TTL seconds: ${preview.effectivePolicy.ttlSeconds}`);
  lines.push(`Max reads: ${preview.effectivePolicy.maxReads ?? 'unlimited'}`);

  const rb = preview.effectivePolicy.rateBudget;
  lines.push(`Rate budget: ${rb.state} (${rb.requests ?? 'n/a'} / ${rb.windowSeconds ?? 'n/a'}s, source=${rb.source})`);

  if (preview.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of preview.warnings) lines.push(`  - ${warning}`);
  }

  if (preview.denyExamples.length > 0) {
    lines.push('Expected deny examples:');
    for (const deny of preview.denyExamples) lines.push(`  - ${deny.code}: ${deny.message}`);
  }

  return lines.join('\n');
}

function showHelp(): void {
  console.log(`
  auramaxx token — Token policy preview

  Usage:
    npx auramaxx token preview --profile <id> [--profile-version <v>] [--overrides <json>] [--json]

  Options:
    --profile <id>          Profile id (required)
    --profile-version <v>   Profile version (default: v1)
    --overrides <json>      JSON object for profile overrides (tighten-only)
    --json                  Print raw PolicyPreviewV1 payload
    --token <token>         Admin token (falls back to AURA_TOKEN env)

  Examples:
    npx auramaxx token preview --profile dev
    npx auramaxx token preview --profile dev --profile-version v1 --json
    npx auramaxx token preview --profile dev --overrides '{"ttlSeconds":900}'
`);
}

async function main(): Promise<void> {
  const parsed = parseTokenArgs(process.argv.slice(2));

  if (!parsed.subcommand || parsed.subcommand === '--help' || parsed.subcommand === '-h') {
    showHelp();
    process.exit(0);
  }

  if (parsed.subcommand !== 'preview') {
    console.error(`Unknown token subcommand: ${parsed.subcommand}`);
    showHelp();
    process.exit(1);
  }

  if (!parsed.profile) {
    console.error('--profile is required');
    process.exit(1);
  }

  const token = parsed.token || process.env.AURA_TOKEN;
  if (!token) {
    console.error('Admin auth required. Provide --token or set AURA_TOKEN.');
    process.exit(1);
  }

  try {
    const profileOverrides = parseOverrides(parsed.overridesRaw);
    const preview = await fetchJson<PolicyPreviewResponse>('/actions/token/preview', {
      method: 'POST',
      token,
      body: {
        profile: parsed.profile,
        profileVersion: parsed.profileVersion,
        profileOverrides,
      },
    });

    if (parsed.json) {
      console.log(JSON.stringify(preview, null, 2));
      return;
    }

    console.log(formatPolicyPreview(preview));
  } catch (error) {
    console.error(`Token preview failed: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Token preview failed: ${getErrorMessage(error)}`);
    process.exit(1);
  });
}
