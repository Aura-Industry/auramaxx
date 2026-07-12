/**
 * System Defaults Routes
 * ======================
 * Admin-only endpoints for managing centralized system defaults.
 *
 * GET    /defaults        — All defaults grouped by type
 * PATCH  /defaults/:key   — Update a single default
 * POST   /defaults/reset  — Reset one or all defaults to seed values
 */

import { Router, Request, Response } from 'express';
import { requireWalletAuth } from '../middleware/auth';
import { requireAdmin } from '../lib/permissions';
import { getAllDefaults, setDefault, resetDefault, SEED_DEFAULTS, getDefault } from '../lib/defaults';
import { events } from '../lib/events';
import { getErrorMessage } from '../lib/error';

const router = Router();

// All defaults routes require admin access
router.use(requireWalletAuth, requireAdmin);

/**
 * GET /defaults — List all defaults grouped by type
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const grouped = await getAllDefaults();
    res.json({ success: true, defaults: grouped });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * PATCH /defaults/:key — Update a single default value
 * Body: { value: any }
 */
router.patch('/:key', async (req: Request<{ key: string }>, res: Response) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      res.status(400).json({ success: false, error: 'value is required' });
      return;
    }

    // Validate the key exists in seeds (don't allow creating arbitrary keys via PATCH)
    const seed = SEED_DEFAULTS.find(s => s.key === key);
    if (!seed) {
      res.status(404).json({ success: false, error: `Unknown default key: ${key}` });
      return;
    }

    // Type-check: ensure value type matches seed type roughly
    const seedType = typeof seed.value;
    const valueType = typeof value;

    if (seedType === 'number' && valueType !== 'number') {
      res.status(400).json({ success: false, error: `Expected number for ${key}, got ${valueType}` });
      return;
    }

    if (Array.isArray(seed.value) && !Array.isArray(value)) {
      res.status(400).json({ success: false, error: `Expected array for ${key}` });
      return;
    }

    const previousValue = key === 'trust.localProfile'
      ? await getDefault<string>('trust.localProfile', 'dev')
      : null;

    await setDefault(key, value);

    if (key === 'trust.localProfile') {
      const previousProfile = typeof previousValue === 'string' ? previousValue.trim() : 'dev';
      const nextProfile = typeof value === 'string' ? value.trim() : '';
      const dangerousModeChanged = (previousProfile === 'admin') !== (nextProfile === 'admin');

      if (dangerousModeChanged) {
        events.custom('trust:local_dangerous_mode_changed', {
          actorType: req.auth?.token?.agentId ? 'agent' : 'admin',
          actorId: req.auth?.token?.agentId ?? 'admin',
          tokenHash: req.auth?.tokenHash,
          key,
          previousValue: previousProfile,
          nextValue: nextProfile,
          timestamp: Date.now(),
        });
      }
    }

    res.json({ success: true, key, value });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /defaults/reset — Reset one or all defaults to seed values
 * Body: { key: string } — use "*" to reset all
 */
router.post('/reset', async (req: Request, res: Response) => {
  try {
    const { key } = req.body;

    if (!key || typeof key !== 'string') {
      res.status(400).json({ success: false, error: 'key is required (use "*" to reset all)' });
      return;
    }

    await resetDefault(key);

    res.json({ success: true, key, reset: true });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
