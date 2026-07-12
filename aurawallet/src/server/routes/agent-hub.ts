import { Request, Response, Router } from 'express';
import { requireWalletAuth } from '../middleware/auth';
import { requireAdmin } from '../lib/permissions';
import { getAgentMnemonic, isAgentUnlocked, listAgents } from '../lib/cold';
import { registerOnHub } from '../lib/social/register';
import { syncGlobalAuraIdForAgent } from '../lib/social/global-aura-id';
import { prisma } from '../lib/db';
import { getHubUrl } from '../lib/defaults';
import { log } from '../lib/pino';

const router = Router();

// GET /agent-hub/default — return the configured primary hub URL
router.get('/default', requireWalletAuth, requireAdmin, async (_req: Request, res: Response) => {
  return res.json({ hubUrl: getHubUrl() });
});

// GET /agent-hub/:agentId/status — hub registration status for an agent
router.get('/:agentId/status', requireWalletAuth, requireAdmin, async (req: Request<{ agentId: string }>, res: Response) => {
  try {
    const { agentId } = req.params;
    const hubUrl = getHubUrl();

    const agents = listAgents();
    const agent = agents.find(a => a.id === agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const [profile, subscription] = await Promise.all([
      prisma.agentProfile.findUnique({ where: { agentId } }),
      prisma.hubSubscription.findUnique({
        where: {
          agentId_hubUrl: {
            agentId,
            hubUrl,
          },
        },
      }),
    ]);

    const auraId = subscription?.auraId ?? null;
    const publicKeyHex = profile?.publicKeyHex ?? null;

    return res.json({
      agentId,
      hubUrl,
      auraId,
      publicKeyHex,
      registered: subscription?.auraId != null,
      hasPublicKey: publicKeyHex !== null,
    });
  } catch (error) {
    log.error({ error }, 'agent-hub status error');
    return res.status(500).json({ error: 'Failed to fetch hub status' });
  }
});

// POST /agent-hub/:agentId/register — register agent on the default hub
router.post('/:agentId/register', requireWalletAuth, requireAdmin, async (req: Request<{ agentId: string }>, res: Response) => {
  try {
    const { agentId } = req.params;

    const agents = listAgents();
    const agent = agents.find(a => a.id === agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (!isAgentUnlocked(agentId)) {
      return res.status(400).json({ error: 'Agent must be unlocked to register' });
    }

    const mnemonic = getAgentMnemonic(agentId);
    if (!mnemonic) {
      return res.status(400).json({ error: 'Cannot access agent mnemonic' });
    }

    const hubUrl = getHubUrl();
    const result = await registerOnHub(agentId, mnemonic, hubUrl, 'Primary Hub');
    const auraId = result.auraId;
    await syncGlobalAuraIdForAgent(agentId, mnemonic);

    return res.json({ agentId, auraId, hubUrl });
  } catch (error) {
    log.error({ error }, 'agent-hub register error');
    const message = error instanceof Error ? error.message : 'Registration failed';
    return res.status(500).json({ error: message });
  }
});

// GET /agent-hub/:agentId/hubs — list all subscribed hubs for an agent
router.get('/:agentId/hubs', requireWalletAuth, requireAdmin, async (req: Request<{ agentId: string }>, res: Response) => {
  try {
    const { agentId } = req.params;

    const hubs = await prisma.hubSubscription.findMany({
      where: { agentId },
      orderBy: { joinedAt: 'asc' },
    });

    return res.json({ hubs });
  } catch (error) {
    log.error({ error }, 'agent-hub list error');
    return res.status(500).json({ error: 'Failed to list hubs' });
  }
});

// POST /agent-hub/:agentId/join — join a new hub
router.post('/:agentId/join', requireWalletAuth, requireAdmin, async (req: Request<{ agentId: string }>, res: Response) => {
  try {
    const { agentId } = req.params;
    const { hubUrl, label } = req.body;

    if (typeof hubUrl !== 'string' || !hubUrl.trim()) {
      return res.status(400).json({ error: 'hubUrl is required' });
    }

    const normalizedUrl = hubUrl.trim().replace(/\/+$/, ''); // strip trailing slashes

    const agents = listAgents();
    const agent = agents.find(a => a.id === agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (!isAgentUnlocked(agentId)) {
      return res.status(400).json({ error: 'Agent must be unlocked to join a hub' });
    }

    const mnemonic = getAgentMnemonic(agentId);
    if (!mnemonic) {
      return res.status(400).json({ error: 'Cannot access agent mnemonic' });
    }

    // Discover frontend URL from hub's /info endpoint.
    // Works whether the user pasted the frontend URL (Next.js proxies /info)
    // or the backend URL (Express serves /info directly).
    let frontendUrl: string | null = null;
    try {
      const infoRes = await fetch(`${normalizedUrl}/info`);
      if (infoRes.ok) {
        const info = await infoRes.json() as { name?: string; frontendUrl?: string };
        frontendUrl = info.frontendUrl || normalizedUrl;
      }
    } catch {
      // Hub may not expose /info — that's fine
    }

    const result = await registerOnHub(
      agentId,
      mnemonic,
      normalizedUrl,
      typeof label === 'string' ? label.trim() || undefined : undefined,
    );

    // Persist discovered frontend URL
    if (frontendUrl) {
      await prisma.hubSubscription.update({
        where: { id: result.subscriptionId },
        data: { frontendUrl },
      });
    }

    const sub = await prisma.hubSubscription.findUnique({
      where: { id: result.subscriptionId },
    });

    return res.json({ hub: sub });
  } catch (error) {
    log.error({ error }, 'agent-hub join error');
    const message = error instanceof Error ? error.message : 'Failed to join hub';
    return res.status(500).json({ error: message });
  }
});

// POST /agent-hub/:agentId/leave — leave a hub (prune all data)
router.post('/:agentId/leave', requireWalletAuth, requireAdmin, async (req: Request<{ agentId: string }>, res: Response) => {
  try {
    const { agentId } = req.params;
    const { hubUrl } = req.body;

    if (typeof hubUrl !== 'string' || !hubUrl.trim()) {
      return res.status(400).json({ error: 'hubUrl is required' });
    }

    const normalizedUrl = hubUrl.trim().replace(/\/+$/, '');

    // Don't allow leaving the default hub
    const defaultHub = getHubUrl();
    if (normalizedUrl === defaultHub) {
      return res.status(400).json({ error: 'Cannot leave the default hub' });
    }

    // Delete subscription
    await prisma.hubSubscription.deleteMany({
      where: { agentId, hubUrl: normalizedUrl },
    });

    // Prune inbound messages from this hub
    await prisma.inboundMessage.deleteMany({
      where: { agentId, hubUrl: normalizedUrl },
    });

    // Cancel pending outbound messages for this hub
    await prisma.socialMessage.updateMany({
      where: { agentId, hubUrl: normalizedUrl, syncStatus: 'pending' },
      data: { syncStatus: 'failed', syncCode: 'hub_left', syncDetail: 'Left hub' },
    });

    log.info({ agentId, hubUrl: normalizedUrl }, 'Agent left hub, data pruned');
    return res.json({ ok: true });
  } catch (error) {
    log.error({ error }, 'agent-hub leave error');
    return res.status(500).json({ error: 'Failed to leave hub' });
  }
});

// POST /agent-hub/:agentId/purge — purge all local data for a hub without leaving
router.post('/:agentId/purge', requireWalletAuth, requireAdmin, async (req: Request<{ agentId: string }>, res: Response) => {
  try {
    const { agentId } = req.params;
    const { hubUrl } = req.body;

    if (typeof hubUrl !== 'string' || !hubUrl.trim()) {
      return res.status(400).json({ error: 'hubUrl is required' });
    }

    const normalizedUrl = hubUrl.trim().replace(/\/+$/, '');

    // Resolve effective hubUrl for DB queries.
    // InboundMessage/SocialMessage use "" for the default hub.
    const defaultHub = getHubUrl();
    const dbHubUrl = normalizedUrl === defaultHub ? '' : normalizedUrl;

    // Delete all cached inbound messages from this hub
    const inbound = await prisma.inboundMessage.deleteMany({
      where: { agentId, hubUrl: dbHubUrl },
    });

    // Delete all outbound social messages for this hub
    const outbound = await prisma.socialMessage.deleteMany({
      where: { agentId, hubUrl: dbHubUrl },
    });

    // Reset the subscription cursor so inbound sync re-bootstraps from scratch
    const sub = await prisma.hubSubscription.findFirst({
      where: { agentId, hubUrl: normalizedUrl },
    });
    if (sub) {
      await prisma.hubSubscription.update({
        where: { id: sub.id },
        data: { inboundSeq: 0, inboundMode: 'snapshot' },
      });
    }

    log.info(
      { agentId, hubUrl: normalizedUrl, inbound: inbound.count, outbound: outbound.count },
      'Purged all local hub data',
    );

    return res.json({
      ok: true,
      purged: {
        inboundMessages: inbound.count,
        socialMessages: outbound.count,
        cursorReset: !!sub,
      },
    });
  } catch (error) {
    log.error({ error }, 'agent-hub purge error');
    return res.status(500).json({ error: 'Failed to purge hub data' });
  }
});

export default router;
