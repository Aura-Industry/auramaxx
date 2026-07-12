import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { getColdWalletAddress, getSolanaColdAddress } from '../lib/cold';
import { tokenCanAccessWallet, getHotWallet } from '../lib/hot';
import { listTempWallets } from '../lib/temp';
import { loadConfig, getRpcUrl } from '../lib/config';
import { detectBestDex } from '../lib/dex';
import { requireWalletAuth, optionalWalletAuth } from '../middleware/auth';
import { hasAnyPermission, isAdmin } from '../lib/permissions';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';
import { prisma } from '../lib/db';
import type { TrackedAsset } from '@prisma/client';
import { upsertTokenMetadata } from '../lib/token-metadata';
import { isSolanaChain, normalizeAddress } from '../lib/address';
import { events } from '../lib/events';
import { getTokenPrices } from '../lib/price';
import { getErrorMessage } from '../lib/error';

const router = Router();

/**
 * Async pool detection for tracked assets (fire-and-forget)
 * Detects DEX pools for assets that don't have poolAddress set
 * Emits asset:changed event when pool is found
 */
async function detectMissingPools(assets: TrackedAsset[]): Promise<void> {
  const config = loadConfig();
  const chainConfig = config.chains[config.defaultChain];
  if (!chainConfig) return;

  const provider = new ethers.JsonRpcProvider(await getRpcUrl(config.defaultChain));

  for (const asset of assets) {
    // Skip if already has pool info
    if (asset.poolAddress) continue;

    try {
      const result = await detectBestDex(asset.tokenAddress, provider, chainConfig.chainId);
      if (result) {
        // Update DB with pool info
        await prisma.trackedAsset.update({
          where: { id: asset.id },
          data: {
            poolAddress: result.pool.poolAddress,
            poolVersion: result.pool.version
          }
        });

        // Emit event for real-time update
        events.assetChanged({
          walletAddress: asset.walletAddress ?? '',
          tokenAddress: asset.tokenAddress,
          symbol: asset.symbol ?? undefined,
          name: asset.name ?? undefined,
          poolAddress: result.pool.poolAddress,
          poolVersion: result.pool.version
        });
      }
    } catch (err) {
      // Silent fail - pool detection is non-critical
      console.error(`[Pool Detection] Failed for ${asset.tokenAddress}:`, getErrorMessage(err));
    }
  }
}

