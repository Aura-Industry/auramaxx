/**
 * Portfolio endpoint — cross-wallet asset aggregation.
 * Returns native balances by chain + token balances aggregated across wallets.
 * Supports filtering by token address or symbol for per-wallet breakdown.
 */

import { Router, Request, Response } from 'express';
import { optionalWalletAuth } from '../middleware/auth';
import { isAdmin, hasAnyPermission } from '../lib/permissions';
import { prisma } from '../lib/db';
import { listHotWallets } from '../lib/hot';
import { getEthToUsd, getSolToUsd } from '../lib/prices';
import { getTokenPrices } from '../lib/price';
import { getNativeCurrency } from '../lib/address';
import { getErrorMessage } from '../lib/error';

const router = Router();

// GET /portfolio — aggregated balances across all wallets
// Requires wallet:list permission for agents (admin always OK, no-auth OK)
// Query params:
//   token  — filter by token contract address (returns per-wallet breakdown)
//   symbol — filter by token symbol, case-insensitive (returns per-wallet breakdown)
//   chain  — filter by chain name
router.get('/', optionalWalletAuth, async (req: Request, res: Response) => {
  try {
    const auth = req.auth;
    const isAgent = auth && !isAdmin(auth);
    const canListAll = isAgent && hasAnyPermission(auth.token.permissions, ['wallet:list']);

    // Agents without wallet:list can only see their own wallets
    let walletFilter: string[] | undefined;
    if (isAgent && !canListAll) {
      const owned = await listHotWallets(auth.tokenHash);
      walletFilter = owned.map((w) => w.address.toLowerCase());
      if (walletFilter.length === 0) {
        res.json({ success: true, byChain: [], byToken: [] });
        return;
      }
    }

    const { token, symbol, chain } = req.query as Record<string, string | undefined>;

    // Native balances by chain
    const nativeWhere: Record<string, unknown> = {};
    if (walletFilter) nativeWhere.walletAddress = { in: walletFilter };
    if (chain) nativeWhere.chain = chain;

    const nativeBalances = await prisma.nativeBalance.findMany({
      where: nativeWhere,
    });

    // Group native balances by chain
    const byChainMap = new Map<string, { chain: string; totalBalance: number; walletCount: number }>();
    for (const nb of nativeBalances) {
      const entry = byChainMap.get(nb.chain) || { chain: nb.chain, totalBalance: 0, walletCount: 0 };
      entry.totalBalance += parseFloat(nb.balance) || 0;
      entry.walletCount += 1;
      byChainMap.set(nb.chain, entry);
    }

    // Token balances — build filter (exclude bookmarks with null walletAddress)
    const assetWhere: Record<string, unknown> = {};
    if (walletFilter) {
      assetWhere.walletAddress = { in: walletFilter };
    } else {
      assetWhere.walletAddress = { not: null };
    }
    assetWhere.lastBalance = { not: null };
    if (chain) assetWhere.chain = chain;
    if (token) assetWhere.tokenAddress = token.toLowerCase();
    if (symbol) assetWhere.symbol = symbol.toUpperCase();

    const trackedAssets = await prisma.trackedAsset.findMany({
      where: assetWhere,
      select: {
        tokenAddress: true,
        symbol: true,
        name: true,
        decimals: true,
        lastBalance: true,
        chain: true,
        walletAddress: true,
      },
    });

    // Batch-lookup TokenMetadata for enrichment
    const uniqueTokenKeys = [...new Set(trackedAssets.map(a => `${a.tokenAddress}:${a.chain}`))];
    const tokenMetaList = uniqueTokenKeys.length > 0
      ? await prisma.tokenMetadata.findMany({
          where: {
            OR: uniqueTokenKeys.map(k => {
              const [addr, ch] = k.split(':');
              return { tokenAddress: addr, chain: ch };
            }),
          },
        })
      : [];
    const metaMap = new Map(tokenMetaList.map(m => [`${m.tokenAddress}:${m.chain}`, m]));

    // Group by tokenAddress+chain
    const tokenKey = (addr: string, c: string) => `${addr.toLowerCase()}:${c}`;
    const byTokenMap = new Map<string, {
      tokenAddress: string;
      chain: string;
      symbol: string | null;
      name: string | null;
      decimals: number;
      totalBalance: number;
      walletCount: number;
    }>();

    // When filtering by token/symbol, also collect per-wallet breakdown
    const isFiltered = !!(token || symbol);
    const walletBreakdown: { walletAddress: string; chain: string; balance: number }[] = [];

    for (const asset of trackedAssets) {
      const key = tokenKey(asset.tokenAddress, asset.chain);
      const meta = metaMap.get(`${asset.tokenAddress}:${asset.chain}`);
      const existing = byTokenMap.get(key);
      const balance = parseFloat(asset.lastBalance || '0') || 0;

      if (isFiltered && asset.walletAddress) {
        walletBreakdown.push({
          walletAddress: asset.walletAddress,
          chain: asset.chain,
          balance,
        });
      }

      if (existing) {
        existing.totalBalance += balance;
        existing.walletCount += 1;
        if (!existing.symbol && (meta?.symbol || asset.symbol)) existing.symbol = meta?.symbol ?? asset.symbol;
        if (!existing.name && (meta?.name || asset.name)) existing.name = meta?.name ?? asset.name;
      } else {
        byTokenMap.set(key, {
          tokenAddress: asset.tokenAddress,
          chain: asset.chain,
          symbol: meta?.symbol ?? asset.symbol,
          name: meta?.name ?? asset.name,
          decimals: meta?.decimals ?? asset.decimals,
          totalBalance: balance,
          walletCount: 1,
        });
      }
    }

    // Fetch cached native prices
    const [ethPrice, solPrice] = await Promise.all([getEthToUsd(), getSolToUsd()]);
    const nativePrices: Record<string, number | null> = { ETH: ethPrice, SOL: solPrice };

    // Batch-fetch USD prices for all tracked tokens
    const tokenEntries = Array.from(byTokenMap.values());
    const priceMap = await getTokenPrices(
      tokenEntries.map((t) => ({ address: t.tokenAddress, chain: t.chain })),
    );

    // Enrich tokens with USD values
    let totalValueUsd = 0;
    const byToken = tokenEntries.map((t) => {
      const cacheKey = `${t.chain}:${t.tokenAddress.toLowerCase()}`;
      const price = priceMap.get(cacheKey);
      const priceUsd = price ? parseFloat(price.priceUsd) : null;
      const valueUsd = priceUsd !== null ? t.totalBalance * priceUsd : null;
      if (valueUsd !== null) totalValueUsd += valueUsd;
      return {
        ...t,
        priceUsd: priceUsd !== null ? priceUsd.toString() : null,
        valueUsd: valueUsd !== null ? valueUsd.toFixed(2) : null,
      };
    }).sort((a, b) => {
      const aVal = a.valueUsd ? parseFloat(a.valueUsd) : -1;
      const bVal = b.valueUsd ? parseFloat(b.valueUsd) : -1;
      return bVal - aVal;
    });

    // Enrich chains with USD values
    const byChain = Array.from(byChainMap.values()).map((c) => {
      const currency = getNativeCurrency(c.chain);
      const nativePrice = nativePrices[currency];
      const valueUsd = nativePrice !== null ? c.totalBalance * nativePrice : null;
      if (valueUsd !== null) totalValueUsd += valueUsd;
      return {
        ...c,
        valueUsd: valueUsd !== null ? valueUsd.toFixed(2) : null,
      };
    });

    // Enrich wallet breakdown with USD when filtered
    let wallets: { walletAddress: string; chain: string; balance: number; valueUsd: string | null }[] | undefined;
    if (isFiltered && walletBreakdown.length > 0) {
      // Use first token's price for all wallet entries (same token)
      const firstPrice = byToken[0]?.priceUsd ? parseFloat(byToken[0].priceUsd) : null;
      wallets = walletBreakdown.map((w) => ({
        ...w,
        valueUsd: firstPrice !== null ? (w.balance * firstPrice).toFixed(2) : null,
      }));
    }

    const response: Record<string, unknown> = {
      success: true,
      byChain,
      byToken,
      prices: { ETH: ethPrice, SOL: solPrice },
      totalValueUsd: totalValueUsd.toFixed(2),
    };
    if (wallets) response.wallets = wallets;

    res.json(response);
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
