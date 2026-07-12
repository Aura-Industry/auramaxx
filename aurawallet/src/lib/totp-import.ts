export interface ParsedTotpUri {
  secret: string;
  issuer?: string;
  account?: string;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: number;
  period: number;
  label?: string;
}

export type TotpPayloadKind = 'otpauth' | 'otpauth-migration' | 'unknown';

const VALID_ALGORITHMS = new Set(['SHA1', 'SHA256', 'SHA512']);

export function normalizeBase32Secret(secret: string): string {
  const normalized = secret.replace(/\s+/g, '').toUpperCase();
  if (normalized.length < 8) throw new Error('Invalid TOTP secret');
  if (!/^[A-Z2-7]+$/.test(normalized)) throw new Error('Invalid TOTP secret');
  return normalized;
}

export function classifyTotpPayload(raw: string): TotpPayloadKind {
  const input = raw.trim().toLowerCase();
  if (input.startsWith('otpauth://totp/')) return 'otpauth';
  if (input.startsWith('otpauth-migration://')) return 'otpauth-migration';
  return 'unknown';
}

export function parseTotpUri(uri: string): ParsedTotpUri {
  const url = new URL(uri.trim());
  if (url.protocol !== 'otpauth:') throw new Error('Not an otpauth URI');
  if (url.hostname !== 'totp') throw new Error('Only TOTP is supported');

  const secretRaw = url.searchParams.get('secret');
  if (!secretRaw) throw new Error('Missing secret parameter');

  const digits = url.searchParams.has('digits') ? Number.parseInt(url.searchParams.get('digits') || '', 10) : 6;
  const period = url.searchParams.has('period') ? Number.parseInt(url.searchParams.get('period') || '', 10) : 30;
  const algorithm = (url.searchParams.get('algorithm') || 'SHA1').toUpperCase();

  if (!VALID_ALGORITHMS.has(algorithm)) throw new Error(`Unsupported TOTP algorithm: ${algorithm}`);
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new Error(`Invalid TOTP digits: ${digits}`);
  if (!Number.isInteger(period) || period < 15 || period > 60) throw new Error(`Invalid TOTP period: ${period}`);

  const label = decodeURIComponent(url.pathname.replace(/^\//, '')) || undefined;
  const [issuerFromLabel, account] = (label || '').includes(':') ? (label || '').split(':', 2) : [undefined, label];

  return {
    secret: normalizeBase32Secret(secretRaw),
    issuer: url.searchParams.get('issuer') || issuerFromLabel || undefined,
    account: account || undefined,
    algorithm: algorithm as ParsedTotpUri['algorithm'],
    digits,
    period,
    label,
  };
}
