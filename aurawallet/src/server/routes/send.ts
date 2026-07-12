import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { resolveChain, getRpcUrl } from '../lib/config';
import { requireWalletAuth } from '../middleware/auth';
import { isSolanaChain } from '../lib/address';
import { resolveName, looksLikeName } from '../lib/resolve';
import { getErrorMessage, HttpError } from '../lib/error';
import { handleSolanaSend } from './send-solana';
import { handleEvmSend } from './send-evm';

const router = Router();

// POST /send - Generic transaction endpoint
// Supports simple ETH sends and complex contract calls
//
// Simple send: { from, to, amount: "100000000000000000", chain }  // amount in wei or lamports
// Contract call: { from, to, value, data, gasLimit, ... }
//
// Requires Bearer token authentication
//
// Spending limit enforced for agent tokens (send limit).
// Sends to the cold wallet address bypass the limit (returning funds to agent).
// Admin tokens bypass all limits.
router.post('/', requireWalletAuth, async (req: Request, res: Response) => {
  try {
    const {
      from,
      to: rawTo,
      amount,  // Amount in wei (EVM) or lamports (Solana)
      value,   // Advanced mode: wei (alias for amount)
      data,
      tokenAddress,                  // Optional: ERC-20/SPL token contract address
      transaction: rawTransaction,   // Solana: base64-encoded VersionedTransaction
    } = req.body;

    const auth = req.auth!;

    if (!from || typeof from !== 'string') {
      res.status(400).json({ error: 'from address is required' });
      return;
    }

    // Token sends require 'to'
    if (tokenAddress && !rawTo) {
      res.status(400).json({ error: 'to address is required for token sends' });
      return;
    }

    // Resolve ENS names (e.g. "vitalik.eth" -> "0x...")
    let to = rawTo;
    if (to && typeof to === 'string' && looksLikeName(to)) {
      try {
        const resolved = await resolveName(to);
        to = resolved.address;
      } catch (err) {
        const msg = getErrorMessage(err);
        res.status(400).json({ error: msg });
        return;
      }
    }

    // 'to' is optional for contract deployment
    if (to && typeof to !== 'string') {
      res.status(400).json({ error: 'to must be a valid address' });
      return;
    }

    // For simple sends, 'to' is required (raw Solana transactions don't need 'to')
    if (!data && !rawTransaction && !to) {
      res.status(400).json({ error: 'to address is required for simple sends' });
      return;
    }

    // Parse value - amount must be in wei (EVM) or lamports (Solana).
    // Callers must convert before calling.
    let valueWei = BigInt(0);
    let valueEth = 0;
    const rawValue = amount || value;

    if (rawValue) {
      if (typeof rawValue === 'string') {
        valueWei = BigInt(rawValue);
      } else if (typeof rawValue === 'number') {
        valueWei = BigInt(rawValue);
      }
      valueEth = parseFloat(ethers.formatEther(valueWei));  // for limits only
    }

    // For simple native sends without data, require some value (raw Solana transactions carry value in instructions)
    // Token sends use amount as token units, not native currency, so skip this check
    if (!data && !rawTransaction && !tokenAddress && valueEth <= 0) {
      res.status(400).json({ error: 'amount is required for simple sends' });
      return;
    }

    // For token sends, require amount
    if (tokenAddress && (!rawValue || BigInt(rawValue) <= 0n)) {
      res.status(400).json({ error: 'amount is required for token sends' });
      return;
    }

    // Validate data if provided
    if (data && typeof data === 'string' && !data.startsWith('0x')) {
      res.status(400).json({ error: 'data must be hex-encoded (start with 0x)' });
      return;
    }

    const { targetChain, chainConfig } = resolveChain(req.body.chain);

    // Mutate req.body.to so handlers see the resolved address
    req.body.to = to;

    // Dispatch to chain-specific handler
    if (isSolanaChain(targetChain)) {
      return handleSolanaSend(req, res, auth, targetChain, chainConfig);
    }
    return handleEvmSend(req, res, auth, targetChain, chainConfig);
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

// POST /send/estimate - Estimate gas for a transaction
router.post('/estimate', async (req: Request, res: Response) => {
  try {
    const { from, to, amount, value, data, chain } = req.body;

    if (!from || typeof from !== 'string') {
      res.status(400).json({ error: 'from address is required' });
      return;
    }

    const { targetChain } = resolveChain(chain);

    const provider = new ethers.JsonRpcProvider(await getRpcUrl(targetChain));

    // Build transaction for estimation
    const tx: ethers.TransactionRequest = { from };
    if (to) tx.to = to;

    const rawValue = amount || value;
    if (rawValue) {
      tx.value = BigInt(rawValue);
    }
    if (data) tx.data = data;

    // Estimate gas
    const gasEstimate = await provider.estimateGas(tx);
    const feeData = await provider.getFeeData();

    const response: Record<string, unknown> = {
      success: true,
      gasLimit: gasEstimate.toString(),
      gasPrice: feeData.gasPrice?.toString() || null,
      maxFeePerGas: feeData.maxFeePerGas?.toString() || null,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString() || null
    };

    // Calculate estimated cost
    if (feeData.maxFeePerGas) {
      const estimatedCost = gasEstimate * feeData.maxFeePerGas;
      response.estimatedCostWei = estimatedCost.toString();
      response.estimatedCostEth = ethers.formatEther(estimatedCost);
    } else if (feeData.gasPrice) {
      const estimatedCost = gasEstimate * feeData.gasPrice;
      response.estimatedCostWei = estimatedCost.toString();
      response.estimatedCostEth = ethers.formatEther(estimatedCost);
    }

    res.json(response);
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

export default router;
