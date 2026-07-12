import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { isUnlocked, getColdWalletInfo, getColdWalletAddress, exportSeed, getSolanaColdAddress, listAgents, exportAgentSeed, getAgentAddress, isAgentUnlocked } from '../lib/cold';
import { createHotWallet, listHotWallets, updateHotWallet, exportHotWallet, tokenCanAccessWallet, searchHotWallets, getHotWallet } from '../lib/hot';
import { createTempWallet, listTempWallets } from '../lib/temp';
import { getRpcUrl } from '../lib/config';
import { events } from '../lib/events';
import { requireWalletAuth, optionalWalletAuth } from '../middleware/auth';
import { hasAnyPermission, isAdmin } from '../lib/permissions';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';
import { prisma } from '../lib/db';
import { isSolanaChain, normalizeAddress } from '../lib/address';
import { getSolanaConnection } from '../lib/solana/connection';
import { logger } from '../lib/logger';
import { getErrorMessage } from '../lib/error';
import transactionRoutes from './wallet-transactions';
import assetRoutes from './wallet-assets';

/**
 * Fetch balance for a single address using JSON-RPC
 */
export async function fetchBalance(address: string, chain: string = 'base'): Promise<string> {
  try {
    // Solana balance fetch
    if (isSolanaChain(chain)) {
      const connection = await getSolanaConnection(chain);
      const pubkey = new PublicKey(address);
      const lamports = await connection.getBalance(pubkey);
      return (lamports / LAMPORTS_PER_SOL).toString();
    }

    // EVM balance fetch
    const rpcUrl = await getRpcUrl(chain);
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [address, 'latest']
      })
    });
    const data = await response.json();
    if (data.result) {
      return ethers.formatEther(data.result);
    }
    return '0';
  } catch (error) {
    console.error(`[Balance] Failed to fetch for ${address}:`, error);
    return '0';
  }
}

/**
 * Batch fetch balances for multiple addresses.
 * Groups by chain type: Solana uses getMultipleAccountsInfo, EVM uses JSON-RPC batch.
 */
export async function fetchBalances(
  addresses: string[],
  chain: string = 'base',
  addressChainMap?: Map<string, string>
): Promise<Map<string, string>> {
  const balances = new Map<string, string>();
  if (addresses.length === 0) return balances;

  // Separate Solana and EVM addresses
  const solanaAddrs: string[] = [];
  const evmAddrs: string[] = [];

  for (const addr of addresses) {
    const addrChain = addressChainMap?.get(addr) || chain;
    if (isSolanaChain(addrChain)) {
      solanaAddrs.push(addr);
    } else {
      evmAddrs.push(addr);
    }
  }

  // Fetch Solana balances
  if (solanaAddrs.length > 0) {
    try {
      const solChain = addressChainMap?.get(solanaAddrs[0]) || 'solana';
      const connection = await getSolanaConnection(solChain);
      const pubkeys = solanaAddrs.map(a => new PublicKey(a));
      const accountInfos = await connection.getMultipleAccountsInfo(pubkeys);
      accountInfos.forEach((info, i) => {
        const lamports = info?.lamports || 0;
        balances.set(solanaAddrs[i], (lamports / LAMPORTS_PER_SOL).toString());
      });
    } catch (error) {
      console.error('[Balance] Solana batch fetch failed:', error);
      solanaAddrs.forEach(addr => balances.set(addr, '0'));
    }
  }

  // Fetch EVM balances
  if (evmAddrs.length > 0) {
    try {
      const rpcUrl = await getRpcUrl(chain);
      const batch = evmAddrs.map((address, index) => ({
        jsonrpc: '2.0',
        id: index,
        method: 'eth_getBalance',
        params: [address, 'latest']
      }));

      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch)
      });
      if (!response.ok) {
        throw new Error(`RPC returned ${response.status}: ${response.statusText}`);
      }
      const text = await response.text();
      if (!text || text.trim().length === 0) {
        throw new Error('RPC returned empty response');
      }
      const results = JSON.parse(text);

      if (Array.isArray(results)) {
        results.forEach((result, index) => {
          const address = evmAddrs[index];
          if (result.result) {
            balances.set(address.toLowerCase(), ethers.formatEther(result.result));
          } else {
            balances.set(address.toLowerCase(), '0');
          }
        });
      }
    } catch (error) {
      console.error(`[Balance] EVM batch fetch failed:`, error);
      evmAddrs.forEach(addr => balances.set(addr.toLowerCase(), '0'));
    }
  }

  return balances;
}

