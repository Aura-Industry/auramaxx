/**
 * TOTP Code Generation
 * ====================
 * Generates RFC 6238 TOTP codes from a base32-encoded shared secret.
 */

import * as OTPAuth from 'otpauth';

export interface TOTPResult {
  code: string;
  remaining: number; // seconds until next code
}

/**
 * Generate a TOTP code from a base32-encoded secret.
 * Honors algorithm, digits, and period from OtpauthParams if provided;
 * falls back to RFC 6238 defaults: SHA-1, 6 digits, 30-second period.
 */
export function generateTOTP(
  secret: string,
  issuerOrParams?: string | Partial<OtpauthParams>,
  label?: string,
): TOTPResult {
  const explicitParams: Partial<OtpauthParams> =
    typeof issuerOrParams === 'object' && issuerOrParams
      ? issuerOrParams
      : {};

  const normalizedSecretInput = typeof secret === 'string' ? secret.trim() : secret;

  // Backward-compatible support for raw otpauth:// URIs stored as the secret.
  // This lets callers pass a full URI directly and still honor query parameters
  // like algorithm/digits/period without pre-parsing.
  const parsedFromUri =
    typeof normalizedSecretInput === 'string' && normalizedSecretInput.startsWith('otpauth://')
      ? parseOtpauthUri(normalizedSecretInput)
      : undefined;

  const merged: Partial<OtpauthParams> = {
    ...parsedFromUri,
    ...explicitParams,
  };

  const normalized = normalizeOtpauthParams(merged);
  const normalizedSecret = normalizeBase32Secret((normalized.secret || normalizedSecretInput));
  const issuer = typeof issuerOrParams === 'string' ? issuerOrParams : normalized.issuer;

  const totp = new OTPAuth.TOTP({
    issuer: issuer || 'AuraMaxx',
    label: label || normalized.label || 'default',
    algorithm: normalized.algorithm,
    digits: normalized.digits,
    period: normalized.period,
    secret: OTPAuth.Secret.fromBase32(normalizedSecret),
  });

  const code = totp.generate();
  const now = Math.floor(Date.now() / 1000);
  const remaining = normalized.period - (now % normalized.period);

  return { code, remaining };
}

/**
 * Parse an otpauth:// URI into its components.
 * Format: otpauth://totp/Label?secret=BASE32&issuer=Example&algorithm=SHA1&digits=6&period=30
 */
export interface OtpauthParams {
  secret: string;
  issuer?: string;
  algorithm?: string;
  digits?: number;
  period?: number;
  label?: string;
}

const DEFAULT_TOTP_PARAMS = {
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
} as const;

const MIN_TOTP_DIGITS = 6;
const MAX_TOTP_DIGITS = 8;
const MIN_TOTP_PERIOD = 15;
const MAX_TOTP_PERIOD = 60;
const VALID_ALGORITHMS = new Set(['SHA1', 'SHA256', 'SHA512']);

function normalizeOtpauthParams(params: Partial<OtpauthParams>): Required<Pick<OtpauthParams, 'algorithm' | 'digits' | 'period'>> & Partial<Omit<OtpauthParams, 'algorithm' | 'digits' | 'period'>> {
  const algorithm = params.algorithm || DEFAULT_TOTP_PARAMS.algorithm;
  const digits = params.digits || DEFAULT_TOTP_PARAMS.digits;
  const period = params.period || DEFAULT_TOTP_PARAMS.period;

  if (!VALID_ALGORITHMS.has(algorithm)) {
    throw new Error(`Unsupported TOTP algorithm: ${algorithm}`);
  }

  if (!Number.isInteger(digits) || digits < MIN_TOTP_DIGITS || digits > MAX_TOTP_DIGITS) {
    throw new Error(`Invalid TOTP digits: ${digits}`);
  }

  if (!Number.isInteger(period) || period < MIN_TOTP_PERIOD || period > MAX_TOTP_PERIOD) {
    throw new Error(`Invalid TOTP period: ${period}`);
  }

  return {
    ...params,
    algorithm,
    digits,
    period,
  };
}

function normalizeBase32Secret(secret: string): string {
  const normalizedSecret = secret.replace(/\s+/g, '').toUpperCase();

  if (normalizedSecret.length < 8) {
    throw new Error('Invalid TOTP secret');
  }

  if (!/^[A-Z2-7]+$/.test(normalizedSecret)) {
    throw new Error('Invalid TOTP secret');
  }

  return normalizedSecret;
}

export function parseOtpauthUri(uri: string): OtpauthParams {
  const url = new URL(uri);
  if (url.protocol !== 'otpauth:') throw new Error('Not an otpauth URI');
  if (url.hostname !== 'totp') throw new Error('Only TOTP is supported');

  const secret = url.searchParams.get('secret');
  if (!secret) throw new Error('Missing secret parameter');

  // Label is the path component (after /totp/)
  const label = decodeURIComponent(url.pathname.replace(/^\//, ''));

  const parsed: Partial<OtpauthParams> = {
    secret: normalizeBase32Secret(secret),
    issuer: url.searchParams.get('issuer') || undefined,
    algorithm: url.searchParams.get('algorithm') || undefined,
    digits: url.searchParams.has('digits') ? parseInt(url.searchParams.get('digits')!, 10) : undefined,
    period: url.searchParams.has('period') ? parseInt(url.searchParams.get('period')!, 10) : undefined,
    label: label || undefined,
  };

  return normalizeOtpauthParams(parsed) as OtpauthParams;

}

/**
 * Validate a TOTP code against a secret.
 * Allows ±1 time step window for clock drift.
 * Honors algorithm/digits/period from params if provided.
 */
export function validateTOTP(secret: string, code: string, params?: Partial<OtpauthParams>): boolean {
  const explicitParams: Partial<OtpauthParams> =
    typeof params === 'object' && params ? params : {};

  const normalizedSecretInput = typeof secret === 'string' ? secret.trim() : secret;

  const parsedFromUri =
    typeof normalizedSecretInput === 'string' && normalizedSecretInput.startsWith('otpauth://')
      ? parseOtpauthUri(normalizedSecretInput)
      : undefined;

  const merged: Partial<OtpauthParams> = {
    ...parsedFromUri,
    ...explicitParams,
  };

  const normalized = normalizeOtpauthParams(merged);
  const normalizedSecret = normalizeBase32Secret((normalized.secret || normalizedSecretInput));

  const totp = new OTPAuth.TOTP({
    algorithm: normalized.algorithm,
    digits: normalized.digits,
    period: normalized.period,
    secret: OTPAuth.Secret.fromBase32(normalizedSecret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

/**
 * Find a TOTP field in a list of credential fields.
 * Checks both 'totp' and 'otp' keys for backward compatibility
 * with 1Password imports that used 'otp'.
 */
export function findTotpField<T extends { key: string }>(fields: T[]): T | undefined {
  return fields.find(f => f.key === 'totp') || fields.find(f => f.key === 'otp');
}
