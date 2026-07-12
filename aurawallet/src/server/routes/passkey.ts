import { Router, Request, Response } from 'express';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { prisma } from '../lib/db';
import { requireWalletAuth } from '../middleware/auth';
import { requireAdmin } from '../lib/permissions';
import { getAgentMnemonic, getPrimaryAgentId, isUnlocked } from '../lib/cold';
import { createAdminToken } from '../lib/auth';
import { storeChallenge, consumeChallenge, uint8ArrayToBase64url, base64urlToUint8Array } from '../lib/passkey';
import { isValidAgentPubkey, normalizeAgentPubkey } from '../lib/credential-transport';
import { log } from '../lib/pino';
import { getErrorMessage } from '../lib/error';
import { syncGlobalAuraIdForAgent } from '../lib/social/global-aura-id';

const router = Router();

// Helper: extract rpId from request
function getRpId(req: Request, bodyRpId?: string): string {
  return bodyRpId || req.hostname || 'localhost';
}

// Helper: get the browser origin for WebAuthn verification.
// The browser records its own origin in clientDataJSON. Since the dashboard
// (Next.js :4747) makes cross-origin requests to Express (:4242), we must
// use the Origin header rather than req.get('host') which reflects the
// Express server's host.
function getBrowserOrigin(req: Request): string {
  const origin = req.get('origin');
  if (origin && origin !== 'null') return origin;
  // Fallback: derive from Referer
  const referer = req.get('referer');
  if (referer) {
    try {
      const url = new URL(referer);
      return url.origin;
    } catch { /* ignore */ }
  }
  // Last resort: use the Express server's own host
  return `${req.protocol}://${req.get('host')}`;
}

// ─── Status ─────────────────────────────────────────────────────────────────

