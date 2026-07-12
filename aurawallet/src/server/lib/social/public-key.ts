/**
 * Public-key format helpers for hub RPC interoperability.
 *
 * AuraWallet stores signer keys as 32-byte hex.
 * AuraHub identity/publicKey fields are base64.
 */

const HEX_ED25519_RE = /^[0-9a-f]{64}$/i;

export function normalizeHubPublicKey(publicKey: string): string {
  const trimmed = publicKey.trim();
  if (!trimmed) return '';
  if (HEX_ED25519_RE.test(trimmed)) {
    return Buffer.from(trimmed.toLowerCase(), 'hex').toString('base64');
  }
  return trimmed;
}

export function normalizeFollowBodyForHub(
  type: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (type !== 'link_add' && type !== 'link_remove') return body;

  const followee = body.followeePublicKey;
  if (typeof followee !== 'string') return body;

  const normalized = normalizeHubPublicKey(followee);
  if (!normalized || normalized === followee) return body;
  return { ...body, followeePublicKey: normalized };
}

