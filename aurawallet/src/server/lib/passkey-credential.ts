/**
 * Passkey Credential Operations — Software WebAuthn Authenticator
 * ===============================================================
 *
 * Generates ECDSA P-256 keypairs, builds WebAuthn attestation/assertion objects,
 * and stores passkey credentials in the encrypted agent.
 */

import crypto from 'crypto';
import { encode as cborEncode } from 'cbor-x';
import {
  createCredential,
  listCredentials,
  getCredential,
  readCredentialSecrets,
  updateCredential,
} from './credentials';
import { CredentialField } from '../types';

// Our software authenticator AAGUID (random, unique to Aura)
const AURA_AAGUID = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', 'hex');

const PASSKEY_CHALLENGE_TTL_MS = 120_000;
const usedChallenges = new Map<string, number>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export class PasskeyCredentialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyCredentialValidationError';
  }
}

function base64urlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

function sha256(data: Buffer | string): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

function cleanupUsedChallenges(now = Date.now()): void {
  for (const [challenge, expiresAt] of usedChallenges.entries()) {
    if (expiresAt <= now) {
      usedChallenges.delete(challenge);
    }
  }
}

function consumeFreshChallenge(challenge: string): void {
  const now = Date.now();
  cleanupUsedChallenges(now);

  const key = challenge.trim();
  if (!key) {
    throw new PasskeyCredentialValidationError('challenge is required');
  }

  if (usedChallenges.has(key)) {
    throw new PasskeyCredentialValidationError('challenge replay detected');
  }

  usedChallenges.set(key, now + PASSKEY_CHALLENGE_TTL_MS);
}

export function _resetPasskeyCredentialChallengeStoreForTests(): void {
  usedChallenges.clear();
}

function validateOriginPolicy(origin: string, rpId: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new PasskeyCredentialValidationError('clientDataJSON.origin must be a valid URL');
  }

  const host = parsed.hostname.toLowerCase();
  const normalizedRpId = rpId.toLowerCase();
  const isRpMatch = host === normalizedRpId || host.endsWith(`.${normalizedRpId}`);
  if (!isRpMatch) {
    throw new PasskeyCredentialValidationError('clientDataJSON.origin does not match rpId');
  }

  const isLocalhost = host === 'localhost' || host.endsWith('.localhost');
  const allowedHttp = parsed.protocol === 'http:' && isLocalhost;
  if (parsed.protocol !== 'https:' && !allowedHttp) {
    throw new PasskeyCredentialValidationError('clientDataJSON.origin must be https (except localhost)');
  }
}

function parseAndValidateClientDataJSON(params: {
  clientDataJSON: string;
  expectedType: 'webauthn.create' | 'webauthn.get';
  expectedChallenge: string;
  rpId: string;
  expectedOrigin?: string;
}): { challenge: string; origin: string } {
  let parsed: Record<string, unknown>;

  try {
    const raw = base64urlDecode(params.clientDataJSON).toString('utf8');
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new PasskeyCredentialValidationError('clientDataJSON must be valid base64url-encoded JSON');
  }

  const type = parsed.type;
  const challenge = parsed.challenge;
  const origin = parsed.origin;

  if (type !== params.expectedType) {
    throw new PasskeyCredentialValidationError(`clientDataJSON.type must be ${params.expectedType}`);
  }

  if (typeof challenge !== 'string' || challenge !== params.expectedChallenge) {
    throw new PasskeyCredentialValidationError('clientDataJSON.challenge mismatch');
  }

  if (typeof origin !== 'string' || !origin.trim()) {
    throw new PasskeyCredentialValidationError('clientDataJSON.origin is required');
  }

  validateOriginPolicy(origin, params.rpId);

  if (params.expectedOrigin && origin !== params.expectedOrigin) {
    throw new PasskeyCredentialValidationError('clientDataJSON.origin mismatch');
  }

  return { challenge, origin };
}

/**
 * Encode an EC public key in COSE_Key format (ECDSA P-256).
 * See RFC 8152 Section 13.1.1
 */
function encodeCosePublicKey(publicKeyDer: Buffer): Buffer {
  const raw = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' })
    .export({ format: 'jwk' });

  const x = base64urlDecode(raw.x!);
  const y = base64urlDecode(raw.y!);

  const coseKey = new Map<number, number | Buffer>();
  coseKey.set(1, 2);      // kty: EC2
  coseKey.set(3, -7);     // alg: ES256
  coseKey.set(-1, 1);     // crv: P-256
  coseKey.set(-2, x);     // x coordinate
  coseKey.set(-3, y);     // y coordinate

  return Buffer.from(cborEncode(coseKey));
}

// ---------------------------------------------------------------------------
// Registration (navigator.credentials.create)
// ---------------------------------------------------------------------------

export interface PasskeyRegisterOptions {
  agentId: string;
  rpId: string;
  rpName?: string;
  userName?: string;
  displayName?: string;
  userHandle: string; // base64url
  challenge: string;  // base64url — from clientDataJSON
  origin: string;
  clientDataJSON: string; // base64url — raw from browser
}

export interface PasskeyRegisterResult {
  credentialId: string;    // base64url
  attestationObject: string; // base64url
  clientDataJSON: string;    // base64url (pass-through)
  publicKey: string;         // base64url (SPKI DER)
  publicKeyCose: string;     // base64url (COSE)
  transports: string[];
  auraCredentialId: string;  // internal cred-xxx id
}

