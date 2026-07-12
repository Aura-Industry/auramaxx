/**
 * Token search by ticker/name via DexScreener with CoinGecko fallback.
 *
 * Local-first: checks TokenMetadata + bookmarks in the database before
 * hitting external APIs. Local matches are prepended to results.
 *
 * DexScreener: primary external source, returns pairs with liquidity data.
 * CoinGecko: fallback when DexScreener fails — search → coin details (two-step).
 *
 * In-memory cache with 5-minute TTL. No DB writes (except TokenMetadata seeding elsewhere).
 */

import { prisma } from './db';

const PERSIST_LIQUIDITY_THRESHOLD = 100;

/** Safely parse a JSON string, returning fallback on failure. */
export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export interface TokenSearchResult {
  address: string;
  chain: string;
  symbol: string;
  name: string;
  priceUsd: string | null;
  liquidity: number;
  volume24h: number;
  marketCap: number | null;
  fdv: number | null;
  imageUrl: string | null;
  websites: string[];
  socials: { type: string; url: string }[];
  dexId: string;
  pairAddress: string;
}

interface CacheEntry {
  results: TokenSearchResult[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

const searchCache = new Map<string, CacheEntry>();

/** Clear cache — exposed for tests */
export function clearTokenSearchCache(): void {
  searchCache.clear();
}

/** Look up a token by address+chain in the in-memory search cache. */
export function lookupCachedToken(
  address: string,
  chain: string,
): { symbol?: string; name?: string; icon?: string } | null {
  const addrLower = address.toLowerCase();
  const now = Date.now();
  for (const entry of searchCache.values()) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) continue;
    for (const r of entry.results) {
      if (r.address.toLowerCase() === addrLower && r.chain === chain) {
        return {
          ...(r.symbol && { symbol: r.symbol }),
          ...(r.name && { name: r.name }),
          ...(r.imageUrl && { icon: r.imageUrl }),
        };
      }
    }
  }
  return null;
}

// CoinGecko platform ID → our chain name
const COINGECKO_CHAIN_MAP: Record<string, string> = {
  'ethereum': 'ethereum',
  'base': 'base',
  'solana': 'solana',
  'polygon-pos': 'polygon',
  'arbitrum-one': 'arbitrum',
  'optimistic-ethereum': 'optimism',
  'binance-smart-chain': 'bsc',
  'avalanche': 'avalanche',
};

/**
 * Search local TokenMetadata + bookmarks (TrackedAsset with null walletAddress).
 * Returns matches by symbol, name, or address. Free and instant.
 */
async function searchLocal(
  query: string,
  chain: string,
  limit: number,
): Promise<TokenSearchResult[]> {
  try {
    const q = query.toLowerCase();
    const qUpper = query.toUpperCase();
    const isAddress = q.startsWith('0x') && q.length >= 10;

    const where: Record<string, unknown> = {
      OR: [
        { symbol: { contains: qUpper } },
        { name: { contains: q } },
        ...(isAddress ? [{ tokenAddress: { contains: q } }] : []),
      ],
    };
    if (chain) where.chain = chain;

    const rows = await prisma.tokenMetadata.findMany({
      where,
      take: limit,
      orderBy: { lastAccessedAt: 'desc' },
    });

    return rows.map((r) => ({
      address: r.tokenAddress,
      chain: r.chain,
      symbol: r.symbol || '',
      name: r.name || '',
      priceUsd: r.priceUsd ?? null,
      liquidity: r.liquidity ?? 0,
      volume24h: r.volume24h ?? 0,
      marketCap: r.marketCap ?? null,
      fdv: r.fdv ?? null,
      imageUrl: r.icon || null,
      websites: safeJsonParse<string[]>(r.websites, []),
      socials: safeJsonParse<{ type: string; url: string }[]>(r.socials, []),
      dexId: r.dexId || 'local',
      pairAddress: r.pairAddress || '',
    }));
  } catch {
    return [];
  }
}

/**
 * Search tokens by ticker/name. Returns deduplicated results sorted by liquidity.
 * Checks local TokenMetadata first, then DexScreener, then CoinGecko.
 * Local matches are prepended to external results.
 */
