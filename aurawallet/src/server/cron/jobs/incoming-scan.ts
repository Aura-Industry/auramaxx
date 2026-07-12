/**
 * Incoming Asset Discovery Job
 * ============================
 * Scans on-chain Transfer events for incoming tokens to HotWallets.
 * New tokens pass a 3-gate spam filter (value, liquidity, safety)
 * before being auto-tracked. Already-tracked tokens just get a
 * Transaction record.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import type { CronJob, CronContext } from '../job';
import { getRpcUrl } from '../../lib/config';
import { isSolanaChain } from '../../lib/address';
import { EVENT_SIGNATURES } from '../../lib/txhistory/signatures';
import { decodeLogs, type RawLog } from '../../lib/txhistory/decoder';
import { resolveTokenMetadataBatch } from '../../lib/txhistory/enricher';
import { getTokenPrice } from '../../lib/price';
import { searchTokens } from '../../lib/token-search';
import { getTokenSafety } from '../../lib/token-safety';
import { upsertTokenMetadata } from '../../lib/token-metadata';
import { getErrorMessage } from '../../lib/error';

// ─── Helpers ──────────────────────────────────────────────────────────

/** Pad a 20-byte address to 32-byte topic for eth_getLogs topic filter */
function padAddress(address: string): string {
  return '0x' + address.slice(2).toLowerCase().padStart(64, '0');
}

