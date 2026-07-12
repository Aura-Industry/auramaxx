import { Connection, VersionedTransaction, PublicKey } from '@solana/web3.js';

const JUPITER_API = 'https://quote-api.jup.ag/v6';

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
}

export interface JupiterSwapResult {
  swapTransaction: string; // base64-encoded VersionedTransaction
  lastValidBlockHeight: number;
}

/**
 * Get a swap quote from Jupiter.
 */
export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number
): Promise<JupiterQuote> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: slippageBps.toString(),
  });

  const response = await fetch(`${JUPITER_API}/quote?${params}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jupiter quote failed: ${response.status} ${text}`);
  }

  return response.json();
}

/**
 * Get a swap transaction from Jupiter.
 * Returns a serialized VersionedTransaction ready to sign.
 */
export async function getJupiterSwapTransaction(
  quote: JupiterQuote,
  userPublicKey: string
): Promise<JupiterSwapResult> {
  const response = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jupiter swap failed: ${response.status} ${text}`);
  }

  return response.json();
}

/**
 * Deserialize a Jupiter swap transaction.
 */
export function deserializeJupiterTransaction(swapTransaction: string): VersionedTransaction {
  const txBuf = Buffer.from(swapTransaction, 'base64');
  return VersionedTransaction.deserialize(txBuf);
}

/**
 * Execute a full Jupiter swap: quote → swap tx → sign → send.
 */
export async function executeJupiterSwap(
  connection: Connection,
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
  userPublicKey: PublicKey,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>
): Promise<{ signature: string; quote: JupiterQuote }> {
  // Get quote
  const quote = await getJupiterQuote(inputMint, outputMint, amount, slippageBps);

  // Get swap transaction
  const { swapTransaction } = await getJupiterSwapTransaction(
    quote,
    userPublicKey.toBase58()
  );

  // Deserialize and sign
  const tx = deserializeJupiterTransaction(swapTransaction);
  const signedTx = await signTransaction(tx);

  // Send
  const signature = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
  });

  // Confirm
  await connection.confirmTransaction(signature, 'confirmed');

  return { signature, quote };
}
