/**
 * Passkey challenge store and helpers for WebAuthn biometric unlock.
 * Challenges are in-memory, single-use, with 60s TTL.
 */

const CHALLENGE_TTL_MS = 60_000;

interface PendingChallenge {
  type: 'register' | 'authenticate';
  expiresAt: number;
}

const challenges = new Map<string, PendingChallenge>();

// Cleanup expired challenges periodically
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, val] of challenges) {
      if (val.expiresAt <= now) challenges.delete(key);
    }
    if (challenges.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, 30_000);
  // Don't keep process alive for cleanup
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }
}

/**
 * Store a challenge for later verification.
 */
export function storeChallenge(challenge: string, type: 'register' | 'authenticate'): void {
  challenges.set(challenge, { type, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  ensureCleanup();
}

/**
 * Consume a challenge (single-use). Returns true if valid and not expired.
 */
export function consumeChallenge(challenge: string, type: 'register' | 'authenticate'): boolean {
  const entry = challenges.get(challenge);
  if (!entry) return false;
  challenges.delete(challenge);
  if (entry.type !== type) return false;
  if (entry.expiresAt <= Date.now()) return false;
  return true;
}

/**
 * Convert base64url string to Uint8Array.
 */
export function base64urlToUint8Array(base64url: string): Uint8Array {
  return Buffer.from(base64url, 'base64url');
}

/**
 * Convert Uint8Array (or Buffer) to base64url string.
 */
export function uint8ArrayToBase64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url');
}
