/**
 * Hub registration: challenge/signup flow.
 *
 * Auto-triggered on first social action when hub subscription is missing.
 * 1. Derive ED25519 pubkey from mnemonic -> base64
 * 2. POST /v1/auth/challenge { publicKey } -> { challenge }
 * 3. Sign challenge bytes with ED25519 -> base64 signature
 * 4. POST /v1/auth/signup { publicKey, challenge, signature } -> { auraId }
 * 5. UPSERT HubSubscription(agentId, hubUrl) with auraId
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { prisma } from '../db';
import { log } from '../pino';
import { deriveSigningSeed } from './sign';
import { getHubUrl } from '../defaults';
import { HubRpcClient, HubRpcError } from './hub-rpc-client';

export class RegistrationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RegistrationError';
    this.code = code;
  }
}

/**
 * Run the challenge/signup flow against a hub.
 * Returns the auraId assigned by the hub.
 */
async function runChallengeSignup(
  mnemonic: string,
  hubUrl: string,
): Promise<number> {
  const rpc = new HubRpcClient(hubUrl);

  // Derive ED25519 keypair
  const seed = deriveSigningSeed(mnemonic);
  const pubKeyBytes = ed25519.getPublicKey(seed);
  const publicKeyB64 = Buffer.from(pubKeyBytes).toString('base64');

  // Step 1: Request challenge
  let challenge: string;
  try {
    const result = await rpc.call<{ challenge: string }>('auth.challenge', { publicKey: publicKeyB64 });
    challenge = result.challenge;
  } catch (err) {
    throw new RegistrationError(
      'CHALLENGE_FAILED',
      `Hub challenge request failed: ${err instanceof HubRpcError ? err.code : (err as Error).message}`,
    );
  }

  if (!challenge) {
    throw new RegistrationError('CHALLENGE_EMPTY', 'Hub returned empty challenge');
  }

  // Step 2: Sign the challenge
  const challengeBytes = new TextEncoder().encode(challenge);
  const sigBytes = ed25519.sign(challengeBytes, seed);
  const signatureB64 = Buffer.from(sigBytes).toString('base64');

  // Step 3: Signup
  let auraId: number;
  try {
    const result = await rpc.call<{ auraId: number; publicKey: string }>('auth.signup', {
      publicKey: publicKeyB64,
      challenge,
      signature: signatureB64,
    });
    auraId = result.auraId;
  } catch (err) {
    throw new RegistrationError(
      'SIGNUP_FAILED',
      `Hub signup request failed: ${err instanceof HubRpcError ? err.code : (err as Error).message}`,
    );
  }

  if (typeof auraId !== 'number' || auraId <= 0) {
    throw new RegistrationError('INVALID_AURA_ID', `Hub returned invalid auraId: ${auraId}`);
  }

  return auraId;
}

/**
 * Ensure the agent is registered on a hub. If already registered in
 * HubSubscription(agentId, hubUrl), returns the existing auraId.
 * Otherwise runs challenge/signup and persists the hub-scoped auraId.
 *
 * @param agentId  Local agent ID (e.g. "primary")
 * @param mnemonic Agent mnemonic (must be unlocked)
 * @param hubUrl   Hub base URL (defaults to production)
 * @returns The agent's auraId (newly registered or existing)
 */
export async function ensureRegistered(
  agentId: string,
  mnemonic: string,
  hubUrl: string = getHubUrl(),
): Promise<number> {
  const existing = await prisma.hubSubscription.findUnique({
    where: { agentId_hubUrl: { agentId, hubUrl } },
  });
  if (existing?.auraId) return existing.auraId;

  const auraId = await runChallengeSignup(mnemonic, hubUrl);

  await prisma.hubSubscription.upsert({
    where: { agentId_hubUrl: { agentId, hubUrl } },
    create: {
      agentId,
      hubUrl,
      auraId,
      inboundMode: null,
      inboundSeq: null,
    },
    update: { auraId },
  });

  log.info({ agentId, auraId, hubUrl }, 'Agent registered with hub');
  return auraId;
}

/**
 * Register an agent on a specific hub, creating or updating a HubSubscription.
 * Returns the subscription info including the hub-assigned auraId.
 */
export async function registerOnHub(
  agentId: string,
  mnemonic: string,
  hubUrl: string,
  label?: string,
): Promise<{ auraId: number; subscriptionId: string }> {
  // Check if already subscribed and registered
  const existing = await prisma.hubSubscription.findUnique({
    where: { agentId_hubUrl: { agentId, hubUrl } },
  });

  if (existing?.auraId) {
    return { auraId: existing.auraId, subscriptionId: existing.id };
  }

  const auraId = await runChallengeSignup(mnemonic, hubUrl);

  // Create or update subscription
  const sub = await prisma.hubSubscription.upsert({
    where: { agentId_hubUrl: { agentId, hubUrl } },
    create: {
      agentId,
      hubUrl,
      label: label ?? null,
      auraId,
      inboundMode: null, // triggers snapshot on next inbound tick
      inboundSeq: null,
    },
    update: { auraId, label: label ?? undefined },
  });

  log.info({ agentId, auraId, hubUrl }, 'Agent registered on hub');
  return { auraId, subscriptionId: sub.id };
}