const router = Router();

// GET /wallets - List wallets (optional auth for filtering)
// With agent token + wallet:list: returns all hot wallets + cold wallet (read-only) + agent info
// With agent token without wallet:list: returns only owned wallets + agent info
// Without token or admin: returns all wallets
// Query params: tier (cold|hot|temp), chain (base|solana|...), sortBy (balance|createdAt|name), sortDir (asc|desc)
router.get('/', optionalWalletAuth, async (req: Request, res: Response) => {
  try {
    const includeHidden = req.query.includeHidden === 'true';
    const tierFilter = req.query.tier as string | undefined;
    const chainFilter = req.query.chain as string | undefined;
    const sortBy = req.query.sortBy as string | undefined;
    const sortDir = (req.query.sortDir as string)?.toLowerCase() === 'asc' ? 'asc' : 'desc';
    const auth = req.auth;

    // Determine if filtering for agent (non-admin token provided)
    const isAgent = auth && !isAdmin(auth);
    // Agents with wallet:list permission can see all hot wallets + cold wallet info
    const canListAll = isAgent && hasAnyPermission(auth.token.permissions, ['wallet:list']);
    const tokenHash = (isAgent && !canListAll) ? auth.tokenHash : undefined;

    // Get wallets (filtered by tokenHash for agents without wallet:list)
    const hotWallets = await listHotWallets(tokenHash, includeHidden);
    // Temp wallets are not associated with tokens, return empty for agents without wallet:list
    const tempWallets = (isAgent && !canListAll) ? [] : listTempWallets();

    // Agents with wallet:list can see cold wallet info (read-only: address + balance)
    const coldInfo = (isAgent && !canListAll) ? null : getColdWalletInfo();

    // Build chain map for multi-chain balance fetching
    const allAddresses: string[] = [];
    const addressChainMap = new Map<string, string>();

    if (coldInfo) {
      allAddresses.push(coldInfo.address);
      // Cold wallet is EVM by default
    }

    // Also include Solana cold address if available
    const solColdAddr = (isAgent && !canListAll) ? null : getSolanaColdAddress();
    if (solColdAddr) {
      allAddresses.push(solColdAddr);
      addressChainMap.set(solColdAddr, 'solana');
    }

    hotWallets.forEach(w => {
      allAddresses.push(w.address);
      if (isSolanaChain(w.chain)) {
        addressChainMap.set(w.address, w.chain);
      }
    });
    tempWallets.forEach(w => {
      allAddresses.push(w.address);
      if (isSolanaChain(w.chain)) {
        addressChainMap.set(w.address, w.chain);
      }
    });

    // Try cached balances first, fall back to RPC
    const cachedBalances = await prisma.nativeBalance.findMany({
      where: { walletAddress: { in: allAddresses.map(a => normalizeAddress(a, addressChainMap.get(a) || 'base')) } },
    });
    const cachedMap = new Map<string, { balance: string; updatedAt: Date }>();
    for (const cb of cachedBalances) {
      cachedMap.set(`${cb.walletAddress}:${cb.chain}`, { balance: cb.balance, updatedAt: cb.updatedAt });
    }

    // Check which addresses have no cache — fetch those from RPC
    const uncachedAddresses = allAddresses.filter(a => {
      const chain = addressChainMap.get(a) || 'base';
      return !cachedMap.has(`${normalizeAddress(a, chain)}:${chain}`);
    });

    let rpcBalances = new Map<string, string>();
    if (uncachedAddresses.length > 0) {
      rpcBalances = await fetchBalances(uncachedAddresses, 'base', addressChainMap);
    }

    // Helper to get balance (cached first, then RPC)
    const getBalance = (address: string, chain: string): string => {
      const norm = normalizeAddress(address, chain);
      const cached = cachedMap.get(`${norm}:${chain}`);
      if (cached) return cached.balance;
      return rpcBalances.get(norm) || '0';
    };

    const getBalanceUpdatedAt = (address: string, chain: string): string | undefined => {
      const norm = normalizeAddress(address, chain);
      const cached = cachedMap.get(`${norm}:${chain}`);
      return cached?.updatedAt?.toISOString();
    };

    // Add balances to wallets
    let wallets = [
      ...(coldInfo ? [{
        ...coldInfo,
        chain: 'base',
        balance: getBalance(coldInfo.address, 'base'),
        balanceUpdatedAt: getBalanceUpdatedAt(coldInfo.address, 'base'),
      }] : []),
      ...(solColdAddr ? [{
        address: solColdAddr,
        tier: 'cold' as const,
        chain: 'solana',
        balance: getBalance(solColdAddr, 'solana'),
        balanceUpdatedAt: getBalanceUpdatedAt(solColdAddr, 'solana'),
        createdAt: coldInfo?.createdAt,
      }] : []),
      ...hotWallets.map(w => ({
        ...w,
        balance: getBalance(w.address, w.chain),
        balanceUpdatedAt: getBalanceUpdatedAt(w.address, w.chain),
      })),
      ...tempWallets.map(w => ({
        ...w,
        balance: getBalance(w.address, w.chain),
        balanceUpdatedAt: getBalanceUpdatedAt(w.address, w.chain),
      })),
    ];

    // Apply tier filter
    if (tierFilter) {
      wallets = wallets.filter(w => w.tier === tierFilter);
    }

    // Apply chain filter
    if (chainFilter) {
      wallets = wallets.filter(w => w.chain === chainFilter);
    }

    // Apply sorting
    if (sortBy) {
      wallets.sort((a, b) => {
        let cmp = 0;
        if (sortBy === 'balance') {
          cmp = parseFloat(a.balance || '0') - parseFloat(b.balance || '0');
        } else if (sortBy === 'createdAt') {
          const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          cmp = aTime - bTime;
        } else if (sortBy === 'name') {
          const aName = ('name' in a ? (a as { name?: string }).name : '') || '';
          const bName = ('name' in b ? (b as { name?: string }).name : '') || '';
          cmp = aName.localeCompare(bName);
        }
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }

    // Include agents list for non-agent access
    const agents = isAgent ? [] : listAgents();

    // Build response
    const response: {
      wallets: typeof wallets;
      unlocked: boolean;
      agents: typeof agents;
      agent?: { id: string; remaining: number };
    } = {
      wallets,
      unlocked: isUnlocked(),
      agents,
    };

    // Include agent info if authenticated as agent
    if (isAgent && auth) {
      const { getRemaining } = await import('../lib/sessions');
      response.agent = {
        id: auth.token.agentId,
        remaining: getRemaining(auth.tokenHash, auth.token)
      };
    }

    res.json(response);
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// POST /wallet/create - Create hot/temp wallet (requires auth + permission)
router.post('/create', requireWalletAuth, async (req: Request, res: Response) => {
  try {
    const { tier, chain, name, color, description, emoji, hidden, agentId } = req.body;
    const auth = req.auth!;

    if (!tier || !['hot', 'temp'].includes(tier)) {
      res.status(400).json({ error: 'tier must be "hot" or "temp"' });
      return;
    }

    if (tier === 'hot') {
      // Check permission
      if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['wallet:create:hot'])) {
        await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_CREATE_HOT_PERMISSION, error: 'Token does not have wallet:create:hot permission', required: ['wallet:create:hot'], have: auth.token.permissions });
        return;
      }

      // Hot wallet creation requires unlocked cold wallet
      if (!isUnlocked()) {
        res.status(401).json({ error: 'Cold wallet must be unlocked to create hot wallets' });
        return;
      }

      // If agentId specified, verify that agent is unlocked
      if (agentId && !isAgentUnlocked(agentId)) {
        res.status(401).json({ error: `Agent ${agentId} must be unlocked to create hot wallets` });
        return;
      }

      const wallet = await createHotWallet({
        tokenHash: auth.tokenHash,
        chain,
        name,
        color,
        description,
        emoji,
        hidden,
        coldWalletId: agentId || undefined,
      });

      // Emit WebSocket events
      events.walletCreated({
        address: wallet.address,
        tier: 'hot',
        chain: wallet.chain || 'base',
        name: wallet.name,
        tokenHash: auth.tokenHash,
      });
      events.walletChanged({ address: wallet.address, reason: 'created' });
      logger.walletCreated(wallet.address, 'hot', isAdmin(auth) ? undefined : auth.token.agentId);

      res.json({ success: true, wallet });
    } else {
      // Temp wallet
      if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['wallet:create:temp'])) {
        await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_CREATE_TEMP_PERMISSION, error: 'Token does not have wallet:create:temp permission', required: ['wallet:create:temp'], have: auth.token.permissions });
        return;
      }

      const wallet = createTempWallet(chain);

      // Emit WebSocket events
      events.walletCreated({
        address: wallet.address,
        tier: 'temp',
        chain: wallet.chain || 'base',
      });
      events.walletChanged({ address: wallet.address, reason: 'created' });
      logger.walletCreated(wallet.address, 'temp', isAdmin(auth) ? undefined : auth.token.agentId);

      res.json({ success: true, wallet });
    }
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// POST /wallet/rename - Update hot wallet metadata (requires auth)
router.post('/rename', requireWalletAuth, async (req: Request, res: Response) => {
  try {
    const { address, name, color, description, emoji, hidden } = req.body;
    const auth = req.auth!;

    if (!address || typeof address !== 'string') {
      res.status(400).json({ error: 'address is required' });
      return;
    }

    // Check permission (admin bypasses)
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['wallet:rename'])) {
      // Fall back to checking wallet access for legacy compatibility
      const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, address);
      if (!canAccess) {
        await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
        return;
      }
    } else if (!isAdmin(auth)) {
      // Has permission, but still need to verify wallet access
      const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, address);
      if (!canAccess) {
        await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
        return;
      }
    }

    const updates: { name?: string; color?: string; description?: string; emoji?: string; hidden?: boolean } = {};
    if (name !== undefined) updates.name = name || undefined;
    if (color !== undefined) updates.color = color || undefined;
    if (description !== undefined) updates.description = description || undefined;
    if (emoji !== undefined) updates.emoji = emoji || undefined;
    if (hidden !== undefined) updates.hidden = hidden;

    const success = await updateHotWallet(address, updates);

    if (!success) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    events.walletChanged({ address, reason: 'updated' });
    logger.walletRenamed(address, isAdmin(auth) ? undefined : auth.token.agentId);

    res.json({ success: true });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// POST /wallet/:address/export - Export hot wallet private key