// GET /auth/passkey/status — public, returns whether passkeys registered for origin
router.get('/status', async (req: Request, res: Response) => {
  try {
    const rpId = getRpId(req, req.query.rpId as string | undefined);
    const passkeys = await prisma.passkey.findMany({
      where: { rpId },
      select: { credentialId: true, createdAt: true },
    });
    res.json({
      registered: passkeys.length > 0,
      count: passkeys.length,
      rpId,
      credentials: passkeys.map(p => ({ id: p.credentialId, createdAt: p.createdAt })),
    });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// ─── Registration ───────────────────────────────────────────────────────────

// POST /auth/passkey/register/options — requires admin token
router.post('/register/options', requireWalletAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!isUnlocked()) {
      res.status(400).json({ error: 'Agent must be unlocked to register passkey' });
      return;
    }

    const rpId = getRpId(req, req.body?.rpId);

    // Get existing credentials for this rpId to exclude
    const existing = await prisma.passkey.findMany({
      where: { rpId },
      select: { credentialId: true, transports: true },
    });

    const excludeCredentials = existing.map((p) => ({
      id: p.credentialId,
      transports: JSON.parse(p.transports || '[]'),
    }));

    const options = await generateRegistrationOptions({
      rpName: 'AuraMaxx',
      rpID: rpId,
      userName: 'owner',
      userDisplayName: 'Agent Owner',
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      excludeCredentials,
      timeout: 60000,
    });

    // Store challenge
    storeChallenge(options.challenge, 'register');

    res.json(options);
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// POST /auth/passkey/register/verify — requires admin token
router.post('/register/verify', requireWalletAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!isUnlocked()) {
      res.status(400).json({ error: 'Agent must be unlocked to register passkey' });
      return;
    }

    const { credential } = req.body;
    if (!credential) {
      res.status(400).json({ error: 'credential is required' });
      return;
    }

    const rpId = getRpId(req, req.body?.rpId);
    const origin = getBrowserOrigin(req);

    // Consume challenge
    const challenge = credential.response?.clientDataJSON
      ? JSON.parse(Buffer.from(credential.response.clientDataJSON, 'base64url').toString()).challenge
      : undefined;

    if (!challenge || !consumeChallenge(challenge, 'register')) {
      res.status(400).json({ error: 'Invalid or expired challenge' });
      return;
    }

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      res.status(400).json({ error: 'Registration verification failed' });
      return;
    }

    const { credential: cred, credentialBackedUp, aaguid } = verification.registrationInfo;

    // Store in DB
    await prisma.passkey.create({
      data: {
        credentialId: cred.id,
        publicKey: Buffer.from(cred.publicKey),
        counter: cred.counter,
        transports: JSON.stringify(credential.response.transports || []),
        rpId,
        aaguid: aaguid || '',
      },
    });

    res.json({
      success: true,
      credentialId: cred.id,
    });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// ─── Authentication ─────────────────────────────────────────────────────────

// POST /auth/passkey/authenticate/options — public (agent must be unlocked server-side)
router.post('/authenticate/options', async (req: Request, res: Response) => {
  try {
    // Specific agent_locked error per audit
    if (!isUnlocked()) {
      res.status(400).json({
        error: 'agent_locked',
        message: 'Password required after server restart',
      });
      return;
    }

    const rpId = getRpId(req, req.body?.rpId);

    // Get credentials for this rpId — reject if none exist (audit item)
    const passkeys = await prisma.passkey.findMany({
      where: { rpId },
      select: { credentialId: true, transports: true },
    });

    if (passkeys.length === 0) {
      res.status(400).json({ error: 'No passkeys registered for this origin' });
      return;
    }

    const allowCredentials = passkeys.map((p) => ({
      id: p.credentialId,
      transports: JSON.parse(p.transports || '[]'),
    }));

    const options = await generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials,
      userVerification: 'required',
      timeout: 60000,
    });

    storeChallenge(options.challenge, 'authenticate');

    res.json(options);
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// POST /auth/passkey/authenticate/verify — public (assertion IS the auth)
router.post('/authenticate/verify', async (req: Request, res: Response) => {
  try {
    // Specific agent_locked error per audit
    if (!isUnlocked()) {
      res.status(400).json({
        error: 'agent_locked',
        message: 'Password required after server restart',
      });
      return;
    }

    const { credential, pubkey } = req.body;
    if (!credential) {
      res.status(400).json({ error: 'credential is required' });
      return;
    }
    if (!pubkey || typeof pubkey !== 'string') {
      res.status(400).json({ error: 'pubkey is required' });
      return;
    }
    if (!isValidAgentPubkey(pubkey)) {
      res.status(400).json({ error: 'pubkey must be a valid RSA public key' });
      return;
    }

    const rpId = getRpId(req, req.body?.rpId);
    const origin = getBrowserOrigin(req);

    // Extract and consume challenge
    const challenge = credential.response?.clientDataJSON
      ? JSON.parse(Buffer.from(credential.response.clientDataJSON, 'base64url').toString()).challenge
      : undefined;

    if (!challenge || !consumeChallenge(challenge, 'authenticate')) {
      log.warn({ ip: req.ip, origin }, 'Passkey auth: invalid or expired challenge');
      res.status(401).json({ error: 'Invalid or expired challenge' });
      return;
    }

    // Look up the credential
    const credentialId = credential.id || credential.rawId;
    const passkey = await prisma.passkey.findUnique({
      where: { credentialId },
    });

    if (!passkey) {
      log.warn({ credentialId, ip: req.ip, origin }, 'Passkey auth: unknown credential');
      res.status(401).json({ error: 'Unknown credential' });
      return;
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: passkey.counter,
          transports: JSON.parse(passkey.transports || '[]'),
        },
        requireUserVerification: true,
      });
    } catch (err) {
      // Log failed attempt (audit item)
      log.warn({
        credentialId,
        ip: req.ip,
        origin,
        error: getErrorMessage(err),
      }, 'Passkey auth: verification failed');
      res.status(401).json({ error: 'Authentication verification failed' });
      return;
    }

    if (!verification.verified) {
      log.warn({ credentialId, ip: req.ip, origin }, 'Passkey auth: assertion not verified');
      res.status(401).json({ error: 'Authentication verification failed' });
      return;
    }

    // Counter validation (clone detection) — @simplewebauthn handles this,
    // but we double-check per audit
    const newCounter = verification.authenticationInfo.newCounter;
    if (newCounter > 0 && newCounter <= passkey.counter) {
      log.warn({
        credentialId,
        storedCounter: passkey.counter,
        newCounter,
        ip: req.ip,
        origin,
      }, 'Passkey auth: counter regression (possible clone)');
      res.status(401).json({ error: 'Credential counter regression detected' });
      return;
    }

    // Update counter and lastUsedAt
    await prisma.passkey.update({
      where: { credentialId: passkey.credentialId },
      data: {
        counter: newCounter,
        lastUsedAt: new Date(),
      },
    });

    // Issue admin token (same as rekey flow)
    const normalizedPubkey = normalizeAgentPubkey(pubkey);
    const primaryAgentId = getPrimaryAgentId() || 'primary';
    const primaryMnemonic = getAgentMnemonic(primaryAgentId);
    if (primaryMnemonic) {
      await syncGlobalAuraIdForAgent(primaryAgentId, primaryMnemonic);
    }
    const token = await createAdminToken(normalizedPubkey);

    res.json({
      success: true,
      token,
    });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// ─── Delete ─────────────────────────────────────────────────────────────────

// DELETE /auth/passkey/:credentialId — requires admin token
router.delete('/:credentialId', requireWalletAuth, requireAdmin, async (req: Request<{ credentialId: string }>, res: Response) => {
  try {
    const { credentialId } = req.params;

    const passkey = await prisma.passkey.findUnique({ where: { credentialId } });
    if (!passkey) {
      res.status(404).json({ error: 'Passkey not found' });
      return;
    }

    await prisma.passkey.delete({ where: { credentialId } });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

export default router;