// GET /wallet/:address/assets - List tracked assets for a wallet
router.get('/:address/assets', optionalWalletAuth, async (req: Request<{ address: string }>, res: Response) => {
  try {
    const address = String(req.params.address);
    const auth = req.auth;
    const agentCanListAll = !!(
      auth &&
      !isAdmin(auth) &&
      hasAnyPermission(auth.token.permissions, ['wallet:list'])
    );

    // Verify wallet exists (hot/cold/temp)
    const hotWallet = await getHotWallet(address);
    const coldEvmAddress = getColdWalletAddress();
    const coldSolAddress = getSolanaColdAddress();
    const isColdEvm = coldEvmAddress
      ? normalizeAddress(coldEvmAddress, 'base') === normalizeAddress(address, 'base')
      : false;
    const isColdSol = coldSolAddress ? coldSolAddress === address : false;
    const tempWallet = listTempWallets().find((w) =>
      normalizeAddress(w.address, w.chain) === normalizeAddress(address, w.chain)
    );

    if (!hotWallet && !isColdEvm && !isColdSol && !tempWallet) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    // If agent (not admin), verify they have access to the wallet
    if (auth && !isAdmin(auth)) {
      if (hotWallet && !agentCanListAll) {
        const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, address);
        if (!canAccess) {
          await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
          return;
        }
      } else if (!hotWallet && !agentCanListAll) {
        await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
        return;
      }
    }

    // Parse query params
    const {
      search,
      chain,
      includeHidden = 'false',
      limit = '50',
      offset = '0',
      sortBy = 'updatedAt',
      sortDir = 'desc'
    } = req.query as Record<string, string>;

    const take = Math.min(parseInt(limit) || 50, 250);
    const skip = parseInt(offset) || 0;

    // Build where clause
    const resolvedChain = hotWallet?.metadata.chain
      || (isColdSol ? 'solana' : undefined)
      || (tempWallet ? (tempWallet.chain === 'any' ? 'base' : tempWallet.chain) : undefined)
      || 'base';
    const normalizedWalletAddress = normalizeAddress(address, resolvedChain);

    const where: Record<string, unknown> = {
      walletAddress: normalizedWalletAddress
    };

    if (chain) {
      where.chain = chain;
    }

    if (includeHidden !== 'true') {
      where.isHidden = false;
    }

    if (search) {
      where.OR = [
        { symbol: { contains: search.toUpperCase() } },
        { name: { contains: search.toLowerCase() } },
        { tokenAddress: { contains: search.toLowerCase() } }
      ];
    }

    // Query assets
    const [assets, total] = await Promise.all([
      prisma.trackedAsset.findMany({
        where,
        orderBy: { [sortBy]: sortDir },
        take,
        skip
      }),
      prisma.trackedAsset.count({ where })
    ]);

    // Batch-lookup TokenMetadata for enrichment
    const tokenKeys = assets.map(a => ({ tokenAddress: a.tokenAddress, chain: a.chain }));
    const tokenMeta = tokenKeys.length > 0
      ? await prisma.tokenMetadata.findMany({
          where: { OR: tokenKeys.map(k => ({ tokenAddress: k.tokenAddress, chain: k.chain })) },
        })
      : [];
    const metaMap = new Map(tokenMeta.map(m => [`${m.tokenAddress}:${m.chain}`, m]));

    // Fire-and-forget: update lastAccessedAt on touched metadata rows
    if (tokenMeta.length > 0) {
      prisma.tokenMetadata.updateMany({
        where: { id: { in: tokenMeta.map(m => m.id) } },
        data: { lastAccessedAt: new Date() },
      }).catch(() => {});
    }

    // Batch-fetch USD prices for all returned assets
    const priceMap = await getTokenPrices(
      assets.map((a) => ({ address: a.tokenAddress, chain: a.chain })),
    );

    const enrichedAssets = assets.map((a) => {
      const meta = metaMap.get(`${a.tokenAddress}:${a.chain}`);
      const cacheKey = `${a.chain}:${a.tokenAddress.toLowerCase()}`;
      const price = priceMap.get(cacheKey);
      const priceUsd = price ? parseFloat(price.priceUsd) : null;
      const balance = parseFloat(a.lastBalance || '0') || 0;
      const valueUsd = priceUsd !== null && balance > 0 ? balance * priceUsd : null;
      return {
        ...a,
        symbol: meta?.symbol ?? a.symbol,
        name: meta?.name ?? a.name,
        decimals: meta?.decimals ?? a.decimals,
        icon: meta?.icon ?? a.icon,
        priceUsd: priceUsd !== null ? priceUsd.toString() : null,
        valueUsd: valueUsd !== null ? valueUsd.toFixed(2) : null,
      };
    });

    res.json({
      success: true,
      assets: enrichedAssets,
      pagination: {
        total,
        limit: take,
        offset: skip,
        hasMore: skip + assets.length < total
      }
    });

    // Fire-and-forget pool detection for assets without pool info
    detectMissingPools(assets).catch(console.error);
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// POST /wallet/:address/asset - Add or update a tracked asset
router.post('/:address/asset', requireWalletAuth, async (req: Request<{ address: string }>, res: Response) => {
  try {
    const address = String(req.params.address);
    const auth = req.auth!;

    // Check permission
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['wallet:asset:add'])) {
      await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_ASSET_ADD_PERMISSION, error: 'Token does not have wallet:asset:add permission', required: ['wallet:asset:add'], have: auth.token.permissions });
      return;
    }

    // Verify wallet exists and access
    const wallet = await getHotWallet(address);
    if (!wallet) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    if (!isAdmin(auth)) {
      const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, address);
      if (!canAccess) {
        await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
        return;
      }
    }

    const {
      tokenAddress,
      symbol,
      name,
      decimals = 18,
      chain = 'base',
      isHidden = false
    } = req.body;

    if (!tokenAddress || typeof tokenAddress !== 'string') {
      res.status(400).json({ error: 'tokenAddress is required' });
      return;
    }

    // Upsert the asset
    const asset = await prisma.trackedAsset.upsert({
      where: {
        walletAddress_tokenAddress_chain: {
          walletAddress: address.toLowerCase(),
          tokenAddress: tokenAddress.toLowerCase(),
          chain
        }
      },
      create: {
        walletAddress: address.toLowerCase(),
        tokenAddress: tokenAddress.toLowerCase(),
        symbol,
        name,
        decimals,
        chain,
        isHidden
      },
      update: {
        symbol: symbol ?? undefined,
        name: name ?? undefined,
        decimals: decimals ?? undefined,
        isHidden: isHidden ?? undefined
      }
    });

    // Emit asset changed event
    events.assetChanged({
      walletAddress: address.toLowerCase(),
      tokenAddress: tokenAddress.toLowerCase(),
      symbol,
      name
    });

    upsertTokenMetadata(tokenAddress.toLowerCase(), chain, { symbol, name, decimals });

    res.json({ success: true, asset });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// DELETE /wallet/:address/asset/:assetId - Remove a tracked asset
router.delete('/:address/asset/:assetId', requireWalletAuth, async (req: Request<{ address: string; assetId: string }>, res: Response) => {
  try {
    const address = String(req.params.address);
    const assetId = String(req.params.assetId);
    const auth = req.auth!;

    // Check permission
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['wallet:asset:remove'])) {
      await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_ASSET_REMOVE_PERMISSION, error: 'Token does not have wallet:asset:remove permission', required: ['wallet:asset:remove'], have: auth.token.permissions });
      return;
    }

    // Verify wallet exists and access
    const wallet = await getHotWallet(address);
    if (!wallet) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    if (!isAdmin(auth)) {
      const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, address);
      if (!canAccess) {
        await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
        return;
      }
    }

    // Find the asset first to verify ownership and get tokenAddress for event
    const asset = await prisma.trackedAsset.findFirst({
      where: {
        id: assetId,
        walletAddress: address.toLowerCase()
      }
    });

    if (!asset) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }

    // Delete the asset
    await prisma.trackedAsset.delete({
      where: { id: assetId }
    });

    // Emit asset changed event with removed flag
    events.assetChanged({
      walletAddress: address.toLowerCase(),
      tokenAddress: asset.tokenAddress,
      removed: true
    });

    res.json({ success: true });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

export default router;
