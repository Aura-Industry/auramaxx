import { Router, Request, Response } from 'express';
import { lock, isUnlocked, lockAgent, isAgentUnlocked } from '../lib/cold';
import { requireWalletAuth } from '../middleware/auth';
import { requireAdmin } from '../lib/permissions';
import { logger } from '../lib/logger';
import { revokeAllTokens } from '../lib/sessions';
import { revokeAdminTokens } from '../lib/auth';

const router = Router();

// POST /lock - Lock all agents (clear memory)
// Requires admin authentication
// Also revokes all active sessions so clients must re-authenticate.
router.post('/', requireWalletAuth, requireAdmin, async (_req: Request, res: Response) => {
  const wasUnlocked = isUnlocked();

  // Lock all agents
  lock();

  // Revoke all active admin + agent tokens
  revokeAdminTokens();
  await revokeAllTokens();

  // Log the lock event
  if (wasUnlocked) {
    logger.locked();
  }

  res.json({
    success: true,
    message: wasUnlocked
      ? 'All agents locked and active sessions revoked'
      : 'Agents were already locked; active sessions revoked'
  });
});

// POST /lock/:agentId - Lock a specific agent
router.post('/:agentId', requireWalletAuth, requireAdmin, (req: Request<{ agentId: string }>, res: Response) => {
  const { agentId } = req.params;
  const wasUnlocked = isAgentUnlocked(agentId);

  lockAgent(agentId);

  if (wasUnlocked) {
    logger.locked();
  }

  res.json({
    success: true,
    message: wasUnlocked ? `Agent ${agentId} locked` : `Agent ${agentId} was already locked`
  });
});

export default router;
