import { randomBytes, scryptSync, createCipheriv, createDecipheriv, createHash } from 'crypto';
import { EncryptedData } from '../types';

const ALGORITHM = 'aes-256-gcm';
const SCRYPT_COST = 131072; // 2^17
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAXMEM = 512 * 1024 * 1024; // 512 MiB
const DKLEN = 32;
const GCM_IV_BYTES = 12;

function derivePasswordKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, DKLEN, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAXMEM,
  });
}

function deriveSeedKey(seed: string): Buffer {
  return createHash('sha256').update(seed, 'utf8').digest();
}

export function encryptPrivateKey(privateKey: string, password: string): EncryptedData {
  const salt = randomBytes(32);
  const iv = randomBytes(GCM_IV_BYTES);
  const derivedKey = derivePasswordKey(password, salt);

  const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(privateKey, 'utf8'),
    cipher.final()
  ]);
  const mac = cipher.getAuthTag().toString('hex');

  return {
    ciphertext: ciphertext.toString('hex'),
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
    mac
  };
}

export function decryptPrivateKey(encrypted: EncryptedData, password: string): string {
  const salt = Buffer.from(encrypted.salt, 'hex');
  const iv = Buffer.from(encrypted.iv, 'hex');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'hex');
  const mac = Buffer.from(encrypted.mac, 'hex');

  const derivedKey = derivePasswordKey(password, salt);

  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
  decipher.setAuthTag(mac);
  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
  } catch {
    throw new Error('Invalid password or corrupted data');
  }

  return decrypted.toString('utf8');
}

/**
 * Encrypt data using a seed phrase (mnemonic) as the key.
 * Uses faster key derivation since mnemonic has high entropy.
 */
export function encryptWithSeed(data: string, seed: string): EncryptedData {
  const iv = randomBytes(GCM_IV_BYTES);
  // Use SHA-256 of seed as key (mnemonic has enough entropy, no need for slow scrypt)
  const derivedKey = deriveSeedKey(seed);

  const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(data, 'utf8'),
    cipher.final()
  ]);
  const mac = cipher.getAuthTag().toString('hex');

  return {
    ciphertext: ciphertext.toString('hex'),
    iv: iv.toString('hex'),
    salt: '', // Not needed for seed-based encryption
    mac
  };
}

/**
 * Decrypt data using a seed phrase (mnemonic) as the key.
 */
export function decryptWithSeed(encrypted: EncryptedData, seed: string): string {
  const iv = Buffer.from(encrypted.iv, 'hex');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'hex');
  const mac = Buffer.from(encrypted.mac, 'hex');
  const derivedKey = deriveSeedKey(seed);

  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
  decipher.setAuthTag(mac);
  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
  } catch {
    throw new Error('Invalid seed or corrupted data');
  }

  return decrypted.toString('utf8');
}
