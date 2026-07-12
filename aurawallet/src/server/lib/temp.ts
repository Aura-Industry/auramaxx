import { ethers, HDNodeWallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import { WalletInfo } from '../types';
import { isSolanaChain } from './address';

// Temp wallets: random, memory-only, no persistence, no expiry
// Supports both EVM (HDNodeWallet) and Solana (Keypair)
const tempWallets = new Map<string, { wallet: HDNodeWallet | Keypair; createdAt: string; chain: string }>();

export function createTempWallet(chain?: string): WalletInfo {
  const createdAt = new Date().toISOString();

  if (chain && isSolanaChain(chain)) {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    tempWallets.set(address, { wallet: keypair, createdAt, chain });
    return {
      address,
      tier: 'temp',
      chain,
      createdAt
    };
  }

  const wallet = ethers.Wallet.createRandom();
  tempWallets.set(wallet.address.toLowerCase(), { wallet, createdAt, chain: chain || 'any' });

  return {
    address: wallet.address,
    tier: 'temp',
    chain: chain || 'any',
    createdAt
  };
}

export function getTempWallet(address: string): HDNodeWallet | null {
  // Try lowercase first (EVM), then exact (Solana)
  const entry = tempWallets.get(address.toLowerCase()) || tempWallets.get(address);
  if (!entry) return null;
  if (entry.wallet instanceof Keypair) return null; // Not an EVM wallet
  return entry.wallet;
}

export function getTempSolanaKeypair(address: string): Keypair | null {
  const entry = tempWallets.get(address);
  if (!entry) return null;
  if (!(entry.wallet instanceof Keypair)) return null;
  return entry.wallet;
}

export function hasTempWallet(address: string): boolean {
  return tempWallets.has(address.toLowerCase()) || tempWallets.has(address);
}

export function listTempWallets(): WalletInfo[] {
  const wallets: WalletInfo[] = [];
  tempWallets.forEach((entry, address) => {
    wallets.push({
      address,
      tier: 'temp',
      chain: entry.chain,
      createdAt: entry.createdAt
    });
  });
  return wallets;
}

export function burnTempWallet(address: string): boolean {
  return tempWallets.delete(address.toLowerCase()) || tempWallets.delete(address);
}

export async function signWithTempWallet(
  address: string,
  transaction: ethers.TransactionRequest,
  provider: ethers.Provider
): Promise<string> {
  const wallet = getTempWallet(address);
  if (!wallet) {
    throw new Error(`Temp wallet not found: ${address}`);
  }

  const connectedWallet = wallet.connect(provider);
  const tx = await connectedWallet.sendTransaction(transaction);

  return tx.hash;
}
