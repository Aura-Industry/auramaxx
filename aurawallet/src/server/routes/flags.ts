import { Router, Request, Response } from 'express';
import { readFlags } from '../lib/feature-flags';

const router = Router();

// GET /flags — return current feature flag values (public, read-only)
router.get('/', (_req: Request, res: Response) => {
  res.json(readFlags());
});

export default router;
