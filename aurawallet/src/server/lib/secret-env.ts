const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeEnvVarName(input: string | undefined): string | null {
  const candidate = String(input || '').trim();
  if (!candidate) return null;
  if (!ENV_VAR_NAME_RE.test(candidate)) return null;
  return candidate;
}

export function defaultSecretEnvVarName(secretName: string | undefined): string {
  const normalized = String(secretName || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return `AURA_${normalized || 'SECRET'}`;
}
