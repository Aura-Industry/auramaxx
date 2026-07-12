import { ethers } from 'ethers';

// V4 PoolKey type (Uniswap V4 specific, but may be reused)
export interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

// Pool detection result
export interface PoolInfo {
  version: string;       // e.g., "v2", "v3", "v4", "stable", "volatile"
  fee?: number;          // Fee tier if applicable
  poolKey?: PoolKey;     // V4 pool key if applicable
  poolAddress?: string;  // Pool/pair address if known
}

// Swap parameters (DEX-agnostic)
export interface SwapParams {
  token: string;
  direction: 'buy' | 'sell';
  amount: string;        // In wei (EVM) or lamports (Solana)
  minOut: string;
  from: string;          // Sender wallet address
  chainId: number;       // EVM chain ID
  destinationChainId?: number; // Cross-chain destination (defaults to chainId)
  version?: string;      // Pool version override
  fee?: number;          // Fee tier override
  poolKey?: PoolKey;     // V4 pool key override
}

// Transaction data result
export interface SwapTxData {
  to: string;
  data: string;
  value: string;         // In wei
}

// DEX Adapter interface
export interface DexAdapter {
  name: string;

  // Supported on this chain?
  supportsChain(chainId: number): boolean;

  // Detect if a pool exists for this token
  detectPool(
    token: string,
    provider: ethers.Provider
  ): Promise<PoolInfo | null>;

  // Build swap transaction
  buildSwapTx(params: SwapParams): Promise<SwapTxData>;

  // Get the router/helper contract address
  getRouterAddress(): string;
}
