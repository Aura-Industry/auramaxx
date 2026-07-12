import { Request, Response } from 'express';
import { ethers } from 'ethers';
import { getHotWallet, signWithHotWallet, tokenCanAccessWallet } from '../lib/hot';
import { getTempWallet, signWithTempWallet } from '../lib/temp';
import { isUnlocked } from '../lib/cold';
import { getRpcUrl } from '../lib/config';
import { logger } from '../lib/logger';
import {
  getDexAdapter,
  detectBestDex,
  listDexes,
  PoolKey
} from '../lib/dex';
import { getV4PoolKey, getKnownV4Hooks, detectV4PoolFromEvents } from '../lib/dex/uniswap';
import { isAdmin, hasAnyPermission } from '../lib/permissions';
import { reserveSpend, releaseSpend, getRemainingByType } from '../lib/sessions';
import { getDefault } from '../lib/defaults';
import { getNativeAddress } from '../lib/address';
import { recordTransaction, autoTrackToken } from '../lib/transactions';
import { AuthInfo } from '../middleware/auth';
import { ChainConfig } from '../lib/config';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';

export async function handleEvmSwap(
  req: Request,
  res: Response,
  auth: AuthInfo,
  targetChain: string,
  chainConfig: ChainConfig,
  destinationChainId?: number,
  targetChainOut?: string
): Promise<void> {
  const {
    from,
    token,
    direction,
    amount,
    minOut,
    slippage,
    dex: requestedDex,
    version: requestedVersion,
    poolFee,
    poolKey,
    hook: requestedHook,
    description: userDescription
  } = req.body;

  const provider = new ethers.JsonRpcProvider(await getRpcUrl(targetChain));

  // Determine wallet type and verify ownership
  const hotWallet = await getHotWallet(from);
  const tempWallet = getTempWallet(from);

  if (!hotWallet && !tempWallet) {
    res.status(404).json({ error: 'Wallet not found' });
    return;
  }

  if (hotWallet) {
    // Check permission
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['swap'])) {
      logger.permissionDenied('swap', auth.token.agentId, '/swap');
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.SWAP_EVM_PERMISSION,
        error: 'Token does not have swap permission',
        required: ['swap'],
        have: auth.token.permissions,
      });
      return;
    }

    // Verify token can access this wallet
    const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, from);
    if (!isAdmin(auth) && !canAccess) {
      logger.permissionDenied('wallet_access', auth.token.agentId, '/swap');
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.SWAP_EVM_WALLET_ACCESS,
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
  } else if (tempWallet) {
    // Check permission
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['swap'])) {
      logger.permissionDenied('swap', auth.token.agentId, '/swap');
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.SWAP_EVM_PERMISSION,
        error: 'Token does not have swap permission',
        required: ['swap'],
        have: auth.token.permissions,
      });
      return;
    }
  }

  // Reserve spending atomically (prevents TOCTOU race between concurrent requests)
  const currency = getNativeAddress(targetChain);
  const evmSwapAmount = parseFloat(ethers.formatEther(BigInt(amount)));
  const needsEvmLimit = !isAdmin(auth) && evmSwapAmount > 0;
  if (needsEvmLimit) {
    const reserve = reserveSpend(auth.tokenHash, auth.token, 'swap', evmSwapAmount, currency);
    if (!reserve.ok) {
      const remaining = getRemainingByType(auth.tokenHash, auth.token, 'swap', currency);
      logger.limitExceeded(auth.token.agentId, 'swap', evmSwapAmount, remaining);
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.SWAP_EVM_LIMIT,
        error: 'Amount exceeds remaining swap limit',
        required: ['swap'],
        have: auth.token.permissions,
        extraPayload: {
          remaining: reserve.remaining,
          requested: evmSwapAmount,
        },
      });
      return;
    }
  }

  // Helper to roll back reserved spend on early exit or error
  const evmRollback = () => {
    if (needsEvmLimit) releaseSpend(auth.tokenHash, 'swap', evmSwapAmount, currency);
  };

  // Get DEX adapter
  let adapter;
  let detectedPool;
  let version = requestedVersion;
  let detectedFee = poolFee;
  let detectedPoolKey = poolKey;

  if (requestedDex) {
    // Use specified DEX
    adapter = getDexAdapter(requestedDex);
    if (!adapter) {
      evmRollback();
      res.status(400).json({
        error: `Unknown DEX: ${requestedDex}. Available: ${listDexes().join(', ')}`
      });
      return;
    }

    if (!adapter.supportsChain(chainConfig.chainId)) {
      evmRollback();
      res.status(400).json({ error: `${requestedDex} not supported on ${targetChain}` });
      return;
    }

    // Detect pool if version not specified
    if (!version) {
      detectedPool = await adapter.detectPool(token, provider);
      if (!detectedPool) {
        evmRollback();
        res.status(400).json({ error: `No ${requestedDex} pool found for this token` });
        return;
      }
      version = detectedPool.version;
      detectedFee = detectedPool.fee;
      detectedPoolKey = detectedPool.poolKey;
    }
  } else {
    // Auto-detect best DEX
    const result = await detectBestDex(token, provider, chainConfig.chainId);
    if (!result) {
      evmRollback();
      res.status(400).json({ error: 'No liquidity pool found for this token' });
      return;
    }
    adapter = result.adapter;
    detectedPool = result.pool;
    // Only use detected version if user didn't specify one
    if (!version) {
      version = detectedPool.version;
    }
    if (!detectedFee) {
      detectedFee = detectedPool.fee;
    }
    if (!detectedPoolKey) {
      detectedPoolKey = detectedPool.poolKey;
    }
  }

  // V4 requires poolKey (Uniswap-specific, skip for aggregators like Relay)
  if (adapter.name === 'uniswap' && version === 'v4' && !detectedPoolKey) {
    // 1. Try specified hook first
    if (requestedHook) {
      detectedPoolKey = getV4PoolKey(token, requestedHook);
      if (!detectedPoolKey) {
        evmRollback();
        res.status(400).json({
          error: `Unknown hook: ${requestedHook}. Known hooks: ${getKnownV4Hooks().join(', ')}, none`
        });
        return;
      }
    }

    // 2. Try known hooks (clanker, zora, etc.)
    if (!detectedPoolKey) {
      for (const hookName of getKnownV4Hooks()) {
        detectedPoolKey = getV4PoolKey(token, hookName);
        if (detectedPoolKey) break;
      }
    }

    // 3. Try no-hook pools with common fee/tickSpacing combos
    if (!detectedPoolKey) {
      detectedPoolKey = getV4PoolKey(token, 'none');
    }

    // 4. Event lookup fallback (slow, requires RPC)
    if (!detectedPoolKey) {
      detectedPoolKey = await detectV4PoolFromEvents(token, provider);
    }

    if (!detectedPoolKey) {
      evmRollback();
      res.status(400).json({
        error: `V4 pool not found. Provide poolKey or specify a known hook. Known hooks: ${getKnownV4Hooks().join(', ')}, none`
      });
      return;
    }
  }

  // Enforce slippage floors
  const minSlippage = isAdmin(auth)
    ? await getDefault<number>('swap.min_slippage_admin', 0.5)
    : await getDefault<number>('swap.min_slippage_agent', 1.0);
  let effectiveSlippage = slippage;
  if (effectiveSlippage !== undefined && effectiveSlippage !== null) {
    if (effectiveSlippage < minSlippage) {
      effectiveSlippage = minSlippage;
    }
  }

  // Calculate finalMinOut — amount is already in wei, use BigInt directly
  let finalMinOut: string;
  if (effectiveSlippage !== undefined && effectiveSlippage !== null) {
    const amountBig = BigInt(amount);
    const slippageBps = BigInt(Math.floor(effectiveSlippage * 100)); // basis points
    const floorMinOut = amountBig - (amountBig * slippageBps / 10000n);

    if (minOut && minOut !== '0') {
      // Caller provided explicit minOut - enforce it's not below the slippage floor
      const explicitMinOut = BigInt(minOut);
      if (explicitMinOut < floorMinOut) {
        evmRollback();
        res.status(400).json({
          error: `minOut too low: ${minOut} is below the ${effectiveSlippage}% slippage floor (min: ${floorMinOut.toString()})`
        });
        return;
      }
      finalMinOut = minOut;
    } else {
      finalMinOut = floorMinOut.toString();
    }
  } else if (minOut && minOut !== '0') {
    // No slippage param but explicit minOut - validate against the floor slippage
    const amountBig = BigInt(amount);
    const floorBps = BigInt(Math.floor(minSlippage * 100));
    const floorMinOut = amountBig - (amountBig * floorBps / 10000n);
    const explicitMinOut = BigInt(minOut);
    if (explicitMinOut < floorMinOut) {
      evmRollback();
      res.status(400).json({
        error: `minOut too low: ${minOut} is below the ${minSlippage}% slippage floor (min: ${floorMinOut.toString()})`
      });
      return;
    }
    finalMinOut = minOut;
  } else {
    evmRollback();
    res.status(400).json({ error: 'slippage is required (percentage, e.g. 1.0 for 1%)' });
    return;
  }

  // Build the swap transaction
  const swapTxData = await adapter.buildSwapTx({
    token,
    direction,
    amount,
    minOut: finalMinOut,
    from,
    chainId: chainConfig.chainId,
    destinationChainId,
    version,
    fee: detectedFee,
    poolKey: detectedPoolKey
  });

  // Build transaction object
  const tx: ethers.TransactionRequest = {
    from,
    to: swapTxData.to,
    data: swapTxData.data,
    value: BigInt(swapTxData.value)
  };

  // Sign and send
  let txHash: string;

  try {
    if (hotWallet) {
      const result = await signWithHotWallet(from, tx, provider);
      txHash = result.hash;
    } else if (tempWallet) {
      txHash = await signWithTempWallet(from, tx, provider);
    } else {
      evmRollback();
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }
  } catch (err) {
    evmRollback();
    throw err;
  }

  // Log the swap
  const versionStr = version ? version.toUpperCase() : '';
  const description = userDescription || (direction === 'buy'
    ? `Bought ${token} with ${amount} ETH via ${adapter.name} ${versionStr}`
    : `Sold ${amount} tokens of ${token} for ETH via ${adapter.name} ${versionStr}`);

  await recordTransaction({
    walletAddress: from,
    txHash,
    type: 'swap',
    amount: direction === 'buy' ? amount : undefined,
    tokenAddress: token,
    tokenAmount: direction === 'sell' ? amount : undefined,
    from,
    to: swapTxData.to || adapter.getRouterAddress(),
    description,
    chain: targetChain,
    logTitle: `Swap ${direction === 'buy' ? 'Buy' : 'Sell'}`,
  });

  // Auto-track the swapped token (save pool info for price lookup)
  await autoTrackToken({
    walletAddress: from,
    tokenAddress: token,
    chain: targetChain,
    poolAddress: detectedPool?.poolAddress,
    poolVersion: detectedPool?.version,
  });

  // Log swap event
  const agentId = !isAdmin(auth) ? auth.token.agentId : undefined;
  const fromToken = direction === 'buy' ? 'ETH' : token.slice(0, 10);
  const toToken = direction === 'buy' ? token.slice(0, 10) : 'ETH';
  logger.swap(from, fromToken, toToken, amount, txHash, agentId);

  const remaining = isAdmin(auth)
    ? Infinity
    : getRemainingByType(auth.tokenHash, auth.token, 'swap', currency);

  res.json({
    success: true,
    hash: txHash,
    from,
    token,
    direction,
    amountIn: amount,
    dex: adapter.name,
    version,
    chain: targetChain,
    ...(targetChainOut && { chainOut: targetChainOut }),
    router: adapter.getRouterAddress(),
    remaining
  });
}
