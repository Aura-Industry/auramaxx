import { Router, Request, Response } from 'express';
import { readViews, upsertView, ViewConfig } from '../lib/view-registry';
import { isEnabled } from '../lib/feature-flags';

const router = Router();

// GET /views — return current view registry (empty when flag off)
router.get('/', (_req: Request, res: Response) => {
  res.json(readViews());
});

// POST /views — upsert a view entry
router.post('/', (req: Request, res: Response) => {
  if (!isEnabled('EXPERIMENTAL_WALLET')) {
    return res.status(403).json({ error: 'EXPERIMENTAL_WALLET flag is not enabled' });
  }

  const { id, label, icon, type, route, enabled } = req.body;
  if (!id || !label || !type || !route) {
    return res.status(400).json({ error: 'Missing required fields: id, label, type, route' });
  }

  const validTypes = ['auth', 'wallet', 'audit', 'custom'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
  }

  const view: ViewConfig = {
    id,
    label,
    icon: icon || '📄',
    type,
    route,
    enabled: enabled !== false,
  };

  const views = upsertView(view);
  res.json(views);
});

export default router;
