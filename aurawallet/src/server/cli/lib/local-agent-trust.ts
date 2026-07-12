import type { LocalAgentProfileMode } from '../../lib/agent-profiles';
import { fetchJson } from './http';

export interface LocalAgentTrustDefaults {
  profile: LocalAgentProfileMode;
  profileVersion: 'v1';
  autoApprove: boolean;
}

export function resolveLocalAgentModeChoice(input: string): LocalAgentProfileMode {
  const normalized = input.trim().toLowerCase();
  if (normalized === '1' || normalized === 'admin' || normalized === 'maxx' || normalized === 'work') return 'admin';
  if (normalized === '3' || normalized === 'strict' || normalized === 'sus' || normalized === 'local') return 'strict';
  if (normalized === '2' || normalized === 'dev' || normalized === 'mid' || normalized === 'recommended') return 'dev';
  return 'admin';
}

export function toLocalAgentTrustDefaults(profile: LocalAgentProfileMode): LocalAgentTrustDefaults {
  return {
    profile,
    profileVersion: 'v1',
    autoApprove: profile !== 'strict',
  };
}

export async function persistLocalAgentTrustDefaults(token: string, profile: LocalAgentProfileMode): Promise<LocalAgentTrustDefaults> {
  const defaults = toLocalAgentTrustDefaults(profile);

  await fetchJson('/defaults/trust.localProfile', {
    method: 'PATCH',
    body: { value: defaults.profile },
    token,
  });
  await fetchJson('/defaults/trust.localProfileVersion', {
    method: 'PATCH',
    body: { value: defaults.profileVersion },
    token,
  });
  await fetchJson('/defaults/trust.localAutoApprove', {
    method: 'PATCH',
    body: { value: defaults.autoApprove },
    token,
  });

  return defaults;
}
