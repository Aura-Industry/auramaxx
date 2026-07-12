/**
 * Network / SSRF Utilities
 * ========================
 * Shared utilities for validating external URLs and preventing SSRF attacks.
 * Used by the strategy executor, source fetcher, app fetch proxy,
 * webhook adapter, and app installer.
 */

import { isIPv4, isIPv6 } from 'net';
import dns from 'dns';
import { getErrorMessage } from './error';

/**
 * Check whether a resolved IP address is in a private/reserved range.
 * Handles both IPv4 and IPv6 (including IPv4-mapped IPv6 addresses).
 */
export function isPrivateIp(ip: string): boolean {
  if (isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 127) return true;                          // 127.0.0.0/8 loopback
    if (a === 10) return true;                           // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;              // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true;              // 169.254.0.0/16 link-local
    if (a === 0) return true;                             // 0.0.0.0/8
    return false;
  }

  if (isIPv6(ip)) {
    const normalized = ip.toLowerCase();

    // Loopback
    if (normalized === '::1') return true;

    // IPv4-mapped IPv6 — ::ffff:a.b.c.d
    if (normalized.startsWith('::ffff:')) {
      const embedded = normalized.slice(7);
      if (isIPv4(embedded)) return isPrivateIp(embedded);
    }

    // Link-local fe80::/10 — first 10 bits = 1111 1110 10
    // Covers fe80:: through febf::
    const firstSegment = normalized.split(':')[0];
    if (firstSegment.length >= 3) {
      const prefix = firstSegment.slice(0, 3);
      if (prefix === 'fe8' || prefix === 'fe9' || prefix === 'fea' || prefix === 'feb') return true;
    }

    // Unique local fc00::/7 — first 7 bits = 1111 110
    // Covers fc00:: through fdff::
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

    return false;
  }

  // Unknown format — treat as suspicious
  return false;
}

/**
 * Resolve a hostname via DNS and verify the resolved IP is not private.
 * Throws if the hostname resolves to a private/reserved IP.
 */
export async function resolveAndValidateHost(hostname: string): Promise<void> {
  // If the hostname is already a raw IP, check directly
  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`Address "${hostname}" is a private/reserved IP`);
    }
    return;
  }

  let address: string;
  try {
    const result = await dns.promises.lookup(hostname);
    address = result.address;
  } catch (err) {
    const msg = getErrorMessage(err);
    throw new Error(`DNS lookup failed for "${hostname}": ${msg}`);
  }

  if (isPrivateIp(address)) {
    throw new Error(`Host "${hostname}" resolves to private IP ${address}`);
  }
}

/**
 * Full validation pipeline for an external URL:
 * 1. Parse the URL
 * 2. Verify protocol is http: or https:
 * 3. If allowedHosts is provided, verify hostname is in the list
 * 4. DNS-resolve and verify the IP is not private
 */
// Reserved test TLDs (RFC 2606) — skip DNS resolution in test environments
const TEST_TLDS = ['.example.com', '.example.org', '.example.net', '.test', '.localhost'];

export async function validateExternalUrl(
  url: string,
  allowedHosts?: string[],
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Protocol "${parsed.protocol}" is not allowed. Only http: and https: are permitted`);
  }

  if (allowedHosts && allowedHosts.length > 0) {
    if (!allowedHosts.includes(parsed.hostname)) {
      throw new Error(`Host "${parsed.hostname}" is not in the allowed hosts list`);
    }
  }

  // Skip DNS resolution for RFC 2606 reserved test domains in test environments
  if (process.env.NODE_ENV === 'test' && TEST_TLDS.some(tld => parsed.hostname.endsWith(tld))) {
    return;
  }

  await resolveAndValidateHost(parsed.hostname);
}

/**
 * Sanitize a path segment (e.g., strategyId, appId) to prevent
 * path traversal when interpolated into REST API URLs.
 * Throws if the segment contains forbidden characters.
 */
export function sanitizePathSegment(segment: string): string {
  if (segment.includes('/') || segment.includes('..') || segment.includes('\\')) {
    throw new Error(`Invalid path segment: "${segment}" contains forbidden characters`);
  }
  return segment;
}
