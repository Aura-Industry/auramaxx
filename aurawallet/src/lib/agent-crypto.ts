/**
 * Browser RSA-OAEP keypair lifecycle + HybridEnvelope decryption.
 *
 * The private key lives in memory only — lost on page reload (intentional).
 * This forces re-unlock on refresh, matching 1Password's behavior.
 */

let privateKey: CryptoKey | null = null;
let publicKeyBase64: string | null = null;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Generate an RSA-OAEP 2048-bit keypair.
 * Private key is non-extractable and stored in module state.
 * Returns the public key as SPKI base64 for sending to the server.
 */
export async function generateAgentKeypair(): Promise<{ publicKeyBase64: string }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    false, // non-extractable private key
    ['decrypt'],
  );
  privateKey = pair.privateKey;
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  publicKeyBase64 = arrayBufferToBase64(spki);
  return { publicKeyBase64 };
}

/** Returns the in-memory private key, or null after reload/lock. */
export function getAgentPrivateKey(): CryptoKey | null {
  return privateKey;
}

/** Returns the cached public key base64, or null. */
export function getAgentPublicKeyBase64(): string | null {
  return publicKeyBase64;
}

/** Discard both keys (called on lock). */
export function discardAgentKeypair(): void {
  privateKey = null;
  publicKeyBase64 = null;
}

interface HybridEnvelope {
  v: number;
  alg: string;
  key: string;
  iv: string;
  tag: string;
  data: string;
}

/**
 * Decrypt a HybridEnvelope from the server's credential read endpoint.
 *
 * Always expects hybrid format: RSA-OAEP wrapped AES-256-GCM session key.
 * WebCrypto expects the GCM auth tag appended to the ciphertext (unlike
 * Node.js which stores it separately), so we concatenate data + tag.
 */
export async function decryptCredentialPayload(encryptedBase64: string): Promise<string> {
  if (!privateKey) {
    throw new Error('No agent keypair — unlock required');
  }

  // Decode the outer base64 → JSON envelope
  const envelopeJson = atob(encryptedBase64);
  const envelope: HybridEnvelope = JSON.parse(envelopeJson);

  if (envelope.v !== 1 || envelope.alg !== 'RSA-OAEP/AES-256-GCM') {
    throw new Error(`Unsupported envelope: v=${envelope.v} alg=${envelope.alg}`);
  }

  // 1. RSA-OAEP decrypt the wrapped AES session key
  const wrappedKey = base64ToArrayBuffer(envelope.key);
  const rawSessionKey = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    wrappedKey,
  );

  // 2. Import the AES-256-GCM session key
  const aesKey = await crypto.subtle.importKey(
    'raw',
    rawSessionKey,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );

  // 3. Concatenate ciphertext + auth tag (WebCrypto expects tag appended)
  const ciphertext = base64ToArrayBuffer(envelope.data);
  const authTag = base64ToArrayBuffer(envelope.tag);
  const combined = new Uint8Array(ciphertext.byteLength + authTag.byteLength);
  combined.set(new Uint8Array(ciphertext), 0);
  combined.set(new Uint8Array(authTag), ciphertext.byteLength);

  // 4. AES-256-GCM decrypt
  const iv = base64ToArrayBuffer(envelope.iv);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    combined.buffer,
  );

  return new TextDecoder().decode(plaintext);
}
