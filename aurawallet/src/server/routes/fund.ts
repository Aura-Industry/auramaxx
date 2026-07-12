import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { reserveSpend, releaseSpend, getRemainingByType } from '../lib/sessions';
import { tokenCanAccessWallet, getHotWallet } from '../lib/hot';
import {
  isUnlocked, getColdWalletAddress, signWithColdWallet, getSolanaColdKeypair, getSolanaColdAddress,
  isAgentUnlocked, getAgentAddress, getAgentSolanaAddress, getAgentSolanaKeypair, signWithAgent, getPrimaryAgentId
} from '../lib/cold';
import { prisma } from '../lib/db';
import { getRpcUrl, resolveChain } from '../lib/config';
import { logger } from '../lib/logger';
import { requireWalletAuth } from '../middleware/auth';
import { hasAnyPermission, isAdmin } from '../lib/permissions';
import { isSolanaChain, normalizeAddress, getNativeAddress, getNativeCurrency } from '../lib/address';
import { getSolanaConnection } from '../lib/solana/connection';
import { buildSolTransfer, sendSolanaTransaction } from '../lib/solana/transfer';
import { getErrorMessage, HttpError } from '../lib/error';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';

const router = Router();

/**
 * POST /fund - Agent transfers funds from cold wallet to their hot wallet
 *
 * This executes immediately if the cold wallet is unlocked.
 * The agent's spending limit is checked and deducted.
 *
 * Security checks:
 * 1. Valid bearer token (HMAC signature)
 * 2. Token not revoked
 * 3. Token can access the target hot wallet (owns or has walletAccess grant)
 * 4. Token has fund permission
 * 5. Amount within remaining spending limit (fund limit)
 * 6. Cold wallet must be unlocked
 */
