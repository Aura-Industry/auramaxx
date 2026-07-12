'use client';

import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ethers } from 'ethers';
import { Button, TextInput, ChainSelector } from '@/components/design-system';
import { useAuth } from '@/context/AuthContext';

const CHAINS = ['base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'solana'];

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DexPair = any;

interface TokenData {
  name: string;
  symbol: string;
  priceUsd: string;
  fdv: number;
  volume24h: number;
  priceChange24h: number;
  pairAddress: string;
  chain: string;
  totalSupply?: string;
  decimals?: number;
  source: 'dex' | 'rpc';
}

interface TokenAppProps {
  config?: {
    defaultChain?: string;
    defaultAddress?: string;
  };
}

function extractToken(pair: DexPair, chain: string): TokenData {
  return {
    name: pair.baseToken?.name || 'Unknown',
    symbol: pair.baseToken?.symbol || '???',
    priceUsd: pair.priceUsd || '0',
    fdv: pair.fdv || 0,
    volume24h: pair.volume?.h24 || 0,
    priceChange24h: pair.priceChange?.h24 || 0,
    pairAddress: pair.pairAddress,
    chain: pair.chainId || chain,
    source: 'dex',
  };
}

function pickBestPair(pairs: DexPair[], chain: string): DexPair {
  // Prefer a pair on the selected chain with highest liquidity
  const onChain = pairs.filter((p: DexPair) => p.chainId === chain);
  if (onChain.length > 0) {
    return onChain.sort((a: DexPair, b: DexPair) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  }
  // Fall back to highest liquidity pair on any chain
  return [...pairs].sort((a: DexPair, b: DexPair) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

export default function TokenApp({ config }: TokenAppProps) {
  const { getRpcUrl } = useAuth();
  const [chain, setChain] = useState(config?.defaultChain || 'base');
  const [query, setQuery] = useState(config?.defaultAddress || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<TokenData | null>(null);

  const handleLoad = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    setToken(null);

    try {
      const isAddress = /^0x[a-fA-F0-9]{40}$/.test(trimmed) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);

      let pairs: DexPair[] = [];

      if (isAddress) {
        // Try as pool/pair address first (chain-specific)
        const pairRes = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${trimmed}`);
        if (pairRes.ok) {
          const pairData = await pairRes.json();
          if (pairData.pairs?.length) pairs = pairData.pairs;
        }

        // If not a pair, try as token address
        if (pairs.length === 0) {
          const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${trimmed}`);
          if (res.ok) {
            const data = await res.json();
            pairs = data.pairs || [];
          }
        }
      }

      // Fallback: search by name/symbol/address
      if (pairs.length === 0) {
        const searchRes = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(trimmed)}`);
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          pairs = searchData.pairs || [];
        }
      }

      if (pairs.length > 0) {
        const pair = pickBestPair(pairs, chain);
        setToken(extractToken(pair, chain));
        return;
      }

      // No DEX data — fall back to RPC for ERC-20 info
      const isEvmAddr = /^0x[a-fA-F0-9]{40}$/.test(trimmed);
      if (!isEvmAddr || chain === 'solana') {
        throw new Error('No data found — try a contract address');
      }

      const rpcUrl = getRpcUrl(chain);
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const contract = new ethers.Contract(trimmed, ERC20_ABI, provider);

      const [name, symbol, decimals, totalSupplyRaw] = await Promise.all([
        contract.name().catch(() => 'Unknown'),
        contract.symbol().catch(() => '???'),
        contract.decimals().catch(() => 18),
        contract.totalSupply().catch(() => BigInt(0)),
      ]);

      const totalSupply = ethers.formatUnits(totalSupplyRaw, decimals);

      setToken({
        name,
        symbol,
        priceUsd: '0',
        fdv: 0,
        volume24h: 0,
        priceChange24h: 0,
        pairAddress: '',
        chain,
        totalSupply,
        decimals,
        source: 'rpc',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch token data');
    } finally {
      setLoading(false);
    }
  };

  const formatUsd = (value: number): string => {
    if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
    return `$${value.toFixed(2)}`;
  };

  const priceChangeColor = token && token.priceChange24h >= 0
    ? 'var(--color-success, #00c853)'
    : 'var(--color-warning, #ff4d00)';

  return (
    <div className="space-y-3">
      <ChainSelector
        label="CHAIN"
        value={chain}
        onChange={setChain}
        chains={CHAINS}
        size="sm"
      />

      <TextInput
        label="TOKEN"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleLoad()}
        placeholder="token, pool, or name"
        compact
      />

      <Button
        type="button"
        onClick={handleLoad}
        disabled={loading || !query.trim()}
        loading={loading}
        className="w-full"
      >
        {loading ? 'LOADING...' : 'LOAD'}
      </Button>

      {error && (
        <div
          className="p-2"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--color-warning, #ff4d00) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-warning, #ff4d00) 30%, transparent)',
          }}
        >
          <div className="flex items-center gap-1">
            <AlertTriangle size={10} style={{ color: 'var(--color-warning, #ff4d00)' }} />
            <span className="font-mono text-[9px]" style={{ color: 'var(--color-warning, #ff4d00)' }}>
              {error}
            </span>
          </div>
        </div>
      )}

      {token && (
        <>
          {/* Token header */}
          <div
            className="p-2"
            style={{
              backgroundColor: 'var(--color-background-alt, #f4f4f5)',
              border: '1px solid var(--color-border, #d4d4d8)',
            }}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-mono text-[11px] font-bold" style={{ color: 'var(--color-text, #0a0a0a)' }}>
                {token.name}
              </span>
              <span className="font-mono text-[9px] font-bold" style={{ color: 'var(--color-text-muted, #6b7280)' }}>
                {token.symbol}
              </span>
            </div>
            {token.source === 'dex' && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-[13px] font-bold" style={{ color: 'var(--color-text, #0a0a0a)' }}>
                  ${parseFloat(token.priceUsd).toFixed(parseFloat(token.priceUsd) < 0.01 ? 8 : 4)}
                </span>
                <span className="font-mono text-[10px] font-bold" style={{ color: priceChangeColor }}>
                  {token.priceChange24h >= 0 ? '+' : ''}{token.priceChange24h.toFixed(2)}%
                </span>
              </div>
            )}
            {token.source === 'rpc' && (
              <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-faint, #9ca3af)' }}>
                ON-CHAIN ONLY — NO DEX DATA
              </div>
            )}
          </div>

          {/* Stats */}
          <div className="space-y-1.5">
            {token.source === 'dex' && (
              <>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #888)' }}>MKT_CAP</span>
                  <span className="font-mono text-[10px] font-bold" style={{ color: 'var(--color-text, #0a0a0a)' }}>
                    {formatUsd(token.fdv)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #888)' }}>VOL_24H</span>
                  <span className="font-mono text-[10px] font-bold" style={{ color: 'var(--color-text, #0a0a0a)' }}>
                    {formatUsd(token.volume24h)}
                  </span>
                </div>
              </>
            )}
            {token.source === 'rpc' && token.totalSupply && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #888)' }}>SUPPLY</span>
                <span className="font-mono text-[10px] font-bold" style={{ color: 'var(--color-text, #0a0a0a)' }}>
                  {parseFloat(token.totalSupply) >= 1_000_000_000
                    ? `${(parseFloat(token.totalSupply) / 1_000_000_000).toFixed(2)}B`
                    : parseFloat(token.totalSupply) >= 1_000_000
                      ? `${(parseFloat(token.totalSupply) / 1_000_000).toFixed(2)}M`
                      : parseFloat(token.totalSupply).toLocaleString()}
                </span>
              </div>
            )}
            {token.source === 'rpc' && token.decimals !== undefined && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #888)' }}>DECIMALS</span>
                <span className="font-mono text-[10px] font-bold" style={{ color: 'var(--color-text, #0a0a0a)' }}>
                  {token.decimals}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #888)' }}>CHAIN</span>
              <span className="font-mono text-[10px] font-bold" style={{ color: 'var(--color-text, #0a0a0a)' }}>
                {token.chain.toUpperCase()}
              </span>
            </div>
          </div>

          {/* DexScreener chart embed (only for DEX data) */}
          {token.source === 'dex' && token.pairAddress && (
            <div
              style={{
                border: '1px solid var(--color-border, #d4d4d8)',
                height: 200,
                overflow: 'hidden',
              }}
            >
              <iframe
                src={`https://dexscreener.com/${token.chain}/${token.pairAddress}?embed=1&theme=dark&info=0&trades=0`}
                title="Price Chart"
                width="100%"
                height="100%"
                style={{ border: 'none' }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
