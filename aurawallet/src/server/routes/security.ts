import { Request, Response, Router } from 'express';
import { getErrorMessage } from '../lib/error';
import { requireAdmin, requireWalletAuth } from '../middleware/auth';
import {
  listNoisyCredentials,
  listNoisyCredentialTokens,
  listRecentCredentialAccess,
} from '../lib/credential-access-audit';

const router = Router();
router.use(requireWalletAuth, requireAdmin);

router.get('/credential-access/recent', async (req: Request, res: Response) => {
  try {
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const rows = await listRecentCredentialAccess(limit);
    res.json({ success: true, rows });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

router.get('/credential-access/noisy-credentials', async (req: Request, res: Response) => {
  try {
    const windowMs = Number.parseInt(String(req.query.windowMs ?? 3600000), 10);
    const limit = Number.parseInt(String(req.query.limit ?? '20'), 10);
    const rows = await listNoisyCredentials(windowMs, limit);
    res.json({ success: true, windowMs, rows });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

router.get('/credential-access/noisy-tokens', async (req: Request, res: Response) => {
  try {
    const windowMs = Number.parseInt(String(req.query.windowMs ?? 3600000), 10);
    const limit = Number.parseInt(String(req.query.limit ?? '20'), 10);
    const rows = await listNoisyCredentialTokens(windowMs, limit);
    res.json({ success: true, windowMs, rows });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

export default router;
