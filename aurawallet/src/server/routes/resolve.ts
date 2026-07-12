import { Router, Request, Response } from 'express';
import { resolveName } from '../lib/resolve';
import { getErrorMessage } from '../lib/error';

const router = Router();

// GET /resolve/:name - Resolve ENS name to address
// Public endpoint (no auth required)
router.get('/:name', async (req: Request, res: Response) => {
  try {
    const name = String(req.params.name);

    if (!name) {
      res.status(400).json({ error: 'Name parameter is required' });
      return;
    }

    const result = await resolveName(name);

    res.json({
      success: true,
      address: result.address,
      name: result.name,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

export default router;