// Requires valid token. Admins can export any wallet.
// Non-admin agents: requires wallet:export permission + wallet ownership
router.post('/:address/export', requireWalletAuth, async (req: Request<{ address: string }>, res: Response) => {
  try {
    const { address } = req.params;
    const auth = req.auth!;

    // Cold wallet must be unlocked
    if (!isUnlocked()) {
      res.status(401).json({ error: 'Wallet must be unlocked to export keys' });
      return;
    }

    // Non-admin tokens need explicit permission and wallet ownership
    if (!isAdmin(auth)) {
      // Check permission
      if (!hasAnyPermission(auth.token.permissions, ['wallet:export'])) {
        await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_EXPORT_PERMISSION, error: 'Token does not have wallet:export permission', required: ['wallet:export'], have: auth.token.permissions });
        return;
      }

      // Verify wallet access
      const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, address);
      if (!canAccess) {
        await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
        return;
      }
    }

    const result = await exportHotWallet(address);
    logger.walletExported(address, auth?.token?.agentId);

    res.json({
      success: true,
      address: result.address,
      privateKey: result.privateKey
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// GET/POST /export-seed - Export mnemonic (requires admin)
// Supports optional ?agentId query param to export a specific agent's seed
const handleExportSeed = async (req: Request, res: Response) => {
  try {
    // Must have admin auth
    if (!req.auth || !isAdmin(req.auth)) {
      await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_ADMIN, error: 'Admin access required', required: ['admin:*'], have: req.auth?.token?.permissions, extraPayload: { success: false } });
      return;
    }

    if (!isUnlocked()) {
      res.status(401).json({ success: false, error: 'Wallet must be unlocked to export seed' });
      return;
    }

    const agentId = (req.query.agentId || req.body?.agentId) as string | undefined;

    let mnemonic: string | null;
    let address: string | null;

    if (agentId) {
      mnemonic = exportAgentSeed(agentId);
      address = getAgentAddress(agentId);
    } else {
      mnemonic = exportSeed();
      address = getColdWalletAddress();
    }

    if (!mnemonic) {
      res.status(400).json({ success: false, error: 'No mnemonic available. Is the agent unlocked?' });
      return;
    }

    logger.seedExported(agentId);

    res.json({
      success: true,
      mnemonic,
      address,
      agentId: agentId || undefined,
      warning: 'NEVER share this mnemonic. Anyone with it can access all your wallets.'
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ success: false, error: message });
  }
};

