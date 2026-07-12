/**
 * Frontend Crypto Utilities
 *
 * RSA-OAEP encryption for secure password transport.
 * Uses Web Crypto API for encryption with server's public key.
 */

import { getAgentPublicKeyBase64 } from './agent-crypto';

/**
 * Convert PEM-encoded public key to ArrayBuffer for Web Crypto API
 */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  // Remove PEM headers and newlines
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');

  // Decode base64 to binary
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Encrypt a password using RSA-OAEP with the server's public key
 *
 * @param password - The plaintext password to encrypt
 * @param pemPublicKey - PEM-encoded RSA public key from /auth/connect
 * @returns Base64-encoded encrypted password
 */
export async function encryptPassword(
  password: string,
  pemPublicKey: string
): Promise<string> {
  // Import the PEM public key
  const keyData = pemToArrayBuffer(pemPublicKey);
  const publicKey = await crypto.subtle.importKey(
    'spki',
    keyData,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );

  // Encrypt the password
  const encoded = new TextEncoder().encode(password);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    publicKey,
    encoded
  );

  // Convert to base64 for transport
  const bytes = new Uint8Array(encrypted);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

let tokenMintPubkeyPromise: Promise<string> | null = null;

/**
 * Generate (or reuse) an in-memory RSA-OAEP public key for token mint requests.
 *
 * Private key persistence/decryption lifecycle is handled separately by agent UI
 * code (TODO-029). This helper only provides the required pubkey.
 */
export async function getTokenMintPubkey(): Promise<string> {
  // Prefer the agent keypair when available (UI unlock flow)
  const agentPubkey = getAgentPublicKeyBase64();
  if (agentPubkey) return agentPubkey;

  if (!tokenMintPubkeyPromise) {
    tokenMintPubkeyPromise = (async () => {
      const pair = await crypto.subtle.generateKey(
        {
          name: 'RSA-OAEP',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['encrypt', 'decrypt'],
      );
      const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
      return arrayBufferToBase64(spki);
    })();
  }

  try {
    return await tokenMintPubkeyPromise;
  } catch (error) {
    tokenMintPubkeyPromise = null;
    throw error;
  }
}
