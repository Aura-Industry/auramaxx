/**
 * Transport Client - RSA encryption for CLI password transport
 *
 * Mirrors the server's transport.ts but provides the encryption side
 * (server has decryption). Uses RSA-OAEP with SHA-256 for semantic security.
 */

import { publicEncrypt, constants } from 'crypto';
import { generateEphemeralKeypair } from '../lib/credential-transport';

export interface AgentKeypair {
  publicKey: string;
  privateKey: string;
}

/**
 * Encrypt a password using the server's RSA public key
 * @param password Plaintext password
 * @param publicKeyPem Server's RSA public key in PEM format
 * @returns Base64-encoded RSA-OAEP encrypted password
 */
export function encryptPassword(password: string, publicKeyPem: string): string {
  const buffer = Buffer.from(password, 'utf8');
  const encrypted = publicEncrypt(
    {
      key: publicKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    buffer
  );
  return encrypted.toString('base64');
}

/**
 * Generate an RSA-OAEP keypair for agent token mint requests.
 *
 * The public key is sent as `pubkey` when minting tokens. The private key can
 * be retained by the caller runtime if credential decryption is needed.
 */
export function generateAgentKeypair(): AgentKeypair {
  const pair = generateEphemeralKeypair();
  return {
    publicKey: pair.publicKeyPem,
    privateKey: pair.privateKeyPem,
  };
}
