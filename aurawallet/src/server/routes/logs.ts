import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db';
import { getErrorMessage } from '../lib/error';
import { requireWalletAuth, requireAdmin } from '../middleware/auth';
import { redactJsonString } from '../lib/redaction';

const router = Router();

// Logs are high-sensitivity; restrict access to authenticated admin callers.
router.use(requireWalletAuth, requireAdmin);

// GET /logs - Event logs - fetch historical events from database
// Supports filtering by: type, category (prefix match), agentId, since/until (timestamps), path
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 250);
    const offset = parseInt(req.query.offset as string) || 0;
    const type = req.query.type as string | undefined;
    const category = req.query.category as string | undefined;
    const agentId = req.query.agentId as string | undefined;
    const since = req.query.since as string | undefined;
    const until = req.query.until as string | undefined;

    const where: Record<string, unknown> = {};

    if (type) {
      where.type = type;
    } else if (category) {
      // Prefix match: category=auth matches auth:unlocked, auth:auth_failed, etc.
      where.type = { startsWith: `${category}:` };
    }

    // Filter by agentId in the JSON data field
    if (agentId) {
      where.data = { contains: `"agentId":"${agentId}"` };
    }

    // Date range filtering
    if (since || until) {
      const timestampFilter: Record<string, Date> = {};
      if (since) timestampFilter.gte = new Date(parseInt(since) || since);
      if (until) timestampFilter.lte = new Date(parseInt(until) || until);
      where.timestamp = timestampFilter;
    }

    const [logs, total] = await Promise.all([
      prisma.event.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.event.count({ where }),
    ]);

    const sanitizedLogs = logs.map((row) => ({
      ...row,
      data: redactJsonString(row.data),
    }));

    res.json({
      success: true,
      logs: sanitizedLogs,
      count: sanitizedLogs.length,
      total,
      pagination: {
        limit,
        offset,
        hasMore: offset + sanitizedLogs.length < total,
      },
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
