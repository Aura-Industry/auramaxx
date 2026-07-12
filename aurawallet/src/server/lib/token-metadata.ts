/**
 * Shared helper for upserting token metadata cache.
 * Fire-and-forget — callers should not await.
 *
 * Enrichment strategy:
 * 1. Use caller-provided metadata if available
 * 2. Check in-memory search cache (free, instant)
 * 3. If row is still a stub after upsert, fire-and-forget DexScreener enrichment
 */
import { prisma } from './db';
import { lookupCachedToken } from './token-search';

export function upsertTokenMetadata(
  tokenAddress: string,
  chain: string,
  metadata?: { symbol?: string; name?: string; decimals?: number; icon?: string }
): void {
  // If no metadata provided, try the search cache (free, instant)
  const resolved = metadata ?? lookupCachedToken(tokenAddress, chain);

  const filtered: Record<string, unknown> = {};
  if (resolved) {
    if (resolved.symbol !== undefined) filtered.symbol = resolved.symbol;
    if (resolved.name !== undefined) filtered.name = resolved.name;
    if (resolved.icon !== undefined) filtered.icon = resolved.icon;
  }
  if (metadata?.decimals !== undefined) filtered.decimals = metadata.decimals;

  prisma.tokenMetadata.upsert({
    where: { tokenAddress_chain: { tokenAddress, chain } },
    create: { tokenAddress, chain, ...filtered },
    update: { ...filtered, lastAccessedAt: new Date() },
  }).then((row) => {
    // If still a stub (no symbol), try DexScreener enrichment
    if (!row.symbol) {
      enrichFromDexScreener(tokenAddress, chain).catch(() => {});
    }
  }).catch(() => {
    // Silently ignore — metadata cache is best-effort
  });
}

/** Fire-and-forget DexScreener enrichment for a single token */
async function enrichFromDexScreener(tokenAddress: string, chain: string): Promise<void> {
  const res = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) return;
  const data = await res.json();
  const pairs: any[] = data.pairs || [];
  if (pairs.length === 0) return;

  // Prefer a pair on the same chain
  const chainPairs = pairs.filter((p: any) => p.chainId === chain);
  const pair = chainPairs.length > 0 ? chainPairs[0] : pairs[0];

  const symbol: string | undefined = pair.baseToken?.symbol;
  const name: string | undefined = pair.baseToken?.name;
  const icon: string | undefined = pair.info?.imageUrl;

  if (!symbol && !name && !icon) return;

  const update: Record<string, unknown> = {};
  if (symbol) update.symbol = symbol;
  if (name) update.name = name;
  if (icon) update.icon = icon;

  // Persist market data from DexScreener pair
  if (pair.priceUsd) update.priceUsd = pair.priceUsd;
  if (pair.marketCap != null) update.marketCap = pair.marketCap;
  if (pair.fdv != null) update.fdv = pair.fdv;
  if (pair.liquidity?.usd != null) update.liquidity = pair.liquidity.usd;
  if (pair.volume?.h24 != null) update.volume24h = pair.volume.h24;
  if (pair.dexId) update.dexId = pair.dexId;
  if (pair.pairAddress) update.pairAddress = pair.pairAddress;
  const websites = (pair.info?.websites || []).map((w: any) => w.url || w).filter(Boolean);
  if (websites.length > 0) update.websites = JSON.stringify(websites);
  const socials = (pair.info?.socials || []).filter((s: any) => s.url);
  if (socials.length > 0) update.socials = JSON.stringify(socials);

  await prisma.tokenMetadata.update({
    where: { tokenAddress_chain: { tokenAddress, chain } },
    data: update,
  }).catch(() => {});
}