export async function searchTokens(
  query: string,
  options?: { chain?: string; limit?: number },
): Promise<TokenSearchResult[]> {
  const chain = options?.chain || '';
  const limit = Math.min(Math.max(options?.limit || 10, 1), 50);
  const cacheKey = `${query.toLowerCase()}:${chain}:${limit}`;

  // Check cache
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.results;
  }

  // 1. Check local TokenMetadata first (instant, free)
  const localResults = await searchLocal(query, chain, limit);

  // 2. Try DexScreener
  const dexResults = await fetchDexScreener(query, chain, limit);
  if (dexResults) {
    const merged = mergeResults(localResults, dexResults, limit);
    return cacheAndReturn(cacheKey, merged);
  }

  // 3. Fallback: CoinGecko
  const cgResults = await fetchCoinGecko(query, chain, limit);
  const merged = mergeResults(localResults, cgResults, limit);
  return cacheAndReturn(cacheKey, merged);
}

/**
 * Merge local results with external results.
 * Local matches come first, external results fill remaining slots.
 * Deduplicates by tokenAddress+chain (local wins).
 */
function mergeResults(
  local: TokenSearchResult[],
  external: TokenSearchResult[],
  limit: number,
): TokenSearchResult[] {
  if (local.length === 0) return external.slice(0, limit);

  const seen = new Set(local.map((r) => `${r.address.toLowerCase()}:${r.chain}`));
  const merged = [...local];

  for (const ext of external) {
    const key = `${ext.address.toLowerCase()}:${ext.chain}`;
    if (seen.has(key)) {
      // Enrich local entry with external data (price, liquidity, etc.)
      const idx = merged.findIndex(
        (r) => r.address.toLowerCase() === ext.address.toLowerCase() && r.chain === ext.chain,
      );
      if (idx !== -1) {
        merged[idx] = { ...ext, dexId: ext.dexId };
      }
      continue;
    }
    seen.add(key);
    merged.push(ext);
  }

  return merged.slice(0, limit);
}

/**
 * DexScreener search: returns pairs with full liquidity data.
 * Returns null on failure (triggers fallback).
 */
async function fetchDexScreener(
  query: string,
  chain: string,
  limit: number,
): Promise<TokenSearchResult[] | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;

    const data = await res.json();
    const pairs: any[] = data.pairs || [];
    if (pairs.length === 0) return null;

    // Filter by chain if specified
    const filtered = chain
      ? pairs.filter((p: any) => p.chainId === chain)
      : pairs;

    // Group by baseToken.address + chainId → pick pair with highest liquidity
    const groups = new Map<string, any>();
    for (const pair of filtered) {
      const addr = pair.baseToken?.address;
      if (!addr) continue;
      const key = `${addr.toLowerCase()}:${pair.chainId}`;
      const existing = groups.get(key);
      if (!existing || (pair.liquidity?.usd || 0) > (existing.liquidity?.usd || 0)) {
        groups.set(key, pair);
      }
    }

    // Sort by liquidity descending, apply limit
    const sorted = Array.from(groups.values())
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
      .slice(0, limit);

    return sorted.map(mapDexScreenerPair);
  } catch {
    return null;
  }
}

function mapDexScreenerPair(pair: any): TokenSearchResult {
  return {
    address: pair.baseToken.address,
    chain: pair.chainId,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    priceUsd: pair.priceUsd || null,
    liquidity: pair.liquidity?.usd || 0,
    volume24h: pair.volume?.h24 || 0,
    marketCap: pair.marketCap ?? null,
    fdv: pair.fdv ?? null,
    imageUrl: pair.info?.imageUrl || null,
    websites: (pair.info?.websites || []).map((w: any) => w.url || w).filter(Boolean),
    socials: (pair.info?.socials || []).filter((s: any) => s.url),
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
  };
}

/**
 * CoinGecko fallback: two-step search → coin details.
 * Step 1: GET /search?query=X → coin IDs
 * Step 2: GET /coins/{id} for top results → addresses + market data
 *
 * Limited to 5 detail fetches to respect CoinGecko rate limits (5-15 req/min free tier).
 */
