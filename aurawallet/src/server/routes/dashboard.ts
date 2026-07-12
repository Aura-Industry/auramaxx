import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db';
import { listTokensFromDb } from '../lib/sessions';
import { getAdminTokenHashes } from '../lib/auth';
import { getErrorMessage } from '../lib/error';
import { buildHumanActionSummary } from '../lib/human-action-summary';
import { getDefaultSync } from '../lib/defaults';

const router = Router();

// GET /dashboard - Combined view of pending/history actions and agent tokens
router.get('/', async (_req: Request, res: Response) => {
  try {
    // Get pending requests + recent resolved history for drawer surfaces.
    const [pendingActions, historyActions] = await Promise.all([
      prisma.humanAction.findMany({
        where: {
          status: 'pending',
          NOT: { type: 'strategy:message' },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.humanAction.findMany({
        where: {
          status: { not: 'pending' },
          NOT: { type: 'strategy:message' },
        },
        orderBy: [{ resolvedAt: 'desc' }, { createdAt: 'desc' }],
        take: 40,
      }),
    ]);

    const requests = pendingActions.map((action) => ({
      ...action,
      humanSummary: buildHumanActionSummary(action),
      rawPayload: action.metadata,
    }));
    const history = historyActions.map((action) => ({
      ...action,
      humanSummary: buildHumanActionSummary(action),
      rawPayload: action.metadata,
    }));

    // Get all tokens from DB (with isActive flag from memory check)
    const allTokens = await listTokensFromDb();

    // Exclude admin tokens from DB list — they're added separately from getAdminTokenHashes()
    const nonAdminTokens = allTokens.filter(t => t.agentId !== 'admin');

    // Active = in memory + not expired + not revoked + (no fund limit OR has remaining)
    const agentActiveTokens = nonAdminTokens.filter(t => t.isActive && (t.limit === 0 || t.remaining > 0));

    // Inactive = not in memory (server restarted) OR expired OR revoked OR depleted (has limit but none remaining)
    const inactiveTokens = nonAdminTokens.filter(t => !t.isActive || (t.limit > 0 && t.remaining <= 0));

    // Get admin token hashes and create admin token entries
    const adminHashes = getAdminTokenHashes();
    const adminTokenTtlMs = getDefaultSync<number>('ttl.admin', 2592000) * 1000;
    const adminTokens = adminHashes.map(hash => ({
      tokenHash: hash,
      agentId: 'admin',
      isAdmin: true,
      limit: 0,
      spent: 0,
      remaining: Infinity,
      permissions: ['admin:*'],
      expiresAt: Date.now() + adminTokenTtlMs,
      isExpired: false,
      isRevoked: false,
      isActive: true,
    }));

    // Combine: admin tokens first, then agent tokens
    const activeTokens = [...adminTokens, ...agentActiveTokens];

    res.json({
      success: true,
      requests,
      history,
      tokens: {
        active: activeTokens,
        inactive: inactiveTokens
      },
      counts: {
        pendingActions: pendingActions.length,
        historyActions: historyActions.length,
        activeTokens: activeTokens.length,
        inactiveTokens: inactiveTokens.length
      }
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

export default router;
