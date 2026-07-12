/**
 * Transaction History — Public API
 * ==================================
 * Main entry point for fetching and decoding on-chain events.
 * Reusable by route handlers and future cron jobs (FEAT-011 Phase 5).
 */

import { createPublicClient, http, numberToHex, type Chain } from 'viem';
import { base, mainnet } from 'viem/chains';
import { getRpcUrl } from '../config';
import { decodeLogs, type RawLog, type DecodedEvent } from './decoder';
import { enrichEvents, type EnrichedTransaction } from './enricher';
import { ALL_TOPIC0S, EVENT_SIGNATURES, KNOWN_CONTRACTS } from './signatures';

// Re-export everything for consumers
export { decodeLogs, type DecodedEvent, type RawLog } from './decoder';
export { enrichEvents, resolveTokenMetadataBatch, resolvePoolMetadata, resolveV4PoolId, type EnrichedTransaction, type TokenInfo, type PoolInfo } from './enricher';
export { EVENT_SIGNATURES, KNOWN_CONTRACTS, TOPIC_TO_EVENT, ALL_TOPIC0S } from './signatures';

// Map chain names to viem chain objects
const VIEM_CHAINS: Record<string, Chain> = {
  base,
  ethereum: mainnet,
};

// Chunk size for getLogs — fits Alchemy free tier (max 10 blocks inclusive per call)
const CHUNK_SIZE = 9n;
// Default scan range: ~2000 blocks (~1 hour on Base at 2s/block)
const DEFAULT_SCAN_RANGE = 2000n;
// Max chunks to scan before giving up (2000 / 10 = 200 chunks × 3 calls = 600 RPC calls max)
const MAX_CHUNKS = 200;

export interface FetchEventsOptions {
  address: string;
  chain?: string;
  fromBlock?: bigint;
  toBlock?: bigint;
  limit?: number;
  /** Filter by event type names (e.g. ['transfer', 'swap_v2']) */
  types?: string[];
  /** When set, query logs emitted BY this token contract (address field) instead of topic-based wallet matching */
  tokenAddress?: string;
}

export interface FetchEventsResult {
  transactions: EnrichedTransaction[];
  blockRange: { from: string; to: string };
  total: number;
}

/** Pad a 20-byte address to 32-byte topic */
function padAddress(addr: string): `0x${string}` {
  return ('0x' + addr.toLowerCase().replace('0x', '').padStart(64, '0')) as `0x${string}`;
}

/**
 * Raw eth_getLogs call — bypasses viem's getLogs which silently ignores the `topics` parameter.
 * viem's getLogs only supports ABI-based event/events params for topic filtering;
 * raw topics arrays are discarded. This function calls eth_getLogs directly via client.request()
 * so we have full control over topic filtering.
 */
async function rawGetLogs(
  client: ReturnType<typeof createPublicClient>,
  params: {
    address?: string;
    topics?: (string | string[] | null)[];
    fromBlock: bigint;
    toBlock: bigint;
  },
): Promise<RawLog[]> {
  const rpcParams: Record<string, unknown> = {
    fromBlock: numberToHex(params.fromBlock),
    toBlock: numberToHex(params.toBlock),
  };
  if (params.address) rpcParams.address = params.address;
  if (params.topics) rpcParams.topics = params.topics;

  const logs: any[] = await (client as any).request({
    method: 'eth_getLogs',
    params: [rpcParams],
  });

  return logs.map(log => ({
    address: log.address,
    topics: log.topics as string[],
    data: log.data,
    transactionHash: log.transactionHash,
    logIndex: typeof log.logIndex === 'number' ? log.logIndex : parseInt(log.logIndex, 16),
    blockNumber: typeof log.blockNumber === 'bigint' ? log.blockNumber : BigInt(log.blockNumber),
  }));
}

/** Map type names to topic0 hashes for filtering */
function getTopicsForTypes(types?: string[]): `0x${string}`[] {
  if (!types || types.length === 0) return ALL_TOPIC0S as unknown as `0x${string}`[];

  const topicMap: Record<string, string[]> = {
    transfer: [EVENT_SIGNATURES.TRANSFER],
    approval: [EVENT_SIGNATURES.APPROVAL],
    swap: [EVENT_SIGNATURES.SWAP_V2, EVENT_SIGNATURES.SWAP_V3, EVENT_SIGNATURES.SWAP_V4],
    swap_v2: [EVENT_SIGNATURES.SWAP_V2],
    swap_v3: [EVENT_SIGNATURES.SWAP_V3],
    swap_v4: [EVENT_SIGNATURES.SWAP_V4],
    wrap: [EVENT_SIGNATURES.WETH_DEPOSIT, EVENT_SIGNATURES.WETH_WITHDRAWAL],
  };

  const topics = new Set<string>();
  for (const t of types) {
    const mapped = topicMap[t.toLowerCase()];
    if (mapped) mapped.forEach(h => topics.add(h));
  }

  // V4 Swap events don't contain the wallet address in topics, so they're
  // discovered via correlation with orphan Transfer events. When swap types
  // are requested, also fetch Transfers so V4 correlation has material.
  const hasSwapType = types.some(t => {
    const lower = t.toLowerCase();
    return lower === 'swap' || lower === 'swap_v4';
  });
  if (hasSwapType) {
    topics.add(EVENT_SIGNATURES.TRANSFER);
  }

  return topics.size > 0
    ? ([...topics] as `0x${string}`[])
    : (ALL_TOPIC0S as unknown as `0x${string}`[]);
}

