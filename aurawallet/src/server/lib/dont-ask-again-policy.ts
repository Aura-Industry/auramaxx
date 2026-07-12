const DEFAULT_ON_ALLOWLIST = new Set([
  'password',
  'cvv',
  'refresh_token',
]);

const HARD_DENYLIST = new Set([
  'privatekey',
  'private_key',
  'seedphrase',
  'seed_phrase',
  'mnemonic',
  'recovery_phrase',
]);

function norm(field: string): string {
  return field.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}

export interface DontAskAgainDecision {
  defaultOn: boolean;
  reason: 'ALLOWLIST_EXCLUDED_FIELD' | 'DENYLIST_SENSITIVE_FIELD' | 'MIXED_OR_UNKNOWN';
}

export function resolveDontAskAgainDefault(excludedFields: string[]): DontAskAgainDecision {
  const normalized = excludedFields.map(norm).filter(Boolean);
  if (!normalized.length) {
    return { defaultOn: false, reason: 'MIXED_OR_UNKNOWN' };
  }

  if (normalized.some((f) => HARD_DENYLIST.has(f))) {
    return { defaultOn: false, reason: 'DENYLIST_SENSITIVE_FIELD' };
  }

  const allAllowlisted = normalized.every((f) => DEFAULT_ON_ALLOWLIST.has(f));
  if (allAllowlisted) {
    return { defaultOn: true, reason: 'ALLOWLIST_EXCLUDED_FIELD' };
  }

  return { defaultOn: false, reason: 'MIXED_OR_UNKNOWN' };
}
