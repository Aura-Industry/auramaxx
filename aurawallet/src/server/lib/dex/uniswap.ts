import { ethers } from 'ethers';
import { DexAdapter, PoolInfo, SwapParams, SwapTxData, PoolKey } from './types';
import SwapHelperABI from '../../abi/SwapHelper.json';

// Constants
export const SWAP_HELPER = '0xD28f98c89d6F88762377b400936b434731c8a61F'; // SwapHelperV2 (Universal Router)
export const WETH = '0x4200000000000000000000000000000000000006';

// Uniswap Factory addresses on Base
const V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const V2_FACTORY = '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6';

// V4 PoolManager address fallback (query from SwapHelper.POOL_MANAGER() at runtime)
const V4_POOL_MANAGER_FALLBACK = '0x6Ab04E3376fB1d12cC0b27E6F2E7485CC8bFCb53';

// Initialize event topic for V4 PoolManager
const INITIALIZE_EVENT_TOPIC = '0x803151a295203f64f7e2ca2db584660e99eaf67eca6f05af1bf0707e7d38f2cf';

// V3 fee tiers to check (ordered by likelihood)
const V3_FEE_TIERS = [3000, 10000, 500] as const;

// Known V4 hooks (Base mainnet)
export const V4_HOOKS: Record<string, string> = {
  clanker: '0x1F98400000000000000000000000000000000004',
  'clanker-dynamic-fee-v2': '0xd60D6B218116cFd801E28F78d011a203D2b068Cc',
  'clanker-static-fee-v2': '0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC',
  'clanker-4.0-a': '0x34a45c6B61876d739400Bd71228CbcbD4F53E8cC',
  'clanker-4.0-b': '0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC',
  zora: '0xe2B4100DE1CD284Bd364f738d1354715515C90C0',
  // doppler: per-token hooks, must provide poolKey manually
};

// Minimal V3 Factory ABI
const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
];

// Minimal V2 Factory ABI
const V2_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address pair)'
];

// DYNAMIC_FEE_FLAG from Uniswap V4 LPFeeLibrary
const DYNAMIC_FEE_FLAG = 0x800000;

// Standard V4 pool params for known hooks
const V4_POOL_PARAMS: Record<string, { fee: number; tickSpacing: number }> = {
  clanker: { fee: 10000, tickSpacing: 200 },  // 1% (legacy)
  'clanker-dynamic-fee-v2': { fee: DYNAMIC_FEE_FLAG, tickSpacing: 200 },  // v4.1.0
  'clanker-static-fee-v2': { fee: DYNAMIC_FEE_FLAG, tickSpacing: 200 },   // v4.1.0
  'clanker-4.0-a': { fee: DYNAMIC_FEE_FLAG, tickSpacing: 200 },  // v4.0.0 dynamic
  'clanker-4.0-b': { fee: DYNAMIC_FEE_FLAG, tickSpacing: 200 },  // v4.0.0 static
  zora: { fee: 10000, tickSpacing: 200 },     // 1%
};

// Common no-hook pool params to try (ordered by likelihood)
const V4_NO_HOOK_PARAMS = [
  { fee: 3000, tickSpacing: 60 },    // 0.3%
  { fee: 10000, tickSpacing: 200 },  // 1%
  { fee: 500, tickSpacing: 10 },     // 0.05%
];

/**
 * Get list of known V4 hook names
 */
export function getKnownV4Hooks(): string[] {
  return Object.keys(V4_HOOKS);
}

/**
 * Get the PoolManager address from SwapHelper contract
 */
async function getPoolManagerAddress(provider: ethers.Provider): Promise<string> {
  const swapHelper = new ethers.Contract(
    SWAP_HELPER,
    ['function POOL_MANAGER() view returns (address)'],
    provider
  );
  try {
    return await swapHelper.POOL_MANAGER();
  } catch {
    return V4_POOL_MANAGER_FALLBACK;
  }
}

/**
 * Build a PoolKey for known V4 hooks or no-hook pools
 *
 * @param token - Token address
 * @param hookName - Hook name ('clanker', 'zora', etc.) or 'none' for no-hook pools
 * @returns PoolKey or null if hook not found
 */
