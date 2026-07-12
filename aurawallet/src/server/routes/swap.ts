import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { getHotWallet, tokenCanAccessWallet } from '../lib/hot';
import { getTempWallet, hasTempWallet } from '../lib/temp';
import { resolveChain, getRpcUrl } from '../lib/config';
import { logger } from '../lib/logger';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';
import {
  getDexAdapter,
  detectBestDex,
  listDexes,
} from '../lib/dex';
import { requireWalletAuth } from '../middleware/auth';
import { hasAnyPermission, isAdmin } from '../lib/permissions';
import { getDefault, getDefaultSync } from '../lib/defaults';
import { isSolanaChain, NATIVE_ADDRESSES } from '../lib/address';
import { getErrorMessage, HttpError } from '../lib/error';
import { getJupiterQuote } from '../lib/solana/jupiter';
import { getRelayPrice } from '../lib/dex/relay';
import { handleSolanaSwap } from './swap-solana';
import { handleEvmSwap } from './swap-evm';
import type { PoolKey } from '../lib/dex';

const router = Router();

export interface SwapRequest {
  from: string;
  token: string;
  direction: 'buy' | 'sell';
  amount: string;
  minOut?: string;
  slippage?: number;
  dex?: string;            // DEX to use (default: auto-detect)
  version?: string;        // Pool version override (v2, v3, v4, etc.)
  poolFee?: number;
  poolKey?: PoolKey;
  hook?: string;           // V4 hook name (e.g., 'clanker-static-fee-v2')
  chain?: string;
  chainOut?: string;       // Destination chain for cross-chain swaps (Relay only)
  description?: string;    // Optional description for the transaction
}

// POST /swap - Execute token swap via DEX adapter
router.post('/', requireWalletAuth, async (req: Request, res: Response) => {
  try {
    const {
      from,
      token,
      direction,
      amount,
      minOut,
      slippage,
      dex: requestedDex,
      chain,
      chainOut,
    } = req.body as SwapRequest;

    const auth = req.auth!;

    // Validate required fields
    if (!from || typeof from !== 'string') {
      res.status(400).json({ error: 'from address is required' });
      return;
    }

    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'token address is required' });
      return;
    }

    if (!direction || (direction !== 'buy' && direction !== 'sell')) {
      res.status(400).json({ error: 'direction must be "buy" or "sell"' });
      return;
    }

    if (!amount || typeof amount !== 'string') {
      res.status(400).json({ error: 'amount is required' });
      return;
    }

    // Validate slippage/minOut - never allow 0 minOut (sandwich attack protection)
    if (!minOut && (slippage === undefined || slippage === null)) {
      res.status(400).json({ error: 'slippage is required (percentage, e.g. 1.0 for 1%)' });
      return;
    }

    if (slippage !== undefined && slippage !== null) {
      if (typeof slippage !== 'number' || isNaN(slippage) || slippage <= 0) {
        res.status(400).json({ error: 'slippage must be a positive number (percentage)' });
        return;
      }
      const maxSlippage = await getDefault<number>('swap.max_slippage', 50);
      if (slippage > maxSlippage) {
        res.status(400).json({ error: `slippage cannot exceed ${maxSlippage}%` });
        return;
      }
    }

    // Early validation: if explicit minOut is provided, check it against the slippage floor
    // This runs before DEX detection so we fail fast on bad minOut values
    if (minOut && minOut !== '0') {
      const minSlippageEarly = isAdmin(auth)
        ? await getDefault<number>('swap.min_slippage_admin', 0.5)
        : await getDefault<number>('swap.min_slippage_agent', 1.0);
      const amountBigEarly = BigInt(amount);
      const floorBpsEarly = BigInt(Math.floor(minSlippageEarly * 100));
      const floorMinOutEarly = amountBigEarly - (amountBigEarly * floorBpsEarly / 10000n);
      const explicitMinOut = BigInt(minOut);
      if (explicitMinOut < floorMinOutEarly) {
        res.status(400).json({
          error: `minOut too low: ${minOut} is below the ${minSlippageEarly}% slippage floor (min: ${floorMinOutEarly.toString()})`
        });
        return;
      }
    }

    // Get chain config
    const { targetChain, chainConfig } = resolveChain(chain);

    // Resolve destination chain for cross-chain swaps
    let destinationChainId: number | undefined;
    let targetChainOut: string | undefined;
    if (chainOut) {
      try {
        const { chainConfig: chainOutConfig } = resolveChain(chainOut);
        destinationChainId = chainOutConfig.chainId;
      } catch {
        res.status(400).json({ error: `Unknown destination chain: ${chainOut}` });
        return;
      }
      // Cross-chain only supported with Relay
      if (requestedDex && requestedDex !== 'relay') {
        res.status(400).json({ error: 'Cross-chain swaps are only supported with Relay (the default DEX)' });
        return;
      }
      targetChainOut = chainOut;
    }

    // Dispatch to chain-specific handler
    if (isSolanaChain(targetChain)) {
      return await handleSolanaSwap(req, res, auth, targetChain, chainConfig);
    }
    return await handleEvmSwap(req, res, auth, targetChain, chainConfig, destinationChainId, targetChainOut);

  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// POST /swap/quote - Get swap quote without executing
