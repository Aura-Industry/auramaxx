import { Request, Response, Router } from 'express';
import { createAgent, deleteAgent, getPrimaryAgentId, getPrimaryAgentPassword, listAgents, lockAgent, type AgentMode } from '../lib/cold';
import { deleteCredential, listCredentials } from '../lib/credentials';
import { requireAdmin } from '../lib/permissions';
import { requireWalletAuth } from '../middleware/auth';
import { parseEncryptedPassword } from '../lib/transport';
import { HttpError, getErrorMessage } from '../lib/error';

const router = Router();

function resolvePassword(body: Record<string, unknown>): string {
  const encrypted = body.encrypted;

  if (typeof encrypted === 'string') {
    return parseEncryptedPassword(encrypted);
  }

  throw new HttpError(400, 'Encrypted password is required');
}

function resolveAgentMode(body: Record<string, unknown>): Exclude<AgentMode, 'primary'> {
  const mode = body.mode;
  if (mode === undefined) return 'linked';
  if (mode === 'linked' || mode === 'independent') return mode;
  throw new HttpError(400, 'mode must be either "linked" or "independent"');
}

function resolveParentTarget(body: Record<string, unknown>): string | undefined {
  const parentAgentId = body.parentAgentId;
  if (typeof parentAgentId === 'string') {
    const trimmed = parentAgentId.trim();
    if (trimmed) return trimmed;
  } else if (parentAgentId !== undefined && parentAgentId !== null && parentAgentId !== '') {
    throw new HttpError(400, 'parentAgentId must be a string when provided');
  }

  // Backward compatibility: accept legacy linkedTo input.
  const linkedTo = body.linkedTo;
  if (linkedTo === undefined || linkedTo === null || linkedTo === '') return undefined;
  if (typeof linkedTo === 'string') return linkedTo.trim();
  throw new HttpError(400, 'linkedTo must be a string when provided');
}

// POST /agents/credential — create credential agent (admin)
router.post('/', requireWalletAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const mode = resolveAgentMode(body);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined;
    const parentAgentId = resolveParentTarget(body);
    if (mode === 'independent' && parentAgentId) {
      throw new HttpError(400, 'independent agents cannot set parentAgentId/linkedTo');
    }

    let password: string;
    if (mode === 'linked') {
      const primaryPassword = getPrimaryAgentPassword();
      if (!primaryPassword) {
        throw new HttpError(401, 'Primary agent must be unlocked to create linked agents');
      }
      password = primaryPassword;
    } else {
      password = resolvePassword(body);
    }

    const created = createAgent(password, name, { mode, parentAgentId });

    res.json({
      success: true,
      agent: {
        id: created.id,
        name: created.name,
        address: created.address,
        solanaAddress: created.solanaAddress,
        mode: created.mode,
        parentAgentId: created.parentAgentId,
        linkedTo: created.linkedTo,
        isPrimary: false,
        isUnlocked: true,
      },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    res.status(400).json({ success: false, error: getErrorMessage(error) });
  }
});

// GET /agents/credential — list agents + unlock status (admin)
router.get('/', requireWalletAuth, requireAdmin, (_req: Request, res: Response) => {
  try {
    const agents = listAgents();
    const counts = new Map<string, number>();
    for (const cred of listCredentials()) {
      counts.set(cred.agentId, (counts.get(cred.agentId) || 0) + 1);
    }

    res.json({
      success: true,
      agents: agents.map(agent => ({
        ...agent,
        credentialCount: counts.get(agent.id) || 0,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

// POST /agents/credential/:id/lock — lock agent (admin)
router.post('/:id/lock', requireWalletAuth, requireAdmin, (req: Request<{ id: string }>, res: Response) => {
  try {
    const { id } = req.params;
    const exists = listAgents().some(agent => agent.id === id);
    if (!exists) {
      res.status(404).json({ success: false, error: 'Agent not found' });
      return;
    }

    lockAgent(id);
    res.json({ success: true, message: `Agent ${id} locked` });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

// DELETE /agents/credential/:id — delete agent + credentials (admin)
router.delete('/:id', requireWalletAuth, requireAdmin, (req: Request<{ id: string }>, res: Response) => {
  try {
    const { id } = req.params;
    const exists = listAgents().some(agent => agent.id === id);
    if (!exists) {
      res.status(404).json({ success: false, error: 'Agent not found' });
      return;
    }
    if (id === getPrimaryAgentId()) {
      res.status(400).json({ success: false, error: 'Cannot delete primary agent from this endpoint' });
      return;
    }

    const credentials = listCredentials({ agentId: id });
    for (const credential of credentials) {
      deleteCredential(credential.id);
    }
    deleteAgent(id);

    res.json({
      success: true,
      message: `Agent ${id} deleted`,
      deletedCredentials: credentials.length,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: getErrorMessage(error) });
  }
});

export default router;
