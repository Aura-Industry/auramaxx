import { useState, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import { useAuth } from '@/context/AuthContext';

interface BalanceMap {
  [address: string]: string;
}

interface UseBalancesResult {
  balances: BalanceMap;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch ETH balances for multiple addresses using batch RPC calls
 * Uses eth_getBalance with JSON-RPC batch request for efficiency
 */
export function useBalances(addresses: string[], chain?: string): UseBalancesResult {
  const { getRpcUrl, getConfiguredChains } = useAuth();
  const [balances, setBalances] = useState<BalanceMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track previous values to detect changes
  const prevAddressesRef = useRef<string>('');
  const prevRpcUrlRef = useRef<string>('');

  const chains = getConfiguredChains();
  const defaultChain = Object.keys(chains)[0] || 'base';
  const targetChain = chain || defaultChain;

  // Get current RPC URL for comparison
  const rpcUrl = getRpcUrl(targetChain);

  const fetchBalances = useCallback(async () => {
    if (!addresses || addresses.length === 0) {
      setBalances({});
      return;
    }

    const currentRpcUrl = getRpcUrl(targetChain);

    setLoading(true);
    setError(null);

    try {
      // Build batch request for all addresses
      const batchRequest = addresses.map((address, index) => ({
        jsonrpc: '2.0',
        id: index,
        method: 'eth_getBalance',
        params: [address, 'latest'],
      }));

      const response = await fetch(currentRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchRequest),
      });

      if (!response.ok) {
        throw new Error(`RPC request failed: ${response.status}`);
      }

      const results = await response.json();

      // Handle both array response (batch) and single response
      const resultsArray = Array.isArray(results) ? results : [results];

      // Sort by id to match original order
      resultsArray.sort((a, b) => a.id - b.id);

      const newBalances: BalanceMap = {};
      resultsArray.forEach((result, index) => {
        const address = addresses[index];
        if (result.result) {
          const wei = BigInt(result.result);
          newBalances[address.toLowerCase()] = ethers.formatEther(wei);
        } else {
          newBalances[address.toLowerCase()] = '0';
        }
      });

      setBalances(newBalances);
    } catch (err) {
      console.error('[useBalances] Failed to fetch balances:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch balances');

      // Set all balances to '0' on error
      const fallbackBalances: BalanceMap = {};
      addresses.forEach(addr => {
        fallbackBalances[addr.toLowerCase()] = '0';
      });
      setBalances(fallbackBalances);
    } finally {
      setLoading(false);
    }
  }, [addresses, targetChain, getRpcUrl]);

  // Refetch when addresses, chain, or RPC URL changes
  useEffect(() => {
    const addressKey = addresses.map(a => a.toLowerCase()).sort().join(',');
    const shouldRefetch =
      addressKey !== prevAddressesRef.current ||
      rpcUrl !== prevRpcUrlRef.current;

    if (shouldRefetch && addresses.length > 0) {
      prevAddressesRef.current = addressKey;
      prevRpcUrlRef.current = rpcUrl;
      fetchBalances();
    }
  }, [addresses, rpcUrl, fetchBalances]);

  return {
    balances,
    loading,
    error,
    refetch: fetchBalances,
  };
}

/**
 * Helper to get balance for a specific address from the balances map
 */
export function getBalance(balances: BalanceMap, address: string): string {
  return balances[address.toLowerCase()] || '0';
}
