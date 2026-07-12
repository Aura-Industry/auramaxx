import { Request, Response } from 'express';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getHotWallet, tokenCanAccessWallet } from '../lib/hot';
import { hasTempWallet, getTempSolanaKeypair } from '../lib/temp';
import { isUnlocked } from '../lib/cold';
import { logger } from '../lib/logger';
import { isAdmin, hasAnyPermission } from '../lib/permissions';
import { reserveSpend, releaseSpend, getRemainingByType } from '../lib/sessions';
import { getDefaultSync } from '../lib/defaults';
import { getNativeAddress, getNativeCurrency, NATIVE_ADDRESSES } from '../lib/address';
import { getSolanaConnection } from '../lib/solana/connection';
import { getSolanaKeypair } from '../lib/solana/wallet';
import { recordTransaction, autoTrackToken } from '../lib/transactions';
import { executeJupiterSwap } from '../lib/solana/jupiter';
import { AuthInfo } from '../middleware/auth';
import { ChainConfig } from '../lib/config';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';

export async function handleSolanaSwap(
  req: Request,
  res: Response,
  auth: AuthInfo,
  targetChain: string,
  _chainConfig: ChainConfig
): Promise<void> {
  const { from, token, direction, amount, slippage, chainOut, description: userDescription } = req.body;

  if (chainOut) {
    res.status(400).json({ error: 'Cross-chain swaps are not supported on Solana' });
    return;
  }

  const currency = getNativeAddress(targetChain);
  const nativeCurrency = getNativeCurrency(targetChain);

  // Determine wallet
  const hotWallet = await getHotWallet(from);
  const isTempWallet = hasTempWallet(from);

  if (!hotWallet && !isTempWallet) {
    res.status(404).json({ error: 'Wallet not found' });
    return;
  }

  // Permission checks
  if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['swap'])) {
    logger.permissionDenied('swap', auth.token.agentId, '/swap');
    await respondPermissionDenied({
      req,
      res,
      routeId: ESCALATION_ROUTE_IDS.SWAP_SOLANA_PERMISSION,
      error: 'Token does not have swap permission',
      required: ['swap'],
      have: auth.token.permissions,
    });
    return;
  }

  if (hotWallet) {
    const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, from, targetChain);
    if (!isAdmin(auth) && !canAccess) {
      logger.permissionDenied('wallet_access', auth.token.agentId, '/swap');
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.SWAP_SOLANA_WALLET_ACCESS,
        error: 'Token does not have access to this wallet',
        required: ['wallet:access'],
        have: auth.token.permissions,
      });
      return;
    }
    if (!isUnlocked()) {
      logger.authFailed('Cold wallet locked', '/swap');
      res.status(401).json({ error: 'Cold wallet must be unlocked to send from hot wallet' });
      return;
    }
  }

  // Reserve spending atomically (prevents TOCTOU race between concurrent requests)
  const swapAmountSol = Number(BigInt(amount)) / 1e9;
  const needsSolLimit = !isAdmin(auth) && swapAmountSol > 0;
  if (needsSolLimit) {
    const reserve = reserveSpend(auth.tokenHash, auth.token, 'swap', swapAmountSol, currency);
    if (!reserve.ok) {
      logger.limitExceeded(auth.token.agentId, 'swap', swapAmountSol, reserve.remaining);
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.SWAP_SOLANA_LIMIT,
        error: 'Amount exceeds remaining swap limit',
        required: ['swap'],
        have: auth.token.permissions,
        extraPayload: {
          remaining: reserve.remaining,
          requested: swapAmountSol,
        },
      });
      return;
    }
  }

  // Jupiter swap
  const connection = await getSolanaConnection(targetChain);
  const inputMint = direction === 'buy' ? NATIVE_ADDRESSES.SOL : token;
  const outputMint = direction === 'buy' ? token : NATIVE_ADDRESSES.SOL;

  // Amount is already in lamports (buy) or raw token amount (sell)
  const amountRaw = amount;

  // Calculate slippage in bps
  const effectiveSlippage = slippage ?? getDefaultSync<number>('swap.min_slippage_agent', 1.0);
  const slippageBps = Math.round(effectiveSlippage * 100);

  let userPubkey: PublicKey;
  try {
    userPubkey = new PublicKey(from);
  } catch {
    if (needsSolLimit) releaseSpend(auth.tokenHash, 'swap', swapAmountSol, currency);
    res.status(400).json({ error: 'Invalid Solana address' });
    return;
  }

  // Get signer
  let signerKeypair;
  if (hotWallet) {
    signerKeypair = await getSolanaKeypair(from);
  } else {
    signerKeypair = getTempSolanaKeypair(from);
    if (!signerKeypair) {
      if (needsSolLimit) releaseSpend(auth.tokenHash, 'swap', swapAmountSol, currency);
      res.status(404).json({ error: 'Temp Solana wallet not found' });
      return;
    }
  }

  let signature: string;
  try {
    const result = await executeJupiterSwap(
      connection,
      inputMint,
      outputMint,
      amountRaw,
      slippageBps,
      userPubkey,
      async (tx: VersionedTransaction) => {
        tx.sign([signerKeypair!]);
        return tx;
      }
    );
    signature = result.signature;
  } catch (err) {
    if (needsSolLimit) releaseSpend(auth.tokenHash, 'swap', swapAmountSol, currency);
    throw err;
  }

  // Log
  const description = userDescription || (direction === 'buy'
    ? `Bought ${token} with ${amount} ${nativeCurrency} via Jupiter`
    : `Sold ${amount} tokens of ${token} for ${nativeCurrency} via Jupiter`);

  await recordTransaction({
    walletAddress: from,
    txHash: signature,
    type: 'swap',
    amount: direction === 'buy' ? amount : undefined,
    tokenAddress: token,
    tokenAmount: direction === 'sell' ? amount : undefined,
    from,
    to: 'jupiter',
    description,
    chain: targetChain,
    logTitle: `Swap ${direction === 'buy' ? 'Buy' : 'Sell'}`,
  });

  await autoTrackToken({
    walletAddress: from,
    tokenAddress: token,
    chain: targetChain,
  });

  const agentId = !isAdmin(auth) ? auth.token.agentId : undefined;
  const fromToken = direction === 'buy' ? nativeCurrency : token.slice(0, 10);
  const toToken = direction === 'buy' ? token.slice(0, 10) : nativeCurrency;
  logger.swap(from, fromToken, toToken, amount, signature, agentId);

  const remaining = isAdmin(auth)
    ? Infinity
    : getRemainingByType(auth.tokenHash, auth.token, 'swap', currency);

  res.json({
    success: true,
    hash: signature,
    from,
    token,
    direction,
    amountIn: amount,
    dex: 'jupiter',
    chain: targetChain,
    remaining
  });
}
