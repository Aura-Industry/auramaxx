import { Request, Response } from 'express';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { getHotWallet, tokenCanAccessWallet } from '../lib/hot';
import { getTempSolanaKeypair, hasTempWallet } from '../lib/temp';
import { isUnlocked, getSolanaColdAddress, listAgents } from '../lib/cold';
import { reserveSpend, releaseSpend } from '../lib/sessions';
import { logger } from '../lib/logger';
import { hasAnyPermission, isAdmin } from '../lib/permissions';
import { getNativeAddress, getNativeCurrency } from '../lib/address';
import { getSolanaConnection } from '../lib/solana/connection';
import { getSolanaKeypair } from '../lib/solana/wallet';
import { buildSolTransfer, buildSplTransfer, sendSolanaTransaction } from '../lib/solana/transfer';
import { getErrorMessage, HttpError } from '../lib/error';
import { recordTransaction, autoTrackToken } from '../lib/transactions';
import type { AuthInfo } from '../middleware/auth';
import type { ChainConfig } from '../lib/config';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';

export async function handleSolanaSend(
  req: Request,
  res: Response,
  auth: AuthInfo,
  targetChain: string,
  chainConfig: ChainConfig
): Promise<void> {
  try {
    const {
      from,
      amount,
      value,
      data,
      chain,
      tokenAddress,
      transaction: rawTransaction,
      description: userDescription
    } = req.body;

    // 'to' may have been resolved by the dispatcher (ENS resolution)
    const to = req.body.to;
    const rawValue = amount || value;

    // Parse value for limit checks
    let valueWei = BigInt(0);
    if (rawValue) {
      valueWei = BigInt(rawValue);
    }

    // 'to' is required for simple sends, but not for raw VersionedTransaction
    if (!rawTransaction && !to) {
      res.status(400).json({ error: 'to address is required for Solana sends' });
      return;
    }

    const currency = getNativeAddress(targetChain);
    const nativeCurrency = getNativeCurrency(targetChain);

    // Determine wallet type
    const hotWallet = await getHotWallet(from);
    const isTempWallet = hasTempWallet(from);

    if (!hotWallet && !isTempWallet) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    // Permission checks
    if (hotWallet) {
      if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['send:hot'])) {
        logger.permissionDenied('send:hot', auth.token.agentId, '/send');
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.SEND_SOLANA_HOT_PERMISSION,
          error: 'Token does not have send:hot permission',
          required: ['send:hot'],
          have: auth.token.permissions,
        });
        return;
      }
      const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, from, targetChain);
      if (!isAdmin(auth) && !canAccess) {
        logger.permissionDenied('wallet_access', auth.token.agentId, '/send');
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.SEND_SOLANA_WALLET_ACCESS,
          error: 'Token does not have access to this wallet',
          required: ['wallet:access'],
          have: auth.token.permissions,
        });
        return;
      }
    } else if (isTempWallet) {
      if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['send:temp'])) {
        logger.permissionDenied('send:temp', auth.token.agentId, '/send');
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.SEND_SOLANA_TEMP_PERMISSION,
          error: 'Token does not have send:temp permission',
          required: ['send:temp'],
          have: auth.token.permissions,
        });
        return;
      }
    }

    if (!isUnlocked()) {
      logger.authFailed('Cold wallet locked', '/send');
      res.status(401).json({ error: 'Cold wallet must be unlocked to send from hot wallet' });
      return;
    }

    // Get signer keypair (shared by both raw tx and simple transfer paths)
    let signerKeypair;
    if (hotWallet) {
      signerKeypair = await getSolanaKeypair(from);
    } else {
      signerKeypair = getTempSolanaKeypair(from);
      if (!signerKeypair) {
        res.status(404).json({ error: 'Temp Solana wallet not found' });
        return;
      }
    }

    // --- Raw VersionedTransaction path ---
    if (rawTransaction) {
      if (typeof rawTransaction !== 'string') {
        res.status(400).json({ error: 'transaction must be a base64-encoded string' });
        return;
      }

      let tx: VersionedTransaction;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(rawTransaction, 'base64'));
      } catch (err) {
        res.status(400).json({ error: 'Invalid transaction: failed to deserialize VersionedTransaction' });
        return;
      }

      const connection = await getSolanaConnection(targetChain);

      // Sign and submit
      tx.sign([signerKeypair]);
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 2,
      });
      await connection.confirmTransaction(signature, 'confirmed');

      // Log
      const description = userDescription || `Program transaction from ${from}`;
      await recordTransaction({
        walletAddress: from,
        txHash: signature,
        type: 'contract',
        amount: '0',
        from,
        to: to || undefined,
        description,
        chain: targetChain,
        logTitle: 'Program Transaction',
      });

      res.json({
        success: true,
        hash: signature,
        from,
        chain: targetChain,
        type: 'program'
      });
      return;
    }

    // --- SPL Token transfer path ---
    if (tokenAddress) {
      const connection = await getSolanaConnection(targetChain);
      const fromPubkey = new PublicKey(from);
      const toPubkey = new PublicKey(to!);
      const mint = new PublicKey(tokenAddress);

      // Resolve decimals from on-chain mint account
      const mintInfo = await getMint(connection, mint);
      const decimals = mintInfo.decimals;

      // Token sends skip native spending limits (spending tokens, not SOL)
      let txHash: string;
      try {
        const tx = await buildSplTransfer(connection, fromPubkey, toPubkey, mint, BigInt(rawValue || '0'), decimals);
        txHash = await sendSolanaTransaction(connection, tx, signerKeypair);
      } catch (err) {
        throw err;
      }

      // Log
      const tokenAmountStr = rawValue || '0';
      const description = userDescription || `Sent ${tokenAmountStr} tokens of ${tokenAddress} to ${to}`;
      await recordTransaction({
        walletAddress: from,
        txHash,
        type: 'send',
        tokenAddress,
        tokenAmount: tokenAmountStr,
        from,
        to: to!,
        description,
        chain: targetChain,
        logTitle: 'Token Send',
      });

      await autoTrackToken({
        walletAddress: from,
        tokenAddress,
        chain: targetChain,
      });

      const agentId = !isAdmin(auth) ? auth.token.agentId : undefined;
      logger.send(from, to!, `${tokenAmountStr} tokens`, txHash, agentId);

      res.json({
        success: true,
        hash: txHash,
        from,
        to,
        tokenAddress,
        tokenAmount: tokenAmountStr,
        chain: targetChain
      });
      return;
    }

    // --- Simple SOL transfer path ---

    // Check if send is going to any agent's Solana address (agent bypass)
    const solColdAddress = getSolanaColdAddress();
    let isSendToAgent = solColdAddress && to === solColdAddress;
    if (!isSendToAgent) {
      const agents = listAgents();
      isSendToAgent = agents.some(v => v.solanaAddress === to);
    }

    // For Solana, convert lamports to SOL for limit checks (9 decimals, not 18)
    const valueSol = Number(valueWei) / 1e9;

    // Reserve spending atomically (prevents TOCTOU race between concurrent requests)
    const needsLimit = !isAdmin(auth) && !isSendToAgent && valueSol > 0;
    if (needsLimit) {
      const reserve = reserveSpend(auth.tokenHash, auth.token, 'send', valueSol, currency);
      if (!reserve.ok) {
        logger.limitExceeded(auth.token.agentId, 'send', valueSol, reserve.remaining);
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.SEND_SOLANA_HOT_LIMIT,
          error: 'Amount exceeds remaining send limit',
          required: ['send:hot'],
          have: auth.token.permissions,
          extraPayload: {
            remaining: reserve.remaining,
            requested: valueSol,
          },
        });
        return;
      }
    }

    let txHash: string;
    try {
      const connection = await getSolanaConnection(targetChain);
      const fromPubkey = new PublicKey(from);
      const toPubkey = new PublicKey(to!);

      // Build SOL transfer -- pass lamports directly
      const tx = await buildSolTransfer(connection, fromPubkey, toPubkey, Number(valueWei));

      txHash = await sendSolanaTransaction(connection, tx, signerKeypair);
    } catch (err) {
      if (needsLimit) releaseSpend(auth.tokenHash, 'send', valueSol, currency);
      throw err;
    }

    // Log
    const description = userDescription || `Sent ${valueSol} ${nativeCurrency} to ${to}`;
    await recordTransaction({
      walletAddress: from,
      txHash,
      type: 'send',
      amount: valueSol.toString(),
      from,
      to: to!,
      description,
      chain: targetChain,
      logTitle: 'Send Transaction',
    });

    if (!data) {
      const agentId = !isAdmin(auth) ? auth.token.agentId : undefined;
      logger.send(from, to!, valueSol.toString(), txHash, agentId);
    }

    res.json({
      success: true,
      hash: txHash,
      from,
      to,
      amount: valueSol.toString(),
      chain: targetChain
    });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
}
