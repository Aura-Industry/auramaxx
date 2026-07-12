/**
 * Token & Pool Metadata Enricher
 * ===============================
 * Resolves token/pool metadata from DB cache or on-chain,
 * then enriches decoded events into human-readable summaries.
 */

import { createPublicClient, http, erc20Abi, type Address, type Chain } from 'viem';
import { base, mainnet } from 'viem/chains';
import { getRpcUrl } from '../config';
import { prisma } from '../db';
import { KNOWN_CONTRACTS, EVENT_SIGNATURES } from './signatures';
import type { DecodedEvent } from './decoder';

/** Serialize event params for JSON — converts BigInt values to strings */
function safeParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = typeof v === 'bigint' ? v.toString() : String(v);
  }
  return out;
}

// --- Types ---

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  icon?: string;
}

export interface PoolInfo {
  address: string;
  token0: string;
  token1: string;
  fee?: number;
  dex?: string;
}

export interface EnrichedTransaction {
  type: string;
  summary: string;
  txHash: string;
  blockNumber: string; // stringified bigint
  timestamp?: number;
  protocol?: string;
  details: Record<string, unknown>;
}

// Map chain names to viem chain objects
const VIEM_CHAINS: Record<string, Chain> = {
  base,
  ethereum: mainnet,
};

// --- Token Resolution ---

export async function resolveTokenMetadataBatch(
  addresses: string[],
  chain: string,
): Promise<Map<string, TokenInfo>> {
  const result = new Map<string, TokenInfo>();
  if (addresses.length === 0) return result;

  const normalized = addresses.map(a => a.toLowerCase());
  const unique = [...new Set(normalized)];

  // 1. Check DB cache
  const cached = await prisma.tokenMetadata.findMany({
    where: {
      tokenAddress: { in: unique },
      chain,
    },
  });

  const uncached: string[] = [];
  for (const addr of unique) {
    const hit = cached.find(c => c.tokenAddress === addr);
    if (hit) {
      result.set(addr, {
        address: addr,
        symbol: hit.symbol || 'UNKNOWN',
        name: hit.name || 'Unknown Token',
        decimals: hit.decimals,
        icon: hit.icon || undefined,
      });
    } else {
      uncached.push(addr);
    }
  }

  if (uncached.length === 0) return result;

  // 2. Multicall for cache misses
  try {
    const rpcUrl = await getRpcUrl(chain);
    const viemChain = VIEM_CHAINS[chain];
    const client = createPublicClient({
      chain: viemChain,
      transport: http(rpcUrl),
      batch: { multicall: true },
    });

    const contracts = uncached.flatMap(addr => [
      { address: addr as Address, abi: erc20Abi, functionName: 'symbol' as const },
      { address: addr as Address, abi: erc20Abi, functionName: 'name' as const },
      { address: addr as Address, abi: erc20Abi, functionName: 'decimals' as const },
    ]);

    const multicallResults = await client.multicall({
      contracts,
      allowFailure: true,
    });

    for (let i = 0; i < uncached.length; i++) {
      const addr = uncached[i];
      const symbolResult = multicallResults[i * 3];
      const nameResult = multicallResults[i * 3 + 1];
      const decimalsResult = multicallResults[i * 3 + 2];

      const symbol = symbolResult.status === 'success' ? String(symbolResult.result) : 'UNKNOWN';
      const name = nameResult.status === 'success' ? String(nameResult.result) : 'Unknown Token';
      const decimals = decimalsResult.status === 'success' ? Number(decimalsResult.result) : 18;

      const info: TokenInfo = { address: addr, symbol, name, decimals };
      result.set(addr, info);

      // Write to DB cache (fire-and-forget)
      prisma.tokenMetadata.upsert({
        where: { tokenAddress_chain: { tokenAddress: addr, chain } },
        create: { tokenAddress: addr, chain, symbol, name, decimals },
        update: { symbol, name, decimals },
      }).catch(() => {});
    }

    // Fire-and-forget: DexScreener enrichment for icon
    enrichFromDexScreener(uncached, chain).catch(() => {});
  } catch {
    // RPC failure — fill with defaults
    for (const addr of uncached) {
      if (!result.has(addr)) {
        result.set(addr, { address: addr, symbol: 'UNKNOWN', name: 'Unknown Token', decimals: 18 });
      }
    }
  }

  return result;
}

