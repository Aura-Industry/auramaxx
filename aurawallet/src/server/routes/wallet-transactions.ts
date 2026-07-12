import { Router, Request, Response } from 'express';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getColdWalletAddress, getSolanaColdAddress } from '../lib/cold';
import { listHotWallets, tokenCanAccessWallet, getHotWallet } from '../lib/hot';
import { listTempWallets } from '../lib/temp';
import { requireWalletAuth, optionalWalletAuth } from '../middleware/auth';
import { hasAnyPermission, isAdmin } from '../lib/permissions';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';
import { prisma } from '../lib/db';
import { isSolanaChain, normalizeAddress } from '../lib/address';
import { getSolanaConnection } from '../lib/solana/connection';
import { events } from '../lib/events';
import { fetchAndDecodeEvents } from '../lib/txhistory';
import { getErrorMessage } from '../lib/error';

const router = Router();

// GET /wallets/transactions - List all transactions across wallets
// Agents without wallet:list only see transactions for their own wallets
router.get('/transactions', optionalWalletAuth, async (req: Request, res: Response) => {
  try {
    const auth = req.auth;
    const isAgent = auth && !isAdmin(auth);
    const canListAll = isAgent && hasAnyPermission(auth.token.permissions, ['wallet:list']);

    // Parse query params
    const {
      wallet: walletFilter,
      type,
      status,
      token: tokenAddress,
      chain,
      search,
      limit = '50',
      offset = '0',
      sortBy = 'createdAt',
      sortDir = 'desc'
    } = req.query as Record<string, string>;

    const take = Math.min(parseInt(limit) || 50, 250);
    const skip = parseInt(offset) || 0;

    // Build where clause
    const where: Record<string, unknown> = {};

    // Scope to accessible wallets for agents without wallet:list
    if (isAgent && !canListAll) {
      const ownedWallets = await listHotWallets(auth.tokenHash);
      const addresses = ownedWallets.map(w => w.address.toLowerCase());
      if (addresses.length === 0) {
        res.json({ success: true, transactions: [], pagination: { total: 0, limit: take, offset: skip, hasMore: false } });
        return;
      }
      where.walletAddress = { in: addresses };
    }

    // Apply wallet filter (further narrow if specified)
    if (walletFilter) {
      const addr = walletFilter.toLowerCase();
      // If agent-scoped, verify they can access this wallet
      if (isAgent && !canListAll) {
        const inScope = (where.walletAddress as { in: string[] })?.in?.includes(addr);
        if (!inScope) {
          await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_TX_LIST_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
          return;
        }
      }
      where.walletAddress = addr;
    }

    if (type) where.type = type;
    if (status) where.status = status;
    if (chain) where.chain = chain;
    if (tokenAddress) where.tokenAddress = tokenAddress.toLowerCase();
    if (search) {
      where.OR = [
        { description: { contains: search.toLowerCase() } },
        { txHash: { contains: search.toLowerCase() } },
        { to: { contains: search.toLowerCase() } },
        { from: { contains: search.toLowerCase() } }
      ];
    }

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: { [sortBy]: sortDir },
        take,
        skip
      }),
      prisma.transaction.count({ where })
    ]);

    res.json({
      success: true,
      transactions,
      pagination: {
        total,
        limit: take,
        offset: skip,
        hasMore: skip + transactions.length < total
      }
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// GET /wallet/:address/transactions - List transactions for a wallet
// Our wallets: returns from DB. External addresses: on-chain fallback via eth_getLogs / Solana.
router.get('/:address/transactions', optionalWalletAuth, async (req: Request<{ address: string }>, res: Response) => {
  try {
    const { address } = req.params;
    const auth = req.auth;
    const agentCanListAll = !!(
      auth &&
      !isAdmin(auth) &&
      hasAnyPermission(auth.token.permissions, ['wallet:list'])
    );

    // Check if this is one of our wallets (hot/cold/temp)
    const hotWallet = await getHotWallet(address);
    const coldEvmAddress = getColdWalletAddress();
    const coldSolAddress = getSolanaColdAddress();
    const isColdEvm = coldEvmAddress
      ? normalizeAddress(coldEvmAddress, 'base') === normalizeAddress(address, 'base')
      : false;
    const isColdSol = coldSolAddress ? coldSolAddress === address : false;
    const tempWallet = listTempWallets().find((w) =>
      normalizeAddress(w.address, w.chain) === normalizeAddress(address, w.chain)
    );

    if (hotWallet || isColdEvm || isColdSol || tempWallet) {
      // --- DB path (existing behavior, unchanged) ---
      if (auth && !isAdmin(auth)) {
        if (hotWallet && !agentCanListAll) {
          const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, address);
          if (!canAccess) {
            await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_TX_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
            return;
          }
        } else if (!hotWallet && !agentCanListAll) {
          await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_TX_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
          return;
        }
      }

      const {
        type,
        status,
        token: tokenAddress,
        search,
        chain: chainFilter,
        limit = '50',
        offset = '0',
        sortBy = 'createdAt',
        sortDir = 'desc'
      } = req.query as Record<string, string>;

      const take = Math.min(parseInt(limit) || 50, 250);
      const skip = parseInt(offset) || 0;

      const resolvedChain = hotWallet?.metadata.chain
        || (isColdSol ? 'solana' : undefined)
        || (tempWallet ? (tempWallet.chain === 'any' ? 'base' : tempWallet.chain) : undefined)
        || 'base';
      const normalizedWalletAddress = normalizeAddress(address, resolvedChain);

      const where: Record<string, unknown> = {
        walletAddress: normalizedWalletAddress
      };

      if (type) where.type = type;
      if (status) where.status = status;
      if (tokenAddress) where.tokenAddress = tokenAddress.toLowerCase();
      if (chainFilter) where.chain = chainFilter;
      if (search) {
        where.OR = [
          { description: { contains: search.toLowerCase() } },
          { txHash: { contains: search.toLowerCase() } },
          { to: { contains: search.toLowerCase() } },
          { from: { contains: search.toLowerCase() } }
        ];
      }

      const [transactions, total] = await Promise.all([
        prisma.transaction.findMany({
          where,
          orderBy: { [sortBy]: sortDir },
          take,
          skip
        }),
        prisma.transaction.count({ where })
      ]);

      res.json({
        success: true,
        source: 'db',
        transactions,
        pagination: {
          total,
          limit: take,
          offset: skip,
          hasMore: skip + transactions.length < total
        }
      });
      return;
    }

    // --- On-chain path (external address, no auth required) ---
    const chain = (req.query.chain as string) || 'base';

    if (isSolanaChain(chain)) {
      // Solana path
      await handleSolanaTransactions(address, chain, req, res);
    } else {
      // EVM path
      await handleEvmTransactions(address, chain, req, res);
    }
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

/** Handle EVM on-chain transaction history via eth_getLogs */
async function handleEvmTransactions(address: string, chain: string, req: Request, res: Response): Promise<void> {
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
  const types = (req.query.types as string)?.split(',').filter(Boolean) || undefined;
  const fromBlock = req.query.fromBlock ? BigInt(req.query.fromBlock as string) : undefined;
  const toBlock = req.query.toBlock ? BigInt(req.query.toBlock as string) : undefined;
  const tokenAddress = req.query.token as string | undefined;
  try {
    const result = await fetchAndDecodeEvents({
      address,
      chain,
      fromBlock,
      toBlock,
      limit,
      types,
      tokenAddress,
    });

    res.json({
      success: true,
      source: 'on-chain',
      chain,
      blockRange: result.blockRange,
      transactions: result.transactions,
      pagination: {
        total: result.total,
        limit,
        offset: 0,
        hasMore: false,
        returned: result.transactions.length,
      },
    });
  } catch (err) {
    const message = getErrorMessage(err);
    const rateLimited = message.includes('Status: 429') || message.toLowerCase().includes('over rate limit');
    if (rateLimited) {
      res.json({
        success: true,
        source: 'on-chain',
        chain,
        rateLimited: true,
        transactions: [],
        pagination: {
          total: 0,
          limit,
          offset: 0,
          hasMore: false,
          returned: 0,
        },
      });
      return;
    }
    throw err;
  }
}

/** Handle Solana on-chain transaction history */
async function handleSolanaTransactions(address: string, chain: string, req: Request, res: Response): Promise<void> {
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);

  const connection = await getSolanaConnection(chain);
  const pubkey = new PublicKey(address);

  // Get recent signatures
  const signatures = await connection.getSignaturesForAddress(pubkey, { limit });

  if (signatures.length === 0) {
    res.json({
      success: true,
      source: 'on-chain',
      chain,
      transactions: [],
      pagination: { total: 0, limit, offset: 0, hasMore: false, returned: 0 },
    });
    return;
  }

  // Fetch parsed transactions
  const txSigs = signatures.map(s => s.signature);
  const parsedTxs = await connection.getParsedTransactions(txSigs, {
    maxSupportedTransactionVersion: 0,
  });

  const transactions = [];
  for (let i = 0; i < signatures.length; i++) {
    const sig = signatures[i];
    const parsed = parsedTxs[i];
    if (!parsed) continue;

    const tx = parseSolanaTransaction(parsed, address, sig);
    if (tx) transactions.push(tx);
  }

  res.json({
    success: true,
    source: 'on-chain',
    chain,
    transactions,
    pagination: {
      total: signatures.length,
      limit,
      offset: 0,
      hasMore: false,
      returned: transactions.length,
    },
  });
}

/** Parse a Solana parsed transaction into an enriched summary */
function parseSolanaTransaction(
  parsed: any,
  address: string,
  sig: { signature: string; blockTime?: number | null; slot: number; err: any },
): { type: string; summary: string; txHash: string; blockNumber: string; timestamp?: number; details: Record<string, unknown> } | null {
  const instructions = parsed.transaction?.message?.instructions || [];
  const addr = address;

  // Detect SOL transfers (system program)
  for (const ix of instructions) {
    if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
      const info = ix.parsed.info;
      const isIncoming = info.destination === addr;
      const amount = (info.lamports / LAMPORTS_PER_SOL).toString();
      const counterparty = isIncoming ? info.source : info.destination;
      const short = `${counterparty.slice(0, 4)}...${counterparty.slice(-4)}`;
      return {
        type: 'transfer',
        summary: isIncoming ? `Received ${amount} SOL from ${short}` : `Sent ${amount} SOL to ${short}`,
        txHash: sig.signature,
        blockNumber: sig.slot.toString(),
        timestamp: sig.blockTime ?? undefined,
        details: {
          from: info.source,
          to: info.destination,
          amount,
          symbol: 'SOL',
          direction: isIncoming ? 'in' : 'out',
        },
      };
    }
  }

  // Detect SPL token transfers
  for (const ix of instructions) {
    if (ix.program === 'spl-token' && ix.parsed?.type === 'transferChecked') {
      const info = ix.parsed.info;
      const amount = info.tokenAmount?.uiAmountString || '0';
      const mint = info.mint || '';
      return {
        type: 'transfer',
        summary: `Transferred ${amount} tokens (${mint.slice(0, 6)}...)`,
        txHash: sig.signature,
        blockNumber: sig.slot.toString(),
        timestamp: sig.blockTime ?? undefined,
        details: {
          amount,
          mint,
          source: info.source,
          destination: info.destination,
        },
      };
    }
    if (ix.program === 'spl-token' && ix.parsed?.type === 'transfer') {
      const info = ix.parsed.info;
      const amount = info.amount || '0';
      return {
        type: 'transfer',
        summary: `Transferred ${amount} tokens`,
        txHash: sig.signature,
        blockNumber: sig.slot.toString(),
        timestamp: sig.blockTime ?? undefined,
        details: {
          amount,
          source: info.source,
          destination: info.destination,
        },
      };
    }
  }

  // Fallback: generic transaction
  return {
    type: sig.err ? 'failed' : 'contract',
    summary: sig.err ? `Failed transaction` : `Contract interaction`,
    txHash: sig.signature,
    blockNumber: sig.slot.toString(),
    timestamp: sig.blockTime ?? undefined,
    details: {
      status: sig.err ? 'failed' : 'confirmed',
      programIds: instructions.map((ix: any) => ix.programId?.toString() || ix.program).filter(Boolean),
    },
  };
}

// POST /wallet/:address/transactions - Add a manual transaction record
router.post('/:address/transactions', requireWalletAuth, async (req: Request<{ address: string }>, res: Response) => {
  try {
    const { address } = req.params;
    const auth = req.auth!;

    // Check permission
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['wallet:tx:add'])) {
      await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_TX_ADD_PERMISSION, error: 'Token does not have wallet:tx:add permission', required: ['wallet:tx:add'], have: auth.token.permissions });
      return;
    }

    // Verify wallet exists and access
    const wallet = await getHotWallet(address);
    if (!wallet) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    if (!isAdmin(auth)) {
      const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, address);
      if (!canAccess) {
        await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_TX_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
        return;
      }
    }

    const {
      txHash,
      type,
      amount,
      tokenAddress,
      tokenAmount,
      from,
      to,
      description,
      blockNumber,
      chain = 'base',
      status = 'confirmed',
      executedAt
    } = req.body;

    if (!type || !['send', 'receive', 'swap', 'contract', 'manual'].includes(type)) {
      res.status(400).json({ error: 'type must be one of: send, receive, swap, contract, manual' });
      return;
    }

    // Check for duplicate txHash
    if (txHash) {
      const existing = await prisma.transaction.findUnique({
        where: { txHash_chain: { txHash, chain } }
      });
      if (existing) {
        res.status(409).json({ error: 'Transaction with this hash already exists', existing });
        return;
      }
    }

    const transaction = await prisma.transaction.create({
      data: {
        walletAddress: address.toLowerCase(),
        txHash,
        type,
        status,
        amount,
        tokenAddress: tokenAddress?.toLowerCase(),
        tokenAmount,
        from: from?.toLowerCase(),
        to: to?.toLowerCase(),
        description,
        blockNumber,
        chain,
        executedAt: executedAt ? new Date(executedAt) : undefined
      }
    });

    // Emit tx created event
    events.txCreated({
      walletAddress: address.toLowerCase(),
      id: transaction.id,
      type,
      txHash,
      amount,
      tokenAddress: tokenAddress?.toLowerCase(),
      tokenAmount,
      description
    });

    res.json({ success: true, transaction });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

export default router;
