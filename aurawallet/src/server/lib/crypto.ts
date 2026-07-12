import { createHash } from 'crypto';

/**
 * Hash a secret for storage (we only store the hash, never the secret)
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