router.get('/export-seed', requireWalletAuth, handleExportSeed);
router.post('/export-seed', requireWalletAuth, handleExportSeed);

// GET /wallets/search - Search wallets by name/address (always includes hidden)
router.get('/search', optionalWalletAuth, async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    if (!query || query.trim().length === 0) {
      res.status(400).json({ error: 'Search query (q) is required' });
      return;
    }

    const auth = req.auth;
    // If agent, only search their wallets; if admin/no auth, search all
    const tokenHash = auth && !isAdmin(auth) ? auth.tokenHash : undefined;
    const hotWallets = await searchHotWallets(query, tokenHash);

    // Batch fetch balances with chain-aware lookup
    const addresses = hotWallets.map(w => w.address);
    const searchChainMap = new Map<string, string>();
    hotWallets.forEach(w => {
      if (isSolanaChain(w.chain)) {
        searchChainMap.set(w.address, w.chain);
      }
    });
    const balances = await fetchBalances(addresses, 'base', searchChainMap);

    // Add balances to wallets
    const walletsWithBalances = hotWallets.map(w => ({
      ...w,
      balance: balances.get(normalizeAddress(w.address, w.chain)) || '0'
    }));

    // Also search address labels
    const addressLabels = await prisma.addressLabel.findMany({
      where: {
        OR: [
          { label: { contains: query } },
          { address: { contains: query.toLowerCase() } },
        ],
      },
      take: 10,
    });

    res.json({ wallets: walletsWithBalances, addressLabels });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

// Mount sub-routers for transactions and assets
// IMPORTANT: These must come after named routes (like /transactions, /search, /export-seed)
// but before the /:address catch-all route, since Express matches in order.
router.use('/', transactionRoutes);
router.use('/', assetRoutes);

// GET /wallet/:address - Get single wallet details (requires auth for access check)
// NOTE: This must be LAST because /:address is a catch-all parameter route
router.get('/:address', optionalWalletAuth, async (req: Request<{ address: string }>, res: Response) => {
  try {
    const { address } = req.params;
    const auth = req.auth;
    const agentCanListAll = !!(
      auth &&
      !isAdmin(auth) &&
      hasAnyPermission(auth.token.permissions, ['wallet:list'])
    );

    // 1) Hot wallet
    const wallet = await getHotWallet(address);
    if (wallet) {
      // If agent (not admin), verify access unless it has wallet:list
      if (auth && !isAdmin(auth) && !agentCanListAll) {
        const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, address);
        if (!canAccess) {
          await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
          return;
        }
      }

      const chain = wallet.metadata.chain || 'base';
      const balance = await fetchBalance(wallet.address, chain);

      res.json({
        address: wallet.address,
        tier: 'hot',
        chain,
        name: wallet.metadata.name,
        color: wallet.metadata.color,
        description: wallet.metadata.description,
        emoji: wallet.metadata.emoji,
        hidden: wallet.metadata.hidden,
        createdAt: wallet.metadata.createdAt,
        tokenHash: wallet.tokenHash,
        balance,
      });
      return;
    }

    // 2) Cold wallet (EVM or Solana)
    const coldInfo = getColdWalletInfo();
    const coldEvmAddress = getColdWalletAddress();
    const coldSolAddress = getSolanaColdAddress();

    const isColdEvm = coldEvmAddress
      ? normalizeAddress(coldEvmAddress, 'base') === normalizeAddress(address, 'base')
      : false;
    const isColdSol = coldSolAddress ? coldSolAddress === address : false;

    if (isColdEvm || isColdSol) {
      if (auth && !isAdmin(auth) && !agentCanListAll) {
        await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
        return;
      }

      const chain = isColdSol ? 'solana' : 'base';
      const resolvedAddress = isColdSol
        ? coldSolAddress!
        : (coldEvmAddress || coldInfo?.address || address);
      const balance = await fetchBalance(resolvedAddress, chain);

      res.json({
        address: resolvedAddress,
        tier: 'cold',
        chain,
        name: 'Cold Wallet',
        createdAt: coldInfo?.createdAt,
        balance,
      });
      return;
    }

    // 3) Temp wallet
    const tempWallet = listTempWallets().find((w) =>
      normalizeAddress(w.address, w.chain) === normalizeAddress(address, w.chain)
    );

    if (tempWallet) {
      if (auth && !isAdmin(auth) && !agentCanListAll) {
        await respondPermissionDenied({ req, res, routeId: ESCALATION_ROUTE_IDS.WALLET_ACCESS, error: 'Token does not have access to this wallet', required: ['wallet:access'], have: auth.token.permissions });
        return;
      }

      const chain = tempWallet.chain === 'any' ? 'base' : tempWallet.chain;
      const balance = await fetchBalance(tempWallet.address, chain);

      res.json({
        address: tempWallet.address,
        tier: 'temp',
        chain,
        createdAt: tempWallet.createdAt,
        balance,
      });
      return;
    }

    res.status(404).json({ error: 'Wallet not found' });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(400).json({ error: message });
  }
});

export default router;
