/**
 * Batch RPC helper for fetching token balances and prices
 * Minimizes RPC calls by batching all requests together
 */

import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';

export interface TokenData {
  balance: string;           // Formatted balance with decimals
  balanceRaw: string;        // Raw balance in smallest unit
  priceInEth: number | null; // Price in ETH (null if no pool)
}

export interface AssetInfo {
  tokenAddress: string;
  decimals: number;
  poolAddress?: string | null;
  poolVersion?: string | null;
}

// ABI fragments for encoding/decoding
const BALANCE_OF_SELECTOR = '0x70a08231'; // balanceOf(address)
const GET_RESERVES_SELECTOR = '0x0902f1ac'; // getReserves() for V2
const SLOT0_SELECTOR = '0x3850c7bd'; // slot0() for V3
const TOKEN0_SELECTOR = '0x0dfe1681'; // token0() for determining price direction

/**
 * Encode balanceOf(address) call
 */
function encodeBalanceOf(walletAddress: string): string {
  const addressParam = ethers.zeroPadValue(walletAddress, 32).slice(2);
  return BALANCE_OF_SELECTOR + addressParam;
}

/**
 * Encode getReserves() call for V2 pools
 */
function encodeGetReserves(): string {
  return GET_RESERVES_SELECTOR;
}

/**
 * Encode slot0() call for V3 pools
 */
function encodeSlot0(): string {
  return SLOT0_SELECTOR;
}

/**
 * Encode token0() call
 */
function encodeToken0(): string {
  return TOKEN0_SELECTOR;
}

/**
 * Execute batch JSON-RPC calls
 */
async function batchRpcCall(
  rpcUrl: string,
  calls: { to: string; data: string }[]
): Promise<(string | null)[]> {
  if (calls.length === 0) return [];

  const batch = calls.map((call, i) => ({
    jsonrpc: '2.0',
    id: i,
    method: 'eth_call',
    params: [{ to: call.to, data: call.data }, 'latest']
  }));

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch)
    });

    const results = await res.json();

    // Sort by id and extract results, handling errors
    return results
      .sort((a: { id: number }, b: { id: number }) => a.id - b.id)
      .map((r: { result?: string; error?: unknown }) => r.result || null);
  } catch (err) {
    console.error('[tokenData] Batch RPC failed:', err);
    return calls.map(() => null);
  }
}

/**
 * Parse V2 reserves to get price
 * Returns price of token in ETH
 */
function parseV2Price(
  reservesData: string | null,
  tokenIsToken0: boolean
): number | null {
  if (!reservesData || reservesData === '0x') return null;

  try {
    // getReserves() returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)
    const reserve0 = BigInt('0x' + reservesData.slice(2, 66));
    const reserve1 = BigInt('0x' + reservesData.slice(66, 130));

    if (reserve0 === BigInt(0) || reserve1 === BigInt(0)) return null;

    // Calculate price based on which token is token0
    // If our token is token0, price = reserve1/reserve0 (ETH per token)
    // If our token is token1, price = reserve0/reserve1
    if (tokenIsToken0) {
      return Number(reserve1) / Number(reserve0);
    } else {
      return Number(reserve0) / Number(reserve1);
    }
  } catch {
    return null;
  }
}

/**
 * Parse V3 slot0 to get price
 * Returns price of token in ETH
 */
function parseV3Price(
  slot0Data: string | null,
  tokenIsToken0: boolean
): number | null {
  if (!slot0Data || slot0Data === '0x') return null;

  try {
    // slot0() returns (sqrtPriceX96, tick, observationIndex, ...)
    // sqrtPriceX96 is the first 32 bytes
    const sqrtPriceX96 = BigInt('0x' + slot0Data.slice(2, 66));

    if (sqrtPriceX96 === BigInt(0)) return null;

    // Convert sqrtPriceX96 to price
    // price = (sqrtPriceX96 / 2^96)^2
    const Q96 = BigInt(2) ** BigInt(96);
    const priceRatio = Number(sqrtPriceX96) / Number(Q96);
    const price = priceRatio * priceRatio;

    // If token is token0, this gives us token1/token0 (ETH per token if ETH is token1)
    // If token is token1, we need to invert
    if (tokenIsToken0) {
      return price;
    } else {
      return price > 0 ? 1 / price : null;
    }
  } catch {
    return null;
  }
}

/**
 * Batch fetch balances AND prices for multiple tokens
 * Returns a Map of tokenAddress (lowercase) to TokenData
 */
