import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db';
import { upsertTokenMetadata } from '../lib/token-metadata';
import { safeJsonParse } from '../lib/token-search';
import { requireWalletAuth, optionalWalletAuth } from '../middleware/auth';
import { isAdmin } from '../lib/permissions';
import { getErrorMessage } from '../lib/error';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';

const router = Router();

// GET /bookmarks - List all bookmarked tokens (TrackedAsset where walletAddress is null)
router.get('/', optionalWalletAuth, async (req: Request, res: Response) => {
  try {
    const chain = req.query.chain as string | undefined;
    const q = req.query.q as string | undefined;

    const where: Record<string, unknown> = {
      walletAddress: null,
    };

    if (chain) where.chain = chain;

    if (q) {
      where.OR = [
        { symbol: { contains: q.toUpperCase() } },
        { name: { contains: q.toLowerCase() } },
        { tokenAddress: { contains: q.toLowerCase() } },
      ];
    }

    const bookmarks = await prisma.trackedAsset.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });

    // Enrich with TokenMetadata if available
    const tokenKeys = bookmarks.map(b => ({ tokenAddress: b.tokenAddress, chain: b.chain }));
    const metadata = tokenKeys.length > 0
      ? await prisma.tokenMetadata.findMany({
          where: {
            OR: tokenKeys.map(k => ({
              tokenAddress: k.tokenAddress,
              chain: k.chain,
            })),
          },
        })
      : [];

    const metaMap = new Map(metadata.map(m => [`${m.tokenAddress}:${m.chain}`, m]));

    const enriched = bookmarks.map(b => {
      const meta = metaMap.get(`${b.tokenAddress}:${b.chain}`);
      return {
        ...b,
        symbol: meta?.symbol ?? b.symbol,
        name: meta?.name ?? b.name,
        decimals: meta?.decimals ?? b.decimals,
        icon: meta?.icon ?? b.icon,
        priceUsd: meta?.priceUsd ?? null,
        marketCap: meta?.marketCap ?? null,
        fdv: meta?.fdv ?? null,
        liquidity: meta?.liquidity ?? null,
        volume24h: meta?.volume24h ?? null,
        dexId: meta?.dexId ?? null,
        pairAddress: meta?.pairAddress ?? null,
        websites: meta?.websites ? safeJsonParse(meta.websites, []) : [],
        socials: meta?.socials ? safeJsonParse(meta.socials, []) : [],
      };
    });

    res.json({ success: true, bookmarks: enriched });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// POST /bookmarks - Create a token bookmark
router.post('/', requireWalletAuth, async (req: Request, res: Response) => {
  try {
    const auth = req.auth!;

    // Check permission
    if (!isAdmin(auth)) {
      const perms = auth.token.permissions;
      if (!perms.includes('bookmark:write') && !perms.includes('admin:*')) {
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.BOOKMARK_WRITE,
          error: 'Token does not have bookmark:write permission',
          required: ['bookmark:write'],
          have: auth.token.permissions,
        });
        return;
      }
    }

    const { tokenAddress, chain = 'base' } = req.body;

    if (!tokenAddress) {
      res.status(400).json({ error: 'tokenAddress is required' });
      return;
    }

    const normalizedToken = tokenAddress.toLowerCase();

    // Find-or-create bookmark (Prisma can't upsert on compound unique with NULL)
    let bookmark = await prisma.trackedAsset.findFirst({
      where: { walletAddress: null, tokenAddress: normalizedToken, chain },
    });

    if (bookmark) {
      bookmark = await prisma.trackedAsset.update({
        where: { id: bookmark.id },
        data: { updatedAt: new Date() },
      });
    } else {
      bookmark = await prisma.trackedAsset.create({
        data: {
          walletAddress: null,
          tokenAddress: normalizedToken,
          chain,
        },
      });
    }

    // Seed TokenMetadata if not cached
    upsertTokenMetadata(normalizedToken, chain);

    res.json({ success: true, bookmark });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// DELETE /bookmarks/:id - Delete a bookmark
router.delete('/:id', requireWalletAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const auth = req.auth!;

    // Check permission
    if (!isAdmin(auth)) {
      const perms = auth.token.permissions;
      if (!perms.includes('bookmark:write') && !perms.includes('admin:*')) {
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.BOOKMARK_WRITE,
          error: 'Token does not have bookmark:write permission',
          required: ['bookmark:write'],
          have: auth.token.permissions,
        });
        return;
      }
    }

    const { id } = req.params;

    const existing = await prisma.trackedAsset.findUnique({ where: { id } });
    if (!existing || existing.walletAddress !== null) {
      res.status(404).json({ error: 'Bookmark not found' });
      return;
    }

    await prisma.trackedAsset.delete({ where: { id } });

    res.json({ success: true });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

export default router;