export function registerPasskey(opts: PasskeyRegisterOptions): PasskeyRegisterResult {
  parseAndValidateClientDataJSON({
    clientDataJSON: opts.clientDataJSON,
    expectedType: 'webauthn.create',
    expectedChallenge: opts.challenge,
    rpId: opts.rpId,
    expectedOrigin: opts.origin,
  });
  consumeFreshChallenge(opts.challenge);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  const credentialIdBuf = crypto.randomBytes(32);
  const credentialId = base64urlEncode(credentialIdBuf);

  const cosePublicKey = encodeCosePublicKey(publicKey as Buffer);

  const rpIdHash = sha256(opts.rpId);
  const flags = Buffer.from([0x45]); // UP + UV + AT
  const signCount = Buffer.alloc(4);

  const credIdLenBuf = Buffer.alloc(2);
  credIdLenBuf.writeUInt16BE(credentialIdBuf.length);

  const authData = Buffer.concat([
    rpIdHash,
    flags,
    signCount,
    AURA_AAGUID,
    credIdLenBuf,
    credentialIdBuf,
    cosePublicKey,
  ]);

  const attestationObject = cborEncode({
    fmt: 'none',
    attStmt: {},
    authData,
  });

  const sensitiveFields: CredentialField[] = [
    { key: 'privateKey', value: base64urlEncode(privateKey as Buffer), type: 'secret', sensitive: true },
  ];

  const meta: Record<string, unknown> = {
    rpId: opts.rpId,
    rpName: opts.rpName || opts.rpId,
    credentialId,
    publicKey: base64urlEncode(publicKey as Buffer),
    publicKeyCose: base64urlEncode(cosePublicKey),
    userHandle: opts.userHandle,
    userName: opts.userName || '',
    displayName: opts.displayName || '',
    signCount: 0,
    transports: ['internal'],
    discoverable: true,
  };

  const name = `${opts.rpId} — ${opts.displayName || opts.userName || 'passkey'}`;
  const cred = createCredential(opts.agentId, 'passkey', name, meta, sensitiveFields);

  return {
    credentialId,
    attestationObject: base64urlEncode(Buffer.from(attestationObject)),
    clientDataJSON: opts.clientDataJSON,
    publicKey: base64urlEncode(publicKey as Buffer),
    publicKeyCose: base64urlEncode(cosePublicKey),
    transports: ['internal'],
    auraCredentialId: cred.id,
  };
}

// ---------------------------------------------------------------------------
// Authentication (navigator.credentials.get)
// ---------------------------------------------------------------------------

export interface PasskeyAuthOptions {
  auraCredentialId: string; // internal cred-xxx id
  rpId: string;
  challenge: string;
  origin?: string;
  clientDataJSON: string;   // base64url — raw from browser
}

export interface PasskeyAuthResult {
  credentialId: string;       // base64url
  authenticatorData: string;  // base64url
  signature: string;          // base64url
  userHandle: string;         // base64url
}

export function authenticatePasskey(opts: PasskeyAuthOptions): PasskeyAuthResult {
  parseAndValidateClientDataJSON({
    clientDataJSON: opts.clientDataJSON,
    expectedType: 'webauthn.get',
    expectedChallenge: opts.challenge,
    rpId: opts.rpId,
    expectedOrigin: opts.origin,
  });
  consumeFreshChallenge(opts.challenge);

  const cred = getCredential(opts.auraCredentialId);
  if (!cred || cred.type !== 'passkey') {
    throw new Error('Passkey credential not found');
  }

  if (cred.meta.rpId !== opts.rpId) {
    throw new Error('rpId mismatch');
  }

  const secrets = readCredentialSecrets(opts.auraCredentialId);
  const privateKeyField = secrets.find(f => f.key === 'privateKey');
  if (!privateKeyField) {
    throw new Error('Private key not found in credential');
  }

  const privateKeyDer = base64urlDecode(privateKeyField.value);
  const privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });

  const currentCount = (cred.meta.signCount as number) || 0;
  const newCount = currentCount + 1;

  const rpIdHash = sha256(opts.rpId);
  const flags = Buffer.from([0x05]); // UP + UV
  const signCountBuf = Buffer.alloc(4);
  signCountBuf.writeUInt32BE(newCount);

  const authenticatorData = Buffer.concat([rpIdHash, flags, signCountBuf]);

  const clientDataHash = sha256(base64urlDecode(opts.clientDataJSON));
  const signedData = Buffer.concat([authenticatorData, clientDataHash]);
  const signature = crypto.sign('sha256', signedData, privateKey);

  updateCredential(opts.auraCredentialId, {
    meta: { ...cred.meta, signCount: newCount },
  });

  return {
    credentialId: cred.meta.credentialId as string,
    authenticatorData: base64urlEncode(authenticatorData),
    signature: base64urlEncode(signature),
    userHandle: (cred.meta.userHandle as string) || '',
  };
}

// ---------------------------------------------------------------------------
// Match — find passkeys for an rpId
// ---------------------------------------------------------------------------

export interface PasskeyMatch {
  auraCredentialId: string;
  credentialId: string;
  rpId: string;
  userName: string;
  displayName: string;
}

export function matchPasskeys(rpId: string, agentId?: string): PasskeyMatch[] {
  const creds = listCredentials({ type: 'passkey', agentId });
  return creds
    .filter(c => c.meta.rpId === rpId)
    .map(c => ({
      auraCredentialId: c.id,
      credentialId: c.meta.credentialId as string,
      rpId: c.meta.rpId as string,
      userName: (c.meta.userName as string) || '',
      displayName: (c.meta.displayName as string) || '',
    }))
    .sort((a, b) => a.auraCredentialId.localeCompare(b.auraCredentialId));
}