export function getV4PoolKey(token: string, hookName?: string): PoolKey | null {
  if (!hookName) return null;

  const name = hookName.toLowerCase();

  // Handle 'none' - return first no-hook params (caller can iterate if needed)
  if (name === 'none') {
    const params = V4_NO_HOOK_PARAMS[0];
    const [currency0, currency1] = token.toLowerCase() < WETH.toLowerCase()
      ? [token, WETH]
      : [WETH, token];

    return {
      currency0,
      currency1,
      fee: params.fee,
      tickSpacing: params.tickSpacing,
      hooks: ethers.ZeroAddress
    };
  }

  const hookAddress = V4_HOOKS[name];
  const params = V4_POOL_PARAMS[name];

  if (!hookAddress || !params) return null;

  const [currency0, currency1] = token.toLowerCase() < WETH.toLowerCase()
    ? [token, WETH]
    : [WETH, token];

  return {
    currency0,
    currency1,
    fee: params.fee,
    tickSpacing: params.tickSpacing,
    hooks: hookAddress
  };
}

/**
 * Get all possible no-hook PoolKeys for a token
 */
export function getV4NoHookPoolKeys(token: string): PoolKey[] {
  const [currency0, currency1] = token.toLowerCase() < WETH.toLowerCase()
    ? [token, WETH]
    : [WETH, token];

  return V4_NO_HOOK_PARAMS.map(params => ({
    currency0,
    currency1,
    fee: params.fee,
    tickSpacing: params.tickSpacing,
    hooks: ethers.ZeroAddress
  }));
}

/**
 * Detect V4 pool by querying PoolManager Initialize events
 *
 * @param token - Token address to search for
 * @param provider - Ethers provider
 * @returns PoolKey if found, null otherwise
 */
export async function detectV4PoolFromEvents(
  token: string,
  provider: ethers.Provider
): Promise<PoolKey | null> {
  try {
    const poolManager = await getPoolManagerAddress(provider);
    const tokenPadded = ethers.zeroPadValue(token.toLowerCase(), 32);

    // Query with token as currency0
    const logs0 = await provider.getLogs({
      address: poolManager,
      topics: [
        INITIALIZE_EVENT_TOPIC,
        null, // poolId - any
        tokenPadded, // currency0
        null  // currency1 - any
      ],
      fromBlock: 0
    });

    // Query with token as currency1
    const logs1 = await provider.getLogs({
      address: poolManager,
      topics: [
        INITIALIZE_EVENT_TOPIC,
        null,
        null,
        tokenPadded // currency1
      ],
      fromBlock: 0
    });

    const allLogs = [...logs0, ...logs1];
    if (allLogs.length === 0) return null;

    // Parse the first matching event
    const log = allLogs[0];

    // Extract currency0 and currency1 from indexed topics
    const currency0 = ethers.getAddress('0x' + log.topics[2].slice(26));
    const currency1 = ethers.getAddress('0x' + log.topics[3].slice(26));

    // Decode the data field: fee (uint24), tickSpacing (int24), hooks (address), sqrtPriceX96 (uint160), tick (int24)
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ['uint24', 'int24', 'address', 'uint160', 'int24'],
      log.data
    );
    const [fee, tickSpacing, hooks] = decoded;

    return {
      currency0,
      currency1,
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
      hooks
    };
  } catch {
    // RPC errors, parsing errors, etc. - return null
    return null;
  }
}

/**
 * Uniswap adapter for V2/V3/V4 swaps via SwapHelper contract
 */
