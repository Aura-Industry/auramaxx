import { useState, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { useAuth } from '@/context/AuthContext';

function isSolanaChain(chain: string): boolean {
  return chain === 'solana' || chain === 'solana-devnet';
}

interface UseBalanceResult {
  balance: string | null;
  balanceWei: bigint | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  /** Native currency symbol for the chain */
  currency: string;
  /** Number of decimals for the native currency */
  decimals: number;
}

export function useBalance(address: string | undefined, chain?: string): UseBalanceResult {
  const { getRpcUrl, getConfiguredChains } = useAuth();
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track previous values to detect changes
  const prevAddressRef = useRef<string>('');
  const prevRpcUrlRef = useRef<string>('');

  const chains = getConfiguredChains();
  const defaultChain = Object.keys(chains)[0] || 'base';
  const targetChain = chain || defaultChain;

  const isSolana = isSolanaChain(targetChain);
  const currency = isSolana ? 'SOL' : 'ETH';
  const decimals = isSolana ? 9 : 18;

  // Get current RPC URL for comparison
  const rpcUrl = getRpcUrl(targetChain);

  const fetchBalance = useCallback(async () => {
    if (!address) {
      setBalance(null);
      setBalanceWei(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const currentRpcUrl = getRpcUrl(targetChain);

      if (isSolanaChain(targetChain)) {
        // Solana balance fetch
        const connection = new Connection(currentRpcUrl, 'confirmed');
        const pubkey = new PublicKey(address);
        const lamports = await connection.getBalance(pubkey);
        setBalanceWei(BigInt(lamports));
        setBalance((lamports / LAMPORTS_PER_SOL).toString());
      } else {
        // EVM balance fetch
        const provider = new ethers.JsonRpcProvider(currentRpcUrl);
        const wei = await provider.getBalance(address);
        setBalanceWei(wei);
        setBalance(ethers.formatEther(wei));
      }
    } catch (err) {
      console.error('[useBalance] Failed to fetch balance:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch balance');
      setBalance(null);
      setBalanceWei(null);
    } finally {
      setLoading(false);
    }
  }, [address, targetChain, getRpcUrl]);

  // Refetch when address, chain, or RPC URL changes
  useEffect(() => {
    const shouldRefetch =
      address !== prevAddressRef.current ||
      rpcUrl !== prevRpcUrlRef.current;

    if (shouldRefetch) {
      prevAddressRef.current = address || '';
      prevRpcUrlRef.current = rpcUrl;
      fetchBalance();
    }
  }, [address, rpcUrl, fetchBalance]);

  return {
    balance,
    balanceWei,
    loading,
    error,
    refetch: fetchBalance,
    currency,
    decimals,
  };
}
