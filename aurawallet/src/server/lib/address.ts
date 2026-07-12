/**
 * Address normalization utilities for multi-chain support.
 * EVM addresses are case-insensitive (lowercase), Solana addresses are case-sensitive (base58).
 */

// Native token addresses by chain type
export const NATIVE_ADDRESSES = {
  ETH: '0x0000000000000000000000000000000000000000',
  SOL: 'So11111111111111111111111111111111111111112',
} as const;

/**
 * Check if a chain identifier refers to a Solana chain.
 */
export function isSolanaChain(chain: string): boolean {
  return chain === 'solana' || chain === 'solana-devnet';
}

/**
 * Normalize an address for the given chain.
 * EVM: lowercase (case-insensitive)
 * Solana: no-op (base58 is case-sensitive)
 */
export function normalizeAddress(addr: string, chain?: string): string {
  if (chain && isSolanaChain(chain)) {
    return addr; // base58 is case-sensitive
  }
  return addr.toLowerCase();
}

/**
 * Get the native token address for a chain.
 */
export function getNativeAddress(chain: string): string {
  if (isSolanaChain(chain)) {
    return NATIVE_ADDRESSES.SOL;
  }
  return NATIVE_ADDRESSES.ETH;
}

/**
 * Get the native currency symbol for a chain.
 */
export function getNativeCurrency(chain: string): string {
  if (isSolanaChain(chain)) {
    return 'SOL';
  }
  return 'ETH';
}