/** Format raw bigint token amount with decimals */
function formatAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0';
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const fraction = raw % divisor;
  if (fraction === 0n) return whole.toString();
  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fractionStr}`;
}

// ─── Token Processing Pipeline ────────────────────────────────────────

interface DiscoveredTransfer {
  tokenAddress: string;
  walletAddress: string;
  amount: bigint;
  from: string;
  txHash: string;
  blockNumber: bigint;
}

/**
 * Process a discovered incoming transfer.
 * If the token is already tracked, just write a Transaction record.
 * If new, run the 3-gate spam filter before auto-tracking.
 */
async function processDiscoveredToken(
  transfer: DiscoveredTransfer,
  chain: string,
  ctx: CronContext,
): Promise<void> {
  const { tokenAddress, walletAddress, amount, from, txHash, blockNumber } = transfer;

  // Check for existing Transaction with this txHash+chain (dedup)
  const existingTx = await ctx.prisma.transaction.findUnique({
    where: { txHash_chain: { txHash, chain } },
  });
  if (existingTx) return;

  // Check if already tracked
  const existing = await ctx.prisma.trackedAsset.findUnique({
    where: {
      walletAddress_tokenAddress_chain: { walletAddress, tokenAddress, chain },
    },
  });

  // Resolve decimals for formatting
  const tokenMap = await resolveTokenMetadataBatch([tokenAddress], chain);
  const tokenInfo = tokenMap.get(tokenAddress);
  const decimals = tokenInfo?.decimals ?? 18;
  const symbol = tokenInfo?.symbol ?? 'UNKNOWN';
  const formattedAmount = formatAmount(amount, decimals);

  if (existing) {
    // Already tracked — just write the Transaction record
    await ctx.prisma.transaction.create({
      data: {
        walletAddress,
        txHash,
        type: 'receive',
        status: 'confirmed',
        tokenAddress,
        tokenAmount: formattedAmount,
        from,
        to: walletAddress,
        blockNumber: blockNumber <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(blockNumber) : null,
        chain,
      },
    }).catch(() => {}); // unique constraint race
    return;
  }

  // New token — run spam filter gates

  // Gate 1: Value
  const minValue = ctx.defaults.get<number>('discovery.min_value_usd', 0.5);
  const priceResult = await getTokenPrice(tokenAddress, chain);
  if (priceResult) {
    const valueUsd = parseFloat(formattedAmount) * parseFloat(priceResult.priceUsd);
    if (valueUsd < minValue) {
      ctx.log.debug({ tokenAddress, chain, valueUsd, minValue }, 'Discovery: below value gate');
      return;
    }
  } else {
    // No price data — skip (can't verify value)
    ctx.log.debug({ tokenAddress, chain }, 'Discovery: no price data, skipping');
    return;
  }

  // Gate 2: Liquidity
  const minLiquidity = ctx.defaults.get<number>('discovery.min_liquidity_usd', 1000);
  const searchResults = await searchTokens(tokenAddress, { chain });
  const bestResult = searchResults[0];
  if (!bestResult || bestResult.liquidity < minLiquidity) {
    ctx.log.debug({
      tokenAddress,
      chain,
      liquidity: bestResult?.liquidity ?? 0,
      minLiquidity,
    }, 'Discovery: below liquidity gate');
    return;
  }

  // Gate 3: Safety
  const safetyEnabled = ctx.defaults.get<boolean>('discovery.safety_enabled', true);
  if (safetyEnabled) {
    const safety = await getTokenSafety(tokenAddress, chain);
    if (safety) {
      if (safety.isHoneypot || parseFloat(safety.buyTax) > 50 || parseFloat(safety.sellTax) > 50) {
        ctx.log.debug({ tokenAddress, chain, isHoneypot: safety.isHoneypot, buyTax: safety.buyTax, sellTax: safety.sellTax }, 'Discovery: failed safety gate');
        // Still write metadata for manual lookup
        upsertTokenMetadata(tokenAddress, chain, {
          symbol: tokenInfo?.symbol,
          name: tokenInfo?.name,
          decimals,
        });
        return;
      }
    }
    // safety === null → GoPlus doesn't have data, let it through
  }

  // All gates passed — auto-track
  ctx.log.info({ tokenAddress, chain, symbol, walletAddress }, 'Discovery: auto-tracking new token');

  upsertTokenMetadata(tokenAddress, chain, {
    symbol: tokenInfo?.symbol,
    name: tokenInfo?.name,
    decimals,
    icon: tokenInfo?.icon,
  });

  await ctx.prisma.trackedAsset.upsert({
    where: {
      walletAddress_tokenAddress_chain: { walletAddress, tokenAddress, chain },
    },
    create: {
      walletAddress,
      tokenAddress,
      chain,
      symbol: tokenInfo?.symbol,
      name: tokenInfo?.name,
      decimals,
      icon: tokenInfo?.icon ?? bestResult?.imageUrl,
    },
    update: {},
  });

  await ctx.prisma.transaction.create({
    data: {
      walletAddress,
      txHash,
      type: 'receive',
      status: 'confirmed',
      tokenAddress,
      tokenAmount: formattedAmount,
      from,
      to: walletAddress,
      blockNumber: blockNumber <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(blockNumber) : null,
      chain,
    },
  }).catch(() => {}); // unique constraint race

  await ctx.emit('asset:discovered', {
    walletAddress,
    tokenAddress,
    chain,
    symbol,
    amount: formattedAmount,
  });
}

// ─── EVM Scanning ─────────────────────────────────────────────────────

async function scanEvmChain(chain: string, ctx: CronContext): Promise<void> {
  const rpcUrl = await getRpcUrl(chain);
  const syncKey = `${chain}:discovery`;

  // Get all hot wallet addresses for this chain
  const hotWallets = await ctx.prisma.hotWallet.findMany({
    where: { chain, hidden: false },
    select: { address: true },
  });
  if (hotWallets.length === 0) return;

  const walletAddresses = hotWallets.map((w) => w.address.toLowerCase());
  const walletSet = new Set(walletAddresses);

  // Read block cursor from SyncState
  const syncState = await ctx.prisma.syncState.findUnique({ where: { chain: syncKey } });
  const maxBlocksPerTick = ctx.defaults.get<number>('discovery.max_blocks_per_tick', 2000);
  const maxInitialLookback = ctx.defaults.get<number>('discovery.max_initial_lookback', 302400);

  // Get current block number
  const blockRes = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    signal: AbortSignal.timeout(10000),
  });
  const blockData = await blockRes.json();
  const latestBlock = BigInt(blockData.result);

  // Calculate scan range
  let fromBlock: bigint;
  if (syncState?.lastBlock) {
    fromBlock = BigInt(syncState.lastBlock) + 1n;
  } else {
    fromBlock = latestBlock - BigInt(maxInitialLookback);
    if (fromBlock < 0n) fromBlock = 0n;
  }

  const toBlock = fromBlock + BigInt(maxBlocksPerTick) - 1n < latestBlock
    ? fromBlock + BigInt(maxBlocksPerTick) - 1n
    : latestBlock;

  if (fromBlock > toBlock) return; // already caught up

  // Build topic2 filter — pad wallet addresses for topic2 (receiver)
  const paddedAddresses = walletAddresses.map(padAddress);

  // eth_getLogs: Transfer events TO our wallets
  const logsRes = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'eth_getLogs',
      params: [{
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
        topics: [
          EVENT_SIGNATURES.TRANSFER,
          null,
          paddedAddresses.length === 1 ? paddedAddresses[0] : paddedAddresses,
        ],
      }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  const logsData = await logsRes.json();

  if (logsData.error) {
    ctx.log.warn({ chain, error: logsData.error }, 'Discovery: eth_getLogs RPC error');
    // Update error state but don't advance cursor
    await ctx.prisma.syncState.upsert({
      where: { chain: syncKey },
      create: { chain: syncKey, lastSyncStatus: 'error', lastError: logsData.error.message, syncCount: 1 },
      update: { lastSyncStatus: 'error', lastError: logsData.error.message, syncCount: { increment: 1 } },
    });
    return;
  }

  const rawLogs: RawLog[] = (logsData.result || []).map((log: any) => ({
    address: log.address,
    topics: log.topics,
    data: log.data,
    transactionHash: log.transactionHash,
    logIndex: parseInt(log.logIndex, 16),
    blockNumber: BigInt(log.blockNumber),
  }));

  // Decode logs
  const decoded = decodeLogs(rawLogs);

  // Filter to ERC-20 transfers where `to` is one of our wallets
  const incomingTransfers: DiscoveredTransfer[] = [];
  for (const event of decoded) {
    if (event.type !== 'transfer') continue;
    const to = (event.params.to as string).toLowerCase();
    if (!walletSet.has(to)) continue;

    incomingTransfers.push({
      tokenAddress: event.contractAddress,
      walletAddress: to,
      amount: event.params.amount as bigint,
      from: (event.params.from as string).toLowerCase(),
      txHash: event.txHash,
      blockNumber: event.blockNumber,
    });
  }

  // Process each transfer
  for (const transfer of incomingTransfers) {
    try {
      await processDiscoveredToken(transfer, chain, ctx);
    } catch (err) {
      ctx.log.debug({ err, txHash: transfer.txHash, token: transfer.tokenAddress }, 'Discovery: failed to process transfer');
    }
  }

  // Advance cursor
  await ctx.prisma.syncState.upsert({
    where: { chain: syncKey },
    create: {
      chain: syncKey,
      lastSyncAt: new Date(),
      lastSyncStatus: 'ok',
      lastBlock: toBlock.toString(),
      syncCount: 1,
    },
    update: {
      lastSyncAt: new Date(),
      lastSyncStatus: 'ok',
      lastError: null,
      lastBlock: toBlock.toString(),
      syncCount: { increment: 1 },
    },
  });
}

// ─── Solana Scanning ──────────────────────────────────────────────────

async function scanSolanaChain(chain: string, ctx: CronContext): Promise<void> {
  const rpcUrl = await getRpcUrl(chain);
  const connection = new Connection(rpcUrl, 'confirmed');
  const syncKey = `${chain}:discovery`;

  const hotWallets = await ctx.prisma.hotWallet.findMany({
    where: { chain, hidden: false },
    select: { address: true },
  });
  if (hotWallets.length === 0) return;

  const syncState = await ctx.prisma.syncState.findUnique({ where: { chain: syncKey } });
  const lastSyncAt = syncState?.lastSyncAt ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  for (const wallet of hotWallets) {
    try {
      const pubkey = new PublicKey(wallet.address);
      const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 50 });

      // Filter to signatures newer than last scan
      const newSigs = signatures.filter(
        (s) => s.blockTime && s.blockTime * 1000 > lastSyncAt.getTime()
      );
      if (newSigs.length === 0) continue;

      const sigStrings = newSigs.map((s) => s.signature);
      const transactions = await connection.getParsedTransactions(sigStrings, {
        maxSupportedTransactionVersion: 0,
      });

      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        if (!tx?.meta || tx.meta.err) continue;

        // Extract incoming SPL token transfers
        const innerInstructions = tx.meta.innerInstructions || [];
        const allInstructions = [
          ...(tx.transaction.message.instructions || []),
          ...innerInstructions.flatMap((ii: any) => ii.instructions || []),
        ];

        for (const ix of allInstructions) {
          const parsed = (ix as any).parsed;
          if (!parsed) continue;

          // SPL token transfer/transferChecked
          if (
            (parsed.type === 'transfer' || parsed.type === 'transferChecked') &&
            parsed.info
          ) {
            const dest = parsed.info.destination || parsed.info.account;
            const mint = parsed.info.mint;
            const amountStr = parsed.info.tokenAmount?.uiAmountString || parsed.info.amount;

            // Only process if destination is our wallet's token account
            // For SPL, we check post token balances to match owner
            const postBalances = tx.meta.postTokenBalances || [];
            const isOurWallet = postBalances.some(
              (b: any) =>
                b.owner === wallet.address &&
                b.mint === mint
            );

            if (!isOurWallet || !mint) continue;

            const amount = BigInt(parsed.info.amount || '0');
            if (amount === 0n) continue;

            try {
              await processDiscoveredToken(
                {
                  tokenAddress: mint,
                  walletAddress: wallet.address,
                  amount,
                  from: parsed.info.authority || parsed.info.source || '',
                  txHash: sigStrings[i],
                  blockNumber: BigInt(tx.slot),
                },
                chain,
                ctx,
              );
            } catch (err) {
              ctx.log.debug({ err, mint, wallet: wallet.address }, 'Discovery: failed Solana transfer');
            }
          }
        }
      }
    } catch (err) {
      ctx.log.warn({ err, chain, wallet: wallet.address }, 'Discovery: Solana wallet scan failed');
    }
  }

  // Update sync state
  await ctx.prisma.syncState.upsert({
    where: { chain: syncKey },
    create: {
      chain: syncKey,
      lastSyncAt: new Date(),
      lastSyncStatus: 'ok',
      syncCount: 1,
    },
    update: {
      lastSyncAt: new Date(),
      lastSyncStatus: 'ok',
      lastError: null,
      syncCount: { increment: 1 },
    },
  });
}

// ─── Viem chain detection (same approach as balance-sync) ──────────────

const EVM_CHAINS = new Set(['base', 'ethereum', 'arbitrum', 'optimism', 'polygon']);

// ─── Job Definition ───────────────────────────────────────────────────

export const incomingScanJob: CronJob = {
  id: 'incoming-scan',
  name: 'Incoming Asset Discovery',
  intervalKey: 'discovery.scan_interval',
  defaultInterval: 60_000,

  async run(ctx: CronContext): Promise<void> {
    const enabled = ctx.defaults.get<boolean>('discovery.enabled', true);
    if (!enabled) return;

    // Discover which chains have wallets
    const chains = await ctx.prisma.hotWallet.groupBy({ by: ['chain'] });

    for (const { chain } of chains) {
      try {
        if (isSolanaChain(chain)) {
          await scanSolanaChain(chain, ctx);
        } else if (EVM_CHAINS.has(chain)) {
          await scanEvmChain(chain, ctx);
        } else {
          ctx.log.debug({ chain }, 'Discovery: skipping unknown chain');
        }
      } catch (err) {
        ctx.log.error({ err, chain }, 'Discovery: scan failed for chain');

        const syncKey = `${chain}:discovery`;
        await ctx.prisma.syncState.upsert({
          where: { chain: syncKey },
          create: {
            chain: syncKey,
            lastSyncAt: new Date(),
            lastSyncStatus: 'error',
            lastError: getErrorMessage(err),
            syncCount: 1,
          },
          update: {
            lastSyncAt: new Date(),
            lastSyncStatus: 'error',
            lastError: getErrorMessage(err),
            syncCount: { increment: 1 },
          },
        });
      }
    }
  },
};
