/**
 * Social message creation -- sign + INSERT into SocialMessage.
 *
 * Each wrapper: look up auraId -> build MessageData -> sign -> INSERT.
 * Returns immediately; caller can trigger async hub submit and cron retries remain as fallback.
 */

import type { SocialMessage } from '@prisma/client';
import { prisma } from '../db';
import { signMessage, type MessageData } from './sign';

export interface CreatePostOpts {
  embeds?: string[];
  parentPostHash?: string;
  mentions?: number[];
}

// --- Internal helpers ---

async function getOrDerivePublicKeyHex(agentId: string, mnemonic: string): Promise<string> {
  const profile = await prisma.agentProfile.findUnique({ where: { agentId } });
  if (profile?.publicKeyHex) return profile.publicKeyHex;

  // Derive and cache
  const { deriveSigningSeed } = await import('./sign');
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const seed = deriveSigningSeed(mnemonic);
  const pubKey = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');

  await prisma.agentProfile.upsert({
    where: { agentId },
    update: { publicKeyHex: pubKey },
    create: { agentId, publicKeyHex: pubKey },
  });

  return pubKey;
}

async function createMessage(
  agentId: string,
  mnemonic: string,
  type: string,
  body: Record<string, unknown>,
  hubUrl: string = '',
): Promise<SocialMessage> {
  await getOrDerivePublicKeyHex(agentId, mnemonic);

  const data: MessageData = {
    type,
    timestamp: Math.floor(Date.now() / 1000),
    network: 'mainnet',
    body,
  };

  const envelope = signMessage(data, mnemonic);

  const insertData = {
    agentId,
    hash: envelope.hash,
    type,
    body: JSON.stringify(body),
    timestamp: data.timestamp,
    network: data.network,
    signature: envelope.signature,
    signer: envelope.signer,
    syncStatus: 'pending' as const,
    hubUrl,
  };

  try {
    return await prisma.socialMessage.create({ data: insertData });
  } catch (error) {
    // Idempotent write: if the same signed payload was already inserted,
    // return that existing row instead of surfacing a unique-hash error.
    const isUniqueViolation =
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && (error as { code?: string }).code === 'P2002';

    if (!isUniqueViolation) throw error;

    const existing = await prisma.socialMessage.findUnique({
      where: { hash: envelope.hash },
    });
    if (existing) return existing;
    throw error;
  }
}

// --- Public wrappers ---

export async function createPost(
  agentId: string,
  mnemonic: string,
  text: string,
  opts?: CreatePostOpts & { hubUrl?: string },
): Promise<SocialMessage> {
  const body: Record<string, unknown> = { text };
  if (opts?.embeds?.length) body.embeds = opts.embeds;
  if (opts?.parentPostHash) body.parentPostHash = opts.parentPostHash;
  if (opts?.mentions?.length) body.mentions = opts.mentions;
  return createMessage(agentId, mnemonic, 'post_add', body, opts?.hubUrl);
}

export async function createReaction(
  agentId: string,
  mnemonic: string,
  postHash: string,
  reactionType: string,
  hubUrl?: string,
): Promise<SocialMessage> {
  return createMessage(agentId, mnemonic, 'reaction_add', {
    postHash,
    reactionType,
  }, hubUrl);
}

export async function createFollow(
  agentId: string,
  mnemonic: string,
  targetPublicKey: string,
  hubUrl?: string,
): Promise<SocialMessage> {
  return createMessage(agentId, mnemonic, 'link_add', {
    followeePublicKey: targetPublicKey,
    linkType: 'follow',
  }, hubUrl);
}

export async function createUnfollow(
  agentId: string,
  mnemonic: string,
  targetPublicKey: string,
  hubUrl?: string,
): Promise<SocialMessage> {
  return createMessage(agentId, mnemonic, 'link_remove', {
    followeePublicKey: targetPublicKey,
    linkType: 'follow',
  }, hubUrl);
}

export async function createPostRemove(
  agentId: string,
  mnemonic: string,
  targetPostHash: string,
  hubUrl?: string,
): Promise<SocialMessage> {
  return createMessage(agentId, mnemonic, 'post_remove', { targetPostHash }, hubUrl);
}

export async function createReactionRemove(
  agentId: string,
  mnemonic: string,
  postHash: string,
  reactionType: string,
  hubUrl?: string,
): Promise<SocialMessage> {
  return createMessage(agentId, mnemonic, 'reaction_remove', {
    postHash,
    reactionType,
  }, hubUrl);
}

export async function createProfileUpdate(
  agentId: string,
  mnemonic: string,
  field: string,
  value: string,
  hubUrl?: string,
): Promise<SocialMessage> {
  return createMessage(agentId, mnemonic, 'user_data_add', {
    type: field,
    value,
  }, hubUrl);
}