router.post('/', requireWalletAuth, async (req: Request, res: Response) => {
  let rollback = () => {};
  try {
    const { to, amount, chain } = req.body;
    const auth = req.auth!;

    // Validate required fields
    if (!to || typeof to !== 'string') {
      res.status(400).json({ error: 'to (hot wallet address) is required' });
      return;
    }

    if (!amount || (typeof amount !== 'string' && typeof amount !== 'number')) {
      res.status(400).json({ error: 'amount is required (in wei for EVM or lamports for Solana)' });
      return;
    }

    // Amount is in wei (EVM) or lamports (Solana). Parse as BigInt.
    const amountWei = BigInt(amount);
    if (amountWei <= 0n) {
      res.status(400).json({ error: 'amount must be a positive number' });
      return;
    }

    // Determine chain first (needed to compute decimal amount for limit checks)
    const { targetChain } = resolveChain(chain);

    const currency = getNativeAddress(targetChain);
    const nativeCurrency = getNativeCurrency(targetChain);

    // Convert wei/lamports to decimal for limit checks
    const amountNum = isSolanaChain(targetChain)
      ? Number(amountWei) / 1e9    // lamports -> SOL
      : parseFloat(ethers.formatEther(amountWei));  // wei -> ETH

    // Admin bypasses permission checks
    if (!isAdmin(auth)) {
      // Check fund permission
      if (!hasAnyPermission(auth.token.permissions, ['fund'])) {
        logger.permissionDenied('fund', auth.token.agentId, '/fund');
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.FUND_PERMISSION,
          error: 'Token does not have fund permission',
          required: ['fund'],
          have: auth.token.permissions,
        });
        return;
      }

      // Check if token can access the target wallet
      const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, to);
      if (!canAccess) {
        logger.permissionDenied('wallet_access', auth.token.agentId, '/fund');
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.FUND_WALLET_ACCESS,
          error: 'Token does not have access to this wallet',
          required: ['wallet:access'],
          have: auth.token.permissions,
        });
        return;
      }

      // Reserve spending atomically (prevents TOCTOU race between concurrent requests)
      const reserve = reserveSpend(auth.tokenHash, auth.token, 'fund', amountNum, currency);
      if (!reserve.ok) {
        logger.limitExceeded(auth.token.agentId, 'fund', amountNum, reserve.remaining);
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.FUND_LIMIT,
          error: 'Amount exceeds remaining spending limit',
          required: ['fund'],
          have: auth.token.permissions,
          extraPayload: {
            remaining: reserve.remaining,
            requested: amountNum,
          },
        });
        return;
      }
    }

    // Set rollback to release reserved spend on early exit or error
    rollback = () => {
      if (!isAdmin(auth)) releaseSpend(auth.tokenHash, 'fund', amountNum, currency);
    };

    // Look up which agent the target hot wallet belongs to
    const hotWalletInfo = await getHotWallet(to);
    const targetAgentId = hotWalletInfo?.coldWalletId || getPrimaryAgentId();

    // The source agent must be unlocked
    if (targetAgentId && !isAgentUnlocked(targetAgentId)) {
      rollback();
      logger.authFailed('Agent locked', '/fund');
      res.status(401).json({ error: `Agent ${targetAgentId} is locked. Human must unlock it first.` });
      return;
    }
    if (!isUnlocked()) {
      rollback();
      logger.authFailed('Agent locked', '/fund');
      res.status(401).json({ error: 'Cold wallet is locked. Human must unlock it first.' });
      return;
    }

    // --- Solana early branch ---
    if (isSolanaChain(targetChain)) {
      const coldKeypair = targetAgentId ? getAgentSolanaKeypair(targetAgentId) : getSolanaColdKeypair();
      const coldAddress = targetAgentId ? getAgentSolanaAddress(targetAgentId) : getSolanaColdAddress();
      if (!coldKeypair || !coldAddress) {
        rollback();
        res.status(400).json({ error: 'Solana cold wallet not available' });
        return;
      }

      const connection = await getSolanaConnection(targetChain);
      const toPubkey = new PublicKey(to);
      // Pass lamports directly to buildSolTransfer
      const tx = await buildSolTransfer(connection, coldKeypair.publicKey, toPubkey, Number(amountWei));
      const txHash = await sendSolanaTransaction(connection, tx, coldKeypair);

      // Spend already reserved atomically above

      await prisma.log.create({
        data: {
          walletAddress: coldAddress,
          title: 'Agent Fund Transfer',
          description: `Transferred ${amountNum} ${nativeCurrency} to hot wallet ${to.slice(0, 10)}...`,
          txHash
        }
      });

      const actorAgentId = !isAdmin(auth) ? auth.token.agentId || undefined : undefined;
      logger.fund(to, amountNum.toString(), txHash, actorAgentId);

      const remaining = isAdmin(auth)
        ? Infinity
        : getRemainingByType(auth.tokenHash, auth.token, 'fund', currency);

      res.json({
        success: true,
        txHash,
        amount: amountNum.toString(),
        from: coldAddress,
        to,
        chain: targetChain,
        remaining
      });
      return;
    }

    // --- EVM path ---
    const coldAddress = targetAgentId ? getAgentAddress(targetAgentId) : getColdWalletAddress();
    if (!coldAddress) {
      rollback();
      res.status(400).json({ error: 'Cold wallet not available' });
      return;
    }

    // Execute the transfer — amountWei is already in wei, pass directly
    const provider = new ethers.JsonRpcProvider(await getRpcUrl(targetChain));
    const txHash = targetAgentId
      ? await signWithAgent(targetAgentId, {
          to: to.toLowerCase(),
          value: amountWei,
          from: coldAddress
        }, provider)
      : await signWithColdWallet({
          to: to.toLowerCase(),
          value: amountWei,
          from: coldAddress
        }, provider);

    // Spend already reserved atomically above

    // Log the transaction
    await prisma.log.create({
      data: {
        walletAddress: coldAddress,
        title: 'Agent Fund Transfer',
        description: `Transferred ${amountNum} ETH to hot wallet ${to.slice(0, 10)}...`,
        txHash
      }
    });

    // Log fund event
    const actorAgentId = !isAdmin(auth) ? auth.token.agentId || undefined : undefined;
    logger.fund(to, amountNum.toString(), txHash, actorAgentId);

    // Get remaining for response
    const remaining = isAdmin(auth)
      ? Infinity
      : getRemainingByType(auth.tokenHash, auth.token, 'fund', currency);

    res.json({
      success: true,
      txHash,
      amount: amountNum.toString(),
      from: coldAddress,
      to: to.toLowerCase(),
      chain: targetChain,
      remaining
    });
  } catch (error) {
    rollback();
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

export default router;
