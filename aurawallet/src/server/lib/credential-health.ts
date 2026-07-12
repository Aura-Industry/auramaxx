import { createHash, createHmac } from 'crypto';
import { CredentialField, CredentialFile, CredentialType } from '../types';

export type CredentialHealthStatus =
  | 'unknown'
  | 'weak_reused_breached'
  | 'reused_breached'
  | 'weak_breached'
  | 'weak_reused'
  | 'breached'
  | 'reused'
  | 'weak'
  | 'safe';

export interface CredentialHealthFlags {
  weak: boolean;
  reused: boolean;
  breached: boolean;
  unknown: boolean;
}

export interface CredentialHealthSummary {
  total: number;
  safe: number;
  weak: number;
  reused: number;
  breached: number;
  unknown: number;
}

export interface CredentialHealthEnvelope {
  status: CredentialHealthStatus;
  flags: CredentialHealthFlags;
  evidence: {
    reuseCount: number;
    breachCount: number | null;
    weakReasons: Array<'short_length' | 'low_charset_diversity' | 'low_entropy_estimate'>;
  };
  lastScannedAt: string | null;
  engineVersion: string;
}

export interface CredentialHealthRow {
  id: string;
  name: string;
  type: CredentialType;
  agentId: string;
  health: CredentialHealthEnvelope;
}

const DEFAULT_CUSTOM_SENSITIVE_KEYS = new Set(['password', 'passwd', 'passphrase']);
const EXPANDED_CUSTOM_SENSITIVE_KEYS = new Set(['secret', 'token']);
const HEALTH_ENGINE_VERSION = '1';
const DEFAULT_TIMEOUT_MS = 4_000;
const HIBP_MAX_RETRIES = 2;

export function deriveCredentialHealthStatus(
  flags: CredentialHealthFlags,
  opts?: { allDimensionsUnavailable?: boolean },
): CredentialHealthStatus {
  if (opts?.allDimensionsUnavailable) return 'unknown';

  const { weak, reused, breached } = flags;

  if (weak && reused && breached) return 'weak_reused_breached';
  if (!weak && reused && breached) return 'reused_breached';
  if (weak && !reused && breached) return 'weak_breached';
  if (weak && reused && !breached) return 'weak_reused';
  if (breached) return 'breached';
  if (reused) return 'reused';
  if (weak) return 'weak';
  return 'safe';
}

export function summarizeCredentialHealthFlags(flagsList: CredentialHealthFlags[]): CredentialHealthSummary {
  const summary: CredentialHealthSummary = {
    total: flagsList.length,
    safe: 0,
    weak: 0,
    reused: 0,
    breached: 0,
    unknown: 0,
  };

  for (const flags of flagsList) {
    if (flags.weak) summary.weak += 1;
    if (flags.reused) summary.reused += 1;
    if (flags.breached) summary.breached += 1;
    if (flags.unknown) summary.unknown += 1;
    if (!flags.weak && !flags.reused && !flags.breached && !flags.unknown) {
      summary.safe += 1;
    }
  }

  return summary;
}

export function shouldScanSensitiveField(
  credentialType: CredentialType,
  key: string,
  opts?: { expandedCustomSensitiveKeys?: boolean },
): boolean {
  const normalizedKey = key.toLowerCase();

  if (credentialType === 'login') return normalizedKey === 'password';
  if (credentialType === 'card') return normalizedKey === 'pin';
  if (credentialType === 'api') return normalizedKey === 'passphrase';

  if (credentialType !== 'custom') return false;

  if (DEFAULT_CUSTOM_SENSITIVE_KEYS.has(normalizedKey)) return true;
  return !!opts?.expandedCustomSensitiveKeys && EXPANDED_CUSTOM_SENSITIVE_KEYS.has(normalizedKey);
}

function countByteFrequencies(bytes: Buffer): Map<number, number> {
  const counts = new Map<number, number>();
  for (const b of bytes) {
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  return counts;
}

function getCategoryCount(secret: string): number {
  let lower = false;
  let upper = false;
  let digit = false;
  let symbol = false;

  for (const ch of secret) {
    if (/[a-z]/.test(ch)) {
      lower = true;
    } else if (/[A-Z]/.test(ch)) {
      upper = true;
    } else if (/[0-9]/.test(ch)) {
      digit = true;
    } else {
      symbol = true;
    }
  }

  return Number(lower) + Number(upper) + Number(digit) + Number(symbol);
}

export interface WeaknessAnalysis {
  weak: boolean;
  reasons: Array<'short_length' | 'low_charset_diversity' | 'low_entropy_estimate'>;
  codePointLength: number;
  entropyBits: number;
  entropyBitsRounded: number;
  categoryCount: number;
}

export function analyzeSecretWeakness(secret: string, minEntropy = 50): WeaknessAnalysis {
  const codePointLength = [...secret].length;
  const categoryCount = getCategoryCount(secret);
  const bytes = Buffer.from(secret, 'utf8');

  let entropyPerByte = 0;
  if (bytes.length > 0) {
    const counts = countByteFrequencies(bytes);
    for (const count of counts.values()) {
      const p = count / bytes.length;
      entropyPerByte -= p * Math.log2(p);
    }
  }

  const entropyBits = entropyPerByte * bytes.length;
  const reasons: WeaknessAnalysis['reasons'] = [];

  if (codePointLength < 12) reasons.push('short_length');
  if (categoryCount < 3) reasons.push('low_charset_diversity');
  if (entropyBits < minEntropy) reasons.push('low_entropy_estimate');

  return {
    weak: reasons.length > 0,
    reasons,
    codePointLength,
    entropyBits,
    entropyBitsRounded: Math.round(entropyBits * 100) / 100,
    categoryCount,
  };
}

export type HealthLogPhase = 'normalize' | 'reuse' | 'weak' | 'hibp_fetch' | 'hibp_match' | 'persist';
export type HealthLogErrorClass = 'timeout' | 'network' | 'rate_limit' | 'parse' | 'internal';

const HEALTH_LOG_ALLOWLIST = new Set([
  'credentialId',
  'agentId',
  'scanId',
  'phase',
  'errorClass',
  'processed',
  'total',
  'durationMs',
]);

export function redactHealthLogMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (HEALTH_LOG_ALLOWLIST.has(key)) {
      redacted[key] = value;
    }
  }
  return redacted;
}

