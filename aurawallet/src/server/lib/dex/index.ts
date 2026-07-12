import { ethers } from 'ethers';
import { DexAdapter, PoolInfo } from './types';
import { uniswapAdapter } from './uniswap';
import { relayAdapter } from './relay';

// Re-export types
export * from './types';

// Registry of available DEX adapters
const adapters: Record<string, DexAdapter> = {
  relay: relayAdapter,
  uniswap: uniswapAdapter,
};

// Default DEX preference order for auto-detection
// Relay is primary (aggregator with MEV protection), Uniswap is fallback
const DEX_PRIORITY = ['relay', 'uniswap'] as const;

/**
 * Get a specific DEX adapter by name
 */
export function getDexAdapter(name: string): DexAdapter | null {
  return adapters[name.toLowerCase()] || null;
}

/**
 * Get all available DEX adapters
 */
export function getAllAdapters(): DexAdapter[] {
  return Object.values(adapters);
}

/**
 * Get adapters that support a specific chain
 */
export function getAdaptersForChain(chainId: number): DexAdapter[] {
  return Object.values(adapters).filter(a => a.supportsChain(chainId));
}

/**
 * Detect the best DEX and pool for a token
 * Returns the first DEX that has liquidity for this token
 */
export async function detectBestDex(
  token: string,
  provider: ethers.Provider,
  chainId: number
): Promise<{ adapter: DexAdapter; pool: PoolInfo } | null> {
  const supportedAdapters = getAdaptersForChain(chainId);

  // Check in priority order
  for (const dexName of DEX_PRIORITY) {
    const adapter = adapters[dexName];
    if (!adapter || !adapter.supportsChain(chainId)) continue;

    const pool = await adapter.detectPool(token, provider);
    if (pool) {
      return { adapter, pool };
    }
  }

  // Check any remaining adapters not in priority list
  for (const adapter of supportedAdapters) {
    if (DEX_PRIORITY.includes(adapter.name as typeof DEX_PRIORITY[number])) continue;

    const pool = await adapter.detectPool(token, provider);
    if (pool) {
      return { adapter, pool };
    }
  }

  return null;
}

/**
 * List available DEX names
 */
export function listDexes(): string[] {
  return Object.keys(adapters);
}
