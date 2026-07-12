import { blake3 } from '@noble/hashes/blake3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { derivePath } from 'ed25519-hd-key';
import * as bip39 from 'bip39';

// --- Types ---

export interface MessageData {
  type: string;
  timestamp: number;
  network: string;
  body: Record<string, unknown>;
}

export interface SignedEnvelope {
  data: MessageData;
  hash: string;
  hashScheme: 'blake3';
  signature: string;
  signatureScheme: 'ed25519';
  signer: string;
}

// --- Wire type mapping ---

const WIRE_TYPE: Record<string, string> = {
  post_add: 'CAST_ADD',
  post_remove: 'CAST_REMOVE',
  reaction_add: 'REACTION_ADD',
  reaction_remove: 'REACTION_REMOVE',
  link_add: 'LINK_ADD',
  link_remove: 'LINK_REMOVE',
  user_data_add: 'USER_DATA_ADD',
};

// --- Helpers ---

/** Recursively sort all object keys alphabetically. */
function sortObjectKeys(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(sortObjectKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[key] = sortObjectKeys((val as Record<string, unknown>)[key]);
  }
  return sorted;
}

/** Derive 32-byte ED25519 seed from mnemonic using Solana path. */
export function deriveSigningSeed(mnemonic: string): Uint8Array {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const path = "m/44'/501'/0'/0'";
  const derived = derivePath(path, seed.toString('hex'));
  return derived.key;
}

// --- Main ---

/**
 * Sign a social message: canonicalize -> BLAKE3 hash -> ED25519 signature.
 * Pure function, no DB access.
 */
export function signMessage(data: MessageData, mnemonic: string): SignedEnvelope {
  const wireType = WIRE_TYPE[data.type];
  if (!wireType) throw new Error(`Unknown message type: ${data.type}`);

  // Match hub canonical field ordering exactly.
  const canonical: Record<string, unknown> = {
    body: sortObjectKeys(data.body),
    network: data.network,
    timestamp: data.timestamp,
    type: data.type,
    wireType,
    version: 1,
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(canonical));

  // BLAKE3 hash
  const hashBytes = blake3(jsonBytes);
  const hash = Buffer.from(hashBytes).toString('hex');

  // ED25519 sign
  const privKey = deriveSigningSeed(mnemonic);
  const pubKey = ed25519.getPublicKey(privKey);
  const sigBytes = ed25519.sign(hashBytes, privKey);

  return {
    data,
    hash,
    hashScheme: 'blake3',
    signature: Buffer.from(sigBytes).toString('hex'),
    signatureScheme: 'ed25519',
    signer: Buffer.from(pubKey).toString('hex'),
  };
}
