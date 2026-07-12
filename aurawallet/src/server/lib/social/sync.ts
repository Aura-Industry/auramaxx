import type { SocialMessage } from '@prisma/client';
import { prisma } from '../db';
import { getHubUrl } from '../defaults';
import { callHubWithSessionAuth, resolveHubAuthIdentity } from '../hub-auth';
import { normalizeFollowBodyForHub } from './public-key';

const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

interface HubMessageResult {
  index?: number;
  hash?: string;
  status:
    | 'accepted'
    | 'duplicate'
    | 'rejected'
    | 'error'
    | 'invalid_message'
    | 'invalid_signature'
    | 'identity_mismatch';
  code?: string;
  detail?: string;
}

interface HubSyncResponse {
  results: HubMessageResult[];
}

interface HubOutboundMessageData {
  type: string;
  timestamp: number;
  network: string;
  body: Record<string, unknown>;
}

interface HubOutboundMessage {
  data: HubOutboundMessageData;
  hashScheme: 'blake3';
  signatureScheme: 'ed25519';
  hash: string;
  signer: string;
  signature: string;
}

type SocialPrismaClient = Pick<typeof prisma, 'socialMessage'>;

type SocialSyncLogger = {
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export type SocialSyncErrorMode = 'retry' | 'fail';

export interface SyncSocialMessagesOptions {
  messages: SocialMessage[];
  transientErrorMode?: SocialSyncErrorMode;
  prismaClient?: SocialPrismaClient;
  hubUrl?: string;
  log?: SocialSyncLogger;
}

export function computeSocialSyncBackoff(attempts: number): Date {
  const delay = Math.min(Math.pow(2, attempts) * 1000, MAX_BACKOFF_MS);
  return new Date(Date.now() + delay);
}

function signerHexToBase64(signerHex: string): string | null {
  const normalized = signerHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return null;
  return Buffer.from(normalized, 'hex').toString('base64');
}

function parseBodyObject(rawBody: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

async function postToHub(
  hubUrl: string,
  publicKeyB64: string,
  messages: SocialMessage[],
  log?: SocialSyncLogger,
): Promise<HubSyncResponse | null> {
  const outboundMessages: HubOutboundMessage[] = messages.map((m) => {
    const body = normalizeFollowBodyForHub(m.type, parseBodyObject(m.body));
    return {
      data: {
        type: m.type,
        timestamp: m.timestamp,
        network: m.network,
        body,
      },
      hashScheme: 'blake3',
      signatureScheme: 'ed25519',
      hash: m.hash,
      signer: m.signer,
      signature: m.signature,
    };
  });

  const authIdentity = resolveHubAuthIdentity(messages[0]?.agentId);
  if (!authIdentity) {
    log?.warn?.('Hub sync.submit skipped: no unlocked agent available for hub auth');
    return null;
  }

  try {
    return await callHubWithSessionAuth<HubSyncResponse>(
      hubUrl,
      'sync.submit',
      {
        publicKey: publicKeyB64,
        messages: outboundMessages,
      },
      authIdentity.mnemonic,
      { log },
    );
  } catch (error) {
    log?.warn?.({ error, publicKeyB64 }, 'Hub authenticated sync.submit failed');
    return null;
  }
}

async function markRetry(
  prismaClient: SocialPrismaClient,
  message: SocialMessage,
  detail?: string,
): Promise<void> {
  const attempts = message.attempts + 1;
  await prismaClient.socialMessage.update({
    where: { id: message.id },
    data: {
      syncStatus: 'pending',
      attempts,
      nextRetryAt: computeSocialSyncBackoff(attempts),
      syncCode: null,
      syncDetail: detail ?? null,
    },
  });
}

async function markFailed(
  prismaClient: SocialPrismaClient,
  message: SocialMessage,
  code: string,
  detail?: string,
): Promise<void> {
  await prismaClient.socialMessage.update({
    where: { id: message.id },
    data: {
      syncStatus: 'failed',
      attempts: message.attempts + 1,
      nextRetryAt: null,
      syncCode: code,
      syncDetail: detail ?? null,
    },
  });
}

async function markTransientError(
  prismaClient: SocialPrismaClient,
  message: SocialMessage,
  mode: SocialSyncErrorMode,
  code: string,
  detail?: string,
): Promise<void> {
  if (mode === 'fail') {
    await markFailed(prismaClient, message, code, detail);
    return;
  }
  await markRetry(prismaClient, message, detail);
}

export async function syncSocialMessagesNow({
  messages,
  transientErrorMode = 'retry',
  prismaClient = prisma,
  hubUrl = getHubUrl(),
  log,
}: SyncSocialMessagesOptions): Promise<void> {
  if (messages.length === 0) return;

  const publicKeyB64 = signerHexToBase64(messages[0].signer);
  if (!publicKeyB64) {
    await Promise.all(messages.map((message) => (
      markFailed(
        prismaClient,
        message,
        'invalid_signer_public_key',
        'Signer public key must be a 64-char hex ed25519 key',
      )
    )));
    return;
  }

  const response = await postToHub(hubUrl, publicKeyB64, messages, log);
  if (!response) {
    await Promise.all(messages.map((message) => (
      markTransientError(
        prismaClient,
        message,
        transientErrorMode,
        'hub_unreachable',
        'Hub request failed or timed out',
      )
    )));
    return;
  }

  const messagesByHash = new Map(messages.map((message) => [message.hash, message]));
  const resolvedMessageIds = new Set<string>();

  for (const result of response.results || []) {
    const messageFromHash = typeof result.hash === 'string'
      ? messagesByHash.get(result.hash)
      : undefined;
    const messageFromIndex = typeof result.index === 'number'
      && Number.isInteger(result.index)
      && result.index >= 0
      && result.index < messages.length
      ? messages[result.index]
      : undefined;
    const message = messageFromHash ?? messageFromIndex;
    if (!message) continue;
    resolvedMessageIds.add(message.id);

    switch (result.status) {
      case 'accepted':
        await prismaClient.socialMessage.update({
          where: { id: message.id },
          data: {
            syncStatus: 'accepted',
            syncedAt: new Date(),
            nextRetryAt: null,
            syncCode: null,
            syncDetail: null,
          },
        });
        break;
      case 'duplicate':
        await prismaClient.socialMessage.update({
          where: { id: message.id },
          data: {
            syncStatus: 'duplicate',
            nextRetryAt: null,
            syncCode: null,
            syncDetail: null,
          },
        });
        break;
      case 'rejected':
      case 'invalid_message':
      case 'invalid_signature':
      case 'identity_mismatch':
        await prismaClient.socialMessage.update({
          where: { id: message.id },
          data: {
            syncStatus: 'rejected',
            nextRetryAt: null,
            syncCode: result.code ?? (result.status === 'rejected' ? 'hub_rejected' : result.status),
            syncDetail: result.detail ?? null,
          },
        });
        break;
      case 'error':
      default:
        await markTransientError(
          prismaClient,
          message,
          transientErrorMode,
          result.code ?? 'hub_error',
          result.detail,
        );
        break;
    }
  }

  for (const message of messages) {
    if (resolvedMessageIds.has(message.id)) continue;
    await markTransientError(
      prismaClient,
      message,
      transientErrorMode,
      'hub_missing_result',
      'Hub response did not include this message hash',
    );
  }
}

export function submitSocialMessagesAsync(options: SyncSocialMessagesOptions): void {
  void syncSocialMessagesNow(options).catch((error) => {
    options.log?.warn?.({ error }, 'Async social sync failed');
  });
}
