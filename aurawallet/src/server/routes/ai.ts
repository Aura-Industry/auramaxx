import { Router, Request, Response } from 'express';
import { requireWalletAuth } from '../middleware/auth';
import { requireAdmin } from '../lib/permissions';
import { getProviderMode, MODEL_TIERS, getProviderStatus, AiProviderMode } from '../lib/ai';
import { getErrorMessage } from '../lib/error';

const router = Router();

/**
 * GET /ai/status
 * Returns active provider, default model, and availability of all providers.
 * Used by the dashboard UI to populate the AI Engine settings section.
 * Auth: admin only.
 */
router.get('/status', requireWalletAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const [activeProvider, providers] = await Promise.all([
      getProviderMode(),
      getProviderStatus(),
    ]);
    const tiers = MODEL_TIERS[activeProvider as AiProviderMode];

    res.json({
      activeProvider,
      tiers,
      providers,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

export default router;
