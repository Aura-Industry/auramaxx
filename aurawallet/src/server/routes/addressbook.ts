import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db';
import { requireWalletAuth, optionalWalletAuth } from '../middleware/auth';
import { isAdmin } from '../lib/permissions';
import { getErrorMessage } from '../lib/error';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';

const router = Router();

// GET /address-labels - List all address labels
router.get('/', optionalWalletAuth, async (req: Request, res: Response) => {
  try {
    const q = req.query.q as string | undefined;

    const where: Record<string, unknown> = {};
    if (q) {
      where.OR = [
        { label: { contains: q } },
        { address: { contains: q.toLowerCase() } },
      ];
    }

    const labels = await prisma.addressLabel.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });

    res.json({ success: true, labels });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// POST /address-labels - Create or update an address label (upsert by address)
router.post('/', requireWalletAuth, async (req: Request, res: Response) => {
  try {
    const auth = req.auth!;

    // Check permission
    if (!isAdmin(auth)) {
      const perms = auth.token.permissions;
      if (!perms.includes('addressbook:write') && !perms.includes('admin:*')) {
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.ADDRESSBOOK_WRITE,
          error: 'Token does not have addressbook:write permission',
          required: ['addressbook:write'],
          have: auth.token.permissions,
        });
        return;
      }
    }

    const { address, label, emoji, color, notes } = req.body;

    if (!address || !label) {
      res.status(400).json({ error: 'address and label are required' });
      return;
    }

    const createdBy = isAdmin(auth) ? 'human' : auth.token.agentId;

    const entry = await prisma.addressLabel.upsert({
      where: { address: address.toLowerCase() },
      create: {
        address: address.toLowerCase(),
        label,
        emoji: emoji || undefined,
        color: color || undefined,
        notes: notes || undefined,
        createdBy,
      },
      update: {
        label,
        ...(emoji !== undefined && { emoji }),
        ...(color !== undefined && { color }),
        ...(notes !== undefined && { notes }),
      },
    });

    res.json({ success: true, label: entry });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// DELETE /address-labels/:id - Delete an address label
router.delete('/:id', requireWalletAuth, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const auth = req.auth!;

    // Check permission
    if (!isAdmin(auth)) {
      const perms = auth.token.permissions;
      if (!perms.includes('addressbook:write') && !perms.includes('admin:*')) {
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.ADDRESSBOOK_WRITE,
          error: 'Token does not have addressbook:write permission',
          required: ['addressbook:write'],
          have: auth.token.permissions,
        });
        return;
      }
    }

    const { id } = req.params;

    const existing = await prisma.addressLabel.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Address label not found' });
      return;
    }

    await prisma.addressLabel.delete({ where: { id } });

    res.json({ success: true });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

export default router;