export async function fetchTokenData(
  walletAddress: string,
  assets: AssetInfo[],
  rpcUrl: string
): Promise<Map<string, TokenData>> {
  const result = new Map<string, TokenData>();

  if (assets.length === 0) return result;

  // Build all RPC calls
  const calls: { to: string; data: string; type: 'balance' | 'reserves' | 'slot0' | 'token0'; assetIndex: number }[] = [];

  // Add balance calls for all tokens
  for (let i = 0; i < assets.length; i++) {
    calls.push({
      to: assets[i].tokenAddress,
      data: encodeBalanceOf(walletAddress),
      type: 'balance',
      assetIndex: i
    });
  }

  // Add price calls for assets with pools
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    if (!asset.poolAddress) continue;

    if (asset.poolVersion === 'v2') {
      calls.push({
        to: asset.poolAddress,
        data: encodeGetReserves(),
        type: 'reserves',
        assetIndex: i
      });
      // Also need token0 to determine price direction
      calls.push({
        to: asset.poolAddress,
        data: encodeToken0(),
        type: 'token0',
        assetIndex: i
      });
    } else if (asset.poolVersion === 'v3' || asset.poolVersion === 'v4') {
      calls.push({
        to: asset.poolAddress,
        data: encodeSlot0(),
        type: 'slot0',
        assetIndex: i
      });
      // Also need token0 to determine price direction
      calls.push({
        to: asset.poolAddress,
        data: encodeToken0(),
        type: 'token0',
        assetIndex: i
      });
    }
  }

  // Execute batch RPC
  const rpcCalls = calls.map(c => ({ to: c.to, data: c.data }));
  const responses = await batchRpcCall(rpcUrl, rpcCalls);

  // Parse results
  // First, organize results by asset and type
  const balances: (string | null)[] = new Array(assets.length).fill(null);
  const priceData: { reserves?: string | null; slot0?: string | null; token0?: string | null }[] =
    assets.map(() => ({}));

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const response = responses[i];

    switch (call.type) {
      case 'balance':
        balances[call.assetIndex] = response;
        break;
      case 'reserves':
        priceData[call.assetIndex].reserves = response;
        break;
      case 'slot0':
        priceData[call.assetIndex].slot0 = response;
        break;
      case 'token0':
        priceData[call.assetIndex].token0 = response;
        break;
    }
  }

  // Build result map
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const balanceRaw = balances[i];

    // Parse balance
    let balance = '0';
    let balanceRawStr = '0';
    if (balanceRaw && balanceRaw !== '0x') {
      try {
        const balanceBigInt = BigInt(balanceRaw);
        balanceRawStr = balanceBigInt.toString();
        balance = ethers.formatUnits(balanceBigInt, asset.decimals);
      } catch {
        // Keep defaults
      }
    }

    // Parse price
    let priceInEth: number | null = null;
    const pd = priceData[i];

    if (pd.token0) {
      // Determine if our token is token0
      let tokenIsToken0 = false;
      try {
        const token0Address = '0x' + pd.token0.slice(26).toLowerCase();
        tokenIsToken0 = token0Address === asset.tokenAddress.toLowerCase();
      } catch {
        // Assume false
      }

      if (asset.poolVersion === 'v2' && pd.reserves) {
        priceInEth = parseV2Price(pd.reserves, tokenIsToken0);
      } else if ((asset.poolVersion === 'v3' || asset.poolVersion === 'v4') && pd.slot0) {
        priceInEth = parseV3Price(pd.slot0, tokenIsToken0);
      }
    }

    result.set(asset.tokenAddress.toLowerCase(), {
      balance,
      balanceRaw: balanceRawStr,
      priceInEth
    });
  }

  return result;
}

/**
 * Calculate USD value for a token
 */
export function calculateUsdValue(
  balance: string,
  priceInEth: number | null,
  ethPrice: number | null
): number | null {
  if (priceInEth === null || ethPrice === null) return null;

  const balanceNum = parseFloat(balance);
  if (isNaN(balanceNum) || balanceNum === 0) return null;

  return balanceNum * priceInEth * ethPrice;
}

/**
 * Format USD value for display
 */
export function formatUsdValue(usdValue: number | null): string {
  if (usdValue === null) return '';
  if (usdValue < 0.01) return '<$0.01';
  if (usdValue < 1) return `$${usdValue.toFixed(2)}`;
  if (usdValue < 1000) return `$${usdValue.toFixed(2)}`;
  if (usdValue < 10000) return `$${usdValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${usdValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// SPL Token Program ID
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/**
 * Fetch SPL token balances for Solana wallets.
 * Uses getParsedTokenAccountsByOwner for a single batched RPC call.
 * Returns Map keyed by mint address (case-sensitive base58).
 */
export async function fetchSolanaTokenData(
  walletAddress: string,
  assets: AssetInfo[],
  rpcUrl: string
): Promise<Map<string, TokenData>> {
  const result = new Map<string, TokenData>();
  if (assets.length === 0) return result;

  try {
    const connection = new Connection(rpcUrl, 'confirmed');
    const ownerPubkey = new PublicKey(walletAddress);

    const response = await connection.getParsedTokenAccountsByOwner(ownerPubkey, {
      programId: SPL_TOKEN_PROGRAM_ID,
    });

    // Build mint → balance map from all token accounts
    const balanceByMint = new Map<string, { amount: string; uiAmount: string }>();
    for (const { account } of response.value) {
      const parsed = account.data.parsed;
      if (parsed?.info?.mint) {
        balanceByMint.set(parsed.info.mint, {
          amount: parsed.info.tokenAmount.amount,
          uiAmount: parsed.info.tokenAmount.uiAmountString || '0',
        });
      }
    }

    for (const asset of assets) {
      const tokenBalance = balanceByMint.get(asset.tokenAddress);
      result.set(asset.tokenAddress, {
        balance: tokenBalance?.uiAmount || '0',
        balanceRaw: tokenBalance?.amount || '0',
        priceInEth: null, // Solana on-chain pricing would need Jupiter API
      });
    }
  } catch (err) {
    console.error('[tokenData] Solana token fetch failed:', err);
    for (const asset of assets) {
      result.set(asset.tokenAddress, { balance: '0', balanceRaw: '0', priceInEth: null });
    }
  }

  return result;
}