/** Fire-and-forget DexScreener enrichment for token icons */
async function enrichFromDexScreener(addresses: string[], chain: string): Promise<void> {
  for (const addr of addresses) {
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${addr}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) continue;
      const data = await res.json();
      const pairs: any[] = data.pairs || [];
      if (pairs.length === 0) continue;

      const info = pairs[0].baseToken;
      if (!info) continue;

      const icon = (pairs[0] as any).info?.imageUrl || null;
      if (icon) {
        await prisma.tokenMetadata.update({
          where: { tokenAddress_chain: { tokenAddress: addr, chain } },
          data: { icon },
        }).catch(() => {});
      }
    } catch {
      // Non-critical
    }
  }
}

// --- Pool Resolution ---

const POOL_ABI = [
  { inputs: [], name: 'token0', outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'token1', outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'fee', outputs: [{ type: 'uint24' }], stateMutability: 'view', type: 'function' },
] as const;

export async function resolvePoolMetadata(
  poolAddress: string,
  chain: string,
): Promise<PoolInfo | null> {
  const addr = poolAddress.toLowerCase();

  // 1. Check DB cache
  const cached = await prisma.poolMetadata.findUnique({
    where: { poolAddress_chain: { poolAddress: addr, chain } },
  });
  if (cached) {
    return {
      address: addr,
      token0: cached.token0 || '',
      token1: cached.token1 || '',
      fee: cached.fee ?? undefined,
      dex: cached.dex ?? undefined,
    };
  }

  // 2. Multicall for pool contract
  try {
    const rpcUrl = await getRpcUrl(chain);
    const viemChain = VIEM_CHAINS[chain];
    const client = createPublicClient({
      chain: viemChain,
      transport: http(rpcUrl),
      batch: { multicall: true },
    });

    const results = await client.multicall({
      contracts: [
        { address: addr as Address, abi: POOL_ABI, functionName: 'token0' },
        { address: addr as Address, abi: POOL_ABI, functionName: 'token1' },
        { address: addr as Address, abi: POOL_ABI, functionName: 'fee' },
      ],
      allowFailure: true,
    });

    const token0 = results[0].status === 'success' ? (results[0].result as string).toLowerCase() : null;
    const token1 = results[1].status === 'success' ? (results[1].result as string).toLowerCase() : null;
    const fee = results[2].status === 'success' ? Number(results[2].result) : null;

    if (!token0 || !token1) return null;

    const dex = fee !== null ? 'uniswap_v3' : 'uniswap_v2';
    const pool: PoolInfo = { address: addr, token0, token1, fee: fee ?? undefined, dex };

    // Write to cache (immutable)
    prisma.poolMetadata.create({
      data: { poolAddress: addr, chain, token0, token1, fee, dex },
    }).catch(() => {});

    return pool;
  } catch {
    return null;
  }
}

