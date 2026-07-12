import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import { derivePath } from 'ed25519-hd-key';
import * as bip39 from 'bip39';
import { EncryptedData } from '../../types';
import { encryptWithSeed, decryptWithSeed } from '../encrypt';
import { getMnemonic, getAgentMnemonic } from '../cold';
import { prisma } from '../db';

/**
 * Derive a Solana keypair from a mnemonic using SLIP-0010.
 * Path: m/44'/501'/{index}'/0'
 */
export function deriveSolanaKeypair(mnemonic: string, index: number = 0): Keypair {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const path = `m/44'/501'/${index}'/0'`;
  const derived = derivePath(path, seed.toString('hex'));
  return Keypair.fromSeed(derived.key);
}

/**
 * Derive the cold (master) Solana keypair.
 * Path: m/44'/501'/0'/0'
 */
export function deriveSolanaColdKeypair(mnemonic: string): Keypair {
  return deriveSolanaKeypair(mnemonic, 0);
}

export interface CreateSolanaHotWalletOptions {
  tokenHash: string;
  chain?: string;
  name?: string;
  color?: string;
  description?: string;
  emoji?: string;
  hidden?: boolean;
  coldWalletId?: string;  // Which agent to encrypt with (null = primary)
}

/**
 * Create a new Solana hot wallet with a random keypair.
 * The secret key is encrypted with the cold wallet mnemonic.
 */
export async function createSolanaHotWallet(options: CreateSolanaHotWalletOptions) {
  const { coldWalletId } = options;
  const mnemonic = coldWalletId ? getAgentMnemonic(coldWalletId) : getMnemonic();
  if (!mnemonic) {
    const target = coldWalletId ? `Agent ${coldWalletId}` : 'Cold wallet';
    throw new Error(`${target} must be unlocked to create Solana hot wallets`);
  }

  const { tokenHash, chain = 'solana', name, color, description, emoji, hidden = false } = options;

  // Generate random Solana keypair
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();

  // Encrypt secret key with mnemonic
  const secretKeyHex = Buffer.from(keypair.secretKey).toString('hex');
  const encrypted = encryptWithSeed(secretKeyHex, mnemonic);

  // Store in DB (with coldWalletId reference)
  const hotWallet = await prisma.hotWallet.create({
    data: {
      address, // Solana addresses are case-sensitive, no toLowerCase
      encryptedPrivateKey: JSON.stringify(encrypted),
      tokenHash,
      coldWalletId: coldWalletId || null,
      name,
      color,
      description,
      emoji,
      hidden,
      chain,
    },
  });

  return {
    address: hotWallet.address,
    tier: 'hot' as const,
    chain: hotWallet.chain,
    createdAt: hotWallet.createdAt.toISOString(),
    name: hotWallet.name || undefined,
    color: hotWallet.color || undefined,
    description: hotWallet.description || undefined,
    emoji: hotWallet.emoji || undefined,
    hidden: hotWallet.hidden,
    tokenHash: hotWallet.tokenHash,
  };
}

/**
 * Get a Solana keypair from a stored hot wallet.
 * Requires cold wallet to be unlocked for decryption.
 */
export async function getSolanaKeypair(address: string): Promise<Keypair> {
  const wallet = await prisma.hotWallet.findUnique({
    where: { address },
  });

  if (!wallet) {
    throw new Error(`Solana hot wallet not found: ${address}`);
  }

  // Get mnemonic from the agent this hot wallet belongs to
  const mnemonic = wallet.coldWalletId
    ? getAgentMnemonic(wallet.coldWalletId)
    : getMnemonic();
  if (!mnemonic) {
    const target = wallet.coldWalletId ? `Agent ${wallet.coldWalletId}` : 'Cold wallet';
    throw new Error(`${target} must be unlocked to access Solana hot wallet`);
  }

  const encrypted: EncryptedData = JSON.parse(wallet.encryptedPrivateKey);
  const secretKeyHex = decryptWithSeed(encrypted, mnemonic);
  const secretKey = Uint8Array.from(Buffer.from(secretKeyHex, 'hex'));
  return Keypair.fromSecretKey(secretKey);
}

/**
 * Sign a Solana transaction with a hot wallet keypair.
 * Returns the transaction signature (base58).
 */
export async function signSolanaTransaction(
  address: string,
  tx: Transaction | VersionedTransaction
): Promise<Uint8Array> {
  const keypair = await getSolanaKeypair(address);

  if (tx instanceof VersionedTransaction) {
    tx.sign([keypair]);
  } else {
    tx.partialSign(keypair);
  }

  return tx.serialize();
}
