/**
 * Token price lookup with cascading fallback:
 * DexScreener → CoinGecko → Alchemy (if key exists)
 *
 * In-memory cache with 60-second TTL. No DB writes.
 */

import { isSolanaChain, normalizeAddress, getNativeCurrency } from './address';
import { getAlchemyKey, ALCHEMY_PATHS } from './config';
import { getEthToUsd, getSolToUsd } from './prices';

export interface PriceResult {
  priceUsd: string;
  source: string;
  cached: boolean;
}

interface CacheEntry {
  priceUsd: string;
  source: string;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds

const priceCache = new Map<string, CacheEntry>();

/** Clear cache — exposed for tests */
export function clearPriceCache(): void {
  priceCache.clear();
}

// CoinGecko platform ID mapping
const COINGECKO_PLATFORMS: Record<string, string> = {
  base: 'base',
  ethereum: 'ethereum',
  solana: 'solana',
  polygon: 'polygon-pos',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
};

/**
 * Get USD price for a token. Returns null if no source has a price.
 */
export async function getTokenPrice(address: string, chain: string): Promise<PriceResult | null> {
  // Native token shortcut — use existing cached prices from cron
  if (address === 'native') {
    return getNativePrice(chain);
  }

  const normalized = normalizeAddress(address, chain);
  const cacheKey = `${chain}:${normalized}`;

  // Check cache
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { priceUsd: cached.priceUsd, source: cached.source, cached: true };
  }

  // Cascading fallback
  let result = await fetchDexScreener(normalized, chain);
  if (!result) result = await fetchCoinGecko(normalized, chain);
  if (!result) result = await fetchAlchemy(normalized, chain);

  if (!result) return null;

  // Cache the result
  priceCache.set(cacheKey, {
    priceUsd: result.priceUsd,
    source: result.source,
    fetchedAt: Date.now(),
  });

  return { ...result, cached: false };
}

/**
 * Batch price lookup — efficient for portfolio valuation.
 * Uses CoinGecko batch (comma-separated per platform) first,
 * then DexScreener in parallel for misses, then Alchemy batch.
 */
export async function getTokenPrices(
  tokens: { address: string; chain: string }[],
): Promise<Map<string, PriceResult>> {
  const results = new Map<string, PriceResult>();
  if (tokens.length === 0) return results;

  const now = Date.now();
  const misses: { address: string; chain: string; normalized: string; cacheKey: string }[] = [];

  // 1. Check cache
  for (const { address, chain } of tokens) {
    const normalized = normalizeAddress(address, chain);
    const cacheKey = `${chain}:${normalized}`;
    const cached = priceCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      results.set(cacheKey, { priceUsd: cached.priceUsd, source: cached.source, cached: true });
    } else {
      misses.push({ address, chain, normalized, cacheKey });
    }
  }

  if (misses.length === 0) return results;

  // 2. CoinGecko batch — group by platform, comma-separate addresses
  const remaining = await batchCoinGecko(misses, results);

  // 3. DexScreener in parallel for CoinGecko misses
  const afterDex = await batchDexScreener(remaining, results);

  // 4. Alchemy batch for remaining misses
  await batchAlchemy(afterDex, results);

  return results;
}

