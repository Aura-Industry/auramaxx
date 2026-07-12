import { ethers } from 'ethers';
import { WalletInfo, EncryptedData } from '../types';
import { getMnemonic, isUnlocked, getAgentMnemonic, isAgentUnlocked, getPrimaryAgentId } from './cold';
import { encryptWithSeed, decryptWithSeed } from './encrypt';
import { prisma } from './db';
import { normalizeAddress, isSolanaChain } from './address';
import { createSolanaHotWallet, getSolanaKeypair, signSolanaTransaction } from './solana/wallet';

export interface HotWalletInfo extends WalletInfo {
  name?: string;
  color?: string;
  description?: string;
  emoji?: string;
  hidden?: boolean;
  tokenHash: string;
}

export interface CreateHotWalletOptions {
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
 * Create a new hot wallet with random keypair, encrypted with the seed phrase.
 * The wallet is owned by the token that creates it.
 */
export async function createHotWallet(options: CreateHotWalletOptions): Promise<HotWalletInfo> {
  const { chain = 'base', coldWalletId } = options;

  // Delegate to Solana wallet creation if Solana chain
  if (isSolanaChain(chain)) {
    return createSolanaHotWallet(options);
  }

  // Get mnemonic from specific agent or primary
  const mnemonic = coldWalletId ? getAgentMnemonic(coldWalletId) : getMnemonic();
  if (!mnemonic) {
    const target = coldWalletId ? `Agent ${coldWalletId}` : 'Cold wallet';
    throw new Error(`${target} must be unlocked to create hot wallets`);
  }

  const { tokenHash, name, color, description, emoji, hidden = false } = options;

  // Generate random wallet
  const wallet = ethers.Wallet.createRandom();

  // Encrypt private key with seed phrase
  const encrypted = encryptWithSeed(wallet.privateKey, mnemonic);

  // Store in DB (with coldWalletId reference)
  const hotWallet = await prisma.hotWallet.create({
    data: {
      address: normalizeAddress(wallet.address, chain),
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
    tier: 'hot',
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
 * List hot wallets. If tokenHash is provided, filter to only wallets owned by that token.
 * If not provided (human access), return all wallets.
 * If includeHidden is false (default), hidden wallets are excluded.
 */
export async function listHotWallets(tokenHash?: string, includeHidden: boolean = false): Promise<HotWalletInfo[]> {
  const where: { tokenHash?: string; hidden?: boolean } = {};
  if (tokenHash) where.tokenHash = tokenHash;
  if (!includeHidden) where.hidden = false;

  const wallets = await prisma.hotWallet.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  return wallets.map((w) => ({
    address: w.address,
    tier: 'hot' as const,
    chain: w.chain,
    createdAt: w.createdAt.toISOString(),
    name: w.name || undefined,
    color: w.color || undefined,
    description: w.description || undefined,
    emoji: w.emoji || undefined,
    hidden: w.hidden,
    tokenHash: w.tokenHash,
  }));
}

/**
 * Get a hot wallet by address.
 */
export async function getHotWallet(address: string) {
  // Try lowercase first (EVM), then exact match (Solana)
  let wallet = await prisma.hotWallet.findUnique({
    where: { address: address.toLowerCase() },
  });
  if (!wallet && address !== address.toLowerCase()) {
    wallet = await prisma.hotWallet.findUnique({
      where: { address },
    });
  }

  if (!wallet) return null;

  return {
    address: wallet.address,
    tokenHash: wallet.tokenHash,
    coldWalletId: wallet.coldWalletId,
    metadata: {
      name: wallet.name,
      color: wallet.color,
      description: wallet.description,
      emoji: wallet.emoji,
      hidden: wallet.hidden,
      chain: wallet.chain,
      createdAt: wallet.createdAt.toISOString(),
    },
  };
}

/**
 * Sign and send a transaction from a hot wallet.
 * Requires the cold wallet to be unlocked to decrypt the private key.
 */
export async function signWithHotWallet(
  address: string,
  transaction: ethers.TransactionRequest,
  provider: ethers.Provider
): Promise<{ hash: string }> {
  // Try lowercase first (EVM), then exact match (Solana)
  let wallet = await prisma.hotWallet.findUnique({
    where: { address: address.toLowerCase() },
  });
  if (!wallet && address !== address.toLowerCase()) {
    wallet = await prisma.hotWallet.findUnique({
      where: { address },
    });
  }

  if (!wallet) {
    throw new Error(`Hot wallet not found: ${address}`);
  }

  // Get mnemonic from the agent this hot wallet belongs to
  const mnemonic = wallet.coldWalletId
    ? getAgentMnemonic(wallet.coldWalletId)
    : getMnemonic();
  if (!mnemonic) {
    const target = wallet.coldWalletId ? `Agent ${wallet.coldWalletId}` : 'Cold wallet';
    throw new Error(`${target} must be unlocked to sign from hot wallet`);
  }

  // Decrypt the private key
  const encrypted: EncryptedData = JSON.parse(wallet.encryptedPrivateKey);
  const privateKey = decryptWithSeed(encrypted, mnemonic);

  // Create signer and send transaction
  const signer = new ethers.Wallet(privateKey, provider);
  const tx = await signer.sendTransaction(transaction);

  return { hash: tx.hash };
}

/**
 * Export a hot wallet's private key.
 * Requires the cold wallet to be unlocked.
 */
export async function exportHotWallet(address: string): Promise<{ address: string; privateKey: string }> {
  // Try lowercase first (EVM), then exact match (Solana)
  let wallet = await prisma.hotWallet.findUnique({
    where: { address: address.toLowerCase() },
  });
  if (!wallet && address !== address.toLowerCase()) {
    wallet = await prisma.hotWallet.findUnique({
      where: { address },
    });
  }

  if (!wallet) {
    throw new Error(`Hot wallet not found: ${address}`);
  }

  // Get mnemonic from the agent this hot wallet belongs to
  const mnemonic = wallet.coldWalletId
    ? getAgentMnemonic(wallet.coldWalletId)
    : getMnemonic();
  if (!mnemonic) {
    const target = wallet.coldWalletId ? `Agent ${wallet.coldWalletId}` : 'Cold wallet';
    throw new Error(`${target} must be unlocked to export hot wallet`);
  }

  // Decrypt the private key
  const encrypted: EncryptedData = JSON.parse(wallet.encryptedPrivateKey);
  const privateKey = decryptWithSeed(encrypted, mnemonic);

  return {
    address: wallet.address,
    privateKey,
  };
}

/**
 * Delete a hot wallet.
 */
export async function deleteHotWallet(address: string): Promise<void> {
  // Try lowercase first (EVM), then exact (Solana)
  try {
    await prisma.hotWallet.delete({ where: { address: address.toLowerCase() } });
  } catch {
    if (address !== address.toLowerCase()) {
      await prisma.hotWallet.delete({ where: { address } }).catch(() => {});
    }
  }
}

/**
 * Update hot wallet metadata.
 */
export async function updateHotWallet(
  address: string,
  updates: { name?: string; color?: string; description?: string; emoji?: string; hidden?: boolean }
): Promise<boolean> {
  try {
    await prisma.hotWallet.update({
      where: { address: address.toLowerCase() },
      data: updates,
    });
    return true;
  } catch {
    // Try exact match (Solana addresses are case-sensitive)
    if (address !== address.toLowerCase()) {
      try {
        await prisma.hotWallet.update({
          where: { address },
          data: updates,
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Search hot wallets by name, address, or description.
 * If tokenHash is provided, filter to only wallets owned by that token.
 * Always includes hidden wallets in search results.
 */
export async function searchHotWallets(query: string, tokenHash?: string): Promise<HotWalletInfo[]> {
  const lowerQuery = query.toLowerCase();

  const where: { tokenHash?: string; OR: Array<{ name?: { contains: string }; address?: { contains: string }; description?: { contains: string } }> } = {
    OR: [
      { name: { contains: lowerQuery } },
      { address: { contains: lowerQuery } },
      { description: { contains: lowerQuery } },
    ],
  };
  if (tokenHash) where.tokenHash = tokenHash;

  const wallets = await prisma.hotWallet.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  return wallets.map((w) => ({
    address: w.address,
    tier: 'hot' as const,
    chain: w.chain,
    createdAt: w.createdAt.toISOString(),
    name: w.name || undefined,
    color: w.color || undefined,
    description: w.description || undefined,
    emoji: w.emoji || undefined,
    hidden: w.hidden,
    tokenHash: w.tokenHash,
  }));
}

/**
 * Check if a token owns a specific hot wallet.
 */
export async function tokenOwnsWallet(tokenHash: string, address: string): Promise<boolean> {
  // Try lowercase first (EVM), then exact match (Solana)
  let wallet = await prisma.hotWallet.findUnique({
    where: { address: address.toLowerCase() },
    select: { tokenHash: true },
  });
  if (!wallet && address !== address.toLowerCase()) {
    wallet = await prisma.hotWallet.findUnique({
      where: { address },
      select: { tokenHash: true },
    });
  }

  return wallet?.tokenHash === tokenHash;
}

/**
 * Check if a token can access a specific wallet.
 * A token can access a wallet if:
 *   1. The token created the wallet (tokenHash match), OR
 *   2. The wallet address is in the token's walletAccess array
 *
 * @param tokenHash - Hash of the token making the request
 * @param walletAccess - Array of wallet addresses the token has been granted access to
 * @param address - The wallet address to check access for
 * @returns true if the token can access the wallet
 */
export async function tokenCanAccessWallet(
  tokenHash: string,
  walletAccess: string[] | undefined,
  address: string,
  chain?: string
): Promise<boolean> {
  const normalized = normalizeAddress(address, chain);

  // Check if wallet address is in the walletAccess grants
  if (walletAccess && walletAccess.includes(normalized)) {
    return true;
  }
  // Also check original address (for Solana addresses that may be stored as-is)
  if (walletAccess && walletAccess.includes(address)) {
    return true;
  }

  // Fall back to checking ownership
  return tokenOwnsWallet(tokenHash, address);
}