// Same auth and validation as /swap, but returns quote data only
router.post('/quote', requireWalletAuth, async (req: Request, res: Response) => {
  try {
    const {
      from,
      token,
      direction,
      amount,
      slippage,
      dex: requestedDex,
      chain,
      chainOut,
    } = req.body as SwapRequest;

    const auth = req.auth!;

    // Validate required fields
    if (!from || typeof from !== 'string') {
      res.status(400).json({ error: 'from address is required' });
      return;
    }

    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'token address is required' });
      return;
    }

    if (!direction || (direction !== 'buy' && direction !== 'sell')) {
      res.status(400).json({ error: 'direction must be "buy" or "sell"' });
      return;
    }

    if (!amount || typeof amount !== 'string') {
      res.status(400).json({ error: 'amount is required' });
      return;
    }

    // Get chain config
    const { targetChain, chainConfig } = resolveChain(chain);

    // Resolve destination chain for cross-chain quotes
    let destinationChainId: number | undefined;
    if (chainOut) {
      try {
        const { chainConfig: chainOutConfig } = resolveChain(chainOut);
        destinationChainId = chainOutConfig.chainId;
      } catch {
        res.status(400).json({ error: `Unknown destination chain: ${chainOut}` });
        return;
      }
      if (requestedDex && requestedDex !== 'relay') {
        res.status(400).json({ error: 'Cross-chain swaps are only supported with Relay' });
        return;
      }
    }

    // Permission check
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['swap'])) {
      logger.permissionDenied('swap', auth.token.agentId, '/swap/quote');
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.SWAP_QUOTE_PERMISSION,
        error: 'Token does not have swap permission',
        required: ['swap'],
        have: auth.token.permissions,
      });
      return;
    }

    // Wallet access check
    const hotWallet = await getHotWallet(from);
    const isTempWallet = isSolanaChain(targetChain) ? hasTempWallet(from) : !!getTempWallet(from);

    if (!hotWallet && !isTempWallet) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    if (hotWallet && !isAdmin(auth)) {
      const chainParam = isSolanaChain(targetChain) ? targetChain : undefined;
      const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, from, chainParam);
      if (!canAccess) {
        logger.permissionDenied('wallet_access', auth.token.agentId, '/swap/quote');
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.SWAP_QUOTE_WALLET_ACCESS,
          error: 'Token does not have access to this wallet',
          required: ['wallet:access'],
          have: auth.token.permissions,
        });
        return;
      }
    }

    // Calculate effective slippage
    const effectiveSlippage = slippage ?? getDefaultSync<number>('swap.min_slippage_agent', 1.0);
    const slippageBps = Math.round(effectiveSlippage * 100);

    // --- Solana/Jupiter quote ---
    if (isSolanaChain(targetChain)) {
      if (chainOut) {
        res.status(400).json({ error: 'Cross-chain swaps are not supported on Solana' });
        return;
      }

      const inputMint = direction === 'buy' ? NATIVE_ADDRESSES.SOL : token;
      const outputMint = direction === 'buy' ? token : NATIVE_ADDRESSES.SOL;

      const quote = await getJupiterQuote(inputMint, outputMint, amount, slippageBps);

      res.json({
        success: true,
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
        priceImpact: quote.priceImpactPct,
        route: quote.routePlan.map((r: any) => ({
          label: r.swapInfo.label,
          percent: r.percent,
          inAmount: r.swapInfo.inAmount,
          outAmount: r.swapInfo.outAmount,
        })),
        slippage: effectiveSlippage,
        dex: 'jupiter',
        chain: targetChain,
      });
      return;
    }

    // --- EVM quote ---
    // Determine DEX
    const provider = new ethers.JsonRpcProvider(await getRpcUrl(targetChain));
    let dexName: string;

    if (requestedDex) {
      const adapter = getDexAdapter(requestedDex);
      if (!adapter) {
        res.status(400).json({ error: `Unknown DEX: ${requestedDex}. Available: ${listDexes().join(', ')}` });
        return;
      }
      if (!adapter.supportsChain(chainConfig.chainId)) {
        res.status(400).json({ error: `${requestedDex} not supported on ${targetChain}` });
        return;
      }
      dexName = adapter.name;
    } else {
      // Auto-detect
      const result = await detectBestDex(token, provider, chainConfig.chainId);
      if (!result) {
        res.status(400).json({ error: 'No liquidity pool found for this token' });
        return;
      }
      dexName = result.adapter.name;
    }

    // For Relay (default), use the lightweight /price endpoint
    if (dexName === 'relay') {
      const originCurrency = direction === 'buy'
        ? '0x0000000000000000000000000000000000000000'
        : token;
      const destinationCurrency = direction === 'buy'
        ? token
        : '0x0000000000000000000000000000000000000000';

      const price = await getRelayPrice({
        user: from,
        originChainId: chainConfig.chainId,
        destinationChainId,
        originCurrency,
        destinationCurrency,
        amount,
        slippageBps,
      });

      res.json({
        success: true,
        inputAmount: price.details.sender.amount,
        inputFormatted: price.details.sender.amountFormatted,
        inputUsd: price.details.sender.amountUsd,
        outputAmount: price.details.recipient.amount,
        outputFormatted: price.details.recipient.amountFormatted,
        outputUsd: price.details.recipient.amountUsd,
        rate: price.details.rate,
        fees: price.fees,
        slippage: effectiveSlippage,
        dex: 'relay',
        chain: targetChain,
        ...(chainOut && { chainOut }),
      });
      return;
    }

    // For Uniswap — return pool info (no on-chain quote endpoint in our adapter)
    const adapter = getDexAdapter(dexName)!;
    const pool = await adapter.detectPool(token, provider);

    res.json({
      success: true,
      dex: dexName,
      chain: targetChain,
      pool: pool ? { version: pool.version, fee: pool.fee, poolAddress: pool.poolAddress } : null,
      message: `Use POST /swap to execute. ${dexName} quote-only is not available — pool info returned instead.`,
    });

  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// GET /swap/dexes - List available DEXes
router.get('/dexes', (_req: Request, res: Response) => {
  res.json({
    success: true,
    dexes: listDexes()
  });
});

export default router;