export const uniswapAdapter: DexAdapter = {
  name: 'uniswap',

  supportsChain(chainId: number): boolean {
    // SwapHelper is deployed on Base
    return chainId === 8453;
  },

  async detectPool(
    token: string,
    provider: ethers.Provider
  ): Promise<PoolInfo | null> {
    // Priority: V4 with known hooks -> V3 -> V2 -> other V4 pools

    // 1. Try V4 with known hooks first
    const v4PoolKey = await detectV4PoolFromEvents(token, provider);
    if (v4PoolKey) {
      // Check if this pool uses a known hook
      const knownHookAddresses = Object.values(V4_HOOKS).map(h => h.toLowerCase());
      const hasKnownHook = v4PoolKey.hooks !== ethers.ZeroAddress &&
        knownHookAddresses.includes(v4PoolKey.hooks.toLowerCase());

      if (hasKnownHook) {
        return { version: 'v4', poolKey: v4PoolKey };
      }
    }

    // 2. Check V3 pools
    const v3Factory = new ethers.Contract(V3_FACTORY, V3_FACTORY_ABI, provider);
    for (const fee of V3_FEE_TIERS) {
      try {
        const pool = await v3Factory.getPool(WETH, token, fee);
        if (pool && pool !== ethers.ZeroAddress) {
          return { version: 'v3', fee, poolAddress: pool };
        }
      } catch {
        // Pool doesn't exist for this fee tier
      }
    }

    // 3. Check V2 pair
    const v2Factory = new ethers.Contract(V2_FACTORY, V2_FACTORY_ABI, provider);
    try {
      const pair = await v2Factory.getPair(WETH, token);
      if (pair && pair !== ethers.ZeroAddress) {
        return { version: 'v2', poolAddress: pair };
      }
    } catch {
      // No V2 pair
    }

    // 4. Return other V4 pool (unknown hooks or no hooks) as fallback
    if (v4PoolKey) {
      return { version: 'v4', poolKey: v4PoolKey };
    }

    return null;
  },

  async buildSwapTx(params: SwapParams): Promise<SwapTxData> {
    const { token, direction, amount, minOut, version, fee, poolKey } = params;

    const swapHelper = new ethers.Interface(SwapHelperABI);

    if (direction === 'buy') {
      return buildBuyTx(swapHelper, token, amount, minOut, version || 'v3', fee, poolKey);
    } else {
      return buildSellTx(swapHelper, token, amount, minOut, version || 'v3', fee, poolKey);
    }
  },

  getRouterAddress(): string {
    return SWAP_HELPER;
  }
};

function buildBuyTx(
  iface: ethers.Interface,
  token: string,
  amount: string,
  minOut: string,
  version: string,
  poolFee?: number,
  poolKey?: PoolKey
): SwapTxData {
  const valueWei = BigInt(amount);
  const minOutBn = BigInt(minOut);

  let data: string;

  if (version === 'v2') {
    data = iface.encodeFunctionData('snipeV2', [token, minOutBn]);
  } else if (version === 'v3') {
    const fee = poolFee || 3000;
    data = iface.encodeFunctionData('snipeV3', [token, fee, minOutBn]);
  } else if (version === 'v4') {
    if (!poolKey) throw new Error('V4 pool key required');
    data = iface.encodeFunctionData('snipeV4', [
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      minOutBn
    ]);
  } else {
    throw new Error(`Invalid Uniswap version: ${version}`);
  }

  return {
    to: SWAP_HELPER,
    data,
    value: valueWei.toString()
  };
}

function buildSellTx(
  iface: ethers.Interface,
  token: string,
  amount: string,
  minOut: string,
  version: string,
  poolFee?: number,
  poolKey?: PoolKey
): SwapTxData {
  const amountIn = BigInt(amount);
  const minOutBn = BigInt(minOut);

  let data: string;

  if (version === 'v2') {
    data = iface.encodeFunctionData('sellV2', [token, amountIn, minOutBn]);
  } else if (version === 'v3') {
    const fee = poolFee || 3000;
    data = iface.encodeFunctionData('sellV3', [token, fee, amountIn, minOutBn]);
  } else if (version === 'v4') {
    if (!poolKey) throw new Error('V4 pool key required');
    data = iface.encodeFunctionData('sellV4', [
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      amountIn,
      minOutBn
    ]);
  } else {
    throw new Error(`Invalid Uniswap version: ${version}`);
  }

  return {
    to: SWAP_HELPER,
    data,
    value: '0'
  };
}

export default uniswapAdapter;
