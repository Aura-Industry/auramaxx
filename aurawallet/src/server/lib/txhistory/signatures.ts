/**
 * Event Signature Constants
 * =========================
 * Pre-computed keccak256 topic0 hashes for common EVM events.
 * Used by the log decoder and on-chain transaction history fetcher.
 */

// keccak256 of event signatures → topic0 hashes
export const EVENT_SIGNATURES = {
  // ERC-20 / ERC-721
  TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Transfer(address,address,uint256)
  APPROVAL: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925', // Approval(address,address,uint256)

  // Uniswap V2
  SWAP_V2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822', // Swap(address,uint256,uint256,uint256,uint256,address)

  // Uniswap V3
  SWAP_V3: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', // Swap(address,address,int256,int256,uint160,uint128,int24)

  // Uniswap V4
  SWAP_V4: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', // Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)

  // Uniswap V4 Initialize
  INITIALIZE_V4: '0x803151a295203f64f7e2ca2db584660e99eaf67eca6f05af1bf0707e7d38f2cf', // Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)

  // WETH
  WETH_DEPOSIT: '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c', // Deposit(address,uint256)
  WETH_WITHDRAWAL: '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65', // Withdrawal(address,uint256)
} as const;

// All topic0 values for getLogs queries
export const ALL_TOPIC0S = Object.values(EVENT_SIGNATURES);

// Known contract addresses per chain
export const KNOWN_CONTRACTS: Record<string, {
  weth: string;
  v2Factory?: string;
  v3Factory?: string;
  v4PoolManager?: string;
}> = {
  base: {
    weth: '0x4200000000000000000000000000000000000006',
    v2Factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
    v3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    v4PoolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  },
  ethereum: {
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    v2Factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    v4PoolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
  },
};

// Reverse lookup: topic0 → event key name
export const TOPIC_TO_EVENT: Record<string, keyof typeof EVENT_SIGNATURES> = {};
for (const [key, hash] of Object.entries(EVENT_SIGNATURES)) {
  TOPIC_TO_EVENT[hash] = key as keyof typeof EVENT_SIGNATURES;
}
