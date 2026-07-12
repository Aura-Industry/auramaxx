/**
 * Transport Security - Encrypted password transport for unlock/setup
 *
 * Generates an ephemeral RSA keypair on server startup. Frontend fetches
 * the public key via /auth/connect and encrypts passwords with RSA-OAEP
 * before sending.
 *
 * Security properties:
 * - RSA private key never leaves server memory
 * - Keypair regenerates on restart (aligns with existing security model)
 * - RSA-OAEP provides semantic security (same plaintext → different ciphertext)
 */

import { generateKeyPairSync, privateDecrypt, constants } from 'crypto';
import { HttpError } from './error';

// Ephemeral RSA keypair - regenerates every restart
// This aligns with the security model: server restart = forced re-authentication
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

console.log('[Transport] RSA keypair generated for encrypted password transport');

/**
 * Get the server's public key (PEM format)
 * Frontend uses this to encrypt passwords before sending
 */
export function getPublicKey(): string {
  return publicKey;
}

/**
 * Get the server's private key (PEM format) — for test use only.
 * In production this key never leaves the process; tests need it
 * to decrypt tokens encrypted with the matching public key.
 */
export function getPrivateKey(): string {
  return privateKey;
}

/**
 * Decrypt a password that was encrypted with our public key
 * @param encrypted Base64-encoded RSA-OAEP encrypted password
 * @returns Decrypted plaintext password
 * @throws Error if decryption fails (wrong key, corrupted data, etc.)
 */
export function decryptPassword(encrypted: string): string {
  const buffer = Buffer.from(encrypted, 'base64');
  const decrypted = privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    buffer
  );
  return decrypted.toString('utf8');
}

/**
 * Decrypt and validate an encrypted password from a request body.
 * Throws HttpError with appropriate status codes on failure.
 */
export function parseEncryptedPassword(encrypted: unknown): string {
  if (!encrypted || typeof encrypted !== 'string') {
    throw new HttpError(400, 'Encrypted password is required');
  }
  let password: string;
  try {
    password = decryptPassword(encrypted);
  } catch {
    throw new HttpError(400, 'Failed to decrypt password. Server may have restarted - refetch public key.');
  }
  if (!password) {
    throw new HttpError(400, 'Password is required');
  }
  if (password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }
  return password;
}
