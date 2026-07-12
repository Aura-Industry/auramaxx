import { createHash, createPublicKey } from 'crypto';

function normalizeFingerprint(hex: string): string {
  return hex.toLowerCase().replace(/[^a-f0-9]/g, '').match(/.{1,2}/g)?.join(':') || '';
}

export function computeSshFingerprint(publicKeyOrPrivateKey: string): string | null {
  const material = publicKeyOrPrivateKey?.trim();
  if (!material) return null;

  try {
    const keyObject = createPublicKey(material);
    const der = keyObject.export({ format: 'der', type: 'spki' }) as Buffer;
    const digest = createHash('sha256').update(der).digest('hex');
    return normalizeFingerprint(digest);
  } catch {
    return null;
  }
}

export function computeGpgFingerprint(material: string): string | null {
  const normalized = material?.trim();
  if (!normalized) return null;

  // Deterministic pseudo-fingerprint for armored key material (v1 scope).
  const digest = createHash('sha1').update(normalized).digest('hex');
  return normalizeFingerprint(digest);
}