export async function resolveV4PoolId(
  poolId: string,
  chain: string,
): Promise<PoolInfo | null> {
  // 1. Check DB cache (use poolId as poolAddress key)
  const cached = await prisma.poolMetadata.findUnique({
    where: { poolAddress_chain: { poolAddress: poolId, chain } },
  });
  if (cached) {
    return {
      address: poolId,
      token0: cached.token0 || '',
      token1: cached.token1 || '',
      fee: cached.fee ?? undefined,
      dex: 'uniswap_v4',
    };
  }

  // 2. Look for Initialize event on PoolManager
  const contracts = KNOWN_CONTRACTS[chain];
  if (!contracts?.v4PoolManager) return null;

  try {
    const rpcUrl = await getRpcUrl(chain);
    const viemChain = VIEM_CHAINS[chain];
    const client = createPublicClient({
      chain: viemChain,
      transport: http(rpcUrl),
    });

    const logs = await client.getLogs({
      address: contracts.v4PoolManager as Address,
      event: {
        type: 'event',
        name: 'Initialize',
        inputs: [
          { name: 'id', type: 'bytes32', indexed: true },
          { name: 'currency0', type: 'address', indexed: true },
          { name: 'currency1', type: 'address', indexed: true },
          { name: 'fee', type: 'uint24', indexed: false },
          { name: 'tickSpacing', type: 'int24', indexed: false },
          { name: 'hooks', type: 'address', indexed: false },
          { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
          { name: 'tick', type: 'int24', indexed: false },
        ],
      },
      args: { id: poolId as `0x${string}` },
      fromBlock: 0n,
    });

    if (logs.length === 0) return null;

    const initLog = logs[0];
    const token0 = (initLog.args.currency0 as string).toLowerCase();
    const token1 = (initLog.args.currency1 as string).toLowerCase();
    const fee = Number(initLog.args.fee);

    const pool: PoolInfo = { address: poolId, token0, token1, fee, dex: 'uniswap_v4' };

    // Cache (immutable)
    prisma.poolMetadata.create({
      data: { poolAddress: poolId, chain, token0, token1, fee, dex: 'uniswap_v4' },
    }).catch(() => {});

    return pool;
  } catch {
    return null;
  }
}

// --- Enrichment ---

function formatAmount(amount: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const remainder = amount % divisor;

  if (remainder === 0n) return whole.toString();

  const fracStr = remainder.toString().padStart(decimals, '0');
  // Trim trailing zeros, keep up to 6 significant decimals
  const trimmed = fracStr.replace(/0+$/, '').slice(0, 6);
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export async function enrichEvents(
  events: DecodedEvent[],
  address: string,
  chain: string,
): Promise<EnrichedTransaction[]> {
  const addr = address.toLowerCase();
  const wethAddress = KNOWN_CONTRACTS[chain]?.weth?.toLowerCase();

  // 1. Collect all unique token and pool addresses
  const tokenAddresses = new Set<string>();
  const poolAddresses: string[] = [];
  const v4PoolIds: string[] = [];

  for (const ev of events) {
    if (ev.type === 'transfer' || ev.type === 'transfer_nft') {
      tokenAddresses.add(ev.contractAddress);
    } else if (ev.type === 'approval') {
      tokenAddresses.add(ev.contractAddress);
    } else if (ev.type === 'swap_v2') {
      poolAddresses.push(ev.contractAddress);
    } else if (ev.type === 'swap_v3') {
      poolAddresses.push(ev.contractAddress);
    } else if (ev.type === 'swap_v4') {
      const poolId = ev.params.poolId as string;
      if (poolId) v4PoolIds.push(poolId);
    }
  }

  // 2. Batch-resolve metadata
  const tokenMap = await resolveTokenMetadataBatch([...tokenAddresses], chain);

  const poolMap = new Map<string, PoolInfo>();
  for (const pa of poolAddresses) {
    const info = await resolvePoolMetadata(pa, chain);
    if (info) {
      poolMap.set(pa, info);
      // Also resolve pool tokens
      if (info.token0) tokenAddresses.add(info.token0);
      if (info.token1) tokenAddresses.add(info.token1);
    }
  }

  for (const pid of v4PoolIds) {
    const info = await resolveV4PoolId(pid, chain);
    if (info) {
      poolMap.set(pid, info);
      if (info.token0) tokenAddresses.add(info.token0);
      if (info.token1) tokenAddresses.add(info.token1);
    }
  }

  // Resolve newly-discovered pool tokens
  const additionalTokens = [...tokenAddresses].filter(a => !tokenMap.has(a));
  if (additionalTokens.length > 0) {
    const extra = await resolveTokenMetadataBatch(additionalTokens, chain);
    for (const [k, v] of extra) tokenMap.set(k, v);
  }

  // Helper to get symbol
  const getSymbol = (addr: string): string => {
    if (addr === wethAddress) return 'WETH';
    return tokenMap.get(addr)?.symbol || shortenAddress(addr);
  };
  const getDecimals = (addr: string): number => {
    return tokenMap.get(addr)?.decimals || 18;
  };

  // 3. Build enriched transactions
  const result: EnrichedTransaction[] = [];

  for (const ev of events) {
    try {
      switch (ev.type) {
        case 'transfer': {
          const from = ev.params.from as string;
          const to = ev.params.to as string;
          const amount = ev.params.amount as bigint;
          const decimals = getDecimals(ev.contractAddress);
          const symbol = getSymbol(ev.contractAddress);
          const formatted = formatAmount(amount, decimals);
          const isIncoming = to === addr;
          const direction = isIncoming ? 'in' : 'out';
          const counterparty = isIncoming ? from : to;
          const summary = isIncoming
            ? `Received ${formatted} ${symbol} from ${shortenAddress(counterparty)}`
            : `Sent ${formatted} ${symbol} to ${shortenAddress(counterparty)}`;

          result.push({
            type: 'transfer',
            summary,
            txHash: ev.txHash,
            blockNumber: ev.blockNumber.toString(),
            details: { from, to, amount: formatted, symbol, direction, tokenAddress: ev.contractAddress },
          });
          break;
        }

        case 'transfer_nft': {
          const from = ev.params.from as string;
          const to = ev.params.to as string;
          const tokenId = ev.params.tokenId as bigint;
          const isIncoming = to === addr;
          const counterparty = isIncoming ? from : to;
          const summary = isIncoming
            ? `Received NFT #${tokenId} from ${shortenAddress(counterparty)}`
            : `Sent NFT #${tokenId} to ${shortenAddress(counterparty)}`;

          result.push({
            type: 'transfer_nft',
            summary,
            txHash: ev.txHash,
            blockNumber: ev.blockNumber.toString(),
            details: { from, to, tokenId: tokenId.toString(), direction: isIncoming ? 'in' : 'out', contractAddress: ev.contractAddress },
          });
          break;
        }

        case 'approval': {
          const spender = ev.params.spender as string;
          const symbol = getSymbol(ev.contractAddress);
          const summary = `Approved ${shortenAddress(spender)} to spend ${symbol}`;
          result.push({
            type: 'approval',
            summary,
            txHash: ev.txHash,
            blockNumber: ev.blockNumber.toString(),
            details: { owner: ev.params.owner, spender, symbol, tokenAddress: ev.contractAddress },
          });
          break;
        }

        case 'approval_nft': {
          const spender = ev.params.spender as string;
          const tokenId = ev.params.tokenId as bigint;
          const summary = `Approved ${shortenAddress(spender)} for NFT #${tokenId}`;
          result.push({
            type: 'approval_nft',
            summary,
            txHash: ev.txHash,
            blockNumber: ev.blockNumber.toString(),
            details: { owner: ev.params.owner, spender, tokenId: tokenId.toString(), contractAddress: ev.contractAddress },
          });
          break;
        }

        case 'swap_v2': {
          const pool = poolMap.get(ev.contractAddress);
          if (!pool) {
            result.push({
              type: 'swap_v2',
              summary: `Swapped on ${shortenAddress(ev.contractAddress)}`,
              txHash: ev.txHash,
              blockNumber: ev.blockNumber.toString(),
              protocol: 'uniswap_v2',
              details: safeParams(ev.params),
            });
            break;
          }

          const a0In = ev.params.amount0In as bigint;
          const a1In = ev.params.amount1In as bigint;
          const a0Out = ev.params.amount0Out as bigint;
          const a1Out = ev.params.amount1Out as bigint;

          const tokenIn = a0In > 0n ? pool.token0 : pool.token1;
          const tokenOut = a0Out > 0n ? pool.token0 : pool.token1;
          const amountIn = a0In > 0n ? a0In : a1In;
          const amountOut = a0Out > 0n ? a0Out : a1Out;

          const symbolIn = getSymbol(tokenIn);
          const symbolOut = getSymbol(tokenOut);
          const formattedIn = formatAmount(amountIn, getDecimals(tokenIn));
          const formattedOut = formatAmount(amountOut, getDecimals(tokenOut));

          result.push({
            type: 'swap',
            summary: `Swapped ${formattedIn} ${symbolIn} for ${formattedOut} ${symbolOut}`,
            txHash: ev.txHash,
            blockNumber: ev.blockNumber.toString(),
            protocol: 'uniswap_v2',
            details: { tokenIn, tokenOut, amountIn: formattedIn, amountOut: formattedOut, symbolIn, symbolOut, pool: ev.contractAddress },
          });
          break;
        }

        case 'swap_v3': {
          const pool = poolMap.get(ev.contractAddress);
          if (!pool) {
            result.push({
              type: 'swap_v3',
              summary: `Swapped on ${shortenAddress(ev.contractAddress)}`,
              txHash: ev.txHash,
              blockNumber: ev.blockNumber.toString(),
              protocol: 'uniswap_v3',
              details: safeParams(ev.params),
            });
            break;
          }

          // V3 uses signed amounts: positive = sent to pool, negative = received from pool
          const amount0 = ev.params.amount0 as bigint;
          const amount1 = ev.params.amount1 as bigint;

          const tokenIn = amount0 > 0n ? pool.token0 : pool.token1;
          const tokenOut = amount0 > 0n ? pool.token1 : pool.token0;
          const amountIn = amount0 > 0n ? amount0 : amount1;
          const amountOut = amount0 > 0n ? -amount1 : -amount0;

          const symbolIn = getSymbol(tokenIn);
          const symbolOut = getSymbol(tokenOut);
          const formattedIn = formatAmount(amountIn, getDecimals(tokenIn));
          const formattedOut = formatAmount(amountOut, getDecimals(tokenOut));

          result.push({
            type: 'swap',
            summary: `Swapped ${formattedIn} ${symbolIn} for ${formattedOut} ${symbolOut}`,
            txHash: ev.txHash,
            blockNumber: ev.blockNumber.toString(),
            protocol: 'uniswap_v3',
            details: { tokenIn, tokenOut, amountIn: formattedIn, amountOut: formattedOut, symbolIn, symbolOut, pool: ev.contractAddress },
          });
          break;
        }

        case 'swap_v4': {
          const poolId = ev.params.poolId as string;
          const pool = poolMap.get(poolId);
          if (!pool) {
            // Serialize params — raw BigInt values (amount0, sqrtPriceX96, etc.) can't be JSON-serialized
            const safeParams: Record<string, string> = {};
            for (const [k, v] of Object.entries(ev.params)) {
              safeParams[k] = typeof v === 'bigint' ? v.toString() : String(v);
            }
            result.push({
              type: 'swap_v4',
              summary: `Swapped on V4 pool`,
              txHash: ev.txHash,
              blockNumber: ev.blockNumber.toString(),
              protocol: 'uniswap_v4',
              details: safeParams,
            });
            break;
          }

          const amount0 = ev.params.amount0 as bigint;
          const amount1 = ev.params.amount1 as bigint;

          const tokenIn = amount0 > 0n ? pool.token0 : pool.token1;
          const tokenOut = amount0 > 0n ? pool.token1 : pool.token0;
          const amountIn = amount0 > 0n ? amount0 : amount1;
          const amountOut = amount0 > 0n ? -amount1 : -amount0;

          const symbolIn = getSymbol(tokenIn);
          const symbolOut = getSymbol(tokenOut);
          const formattedIn = formatAmount(amountIn, getDecimals(tokenIn));
          const formattedOut = formatAmount(amountOut, getDecimals(tokenOut));

          result.push({
            type: 'swap',
            summary: `Swapped ${formattedIn} ${symbolIn} for ${formattedOut} ${symbolOut}`,
            txHash: ev.txHash,
            blockNumber: ev.blockNumber.toString(),
            protocol: 'uniswap_v4',
            details: { tokenIn, tokenOut, amountIn: formattedIn, amountOut: formattedOut, symbolIn, symbolOut, poolId },
          });
          break;
        }

        case 'weth_deposit': {
          const wad = ev.params.wad as bigint;
          const formatted = formatAmount(wad, 18);
          result.push({
            type: 'wrap',
            summary: `Wrapped ${formatted} ETH`,
            txHash: ev.txHash,
            blockNumber: ev.blockNumber.toString(),
            details: { amount: formatted, direction: 'wrap' },
          });
          break;
        }

        case 'weth_withdrawal': {
          const wad = ev.params.wad as bigint;
          const formatted = formatAmount(wad, 18);
          result.push({
            type: 'unwrap',
            summary: `Unwrapped ${formatted} WETH`,
            txHash: ev.txHash,
            blockNumber: ev.blockNumber.toString(),
            details: { amount: formatted, direction: 'unwrap' },
          });
          break;
        }

        default:
          result.push({
            type: ev.type,
            summary: `Unknown event on ${shortenAddress(ev.contractAddress)}`,
            txHash: ev.txHash,
            blockNumber: ev.blockNumber.toString(),
            details: safeParams(ev.params),
          });
      }
    } catch {
      result.push({
        type: ev.type,
        summary: `Event on ${shortenAddress(ev.contractAddress)}`,
        txHash: ev.txHash,
        blockNumber: ev.blockNumber.toString(),
        details: safeParams(ev.params),
      });
    }
  }

  return result;
}