function firstEligibleSecret(credential: CredentialFile, fields: CredentialField[]): string | null {
  const expanded = process.env.HEALTH_SCAN_CUSTOM_SENSITIVE_KEYS === 'true';
  const field = fields.find((f) => shouldScanSensitiveField(credential.type, f.key, { expandedCustomSensitiveKeys: expanded }));
  return field?.value ?? null;
}

function secretReuseDigest(secret: string): string {
  const pepper = process.env.HEALTH_SECRET_PEPPER || 'auramaxx-health-pepper-dev';
  return createHmac('sha256', pepper).update(secret, 'utf8').digest('hex');
}

function sha1Hex(secret: string): string {
  return createHash('sha1').update(secret, 'utf8').digest('hex').toUpperCase();
}

const hibpCache = new Map<string, { expiresAt: number; lines: string[] }>();

async function hibpRangeLookup(prefix: string, fetchImpl: typeof fetch): Promise<string[]> {
  const cached = hibpCache.get(prefix);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.lines;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Add-Padding': 'true',
      },
    });

    if (!response.ok) {
      throw new Error(`HIBP range lookup failed (${response.status})`);
    }

    const body = await response.text();
    const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
    hibpCache.set(prefix, { expiresAt: now + 24 * 60 * 60 * 1000, lines });
    return lines;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveBreachCount(secret: string, fetchImpl: typeof fetch): Promise<number | null> {
  const full = sha1Hex(secret);
  const prefix = full.slice(0, 5);
  const suffix = full.slice(5);

  for (let attempt = 0; attempt <= HIBP_MAX_RETRIES; attempt++) {
    try {
      const lines = await hibpRangeLookup(prefix, fetchImpl);
      for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const lineSuffix = line.slice(0, idx).trim();
        if (lineSuffix.toUpperCase() !== suffix) continue;
        const count = Number.parseInt(line.slice(idx + 1).trim(), 10);
        return Number.isFinite(count) ? count : 0;
      }
      return 0;
    } catch {
      if (attempt === HIBP_MAX_RETRIES) return null;
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 750));
    }
  }

  return null;
}

export async function buildCredentialHealthRows(
  credentials: CredentialFile[],
  readSecrets: (credentialId: string) => CredentialField[],
  opts?: { fetchImpl?: typeof fetch; minEntropy?: number },
): Promise<CredentialHealthRow[]> {
  const fetchImpl = opts?.fetchImpl || fetch;
  const minEntropy = opts?.minEntropy ?? Number(process.env.HEALTH_MIN_ENTROPY || 50);

  const usable: Array<{ credential: CredentialFile; secret: string }> = [];

  for (const credential of credentials) {
    try {
      const secrets = readSecrets(credential.id);
      const secret = firstEligibleSecret(credential, secrets);
      if (!secret) continue;
      usable.push({ credential, secret });
    } catch {
      // Skip locked/inaccessible credential.
    }
  }

  const reuseClusters = new Map<string, number>();
  for (const entry of usable) {
    const digest = secretReuseDigest(entry.secret);
    reuseClusters.set(digest, (reuseClusters.get(digest) || 0) + 1);
  }

  const rows: CredentialHealthRow[] = [];
  for (const entry of usable) {
    const weakness = analyzeSecretWeakness(entry.secret, minEntropy);
    const reuseCount = reuseClusters.get(secretReuseDigest(entry.secret)) || 1;
    const breachChecksEnabled = process.env.HEALTH_BREACH_CHECK === 'true';
    const breachCount = breachChecksEnabled ? await resolveBreachCount(entry.secret, fetchImpl) : null;

    const flags: CredentialHealthFlags = {
      weak: weakness.weak,
      reused: reuseCount >= 2,
      breached: typeof breachCount === 'number' && breachCount > 0,
      unknown: breachCount === null,
    };

    const allDimensionsUnavailable = breachCount === null && !flags.weak && !flags.reused;

    rows.push({
      id: entry.credential.id,
      name: entry.credential.name,
      type: entry.credential.type,
      agentId: entry.credential.agentId,
      health: {
        status: deriveCredentialHealthStatus(flags, { allDimensionsUnavailable }),
        flags,
        evidence: {
          reuseCount,
          breachCount,
          weakReasons: weakness.reasons,
        },
        lastScannedAt: new Date().toISOString(),
        engineVersion: HEALTH_ENGINE_VERSION,
      },
    });
  }

  return rows;
}
