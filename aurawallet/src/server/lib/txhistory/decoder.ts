/**
 * Log Decoder
 * ===========
 * Decodes raw EVM logs into structured DecodedEvent objects.
 * Handles Transfer (ERC-20/721), Swap (V2/V3/V4), WETH Deposit/Withdrawal, Approval.
 */

import { decodeAbiParameters } from 'viem';
import { EVENT_SIGNATURES, TOPIC_TO_EVENT } from './signatures';

// --- Types ---

export interface DecodedEvent {
  type: string; // 'transfer' | 'approval' | 'swap_v2' | 'swap_v3' | 'swap_v4' | 'weth_deposit' | 'weth_withdrawal' | 'unknown'
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  contractAddress: string;
  params: Record<string, unknown>;
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: bigint;
}

// --- Helpers ---

/** Extract a 20-byte address from a 32-byte topic */
export function extractAddress(topic: string): string {
  return '0x' + topic.slice(26).toLowerCase();
}

// --- Decoder ---

function decodeTransfer(log: RawLog): DecodedEvent {
  const isERC721 = log.topics.length === 4; // ERC-721: 3 indexed (from, to, tokenId)
  const from = extractAddress(log.topics[1]);
  const to = extractAddress(log.topics[2]);

  if (isERC721) {
    const tokenId = BigInt(log.topics[3]);
    return {
      type: 'transfer_nft',
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      contractAddress: log.address.toLowerCase(),
      params: { from, to, tokenId },
    };
  }

  // ERC-20: 2 indexed (from, to), 1 non-indexed (amount)
  const [amount] = decodeAbiParameters(
    [{ name: 'amount', type: 'uint256' }],
    log.data as `0x${string}`,
  );
  return {
    type: 'transfer',
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    contractAddress: log.address.toLowerCase(),
    params: { from, to, amount },
  };
}

function decodeApproval(log: RawLog): DecodedEvent {
  const owner = extractAddress(log.topics[1]);
  const spender = extractAddress(log.topics[2]);

  // ERC-721 Approval has tokenId indexed (4 topics, no/empty data)
  if (log.topics.length === 4) {
    const tokenId = BigInt(log.topics[3]);
    return {
      type: 'approval_nft',
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      contractAddress: log.address.toLowerCase(),
      params: { owner, spender, tokenId },
    };
  }

  // ERC-20 Approval: amount in data
  const [amount] = decodeAbiParameters(
    [{ name: 'amount', type: 'uint256' }],
    log.data as `0x${string}`,
  );
  return {
    type: 'approval',
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    contractAddress: log.address.toLowerCase(),
    params: { owner, spender, amount },
  };
}

function decodeSwapV2(log: RawLog): DecodedEvent {
  const sender = extractAddress(log.topics[1]);
  const to = extractAddress(log.topics[2]);
  const [amount0In, amount1In, amount0Out, amount1Out] = decodeAbiParameters(
    [
      { name: 'amount0In', type: 'uint256' },
      { name: 'amount1In', type: 'uint256' },
      { name: 'amount0Out', type: 'uint256' },
      { name: 'amount1Out', type: 'uint256' },
    ],
    log.data as `0x${string}`,
  );
  return {
    type: 'swap_v2',
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    contractAddress: log.address.toLowerCase(),
    params: { sender, to, amount0In, amount1In, amount0Out, amount1Out },
  };
}

function decodeSwapV3(log: RawLog): DecodedEvent {
  const sender = extractAddress(log.topics[1]);
  const recipient = extractAddress(log.topics[2]);
  const [amount0, amount1, sqrtPriceX96, liquidity, tick] = decodeAbiParameters(
    [
      { name: 'amount0', type: 'int256' },
      { name: 'amount1', type: 'int256' },
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'tick', type: 'int24' },
    ],
    log.data as `0x${string}`,
  );
  return {
    type: 'swap_v3',
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    contractAddress: log.address.toLowerCase(),
    params: { sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick },
  };
}

function decodeSwapV4(log: RawLog): DecodedEvent {
  const poolId = log.topics[1];
  const sender = extractAddress(log.topics[2]);
  const [amount0, amount1, sqrtPriceX96, liquidity, tick, fee] = decodeAbiParameters(
    [
      { name: 'amount0', type: 'int128' },
      { name: 'amount1', type: 'int128' },
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'tick', type: 'int24' },
      { name: 'fee', type: 'uint24' },
    ],
    log.data as `0x${string}`,
  );
  return {
    type: 'swap_v4',
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    contractAddress: log.address.toLowerCase(),
    params: { poolId, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee },
  };
}

function decodeWethDeposit(log: RawLog): DecodedEvent {
  const dst = extractAddress(log.topics[1]);
  const [wad] = decodeAbiParameters(
    [{ name: 'wad', type: 'uint256' }],
    log.data as `0x${string}`,
  );
  return {
    type: 'weth_deposit',
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    contractAddress: log.address.toLowerCase(),
    params: { dst, wad },
  };
}

function decodeWethWithdrawal(log: RawLog): DecodedEvent {
  const src = extractAddress(log.topics[1]);
  const [wad] = decodeAbiParameters(
    [{ name: 'wad', type: 'uint256' }],
    log.data as `0x${string}`,
  );
  return {
    type: 'weth_withdrawal',
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    contractAddress: log.address.toLowerCase(),
    params: { src, wad },
  };
}

/** Decode a batch of raw logs into structured events */
export function decodeLogs(logs: RawLog[]): DecodedEvent[] {
  const decoded: DecodedEvent[] = [];

  for (const log of logs) {
    if (!log.topics || log.topics.length === 0) continue;

    const topic0 = log.topics[0];
    const eventKey = TOPIC_TO_EVENT[topic0];

    try {
      switch (eventKey) {
        case 'TRANSFER':
          decoded.push(decodeTransfer(log));
          break;
        case 'APPROVAL':
          decoded.push(decodeApproval(log));
          break;
        case 'SWAP_V2':
          decoded.push(decodeSwapV2(log));
          break;
        case 'SWAP_V3':
          decoded.push(decodeSwapV3(log));
          break;
        case 'SWAP_V4':
          decoded.push(decodeSwapV4(log));
          break;
        case 'WETH_DEPOSIT':
          decoded.push(decodeWethDeposit(log));
          break;
        case 'WETH_WITHDRAWAL':
          decoded.push(decodeWethWithdrawal(log));
          break;
        default:
          decoded.push({
            type: 'unknown',
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            blockNumber: log.blockNumber,
            contractAddress: log.address.toLowerCase(),
            params: { topic0 },
          });
      }
    } catch {
      // Malformed log data — skip
      decoded.push({
        type: 'unknown',
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        contractAddress: log.address.toLowerCase(),
        params: { topic0, error: 'decode_failed' },
      });
    }
  }

  return decoded;
}
