'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, Api } from '@/lib/api';

interface PriceContextType {
  ethPrice: number | null;
  solPrice: number | null;
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => void;
  formatUsd: (ethAmount: string | number | undefined) => string;
  formatUsdForChain: (amount: string | number | undefined, chain: string) => string;
}

const PriceContext = createContext<PriceContextType>({
  ethPrice: null,
  solPrice: null,
  loading: true,
  error: null,
  lastUpdated: null,
  refresh: () => {},
  formatUsd: () => '',
  formatUsdForChain: () => '',
});

export const usePrice = () => useContext(PriceContext);

const REFRESH_INTERVAL = 60000; // 60 seconds

interface PriceResponse {
  success: boolean;
  priceUsd?: string;
  error?: string;
}

function isSolanaChain(chain: string): boolean {
  return chain === 'solana' || chain === 'solana-devnet';
}

export const PriceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [ethPrice, setEthPrice] = useState<number | null>(null);
  const [solPrice, setSolPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchAllPrices = useCallback(async () => {
    try {
      const [ethRes, solRes] = await Promise.all([
        api.get<PriceResponse>(Api.Wallet, '/price/native', { chain: 'base' }).catch(() => null),
        api.get<PriceResponse>(Api.Wallet, '/price/native', { chain: 'solana' }).catch(() => null),
      ]);

      if (ethRes?.success && ethRes.priceUsd) {
        const price = parseFloat(ethRes.priceUsd);
        if (!isNaN(price)) setEthPrice(price);
      }

      if (solRes?.success && solRes.priceUsd) {
        const price = parseFloat(solRes.priceUsd);
        if (!isNaN(price)) setSolPrice(price);
      }

      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Price fetch failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAllPrices();
    const interval = setInterval(fetchAllPrices, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchAllPrices]);

  const formatAmountToUsd = useCallback((amount: string | number | undefined, price: number | null): string => {
    if (amount === undefined || amount === null || amount === '') return '';
    if (price === null) return '';

    const numStr = String(amount).replace(/[^0-9.-]/g, '');
    const num = parseFloat(numStr);

    if (isNaN(num) || num === 0) return '$0';

    const usd = num * price;

    if (usd < 0.01) return '<$0.01';
    if (usd < 1) return `$${usd.toFixed(2)}`;
    if (usd < 1000) return `$${usd.toFixed(2)}`;
    if (usd < 10000) return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }, []);

  const formatUsd = useCallback((ethAmount: string | number | undefined): string => {
    return formatAmountToUsd(ethAmount, ethPrice);
  }, [ethPrice, formatAmountToUsd]);

  const formatUsdForChain = useCallback((amount: string | number | undefined, chain: string): string => {
    const price = isSolanaChain(chain) ? solPrice : ethPrice;
    return formatAmountToUsd(amount, price);
  }, [ethPrice, solPrice, formatAmountToUsd]);

  return (
    <PriceContext.Provider value={{ ethPrice, solPrice, loading, error, lastUpdated, refresh: fetchAllPrices, formatUsd, formatUsdForChain }}>
      {children}
    </PriceContext.Provider>
  );
};
