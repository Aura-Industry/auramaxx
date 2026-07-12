import { ethers } from 'ethers';
import { DexAdapter, PoolInfo, SwapParams, SwapTxData } from './types';
import { getDefaultSync } from '../defaults';

const RELAY_API = 'https://api.relay.link';

// Native ETH address used by Relay
const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

// App fee: 1% (100 bps). Relay keeps 25%, we keep 75%.
const APP_FEE_BPS = '100';

// Supported EVM chain IDs
const SUPPORTED_CHAINS = new Set([
  1,      // Ethereum
  10,     // Optimism
  137,    // Polygon
  8453,   // Base
  42161,  // Arbitrum
  324,    // zkSync Era
  43114,  // Avalanche
  56,     // BNB Chain
  250,    // Fantom
  59144,  // Linea
  534352, // Scroll
  7777777, // Zora
]);

// Relay quote request
interface RelayQuoteRequest {
  user: string;
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  tradeType: 'EXACT_INPUT';
  slippageTolerance?: string;
  source?: string;
  appFees?: { recipient: string; fee: string }[];
}

// Relay quote response types
interface RelayTxData {
  from: string;
  to: string;
  data: string;
  value: string;
  chainId: number;
}

interface RelayStepItem {
  status: string;
  data: RelayTxData;
}

interface RelayStep {
  id: string;
  kind: string;
  items: RelayStepItem[];
}

interface RelayQuoteResponse {
  steps: RelayStep[];
}

// Relay price response types
export interface RelayPriceResponse {
  fees: {
    gas: { amount: string; amountUsd: string; currency: { symbol: string } };
    relayer?: { amount: string; amountUsd: string };
    app?: { amount: string; amountUsd: string };
  };
  details: {
    sender: { amount: string; amountFormatted: string; amountUsd: string; currency: { symbol: string; decimals: number; address: string } };
    recipient: { amount: string; amountFormatted: string; amountUsd: string; currency: { symbol: string; decimals: number; address: string } };
    rate: string;
    slippageTolerance: { origin: { percent: string } };
  };
}

/**
 * Get a lightweight price/quote from Relay.
 * Uses /price endpoint (no calldata, lighter than /quote/v2).
 * Returns amounts, fees, exchange rate, and impact.
 */
export async function getRelayPrice(params: {
  user: string;
  originChainId: number;
  destinationChainId?: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  slippageBps?: number;
}): Promise<RelayPriceResponse> {
  const body: RelayQuoteRequest = {
    user: params.user,
    originChainId: params.originChainId,
    destinationChainId: params.destinationChainId ?? params.originChainId,
    originCurrency: params.originCurrency,
    destinationCurrency: params.destinationCurrency,
    amount: params.amount,
    tradeType: 'EXACT_INPUT',
    source: 'auramaxx',
    appFees: [{ recipient: getDefaultSync('protocol.fee_address', '0xa931533E0E0cCE34fc0FafB25ea2046d391eCAA5'), fee: APP_FEE_BPS }],
  };

  if (params.slippageBps !== undefined) {
    body.slippageTolerance = params.slippageBps.toString();
  }

  const response = await fetch(`${RELAY_API}/price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Relay price failed: ${response.status} ${text}`);
  }

  return response.json();
}

/**
 * Get a swap quote from Relay.
 * Returns the raw transaction data for the first incomplete transaction step.
 */
async function getRelayQuote(params: {
  user: string;
  originChainId: number;
  destinationChainId?: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  slippageBps?: number;
}): Promise<RelayTxData> {
  const body: RelayQuoteRequest = {
    user: params.user,
    originChainId: params.originChainId,
    destinationChainId: params.destinationChainId ?? params.originChainId,
    originCurrency: params.originCurrency,
    destinationCurrency: params.destinationCurrency,
    amount: params.amount,
    tradeType: 'EXACT_INPUT',
    source: 'auramaxx',
    appFees: [{ recipient: getDefaultSync('protocol.fee_address', '0xa931533E0E0cCE34fc0FafB25ea2046d391eCAA5'), fee: APP_FEE_BPS }],
  };

  if (params.slippageBps !== undefined) {
    body.slippageTolerance = params.slippageBps.toString();
  }

  const response = await fetch(`${RELAY_API}/quote/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Relay quote failed: ${response.status} ${text}`);
  }

  const data: RelayQuoteResponse = await response.json();

  // Find the first incomplete transaction step
  for (const step of data.steps) {
    if (step.kind !== 'transaction') continue;
    for (const item of step.items) {
      if (item.status === 'incomplete' && item.data) {
        return item.data;
      }
    }
  }

  throw new Error('Relay quote returned no executable transaction steps');
}

/**
 * Relay adapter for same-chain swaps via Relay aggregator API.
 * Supports all major EVM chains. No API key required.
 */
export const relayAdapter: DexAdapter = {
  name: 'relay',

  supportsChain(chainId: number): boolean {
    return SUPPORTED_CHAINS.has(chainId);
  },

  async detectPool(
    _token: string,
    _provider: ethers.Provider
  ): Promise<PoolInfo | null> {
    // Relay is an aggregator -- it finds routes internally.
    // Return a synthetic PoolInfo to indicate Relay can handle this token.
    return { version: 'relay', poolAddress: 'relay' };
  },

  async buildSwapTx(params: SwapParams): Promise<SwapTxData> {
    const { token, direction, amount, from, chainId, destinationChainId } = params;

    // Determine origin/destination currencies
    // buy: ETH -> token, sell: token -> ETH
    const originCurrency = direction === 'buy' ? NATIVE_ADDRESS : token;
    const destinationCurrency = direction === 'buy' ? token : NATIVE_ADDRESS;

    // Amount is already in wei (EVM) or lamports (Solana)
    const amountWei = amount;

    const txData = await getRelayQuote({
      user: from,
      originChainId: chainId,
      destinationChainId,
      originCurrency,
      destinationCurrency,
      amount: amountWei,
    });

    return {
      to: txData.to,
      data: txData.data,
      value: txData.value || '0',
    };
  },

  getRouterAddress(): string {
    // Relay uses different contract addresses per chain/tx.
    // Return a descriptive placeholder; the actual `to` comes from buildSwapTx.
    return 'relay';
  },
};

export default relayAdapter;
