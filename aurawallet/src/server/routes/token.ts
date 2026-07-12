import { Router, Request, Response } from 'express';
import { createPublicClient, http, erc20Abi, formatUnits, type Address, type Chain } from 'viem';
import { base, mainnet } from 'viem/chains';
import { PublicKey } from '@solana/web3.js';
import { searchTokens } from '../lib/token-search';
import { getTokenSafety } from '../lib/token-safety';
import { getRpcUrl, loadConfig } from '../lib/config';
import { isSolanaChain } from '../lib/address';
import { getSolanaConnection } from '../lib/solana/connection';
import { getTokenPrices } from '../lib/price';
import { getErrorMessage } from '../lib/error';

const router = Router();

// Map chain names to viem chain objects
const VIEM_CHAINS: Record<string, Chain> = {
  base,
  ethereum: mainnet,
};

// GET /token/search — Public endpoint (no auth required)
router.get('/search', async (req: Request, res: Response) => {
  try {
    const q = req.query.q as string | undefined;
    if (!q || !q.trim()) {
      res.status(400).json({ success: false, error: 'Missing required query parameter: q' });
      return;
    }

    const chain = (req.query.chain as string) || undefined;
    const parsedLimit = req.query.limit !== undefined ? parseInt(req.query.limit as string, 10) : NaN;
    const limit = Number.isNaN(parsedLimit) ? 10 : Math.min(Math.max(parsedLimit, 1), 50);

    const results = await searchTokens(q.trim(), { chain, limit });

    res.json({
      success: true,
      query: q.trim(),
      results,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /token/safety/:address — Public endpoint (no auth required)
router.get('/safety/:address', async (req: Request, res: Response) => {
  try {
    const address = String(req.params.address);
    const chain = (req.query.chain as string) || 'ethereum';

    const result = await getTokenSafety(address, chain);

    if (!result) {
      res.status(404).json({
        success: false,
        error: `No safety data found for ${address} on ${chain}`,
      });
      return;
    }

    res.json({
      success: true,
      address,
      chain,
      safety: result,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /token/holders/:address — Public endpoint (no auth required)
// Convenience endpoint that returns holder data from the same GoPlusLabs source
router.get('/holders/:address', async (req: Request, res: Response) => {
  try {
    const address = String(req.params.address);
    const chain = (req.query.chain as string) || 'ethereum';

    const result = await getTokenSafety(address, chain);

    if (!result) {
      res.status(404).json({
        success: false,
        error: `No holder data found for ${address} on ${chain}`,
      });
      return;
    }

    res.json({
      success: true,
      address,
      chain,
      tokenName: result.tokenName,
      tokenSymbol: result.tokenSymbol,
      holderCount: result.holderCount,
      holders: result.holders,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

// GET /token/:tokenAddress/balance/:walletAddress — Public endpoint (no auth required)
// Returns the on-chain token balance for any wallet address (not just registered wallets)
router.get('/:tokenAddress/balance/:walletAddress', async (req: Request, res: Response) => {
  try {
    const tokenAddress = String(req.params.tokenAddress);
    const walletAddress = String(req.params.walletAddress);
    const config = loadConfig();
    const chain = (req.query.chain as string) || config.defaultChain;

    if (isSolanaChain(chain)) {
      // ── Solana SPL token balance ──
      try {
        new PublicKey(walletAddress);
        new PublicKey(tokenAddress);
      } catch {
        res.status(400).json({ success: false, error: 'Invalid Solana address format' });
        return;
      }

      const connection = await getSolanaConnection(chain);
      const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount } = await import('@solana/spl-token');
      const mint = new PublicKey(tokenAddress);
      const owner = new PublicKey(walletAddress);

      // Get mint info for decimals
      const mintInfo = await connection.getParsedAccountInfo(mint);
      const mintData = (mintInfo.value?.data as any)?.parsed?.info;
      if (!mintData) {
        res.status(404).json({ success: false, error: `Token mint not found: ${tokenAddress}` });
        return;
      }
      const decimals = mintData.decimals ?? 0;

      // Get the associated token account balance
      let balance = '0';
      let formatted = '0';
      try {
        const ata = await getAssociatedTokenAddress(mint, owner);
        const account = await getAccount(connection, ata);
        balance = account.amount.toString();
        formatted = formatUnits(account.amount, decimals);
      } catch {
        // No ATA = zero balance
      }

      // Fetch price
      const priceMap = await getTokenPrices([{ address: tokenAddress, chain }]);
      const cacheKey = `${chain}:${tokenAddress}`;
      const price = priceMap.get(cacheKey);
      const priceUsd = price ? parseFloat(price.priceUsd) : null;
      const balanceNum = parseFloat(formatted) || 0;
      const valueUsd = priceUsd !== null && balanceNum > 0 ? balanceNum * priceUsd : null;

      res.json({
        success: true,
        tokenAddress,
        walletAddress,
        chain,
        balance,
        formatted,
        decimals,
        priceUsd: priceUsd !== null ? priceUsd.toString() : null,
        valueUsd: valueUsd !== null ? valueUsd.toFixed(2) : null,
      });
      return;
    }

    // ── EVM ERC-20 balance ──
    if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
      res.status(400).json({ success: false, error: 'Invalid EVM token address format' });
      return;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      res.status(400).json({ success: false, error: 'Invalid EVM wallet address format' });
      return;
    }

    const rpcUrl = await getRpcUrl(chain);
    const viemChain = VIEM_CHAINS[chain];
    const tokenAddr = tokenAddress as Address;
    const walletAddr = walletAddress as Address;

    const client = createPublicClient({
      chain: viemChain,
      transport: http(rpcUrl),
      batch: { multicall: true },
    });

    // Batch balanceOf, decimals, symbol, name via multicall
    const contracts = [
      { address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf' as const, args: [walletAddr] as const },
      { address: tokenAddr, abi: erc20Abi, functionName: 'decimals' as const },
      { address: tokenAddr, abi: erc20Abi, functionName: 'symbol' as const },
      { address: tokenAddr, abi: erc20Abi, functionName: 'name' as const },
    ];

    const results = await client.multicall({
      contracts,
      allowFailure: true,
    });

    const [balanceResult, decimalsResult, symbolResult, nameResult] = results;

    if (balanceResult.status === 'failure') {
      res.status(502).json({ success: false, error: 'Failed to query token balance from RPC' });
      return;
    }

    const rawBalance = balanceResult.result as bigint;
    const tokenDecimals = decimalsResult.status === 'success' ? (decimalsResult.result as number) : 18;
    const tokenSymbol = symbolResult.status === 'success' ? (symbolResult.result as string) : null;
    const tokenName = nameResult.status === 'success' ? (nameResult.result as string) : null;
    const formatted = formatUnits(rawBalance, tokenDecimals);

    // Fetch price
    const priceMap = await getTokenPrices([{ address: tokenAddress, chain }]);
    const cacheKey = `${chain}:${tokenAddress.toLowerCase()}`;
    const price = priceMap.get(cacheKey);
    const priceUsd = price ? parseFloat(price.priceUsd) : null;
    const balanceNum = parseFloat(formatted) || 0;
    const valueUsd = priceUsd !== null && balanceNum > 0 ? balanceNum * priceUsd : null;

    res.json({
      success: true,
      tokenAddress,
      walletAddress,
      chain,
      balance: rawBalance.toString(),
      formatted,
      decimals: tokenDecimals,
      symbol: tokenSymbol,
      name: tokenName,
      priceUsd: priceUsd !== null ? priceUsd.toString() : null,
      valueUsd: valueUsd !== null ? valueUsd.toFixed(2) : null,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
