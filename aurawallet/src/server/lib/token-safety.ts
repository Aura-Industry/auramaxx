/**
 * Token safety check via GoPlusLabs.
 *
 * Free API, no key needed. Returns honeypot detection, tax analysis,
 * holder data, LP info, and contract red flags.
 *
 * In-memory cache with 10-minute TTL. No DB writes.
 */

export interface TokenSafetyResult {
  // Token basics
  tokenName: string;
  tokenSymbol: string;
  totalSupply: string;

  // Safety flags
  isHoneypot: boolean;
  isMintable: boolean;
  isOpenSource: boolean;
  isProxy: boolean;
  isBlacklisted: boolean;
  isAntiWhale: boolean;
  hasHiddenOwner: boolean;
  hasExternalCall: boolean;
  hasSelfDestruct: boolean;
  canTakeBackOwnership: boolean;
  transferPausable: boolean;

  // Tax
  buyTax: string;
  sellTax: string;

  // Owner
  ownerAddress: string;
  creatorAddress: string;
  creatorPercent: string;

  // Holders
  holderCount: number;
  holders: TokenHolder[];

  // LP
  lpHolderCount: number;
  lpTotalSupply: string;
  lpHolders: LpHolder[];

  // DEX listing
  dexInfo: DexInfo[];
}

export interface TokenHolder {
  address: string;
  balance: string;
  percent: string;
  isLocked: boolean;
  isContract: boolean;
  tag: string;
}

export interface LpHolder {
  address: string;
  balance: string;
  percent: string;
  isLocked: boolean;
  isContract: boolean;
}

export interface DexInfo {
  name: string;
  liquidity: string;
  pair: string;
}

interface CacheEntry {
  result: TokenSafetyResult;
  fetchedAt: number;
}

const CACHE_TTL_MS = 10 * 60_000; // 10 minutes — safety data changes slowly

const safetyCache = new Map<string, CacheEntry>();

/** Clear cache — exposed for tests */
export function clearTokenSafetyCache(): void {
  safetyCache.clear();
}

// Our chain name → GoPlusLabs chain ID
const GOPLUS_CHAIN_IDS: Record<string, string> = {
  ethereum: '1',
  base: '8453',
  solana: 'solana',
  polygon: '137',
  arbitrum: '42161',
  optimism: '10',
  bsc: '56',
  avalanche: '43114',
};

/**
 * Get token safety report from GoPlusLabs.
 * Returns null if the token/chain is not supported or GoPlus has no data.
 */
export async function getTokenSafety(
  address: string,
  chain: string,
): Promise<TokenSafetyResult | null> {
  const goplusChainId = GOPLUS_CHAIN_IDS[chain];
  if (!goplusChainId) return null;

  const cacheKey = `${chain}:${address.toLowerCase()}`;

  // Check cache
  const cached = safetyCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    const res = await fetch(
      `https://api.gopluslabs.io/api/v1/token_security/${goplusChainId}?contract_addresses=${encodeURIComponent(address)}`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return null;

    const data = await res.json();
    if (data.code !== 1 || !data.result) return null;

    // GoPlus keys results by lowercase address
    const key = Object.keys(data.result)[0];
    if (!key) return null;

    const token = data.result[key];
    if (!token) return null;

    const result = mapGoPlusResult(token);

    safetyCache.set(cacheKey, { result, fetchedAt: Date.now() });
    return result;
  } catch {
    return null;
  }
}

function toBool(val: any): boolean {
  return val === '1' || val === 1 || val === true;
}

function mapGoPlusResult(t: any): TokenSafetyResult {
  return {
    tokenName: t.token_name || '',
    tokenSymbol: t.token_symbol || '',
    totalSupply: t.total_supply || '0',

    isHoneypot: toBool(t.is_honeypot),
    isMintable: toBool(t.is_mintable),
    isOpenSource: toBool(t.is_open_source),
    isProxy: toBool(t.is_proxy),
    isBlacklisted: toBool(t.is_blacklisted),
    isAntiWhale: toBool(t.is_anti_whale),
    hasHiddenOwner: toBool(t.hidden_owner),
    hasExternalCall: toBool(t.external_call),
    hasSelfDestruct: toBool(t.selfdestruct),
    canTakeBackOwnership: toBool(t.can_take_back_ownership),
    transferPausable: toBool(t.transfer_pausable),

    buyTax: t.buy_tax || '0',
    sellTax: t.sell_tax || '0',

    ownerAddress: t.owner_address || '',
    creatorAddress: t.creator_address || '',
    creatorPercent: t.creator_percent || '0',

    holderCount: parseInt(t.holder_count || '0', 10) || 0,
    holders: (t.holders || []).map((h: any) => ({
      address: h.address || '',
      balance: h.balance || '0',
      percent: h.percent || '0',
      isLocked: toBool(h.is_locked),
      isContract: toBool(h.is_contract),
      tag: h.tag || '',
    })),

    lpHolderCount: parseInt(t.lp_holder_count || '0', 10) || 0,
    lpTotalSupply: t.lp_total_supply || '0',
    lpHolders: (t.lp_holders || []).map((h: any) => ({
      address: h.address || '',
      balance: h.balance || '0',
      percent: h.percent || '0',
      isLocked: toBool(h.is_locked),
      isContract: toBool(h.is_contract),
    })),

    dexInfo: (t.dex || []).map((d: any) => ({
      name: d.name || '',
      liquidity: d.liquidity || '0',
      pair: d.pair || d.pool_manager || '',
    })),
  };
}
