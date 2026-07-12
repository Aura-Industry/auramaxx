/**
 * Balance Sync Job
 * Syncs ERC-20 token balances via Multicall3 and native ETH/SOL balances.
 * Writes to TrackedAsset.lastBalance + NativeBalance table.
 */

import { createPublicClient, http, erc20Abi, type Address, type MulticallResults, type Chain } from 'viem';
import { base, mainnet } from 'viem/chains';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { CronJob, CronContext } from '../job';
import { getRpcUrl } from '../../lib/config';
import { getErrorMessage } from '../../lib/error';

// Multicall3 address (deployed on all major EVM chains)
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

// Map chain names to viem chain objects
const VIEM_CHAINS: Record<string, Chain> = {
  base,
  ethereum: mainnet,
};

function isSolanaChain(chain: string): boolean {
  return chain === 'solana' || chain === 'solana-devnet';
}

// ─── EVM Balance Sync ─────────────────────────────────────────────────

async function syncEvmChain(
  chain: string,
  ctx: CronContext
): Promise<void> {
  const viemChain = VIEM_CHAINS[chain];
  const rpcUrl = await getRpcUrl(chain);

  const client = createPublicClient({
    chain: viemChain,
    transport: http(rpcUrl),
    batch: { multicall: true },
  });

  // 1. Get all tracked assets for this chain (skip bookmarks with null walletAddress)
  const assets = await ctx.prisma.trackedAsset.findMany({
    where: { chain, walletAddress: { not: null } },
    select: {
      id: true,
      walletAddress: true,
      tokenAddress: true,
      lastBalance: true,
      decimals: true,
    },
  });

  // 2. Get all wallet addresses for this chain (for native balance)
  const hotWallets = await ctx.prisma.hotWallet.findMany({
    where: { chain },
    select: { address: true },
  });

  const walletAddresses = hotWallets.map((w) => w.address as Address);
  const maxPerCall = ctx.defaults.get<number>('sync.max_assets_per_call', 200);

  // 3. Batch native balance reads via multicall getEthBalance
  if (walletAddresses.length > 0) {
    try {
      const nativeContracts = walletAddresses.map((addr) => ({
        address: MULTICALL3 as Address,
        abi: [
          {
            inputs: [{ name: 'addr', type: 'address' }],
            name: 'getEthBalance',
            outputs: [{ name: 'balance', type: 'uint256' }],
            stateMutability: 'view' as const,
            type: 'function' as const,
          },
        ] as const,
        functionName: 'getEthBalance' as const,
        args: [addr] as const,
      }));

      const results = await client.multicall({
        contracts: nativeContracts,
        allowFailure: true,
      });

      const upserts: Promise<unknown>[] = [];
      const changedBalances: { walletAddress: string; balance: string }[] = [];

      for (let i = 0; i < walletAddresses.length; i++) {
        const result = results[i];
        if (result.status === 'success') {
          const rawBalance = result.result as bigint;
          // Format to full precision string (18 decimals)
          const formatted = formatBalance(rawBalance, 18);

          upserts.push(
            ctx.prisma.nativeBalance.upsert({
              where: {
                walletAddress_chain: {
                  walletAddress: walletAddresses[i].toLowerCase(),
                  chain,
                },
              },
              create: {
                walletAddress: walletAddresses[i].toLowerCase(),
                chain,
                balance: formatted,
              },
              update: { balance: formatted },
            })
          );

          changedBalances.push({
            walletAddress: walletAddresses[i].toLowerCase(),
            balance: formatted,
          });
        }
      }

      await Promise.all(upserts);

      // Emit balance:updated for native balances
      if (changedBalances.length > 0) {
        await ctx.emit('balance:updated', {
          chain,
          type: 'native',
          balances: changedBalances,
        });
      }
    } catch (err) {
      ctx.log.warn({ err, chain }, 'Native balance multicall failed');
    }
  }

  // 4. Batch ERC-20 balanceOf reads
  if (assets.length > 0) {
    // Chunk assets to respect max_assets_per_call
    for (let offset = 0; offset < assets.length; offset += maxPerCall) {
      const chunk = assets.slice(offset, offset + maxPerCall);

      try {
        const contracts = chunk.map((asset) => ({
          address: asset.tokenAddress as Address,
          abi: erc20Abi,
          functionName: 'balanceOf' as const,
          args: [asset.walletAddress! as Address] as const,
        }));

        const results = await client.multicall({
          contracts,
          allowFailure: true,
        });

        const now = new Date();
        const updates: Promise<unknown>[] = [];
        const changedAssets: { walletAddress: string; tokenAddress: string; balance: string }[] = [];

        for (let i = 0; i < chunk.length; i++) {
          const result = results[i];
          const asset = chunk[i];

          if (result.status === 'success') {
            const rawBalance = result.result as bigint;
            const formatted = formatBalance(rawBalance, asset.decimals);

            // Only update if balance changed
            if (formatted !== asset.lastBalance) {
              updates.push(
                ctx.prisma.trackedAsset.update({
                  where: { id: asset.id },
                  data: { lastBalance: formatted, lastBalanceAt: now },
                })
              );

              changedAssets.push({
                walletAddress: asset.walletAddress!,
                tokenAddress: asset.tokenAddress,
                balance: formatted,
              });
            }
          }
        }

        await Promise.all(updates);

        if (changedAssets.length > 0) {
          await ctx.emit('balance:updated', {
            chain,
            type: 'token',
            balances: changedAssets,
          });
        }
      } catch (err) {
        ctx.log.warn({ err, chain, offset }, 'ERC-20 multicall chunk failed');
      }
    }
  }

  // 5. Update sync state
  await ctx.prisma.syncState.upsert({
    where: { chain },
    create: {
      chain,
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

// ─── Solana Balance Sync ──────────────────────────────────────────────

async function syncSolanaChain(
  chain: string,
  ctx: CronContext
): Promise<void> {
  const rpcUrl = await getRpcUrl(chain);
  const connection = new Connection(rpcUrl, 'confirmed');

  // 1. Get all wallet addresses for this chain
  const hotWallets = await ctx.prisma.hotWallet.findMany({
    where: { chain },
    select: { address: true },
  });

  const walletAddresses = hotWallets.map((w) => w.address);

  // 2. Batch native SOL balance
  if (walletAddresses.length > 0) {
    try {
      const pubkeys = walletAddresses.map((a) => new PublicKey(a));
      const accountInfos = await connection.getMultipleAccountsInfo(pubkeys);

      const upserts: Promise<unknown>[] = [];
      const changedBalances: { walletAddress: string; balance: string }[] = [];

      for (let i = 0; i < walletAddresses.length; i++) {
        const lamports = accountInfos[i]?.lamports || 0;
        const balance = (lamports / LAMPORTS_PER_SOL).toString();

        upserts.push(
          ctx.prisma.nativeBalance.upsert({
            where: {
              walletAddress_chain: {
                walletAddress: walletAddresses[i],
                chain,
              },
            },
            create: { walletAddress: walletAddresses[i], chain, balance },
            update: { balance },
          })
        );

        changedBalances.push({ walletAddress: walletAddresses[i], balance });
      }

      await Promise.all(upserts);

      if (changedBalances.length > 0) {
        await ctx.emit('balance:updated', {
          chain,
          type: 'native',
          balances: changedBalances,
        });
      }
    } catch (err) {
      ctx.log.warn({ err, chain }, 'Solana native balance fetch failed');
    }
  }

  // 3. SPL token balances — per wallet (getTokenAccountsByOwner returns all in one call)
  const assets = await ctx.prisma.trackedAsset.findMany({
    where: { chain, walletAddress: { not: null } },
    select: {
      id: true,
      walletAddress: true,
      tokenAddress: true,
      lastBalance: true,
      decimals: true,
    },
  });

  if (assets.length > 0) {
    // Group assets by wallet
    const assetsByWallet = new Map<string, typeof assets>();
    for (const asset of assets) {
      const wa = asset.walletAddress!; // guaranteed non-null by query filter
      const list = assetsByWallet.get(wa) || [];
      list.push(asset);
      assetsByWallet.set(wa, list);
    }

    const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');

    for (const [walletAddr, walletAssets] of assetsByWallet) {
      try {
        const pubkey = new PublicKey(walletAddr);
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
          pubkey,
          { programId: TOKEN_PROGRAM_ID }
        );

        // Build lookup: mint → balance
        const balanceByMint = new Map<string, string>();
        for (const { account } of tokenAccounts.value) {
          const parsed = account.data.parsed?.info;
          if (parsed?.mint && parsed?.tokenAmount?.uiAmountString) {
            balanceByMint.set(parsed.mint, parsed.tokenAmount.uiAmountString);
          }
        }

        const now = new Date();
        const updates: Promise<unknown>[] = [];
        const changedAssets: { walletAddress: string; tokenAddress: string; balance: string }[] = [];

        for (const asset of walletAssets) {
          const balance = balanceByMint.get(asset.tokenAddress) || '0';

          if (balance !== asset.lastBalance) {
            updates.push(
              ctx.prisma.trackedAsset.update({
                where: { id: asset.id },
                data: { lastBalance: balance, lastBalanceAt: now },
              })
            );

            changedAssets.push({
              walletAddress: asset.walletAddress!,
              tokenAddress: asset.tokenAddress,
              balance,
            });
          }
        }

        await Promise.all(updates);

        if (changedAssets.length > 0) {
          await ctx.emit('balance:updated', {
            chain,
            type: 'token',
            balances: changedAssets,
          });
        }
      } catch (err) {
        ctx.log.warn({ err, chain, wallet: walletAddr }, 'SPL token fetch failed');
      }
    }
  }

  // 4. Update sync state
  await ctx.prisma.syncState.upsert({
    where: { chain },
    create: {
      chain,
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

// ─── Helpers ──────────────────────────────────────────────────────────

function formatBalance(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0';
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const fraction = raw % divisor;
  if (fraction === 0n) return whole.toString();
  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fractionStr}`;
}

// ─── Job Definition ───────────────────────────────────────────────────

export const balanceSyncJob: CronJob = {
  id: 'balance-sync',
  name: 'Balance Sync',
  intervalKey: 'sync.background_interval',
  defaultInterval: 120_000,

  async run(ctx: CronContext): Promise<void> {
    const enabled = ctx.defaults.get<boolean>('sync.enabled', true);
    if (!enabled) return;

    // Discover which chains have wallets
    const chains = await ctx.prisma.hotWallet.groupBy({
      by: ['chain'],
    });

    for (const { chain } of chains) {
      try {
        if (isSolanaChain(chain)) {
          await syncSolanaChain(chain, ctx);
        } else if (VIEM_CHAINS[chain]) {
          await syncEvmChain(chain, ctx);
        } else {
          // Unknown chain — try as generic EVM
          ctx.log.debug({ chain }, 'Skipping unknown chain (no viem config)');
        }
      } catch (err) {
        ctx.log.error({ err, chain }, 'Balance sync failed for chain');

        // Record error in sync state
        await ctx.prisma.syncState.upsert({
          where: { chain },
          create: {
            chain,
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
