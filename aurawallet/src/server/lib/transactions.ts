/**
 * Shared transaction recording and asset tracking helpers.
 * Eliminates duplicated log+transaction+event boilerplate across route files.
 */

import { prisma } from './db';
import { events } from './events';
import { upsertTokenMetadata } from './token-metadata';
import { normalizeAddress } from './address';

/**
 * Record a transaction: creates a Log entry, a Transaction record,
 * and emits a txCreated WebSocket event.
 */
export async function recordTransaction(params: {
  walletAddress: string;
  txHash: string;
  type: string;
  status?: string;
  amount?: string;
  tokenAddress?: string;
  tokenAmount?: string;
  from: string;
  to?: string;
  description: string;
  chain: string;
  logTitle?: string;
}): Promise<{ id: string }> {
  await prisma.log.create({
    data: {
      walletAddress: params.walletAddress,
      title: params.logTitle || `${params.type} Transaction`,
      description: params.description,
      txHash: params.txHash,
    },
  });

  const norm = (addr: string) => normalizeAddress(addr, params.chain);

  const tx = await prisma.transaction.create({
    data: {
      walletAddress: norm(params.from),
      txHash: params.txHash,
      type: params.type,
      status: params.status || 'confirmed',
      amount: params.amount,
      tokenAddress: params.tokenAddress ? norm(params.tokenAddress) : undefined,
      tokenAmount: params.tokenAmount,
      from: norm(params.from),
      to: params.to ? norm(params.to) : undefined,
      description: params.description,
      chain: params.chain,
      executedAt: new Date(),
    },
  });

  events.txCreated({
    walletAddress: norm(params.from),
    id: tx.id,
    type: params.type,
    txHash: params.txHash,
    amount: params.amount,
    tokenAddress: params.tokenAddress ? norm(params.tokenAddress) : undefined,
    tokenAmount: params.tokenAmount,
    description: params.description,
  });

  return tx;
}

/**
 * Auto-track a token after a successful send/swap/launch:
 * upserts TrackedAsset, emits asset:changed event, and kicks off metadata lookup.
 */
export async function autoTrackToken(params: {
  walletAddress: string;
  tokenAddress: string;
  chain: string;
  poolAddress?: string;
  poolVersion?: string;
  symbol?: string;
  name?: string;
}): Promise<void> {
  const wallet = params.walletAddress.toLowerCase();
  const token = params.tokenAddress.toLowerCase();

  await prisma.trackedAsset.upsert({
    where: {
      walletAddress_tokenAddress_chain: {
        walletAddress: wallet,
        tokenAddress: token,
        chain: params.chain,
      },
    },
    create: {
      walletAddress: wallet,
      tokenAddress: token,
      chain: params.chain,
      ...(params.poolAddress && { poolAddress: params.poolAddress }),
      ...(params.poolVersion && { poolVersion: params.poolVersion }),
    },
    update: {
      updatedAt: new Date(),
      ...(params.poolAddress && { poolAddress: params.poolAddress }),
      ...(params.poolVersion && { poolVersion: params.poolVersion }),
    },
  });

  events.assetChanged({
    walletAddress: wallet,
    tokenAddress: token,
    ...(params.poolAddress && { poolAddress: params.poolAddress }),
    ...(params.poolVersion && { poolVersion: params.poolVersion }),
    ...(params.symbol && { symbol: params.symbol }),
    ...(params.name && { name: params.name }),
  });

  upsertTokenMetadata(
    token,
    params.chain,
    params.symbol ? { symbol: params.symbol, name: params.name } : undefined,
  );
}