/** Fetch logs for a single chunk (3 parallel calls: sender, recipient, WETH) */
async function fetchLogsForChunk(
  client: ReturnType<typeof createPublicClient>,
  topicFilter: `0x${string}`[],
  paddedAddr: `0x${string}`,
  chunkFrom: bigint,
  chunkTo: bigint,
): Promise<RawLog[]> {
  const wethTopics = [
    EVENT_SIGNATURES.WETH_DEPOSIT,
    EVENT_SIGNATURES.WETH_WITHDRAWAL,
  ] as `0x${string}`[];

  const [logs1, logs2, logsWeth] = await Promise.all([
    rawGetLogs(client, { topics: [topicFilter, paddedAddr], fromBlock: chunkFrom, toBlock: chunkTo }),
    rawGetLogs(client, { topics: [topicFilter, null, paddedAddr], fromBlock: chunkFrom, toBlock: chunkTo }),
    rawGetLogs(client, { topics: [wethTopics, paddedAddr], fromBlock: chunkFrom, toBlock: chunkTo }),
  ]);

  const seen = new Set<string>();
  const result: RawLog[] = [];

  for (const logSet of [logs1, logs2, logsWeth]) {
    for (const log of logSet) {
      const key = `${log.transactionHash}:${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(log);
    }
  }

  return result;
}

/** Fetch logs emitted BY a specific token contract (uses viem's address filter instead of topic positions) */
async function fetchLogsForToken(
  client: ReturnType<typeof createPublicClient>,
  topicFilter: `0x${string}`[],
  tokenAddress: string,
  chunkFrom: bigint,
  chunkTo: bigint,
): Promise<RawLog[]> {
  return rawGetLogs(client, {
    address: tokenAddress.toLowerCase(),
    topics: [topicFilter],
    fromBlock: chunkFrom,
    toBlock: chunkTo,
  });
}

/**
 * Post-processing: find V4 Swap events for wallet transactions.
 * V4 Swap topics don't contain the wallet address (topic1 = poolId, topic2 = Universal Router),
 * so we correlate via shared txHash with the wallet's Transfer events.
 */
async function fetchV4SwapsForTransactions(
  client: ReturnType<typeof createPublicClient>,
  decoded: DecodedEvent[],
  address: string,
  chain: string,
): Promise<RawLog[]> {
  const v4PoolManager = KNOWN_CONTRACTS[chain]?.v4PoolManager;
  if (!v4PoolManager) return [];

  const addr = address.toLowerCase();

  // Collect txHashes that already have a swap event
  const txHashesWithSwap = new Set<string>();
  for (const ev of decoded) {
    if (ev.type === 'swap_v2' || ev.type === 'swap_v3' || ev.type === 'swap_v4') {
      txHashesWithSwap.add(ev.txHash);
    }
  }

  // Find "orphan" transfers: Transfer events involving the wallet that have no swap in the same tx
  const orphanBlocks = new Map<string, bigint>(); // txHash -> blockNumber
  for (const ev of decoded) {
    if (ev.type !== 'transfer') continue;
    if (txHashesWithSwap.has(ev.txHash)) continue;
    const from = (ev.params.from as string).toLowerCase();
    const to = (ev.params.to as string).toLowerCase();
    if (from === addr || to === addr) {
      orphanBlocks.set(ev.txHash, ev.blockNumber);
    }
  }

  if (orphanBlocks.size === 0) return [];

  // Get unique block numbers to query
  const uniqueBlocks = [...new Set(orphanBlocks.values())];
  const orphanTxHashes = new Set(orphanBlocks.keys());

  // Query PoolManager for V4 Swap events at those blocks (batched 5 at a time)
  const v4SwapTopic = EVENT_SIGNATURES.SWAP_V4 as `0x${string}`;
  const allV4Logs: RawLog[] = [];

  for (let i = 0; i < uniqueBlocks.length; i += 5) {
    const batch = uniqueBlocks.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(blockNum =>
        rawGetLogs(client, {
          address: v4PoolManager,
          topics: [v4SwapTopic],
          fromBlock: blockNum,
          toBlock: blockNum,
        }).catch(() => []),
      ),
    );

    for (const logs of results) {
      for (const log of logs) {
        // Only include V4 Swap logs that share a txHash with an orphan transfer
        if (orphanTxHashes.has(log.transactionHash)) {
          allV4Logs.push({
            address: log.address,
            topics: log.topics as string[],
            data: log.data,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
            blockNumber: log.blockNumber,
          });
        }
      }
    }
  }

  return allV4Logs;
}

/**
 * Fetch, decode, and enrich on-chain events for an address.
 * Scans backwards in CHUNK_SIZE-block chunks to stay within RPC limits.
 */
export async function fetchAndDecodeEvents(opts: FetchEventsOptions): Promise<FetchEventsResult> {
  const {
    address,
    chain = 'base',
    limit = 20,
    types,
    tokenAddress,
  } = opts;

  const rpcUrl = await getRpcUrl(chain);
  const viemChain = VIEM_CHAINS[chain];
  const client = createPublicClient({
    chain: viemChain,
    transport: http(rpcUrl),
  });

  const latestBlock = await client.getBlockNumber();
  const toBlock = opts.toBlock ?? latestBlock;
  const fromBlock = opts.fromBlock ?? (toBlock > DEFAULT_SCAN_RANGE ? toBlock - DEFAULT_SCAN_RANGE : 0n);

  const paddedAddr = padAddress(address);
  const topicFilter = getTopicsForTypes(types);

  // Scan backwards in chunks, collecting logs until we have enough
  const allLogs: RawLog[] = [];
  const seenGlobal = new Set<string>();
  let chunksScanned = 0;
  let chunkEnd = toBlock;

  while (chunkEnd > fromBlock && chunksScanned < MAX_CHUNKS) {
    const chunkStart = chunkEnd - CHUNK_SIZE > fromBlock ? chunkEnd - CHUNK_SIZE : fromBlock;

    // Token mode: query logs emitted BY the token contract
    // Wallet mode: query logs with wallet address in topic positions
    const chunkLogs = tokenAddress
      ? await fetchLogsForToken(client, topicFilter, tokenAddress, chunkStart, chunkEnd)
      : await fetchLogsForChunk(client, topicFilter, paddedAddr, chunkStart, chunkEnd);

    for (const log of chunkLogs) {
      const key = `${log.transactionHash}:${log.logIndex}`;
      if (!seenGlobal.has(key)) {
        seenGlobal.add(key);
        allLogs.push(log);
      }
    }

    chunksScanned++;
    chunkEnd = chunkStart > 0n ? chunkStart - 1n : 0n;

    // Early exit once we have enough logs
    if (allLogs.length >= limit) break;
  }

  // Sort by block desc, then logIndex desc
  allLogs.sort((a, b) => {
    const blockCmp = Number(b.blockNumber - a.blockNumber);
    if (blockCmp !== 0) return blockCmp;
    return b.logIndex - a.logIndex;
  });

  const total = allLogs.length;
  const limited = allLogs.slice(0, limit);

  // Decode
  let decoded = decodeLogs(limited);

  // V4 swap correlation: for wallet-level queries (not token queries),
  // find V4 Swap events that share a txHash with orphan transfers
  if (!tokenAddress && decoded.length > 0) {
    const v4Logs = await fetchV4SwapsForTransactions(client, decoded, address, chain);
    if (v4Logs.length > 0) {
      const v4Decoded = decodeLogs(v4Logs);
      decoded = [...decoded, ...v4Decoded];
      // Re-sort after merging
      decoded.sort((a, b) => {
        const blockCmp = Number(b.blockNumber - a.blockNumber);
        if (blockCmp !== 0) return blockCmp;
        return b.logIndex - a.logIndex;
      });
    }
  }

  // Enrich
  const transactions = await enrichEvents(decoded, address, chain);

  // Fetch block timestamps (batch unique blocks, max 10 at a time)
  const allBlockNumbers = decoded.map(d => d.blockNumber);
  const uniqueBlocks = [...new Set(allBlockNumbers)];
  const timestampMap = new Map<string, number>();

  for (let i = 0; i < uniqueBlocks.length; i += 10) {
    const batch = uniqueBlocks.slice(i, i + 10);
    const blocks = await Promise.all(
      batch.map(bn => client.getBlock({ blockNumber: bn }).catch(() => null)),
    );
    for (const block of blocks) {
      if (block) {
        timestampMap.set(block.number.toString(), Number(block.timestamp));
      }
    }
  }

  // Attach timestamps
  for (const tx of transactions) {
    const ts = timestampMap.get(tx.blockNumber);
    if (ts) tx.timestamp = ts;
  }

  // Post-filter by requested types (the topic filter may include extra event types
  // for V4 correlation — e.g. Transfer events fetched alongside swap types)
  let filtered = transactions;
  if (types && types.length > 0) {
    const requested = new Set(types.map(t => t.toLowerCase()));
    filtered = transactions.filter(tx => {
      const t = tx.type;
      if (requested.has(t)) return true;
      // 'swap' matches all enriched swap variants (swap, swap_v2, swap_v3, swap_v4)
      if (requested.has('swap') && (t === 'swap' || t === 'swap_v2' || t === 'swap_v3' || t === 'swap_v4')) return true;
      // 'wrap' matches both wrap and unwrap
      if (requested.has('wrap') && (t === 'wrap' || t === 'unwrap')) return true;
      return false;
    });
  }

  return {
    transactions: filtered,
    blockRange: { from: fromBlock.toString(), to: toBlock.toString() },
    total,
  };
}
