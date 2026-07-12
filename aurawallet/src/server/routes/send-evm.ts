import { Request, Response } from 'express';
import { ethers } from 'ethers';
import { getHotWallet, signWithHotWallet, tokenCanAccessWallet } from '../lib/hot';
import { getTempWallet, signWithTempWallet } from '../lib/temp';
import { isUnlocked, getColdWalletAddress, listAgents } from '../lib/cold';
import { reserveSpend, releaseSpend } from '../lib/sessions';
import { getRpcUrl } from '../lib/config';
import { logger } from '../lib/logger';
import { hasAnyPermission, isAdmin } from '../lib/permissions';
import { getErrorMessage, HttpError } from '../lib/error';
import { recordTransaction, autoTrackToken } from '../lib/transactions';
import type { AuthInfo } from '../middleware/auth';
import type { ChainConfig } from '../lib/config';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';

export async function handleEvmSend(
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
      gasLimit,
      gasPrice,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      tokenAddress,
      description: userDescription
    } = req.body;

    // 'to' may have been resolved by the dispatcher (ENS resolution)
    const to = req.body.to;
    const rawValue = amount || value;

    // Parse value
    let valueWei = BigInt(0);
    let valueEth = 0;
    if (rawValue) {
      if (typeof rawValue === 'string') {
        valueWei = BigInt(rawValue);
      } else if (typeof rawValue === 'number') {
        valueWei = BigInt(rawValue);
      }
      valueEth = parseFloat(ethers.formatEther(valueWei));
    }

    const provider = new ethers.JsonRpcProvider(await getRpcUrl(targetChain));

    // Determine wallet type
    const hotWallet = await getHotWallet(from);
    const tempWallet = getTempWallet(from);

    let txHash: string;

    // Build transaction object
    const tx: ethers.TransactionRequest = {
      from,
      value: valueWei
    };

    if (to) tx.to = to;
    if (data) tx.data = data;
    if (gasLimit) tx.gasLimit = BigInt(gasLimit);
    if (nonce !== undefined) tx.nonce = nonce;

    // Gas price settings (EIP-1559 or legacy)
    if (maxFeePerGas) {
      tx.maxFeePerGas = BigInt(maxFeePerGas);
      if (maxPriorityFeePerGas) {
        tx.maxPriorityFeePerGas = BigInt(maxPriorityFeePerGas);
      }
    } else if (gasPrice) {
      tx.gasPrice = BigInt(gasPrice);
    }

    // ERC-20 token send: encode transfer(to, amount) calldata
    const isTokenSend = !!tokenAddress;
    if (isTokenSend) {
      if (!to) {
        res.status(400).json({ error: 'to address is required for token sends' });
        return;
      }
      const iface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
      tx.data = iface.encodeFunctionData('transfer', [to, valueWei]);
      tx.to = tokenAddress;    // send to the token contract
      tx.value = 0n;           // no native value
    }

    // Check if this send is going to any agent's EVM address (returning funds to agent bypasses limit)
    const coldAddress = getColdWalletAddress();
    let isSendToAgent = to && coldAddress && to.toLowerCase() === coldAddress.toLowerCase();
    if (!isSendToAgent && to) {
      const agents = listAgents();
      isSendToAgent = agents.some(v => v.address.toLowerCase() === to.toLowerCase());
    }

    if (hotWallet) {
      // Check permission
      if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['send:hot'])) {
        logger.permissionDenied('send:hot', auth.token.agentId, '/send');
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.SEND_EVM_HOT_PERMISSION,
          error: 'Token does not have send:hot permission',
          required: ['send:hot'],
          have: auth.token.permissions,
        });
        return;
      }

      // Verify token can access this wallet
      const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, from);
      if (!isAdmin(auth) && !canAccess) {
        logger.permissionDenied('wallet_access', auth.token.agentId, '/send');
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.SEND_EVM_WALLET_ACCESS,
          error: 'Token does not have access to this wallet',
          required: ['wallet:access'],
          have: auth.token.permissions,
        });
        return;
      }

      // Reserve spending atomically (prevents TOCTOU race between concurrent requests)
      // Token sends skip native spending limits (spending tokens, not ETH)
      const needsHotLimit = !isAdmin(auth) && !isSendToAgent && !isTokenSend && valueEth > 0;
      if (needsHotLimit) {
        const reserve = reserveSpend(auth.tokenHash, auth.token, 'send', valueEth);
        if (!reserve.ok) {
          logger.limitExceeded(auth.token.agentId, 'send', valueEth, reserve.remaining);
          await respondPermissionDenied({
            req,
            res,
            routeId: ESCALATION_ROUTE_IDS.SEND_EVM_HOT_LIMIT,
            error: 'Amount exceeds remaining send limit',
            required: ['send:hot'],
            have: auth.token.permissions,
            extraPayload: {
              remaining: reserve.remaining,
              requested: valueEth,
            },
          });
          return;
        }
      }

      if (!isUnlocked()) {
        if (needsHotLimit) releaseSpend(auth.tokenHash, 'send', valueEth);
        logger.authFailed('Cold wallet locked', '/send');
        res.status(401).json({ error: 'Cold wallet must be unlocked to send from hot wallet' });
        return;
      }

      try {
        const result = await signWithHotWallet(from, tx, provider);
        txHash = result.hash;
      } catch (err) {
        if (needsHotLimit) releaseSpend(auth.tokenHash, 'send', valueEth);
        throw err;
      }
    } else if (tempWallet) {
      // Check permission
      if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['send:temp'])) {
        logger.permissionDenied('send:temp', auth.token.agentId, '/send');
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.SEND_EVM_TEMP_PERMISSION,
          error: 'Token does not have send:temp permission',
          required: ['send:temp'],
          have: auth.token.permissions,
        });
        return;
      }

      // Reserve spending atomically for temp wallets too
      // Token sends skip native spending limits (spending tokens, not ETH)
      const needsTempLimit = !isAdmin(auth) && !isSendToAgent && !isTokenSend && valueEth > 0;
      if (needsTempLimit) {
        const reserve = reserveSpend(auth.tokenHash, auth.token, 'send', valueEth);
        if (!reserve.ok) {
          logger.limitExceeded(auth.token.agentId, 'send', valueEth, reserve.remaining);
          await respondPermissionDenied({
            req,
            res,
            routeId: ESCALATION_ROUTE_IDS.SEND_EVM_TEMP_LIMIT,
            error: 'Amount exceeds remaining send limit',
            required: ['send:temp'],
            have: auth.token.permissions,
            extraPayload: {
              remaining: reserve.remaining,
              requested: valueEth,
            },
          });
          return;
        }
      }

      try {
        txHash = await signWithTempWallet(from, tx, provider);
      } catch (err) {
        if (needsTempLimit) releaseSpend(auth.tokenHash, 'send', valueEth);
        throw err;
      }
    } else {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    // Log the transaction
    const tokenAmountStr = rawValue || '0';
    const txType = data && !isTokenSend ? 'contract' : 'send';
    const description = userDescription || (isTokenSend
      ? `Sent ${tokenAmountStr} tokens of ${tokenAddress} to ${to}`
      : data
        ? `Contract call to ${to || 'deploy'} with ${ethers.formatEther(valueWei)} ETH`
        : `Sent ${ethers.formatEther(valueWei)} ETH to ${to}`);

    await recordTransaction({
      walletAddress: from,
      txHash,
      type: txType,
      amount: isTokenSend ? undefined : ethers.formatEther(valueWei),
      tokenAddress: isTokenSend ? tokenAddress : undefined,
      tokenAmount: isTokenSend ? tokenAmountStr : undefined,
      from,
      to,
      description,
      chain: targetChain,
      logTitle: isTokenSend ? 'Token Send' : data ? 'Contract Transaction' : 'Send Transaction',
    });

    // Auto-track token after successful ERC-20 send
    if (isTokenSend) {
      await autoTrackToken({
        walletAddress: from,
        tokenAddress,
        chain: targetChain,
      });
    }

    // Log send event (only for simple sends and token sends, not contract calls)
    if ((!data || isTokenSend) && to) {
      const agentId = !isAdmin(auth) ? auth.token.agentId : undefined;
      const amountStr = isTokenSend ? `${tokenAmountStr} tokens` : ethers.formatEther(valueWei);
      logger.send(from, to, amountStr, txHash, agentId);
    }

    const response: Record<string, unknown> = {
      success: true,
      hash: txHash,
      from,
      to: to || null,
      chain: targetChain
    };

    if (isTokenSend) {
      response.tokenAddress = tokenAddress;
      response.tokenAmount = tokenAmountStr;
    } else {
      response.amount = ethers.formatEther(valueWei);
      response.value = valueWei.toString();
    }

    if (data && !isTokenSend) {
      response.type = 'contract';
      response.data = data.slice(0, 10) + '...'; // Just show selector
    }

    res.json(response);
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(400).json({ error: getErrorMessage(error) });
  }
}
