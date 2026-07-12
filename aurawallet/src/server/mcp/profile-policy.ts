import type { ProfileIssuanceSelection } from '../lib/credential-transport';

function parseOverrides(raw: string | undefined): ProfileIssuanceSelection['profileOverrides'] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as ProfileIssuanceSelection['profileOverrides'];
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function resolveMcpIssuanceProfile(
  kind: 'read' | 'write',
  env: NodeJS.ProcessEnv = process.env,
): ProfileIssuanceSelection | undefined {
  const prefix = kind === 'read' ? 'AURA_MCP_READ_PROFILE' : 'AURA_MCP_WRITE_PROFILE';
  const profile = env[prefix]?.trim();
  if (!profile) return undefined;

  const version = env[`${prefix}_VERSION`]?.trim();
  const overrides = parseOverrides(env[`${prefix}_OVERRIDES_JSON`]);

  return {
    profile,
    ...(version ? { profileVersion: version } : {}),
    ...(overrides ? { profileOverrides: overrides } : {}),
  };
}