/** CoinGecko batch: one API call per platform with comma-separated addresses */
async function batchCoinGecko(
  tokens: { address: string; chain: string; normalized: string; cacheKey: string }[],
  results: Map<string, PriceResult>,
): Promise<typeof tokens> {
  // Group by platform
  const byPlatform = new Map<string, typeof tokens>();
  const unsupported: typeof tokens = [];

  for (const t of tokens) {
    const platformId = COINGECKO_PLATFORMS[t.chain];
    if (!platformId) {
      unsupported.push(t);
      continue;
    }
    const group = byPlatform.get(platformId) || [];
    group.push(t);
    byPlatform.set(platformId, group);
  }

  const remaining = [...unsupported];

  await Promise.all(
    Array.from(byPlatform.entries()).map(async ([platformId, group]) => {
      const addresses = group.map((t) => t.normalized).join(',');
      try {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/token_price/${platformId}?contract_addresses=${addresses}&vs_currencies=usd`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) {
          remaining.push(...group);
          return;
        }
        const data = await res.json();

        for (const t of group) {
          const price = data[t.normalized.toLowerCase()]?.usd;
          if (price !== undefined && price !== null) {
            const entry = { priceUsd: price.toString(), source: 'coingecko' as const };
            results.set(t.cacheKey, { ...entry, cached: false });
            priceCache.set(t.cacheKey, { ...entry, fetchedAt: Date.now() });
          } else {
            remaining.push(t);
          }
        }
      } catch {
        remaining.push(...group);
      }
    }),
  );

  return remaining;
}

/** DexScreener: one API call per token, run in parallel */
async function batchDexScreener(
  tokens: { address: string; chain: string; normalized: string; cacheKey: string }[],
  results: Map<string, PriceResult>,
): Promise<typeof tokens> {
  if (tokens.length === 0) return [];

  const remaining: typeof tokens = [];

  await Promise.all(
    tokens.map(async (t) => {
      const result = await fetchDexScreener(t.normalized, t.chain);
      if (result) {
        results.set(t.cacheKey, { ...result, cached: false });
        priceCache.set(t.cacheKey, { ...result, fetchedAt: Date.now() });
      } else {
        remaining.push(t);
      }
    }),
  );

  return remaining;
}

/** Alchemy batch: one API call with multiple addresses (EVM only) */
async function batchAlchemy(
  tokens: { address: string; chain: string; normalized: string; cacheKey: string }[],
  results: Map<string, PriceResult>,
): Promise<void> {
  if (tokens.length === 0) return;

  const apiKey = await getAlchemyKey();
  if (!apiKey) return;

  // Filter to EVM only
  const evmTokens = tokens.filter((t) => !isSolanaChain(t.chain) && ALCHEMY_PATHS[t.chain]);
  if (evmTokens.length === 0) return;

  const addressPayload = evmTokens.map((t) => ({
    network: ALCHEMY_PATHS[t.chain].path,
    address: t.normalized,
  }));

  try {
    const res = await fetch(
      `https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-address`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: addressPayload }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return;
    const data = await res.json();

    for (let i = 0; i < evmTokens.length; i++) {
      const priceEntry = data.data?.[i]?.prices?.find(
        (p: any) => p.currency === 'usd' || p.currency === 'USD',
      );
      if (priceEntry?.value) {
        const entry = { priceUsd: priceEntry.value, source: 'alchemy' as const };
        results.set(evmTokens[i].cacheKey, { ...entry, cached: false });
        priceCache.set(evmTokens[i].cacheKey, { ...entry, fetchedAt: Date.now() });
      }
    }
  } catch {
    // Alchemy failed — prices just won't be available for these tokens
  }
}

async function getNativePrice(chain: string): Promise<PriceResult | null> {
  const currency = getNativeCurrency(chain);
  const price = currency === 'SOL' ? await getSolToUsd() : await getEthToUsd();
  if (price === null) return null;
  return { priceUsd: price.toString(), source: 'cache', cached: true };
}

/**
 * DexScreener: free, 300 req/min, no key needed
 */
async function fetchDexScreener(address: string, chain: string): Promise<{ priceUsd: string; source: string } | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const data = await res.json();

    const pairs = data.pairs
      ?.filter((p: any) => p.chainId === chain)
      ?.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

    const best = pairs?.[0];
    if (!best?.priceUsd) return null;

    return { priceUsd: best.priceUsd, source: 'dexscreener' };
  } catch {
    return null;
  }
}

/**
 * CoinGecko: free tier, 5-15 req/min, no key needed
 */
async function fetchCoinGecko(address: string, chain: string): Promise<{ priceUsd: string; source: string } | null> {
  const platformId = COINGECKO_PLATFORMS[chain];
  if (!platformId) return null;

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/token_price/${platformId}?contract_addresses=${address}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const data = await res.json();

    const key = address.toLowerCase();
    const price = data[key]?.usd;
    if (price === undefined || price === null) return null;

    return { priceUsd: price.toString(), source: 'coingecko' };
  } catch {
    return null;
  }
}

/**
 * Alchemy: requires API key, EVM only
 */
async function fetchAlchemy(address: string, chain: string): Promise<{ priceUsd: string; source: string } | null> {
  // Skip for Solana chains — Alchemy price API is EVM only
  if (isSolanaChain(chain)) return null;

  const apiKey = await getAlchemyKey();
  if (!apiKey) return null;

  const alchemyConfig = ALCHEMY_PATHS[chain];
  if (!alchemyConfig) return null;

  try {
    const res = await fetch(
      `https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-address`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          addresses: [{ network: alchemyConfig.path, address }],
        }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return null;
    const data = await res.json();

    const priceEntry = data.data?.[0]?.prices?.find(
      (p: any) => p.currency === 'usd' || p.currency === 'USD',
    );
    if (!priceEntry?.value) return null;

    return { priceUsd: priceEntry.value, source: 'alchemy' };
  } catch {
    return null;
  }
}