async function fetchCoinGecko(
  query: string,
  chain: string,
  limit: number,
): Promise<TokenSearchResult[]> {
  try {
    // Step 1: Search for coin IDs
    const searchRes = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!searchRes.ok) return [];

    const searchData = await searchRes.json();
    const coins: any[] = searchData.coins || [];
    if (coins.length === 0) return [];

    // Take top 5 to stay within rate limits
    const topCoins = coins.slice(0, 5);

    // Step 2: Fetch details for each coin (in parallel)
    const details = await Promise.all(
      topCoins.map((coin) => fetchCoinGeckoDetails(coin.id)),
    );

    // Flatten: each coin may have multiple platform addresses
    const results: TokenSearchResult[] = [];
    for (const detail of details) {
      if (!detail) continue;
      for (const result of detail) {
        // Apply chain filter
        if (chain && result.chain !== chain) continue;
        results.push(result);
      }
    }

    // Sort by market cap (best proxy for liquidity from CoinGecko)
    results.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));

    return results.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Fetch coin details from CoinGecko and map to TokenSearchResult[].
 * Returns one result per platform (chain) the token is deployed on.
 */
async function fetchCoinGeckoDetails(coinId: string): Promise<TokenSearchResult[] | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;

    const data = await res.json();
    const platforms: Record<string, string> = data.platforms || {};
    const results: TokenSearchResult[] = [];

    // Extract common fields
    const symbol: string = data.symbol?.toUpperCase() || '';
    const name: string = data.name || '';
    const priceUsd = data.market_data?.current_price?.usd?.toString() || null;
    const volume24h = data.market_data?.total_volume?.usd || 0;
    const marketCap = data.market_data?.market_cap?.usd ?? null;
    const fdv = data.market_data?.fully_diluted_valuation?.usd ?? null;
    const imageUrl = data.image?.large || data.image?.small || null;
    const websites = (data.links?.homepage || []).filter(Boolean);
    const socials: { type: string; url: string }[] = [];
    if (data.links?.twitter_screen_name) {
      socials.push({ type: 'twitter', url: `https://twitter.com/${data.links.twitter_screen_name}` });
    }
    if (data.links?.telegram_channel_identifier) {
      socials.push({ type: 'telegram', url: `https://t.me/${data.links.telegram_channel_identifier}` });
    }

    for (const [platformId, address] of Object.entries(platforms)) {
      if (!address) continue;
      const chainName = COINGECKO_CHAIN_MAP[platformId] || platformId;

      results.push({
        address,
        chain: chainName,
        symbol,
        name,
        priceUsd,
        liquidity: 0, // CoinGecko doesn't provide liquidity
        volume24h,
        marketCap,
        fdv,
        imageUrl,
        websites,
        socials,
        dexId: 'coingecko',
        pairAddress: '',
      });
    }

    return results;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget persist market data from search results to TokenMetadata.
 * Skips tokens with low liquidity and local-only results (no new data).
 */
function persistSearchMarketData(results: TokenSearchResult[]): void {
  for (const r of results) {
    if (r.dexId === 'local') continue;
    if (r.liquidity < PERSIST_LIQUIDITY_THRESHOLD && !r.marketCap) continue;

    const websites = r.websites.length > 0 ? JSON.stringify(r.websites) : null;
    const socials = r.socials.length > 0 ? JSON.stringify(r.socials) : null;

    prisma.tokenMetadata.upsert({
      where: { tokenAddress_chain: { tokenAddress: r.address, chain: r.chain } },
      create: {
        tokenAddress: r.address,
        chain: r.chain,
        symbol: r.symbol || undefined,
        name: r.name || undefined,
        icon: r.imageUrl || undefined,
        priceUsd: r.priceUsd,
        marketCap: r.marketCap,
        fdv: r.fdv,
        liquidity: r.liquidity || null,
        volume24h: r.volume24h || null,
        dexId: r.dexId,
        pairAddress: r.pairAddress || null,
        websites,
        socials,
      },
      update: {
        symbol: r.symbol || undefined,
        name: r.name || undefined,
        icon: r.imageUrl || undefined,
        priceUsd: r.priceUsd,
        marketCap: r.marketCap,
        fdv: r.fdv,
        liquidity: r.liquidity || null,
        volume24h: r.volume24h || null,
        dexId: r.dexId,
        pairAddress: r.pairAddress || null,
        websites,
        socials,
        lastAccessedAt: new Date(),
      },
    }).catch(() => {});
  }
}

function cacheAndReturn(key: string, results: TokenSearchResult[]): TokenSearchResult[] {
  searchCache.set(key, { results, fetchedAt: Date.now() });
  persistSearchMarketData(results);
  return results;
}
