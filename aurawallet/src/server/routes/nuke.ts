import { Router, Request, Response } from 'express';
import fs from 'fs';
import { deleteColdWallet, importColdWallet, listAgents, deleteAgent } from '../lib/cold';
import { DATA_PATHS } from '../lib/config';
import { prisma } from '../lib/db';
import { lockAllCredentialAgents } from '../lib/credential-agent';
import { requireWalletAuth } from '../middleware/auth';
import { requireAdmin } from '../lib/permissions';
import { parseEncryptedPassword } from '../lib/transport';
import { logger } from '../lib/logger';
import { getErrorMessage, HttpError } from '../lib/error';

const router = Router();

function writeNukeStateMarker(source: 'api' | 'cli'): void {
  const markerPath = DATA_PATHS.nukeStateMarker;
  try {
    fs.writeFileSync(
      markerPath,
      JSON.stringify(
        {
          version: 1,
          source,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    // Marker is best-effort; nuke should still complete.
  }
}

// POST /nuke - Delete all wallet data (requires admin)
router.post('/', requireWalletAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    // 1. Delete all agents (files + memory)
    try {
      const agents = listAgents();
      for (const agent of agents) {
        deleteAgent(agent.id);
      }
      deleteColdWallet(); // Also handles legacy cold.json
    } catch (e) {
      console.log('No cold wallet to delete:', e);
    }

    // 2. Delete all hot wallet files
    const hotDir = DATA_PATHS.hotWallets;
    if (fs.existsSync(hotDir)) {
      fs.rmSync(hotDir, { recursive: true, force: true });
      fs.mkdirSync(hotDir, { recursive: true });
    }

    // 3. Delete pending requests directory
    const pendingDir = DATA_PATHS.pending;
    if (fs.existsSync(pendingDir)) {
      fs.rmSync(pendingDir, { recursive: true, force: true });
      fs.mkdirSync(pendingDir, { recursive: true });
    }

    // 4. Delete credential files directory and clear in-memory credential sessions
    const credentialsDir = DATA_PATHS.credentials;
    if (fs.existsSync(credentialsDir)) {
      fs.rmSync(credentialsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(credentialsDir, { recursive: true });
    lockAllCredentialAgents();

    // 5. Clear database tables
    try {
      await prisma.humanAction.deleteMany({});
      await prisma.agentToken.deleteMany({});
      await prisma.hotWallet.deleteMany({});
    } catch (e) {
      console.log('Error clearing database:', e);
    }

    // Record that this no-agent state is intentional (nuke), so startup
    // recovery does not treat it as accidental partial deletion.
    writeNukeStateMarker('api');

    logger.nuke();

    res.json({
      success: true,
      message: 'All data nuked. Ready for fresh setup.'
    });
  } catch (error) {
    console.error('[NUKE ERROR]', error);
    res.status(500).json({
      success: false,
      error: getErrorMessage(error)
    });
  }
});

// POST /nuke/import - Import wallet from seed phrase (requires admin)
router.post('/import', requireWalletAuth, requireAdmin, (req: Request, res: Response) => {
  try {
    const { mnemonic, password, encrypted } = req.body;

    if (!mnemonic || typeof mnemonic !== 'string') {
      res.status(400).json({ error: 'Seed phrase is required' });
      return;
    }

    // Support encrypted password transport (dashboard) or plaintext (CLI)
    let plainPassword: string;
    if (encrypted && typeof encrypted === 'string') {
      plainPassword = parseEncryptedPassword(encrypted);
    } else if (password && typeof password === 'string') {
      if (password.length < 8) {
        throw new HttpError(400, 'Password must be at least 8 characters');
      }
      plainPassword = password;
    } else {
      throw new HttpError(400, 'Password is required (encrypted or plaintext)');
    }

    const result = importColdWallet(mnemonic, plainPassword);

    res.json({
      success: true,
      address: result.address,
      message: 'Wallet imported successfully'
    });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

export default router;
