/**
 * Passkey Credential Routes — WebAuthn software authenticator endpoints
 * =====================================================================
 *
 * POST /credentials/passkey/register   — Generate keypair, store, return attestation
 * POST /credentials/passkey/authenticate — Sign challenge, return assertion
 * GET  /credentials/passkey/match      — Find passkeys matching rpId
 */

import { Router, Request, Response } from 'express';
import { requireWalletAuth } from '../middleware/auth';
import { registerPasskey, authenticatePasskey, matchPasskeys, PasskeyCredentialValidationError } from '../lib/passkey-credential';
import { getErrorMessage } from '../lib/error';
import { log } from '../lib/pino';

const router = Router();
router.use(requireWalletAuth);

// POST /credentials/passkey/register
router.post('/register', (req: Request, res: Response) => {
  try {
    const { agentId, rpId, rpName, userName, displayName, userHandle, challenge, origin, clientDataJSON } = req.body;

    if (!agentId || !rpId || !userHandle || !clientDataJSON) {
      res.status(400).json({ error: 'agentId, rpId, userHandle, and clientDataJSON are required' });
      return;
    }

    const result = registerPasskey({
      agentId,
      rpId,
      rpName,
      userName,
      displayName,
      userHandle,
      challenge,
      origin,
      clientDataJSON,
    });

    log.info({ rpId, credentialId: result.credentialId }, 'Passkey registered');
    res.json(result);
  } catch (error) {
    const message = getErrorMessage(error);
    if (error instanceof PasskeyCredentialValidationError) {
      res.status(400).json({ error: message });
      return;
    }

    log.error({ error: message }, 'Passkey register error');
    res.status(500).json({ error: message });
  }
});

// POST /credentials/passkey/authenticate
router.post('/authenticate', (req: Request, res: Response) => {
  try {
    const { auraCredentialId, rpId, challenge, origin, clientDataJSON } = req.body;

    if (!auraCredentialId || !rpId || !challenge || !clientDataJSON) {
      res.status(400).json({ error: 'auraCredentialId, rpId, challenge, and clientDataJSON are required' });
      return;
    }

    const result = authenticatePasskey({ auraCredentialId, rpId, challenge, origin, clientDataJSON });

    log.info({ rpId, credentialId: result.credentialId }, 'Passkey authenticated');
    res.json(result);
  } catch (error) {
    const message = getErrorMessage(error);
    if (error instanceof PasskeyCredentialValidationError) {
      res.status(400).json({ error: message });
      return;
    }

    log.error({ error: message }, 'Passkey authenticate error');
    res.status(500).json({ error: message });
  }
});

// GET /credentials/passkey/match?rpId=xxx
router.get('/match', (req: Request, res: Response) => {
  try {
    const rpId = req.query.rpId as string;
    const agentId = req.query.agentId as string | undefined;

    if (!rpId) {
      res.status(400).json({ error: 'rpId query parameter is required' });
      return;
    }

    const matches = matchPasskeys(rpId, agentId);
    res.json({ matches });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

export default router;
