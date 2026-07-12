import { Router, Request, Response } from 'express';
import {
  createColdWallet,
  hasColdWallet,
  isUnlocked,
  getColdWalletAddress,
  createAgent,
  importAgent,
  listAgents,
  rotatePrimaryAgentPassword,
} from '../lib/cold';
import { createAdminToken } from '../lib/auth';
import { parseEncryptedPassword } from '../lib/transport';
import { prisma } from '../lib/db';
import { loadConfig } from '../lib/config';
import { ensureApiKeysMigrated, hasActiveApiKeyCredential } from '../lib/apikey-migration';
import { logger } from '../lib/logger';
import { requireWalletAuth } from '../middleware/auth';
import { requireAdmin } from '../lib/permissions';
import { isValidAgentPubkey, normalizeAgentPubkey } from '../lib/credential-transport';
import { getErrorMessage, HttpError } from '../lib/error';
import { getDefault } from '../lib/defaults';

const router = Router();

// POST /setup - Create cold wallet with encrypted password
router.post('/', async (req: Request, res: Response) => {
  try {
    const pubkey = typeof req.body?.pubkey === 'string' ? req.body.pubkey : '';
    if (!pubkey.trim()) {
      res.status(400).json({ error: 'pubkey is required' });
      return;
    }
    if (!isValidAgentPubkey(pubkey)) {
      res.status(400).json({ error: 'pubkey must be a valid RSA public key (PEM or base64)' });
      return;
    }
    const normalizedPubkey = normalizeAgentPubkey(pubkey);
    const password = parseEncryptedPassword(req.body.encrypted);

    const result = createColdWallet(password);

    // Log the setup event
    logger.setup(result.address);

    // Create admin token (agent is auto-unlocked after creation)
    const token = await createAdminToken(normalizedPubkey);

    res.json({
      success: true,
      address: result.address,
      mnemonic: result.mnemonic,
      token,
      message: 'Primary agent created. SAVE YOUR MNEMONIC SECURELY. It will not be shown again.'
    });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// GET /setup - Check setup status (includes adapter/key status for agents)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const hasWallet = hasColdWallet();
    const unlocked = isUnlocked();
    const address = getColdWalletAddress();
    const config = loadConfig();
    const projectScopeMode = await getDefault<'auto' | 'strict' | 'off'>('trust.projectScopeMode', 'off');

    // Check which API keys are configured in agent-backed credential storage.
    await ensureApiKeysMigrated();

    // Check adapter config
    let telegramEnabled = false;
    let webhookEnabled = false;
    try {
      const appConfig = await prisma.appConfig.findUnique({ where: { id: 'global' } });
      if (appConfig?.adapterConfig) {
        const parsed = JSON.parse(appConfig.adapterConfig);
        const adapters: Array<{ type: string; enabled: boolean }> = parsed.adapters || [];
        telegramEnabled = adapters.some((a) => a.type === 'telegram' && a.enabled);
        webhookEnabled = adapters.some((a) => a.type === 'webhook' && a.enabled);
      }
    } catch {
      // Ignore parse errors
    }

    res.json({
      hasWallet,
      unlocked,
      address,
      adapters: {
        telegram: telegramEnabled,
        webhook: webhookEnabled,
      },
      apiKeys: {
        alchemy: hasActiveApiKeyCredential('alchemy'),
        anthropic: hasActiveApiKeyCredential('anthropic'),
      },
      defaultChain: config.defaultChain,
      projectScopeMode,
    });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// POST /setup/agent - Create additional agent (requires admin + unlocked primary)
router.post('/agent', requireWalletAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    const password = parseEncryptedPassword(req.body.encrypted);

    if (!isUnlocked()) {
      res.status(401).json({ error: 'Primary agent must be unlocked to create additional agents' });
      return;
    }

    const result = createAgent(password, name, { mode: 'independent' });

    logger.setup(result.address);

    res.json({
      success: true,
      id: result.id,
      address: result.address,
      solanaAddress: result.solanaAddress,
      mnemonic: result.mnemonic,
      name: result.name,
      message: 'Agent created. SAVE YOUR MNEMONIC SECURELY. It will not be shown again.'
    });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// POST /setup/agent/import - Import agent from seed (requires admin + unlocked primary)
router.post('/agent/import', requireWalletAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const { mnemonic, name } = req.body;

    if (!mnemonic || typeof mnemonic !== 'string') {
      res.status(400).json({ error: 'Seed phrase (mnemonic) is required' });
      return;
    }

    const password = parseEncryptedPassword(req.body.encrypted);

    if (!isUnlocked()) {
      res.status(401).json({ error: 'Primary agent must be unlocked to import additional agents' });
      return;
    }

    const result = importAgent(mnemonic, password, name, { mode: 'independent' });

    logger.setup(result.address);

    res.json({
      success: true,
      id: result.id,
      address: result.address,
      solanaAddress: result.solanaAddress,
      name: result.name,
      message: 'Agent imported successfully'
    });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// GET /setup/agents - List all agents
router.get('/agents', (_req: Request, res: Response) => {
  const agents = listAgents();
  res.json({ agents });
});

// POST /setup/password - Rotate primary agent password (admin)
router.post('/password', requireWalletAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const currentPassword = parseEncryptedPassword(req.body.currentEncrypted);
    const newPassword = parseEncryptedPassword(req.body.newEncrypted);

    if (newPassword.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    const changed = rotatePrimaryAgentPassword(currentPassword, newPassword);
    if (!changed) {
      res.status(401).json({ error: 'Invalid current password' });
      return;
    }

    res.json({
      success: true,
      message: 'Primary agent password updated',
    });
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

export default router;
