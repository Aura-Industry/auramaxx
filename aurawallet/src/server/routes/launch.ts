import { Router, Request, Response } from 'express';
import { createPublicClient, createWalletClient, http, parseEther, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, mainnet, ink, unichain } from 'viem/chains';
import {
  DopplerSDK,
  MulticurveBuilder,
  StaticAuctionBuilder,
  DynamicAuctionBuilder,
  FEE_TIERS,
  DAY_SECONDS,
  getAddresses,
  isSupportedChainId,
  type MigrationConfig,
} from '@whetstone-research/doppler-sdk';
import { getHotWallet, exportHotWallet, tokenCanAccessWallet } from '../lib/hot';
import { getTempWallet, hasTempWallet } from '../lib/temp';
import { isUnlocked } from '../lib/cold';
import { loadConfig, getRpcUrl, resolveChain } from '../lib/config';
import { prisma } from '../lib/db';
import { logger, logEvent } from '../lib/logger';
import { requireWalletAuth } from '../middleware/auth';
import { hasAnyPermission, isAdmin } from '../lib/permissions';
import { getDefault, getDefaultSync } from '../lib/defaults';
import { getErrorMessage, HttpError } from '../lib/error';
import { recordTransaction, autoTrackToken } from '../lib/transactions';
import { respondPermissionDenied } from '../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';

const router = Router();

interface LaunchRequest {
  from: string;
  name: string;
  symbol: string;
  tokenURI?: string;
  type?: 'static' | 'dynamic' | 'multicurve';

  // Token metadata (builds tokenURI automatically if tokenURI not provided)
  imageUrl?: string;                       // Public URL of the token image (e.g. telegra.ph)
  metadata?: Record<string, string>;       // Extra metadata fields (description, website, twitter, etc.)

  // Supply config
  initialSupply?: string;     // Default: '1000000000' (1B)
  numTokensToSell?: string;   // Default: 90% of initialSupply

  // Multicurve preset (simplest option)
  preset?: 'low' | 'medium' | 'high';

  // Pool config (advanced)
  fee?: number;
  tickSpacing?: number;

  // Static auction ticks
  startTick?: number;
  endTick?: number;

  // Dynamic auction config
  duration?: number;        // seconds
  epochLength?: number;     // seconds
  minProceeds?: string;     // ETH
  maxProceeds?: string;     // ETH

  // Migration after auction
  migration?: 'uniswapV2' | 'uniswapV4' | 'noOp';

  // Vesting
  vestingDuration?: number; // seconds

  // Scheduling (multicurve only)
  startTime?: number;       // Unix timestamp

  // Governance
  governance?: 'default' | 'noOp';

  // Beneficiaries (fee recipients for the launched pool)
  beneficiaries?: { address: string; shares: string }[];

  chain?: string;
  description?: string;
}

// Map chain names to viem chain objects
const VIEM_CHAINS: Record<string, Chain> = {
  base,
  ethereum: mainnet,
  ink,
  unichain,
};

// POST /launch - Launch a token via Doppler protocol
router.post('/', requireWalletAuth, async (req: Request, res: Response) => {
  try {
    const {
      from,
      name,
      symbol,
      tokenURI: explicitTokenURI,
      imageUrl,
      metadata: extraMetadata,
      type: auctionType = 'multicurve',
      initialSupply: initialSupplyStr,
      numTokensToSell: numTokensToSellStr,
      preset,
      fee,
      tickSpacing,
      startTick,
      endTick,
      duration,
      epochLength,
      minProceeds: minProceedsStr,
      maxProceeds: maxProceedsStr,
      migration = 'uniswapV2',
      vestingDuration,
      startTime,
      governance = 'default',
      beneficiaries,
      chain,
      description: userDescription,
    } = req.body as LaunchRequest;

    const auth = req.auth!;

    // Validate required fields
    if (!from || typeof from !== 'string') {
      res.status(400).json({ error: 'from address is required' });
      return;
    }

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    if (!symbol || typeof symbol !== 'string') {
      res.status(400).json({ error: 'symbol is required' });
      return;
    }

    if (!['static', 'dynamic', 'multicurve'].includes(auctionType)) {
      res.status(400).json({ error: 'type must be "static", "dynamic", or "multicurve"' });
      return;
    }

    // Get chain config
    const { targetChain, chainConfig } = resolveChain(chain);

    // Doppler only supports EVM chains
    if (!isSupportedChainId(chainConfig.chainId)) {
      res.status(400).json({
        error: `Doppler does not support chain ${targetChain} (chainId: ${chainConfig.chainId})`
      });
      return;
    }

    // Determine wallet type and verify ownership
    const hotWallet = await getHotWallet(from);
    const tempWallet = getTempWallet(from);

    if (!hotWallet && !tempWallet) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    // Permission checks
    if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['launch'])) {
      logger.permissionDenied('launch', auth.token.agentId, '/launch');
      await respondPermissionDenied({
        req,
        res,
        routeId: ESCALATION_ROUTE_IDS.LAUNCH_PERMISSION,
        error: 'Token does not have launch permission',
        required: ['launch'],
        have: auth.token.permissions,
      });
      return;
    }

    if (hotWallet) {
      const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, from);
      if (!isAdmin(auth) && !canAccess) {
        logger.permissionDenied('wallet_access', auth.token.agentId, '/launch');
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.LAUNCH_WALLET_ACCESS,
          error: 'Token does not have access to this wallet',
          required: ['wallet:access'],
          have: auth.token.permissions,
        });
        return;
      }

      if (!isUnlocked()) {
        logger.authFailed('Cold wallet locked', '/launch');
        res.status(401).json({ error: 'Cold wallet must be unlocked to launch from hot wallet' });
        return;
      }
    } else if (tempWallet) {
      if (!isAdmin(auth) && !hasAnyPermission(auth.token.permissions, ['launch'])) {
        logger.permissionDenied('launch', auth.token.agentId, '/launch');
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.LAUNCH_PERMISSION,
          error: 'Token does not have launch permission',
          required: ['launch'],
          have: auth.token.permissions,
        });
        return;
      }
    }

    // Get the wallet's private key for viem
    let privateKey: `0x${string}`;

    if (hotWallet) {
      const exported = await exportHotWallet(from);
      privateKey = exported.privateKey as `0x${string}`;
      if (!privateKey.startsWith('0x')) {
        privateKey = `0x${privateKey}` as `0x${string}`;
      }
    } else if (tempWallet) {
      privateKey = tempWallet.privateKey as `0x${string}`;
      if (!privateKey.startsWith('0x')) {
        privateKey = `0x${privateKey}` as `0x${string}`;
      }
    } else {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    // Set up viem clients
    const rpcUrl = await getRpcUrl(targetChain);
    const viemChain = VIEM_CHAINS[targetChain];

    if (!viemChain) {
      res.status(400).json({ error: `No viem chain config for ${targetChain}` });
      return;
    }

    const account = privateKeyToAccount(privateKey);

    const publicClient = createPublicClient({
      chain: viemChain,
      transport: http(rpcUrl),
    });

    const walletClient = createWalletClient({
      chain: viemChain,
      transport: http(rpcUrl),
      account,
    });

    // Initialize Doppler SDK
    const sdk = new DopplerSDK({
      publicClient,
      walletClient,
      chainId: chainConfig.chainId,
    });

    const addresses = getAddresses(chainConfig.chainId);
    const defaultSupply = await getDefault<string>('launch.initial_supply', '1000000000');
    const defaultSellPercent = await getDefault<number>('launch.sell_percent', 90);
    const supplyStr = initialSupplyStr || String(defaultSupply);
    const initialSupply = parseEther(supplyStr);
    const numTokensToSell = numTokensToSellStr
      ? parseEther(numTokensToSellStr)
      : (initialSupply * BigInt(defaultSellPercent)) / 100n;

    // Build tokenURI: explicit tokenURI wins, otherwise build from imageUrl/metadata
    let tokenURI = explicitTokenURI || '';
    if (!tokenURI && (imageUrl || extraMetadata)) {
      const metadataJson: Record<string, unknown> = {
        name,
        symbol,
        ...(imageUrl && { image: imageUrl }),
        ...extraMetadata,
      };
      const encoded = Buffer.from(JSON.stringify(metadataJson)).toString('base64');
      tokenURI = `data:application/json;base64,${encoded}`;
    }

    const tokenConfig = {
      name,
      symbol,
      tokenURI,
    };

    const saleConfig = {
      initialSupply,
      numTokensToSell,
      numeraire: addresses.weth,
    };

    // Protocol fee address (integrator for all launches)
    const protocolFeeAddress = getDefaultSync('protocol.fee_address', '0xa931533E0E0cCE34fc0FafB25ea2046d391eCAA5') as `0x${string}`;

    // Convert beneficiaries from API format to SDK format
    const sdkBeneficiaries = beneficiaries?.map(b => ({
      beneficiary: b.address as `0x${string}`,
      shares: parseEther(b.shares),
    }));

    let result: {
      tokenAddress?: string;
      poolAddress?: string;
      hookAddress?: string;
      poolId?: string;
      hash?: string;
    };

    if (auctionType === 'multicurve') {
      const builder = new MulticurveBuilder(chainConfig.chainId)
        .tokenConfig(tokenConfig)
        .saleConfig(saleConfig);

      // Use preset or manual config
      if (preset) {
        builder.withMarketCapPresets({
          fee: fee ?? FEE_TIERS.LOW,
          presets: [preset],
          ...(sdkBeneficiaries && { beneficiaries: sdkBeneficiaries }),
        });
      } else {
        builder.poolConfig({
          fee: fee ?? 0,
          tickSpacing: tickSpacing ?? 8,
          curves: [
            { tickLower: 0, tickUpper: 240000, numPositions: 10, shares: parseEther('0.5') },
            { tickLower: 16000, tickUpper: 240000, numPositions: 10, shares: parseEther('0.5') },
          ],
          ...(sdkBeneficiaries && { beneficiaries: sdkBeneficiaries }),
        });
      }

      if (vestingDuration) {
        builder.withVesting({ duration: BigInt(vestingDuration) });
      }

      if (startTime) {
        builder.withSchedule({ startTime });
      }

      builder.withIntegrator(protocolFeeAddress);
      builder.withGovernance({ type: governance === 'noOp' ? 'noOp' : 'default' });
      builder.withMigration({ type: migration } as MigrationConfig);
      builder.withUserAddress(from as `0x${string}`);

      const params = builder.build();
      const createResult = await sdk.factory.createMulticurve(params);

      result = {
        tokenAddress: createResult.tokenAddress,
        poolId: createResult.poolId,
        hash: createResult.transactionHash,
      };

    } else if (auctionType === 'static') {
      const builder = new StaticAuctionBuilder(chainConfig.chainId)
        .tokenConfig(tokenConfig)
        .saleConfig(saleConfig);

      if (startTick !== undefined && endTick !== undefined) {
        builder.poolByTicks({
          startTick,
          endTick,
          fee: fee ?? 10000,
        });
      } else {
        builder.poolByTicks({ fee: fee ?? 10000 });
      }

      if (vestingDuration) {
        builder.withVesting({ duration: BigInt(vestingDuration) });
      }

      if (sdkBeneficiaries) {
        builder.withBeneficiaries(sdkBeneficiaries);
      }

      builder.withIntegrator(protocolFeeAddress);
      builder.withGovernance({ type: governance === 'noOp' ? 'noOp' : 'default' });
      builder.withMigration({ type: migration } as MigrationConfig);
      builder.withUserAddress(from as `0x${string}`);

      const params = builder.build();
      const createResult = await sdk.factory.createStaticAuction(params);

      result = {
        tokenAddress: createResult.tokenAddress,
        poolAddress: createResult.poolAddress,
        hash: createResult.transactionHash,
      };

    } else if (auctionType === 'dynamic') {
      if (beneficiaries?.length) {
        logEvent({ category: 'system', action: 'launch_warning', description: 'Beneficiaries are not supported for dynamic auctions — ignoring' });
      }

      const builder = new DynamicAuctionBuilder(chainConfig.chainId)
        .tokenConfig(tokenConfig)
        .saleConfig(saleConfig)
        .poolConfig({
          fee: fee ?? 3000,
          tickSpacing: tickSpacing ?? 60,
        });

      const defaultEpochLength = await getDefault<number>('launch.epoch_length', 3600);
      builder.auctionByTicks({
        duration: duration ?? 7 * DAY_SECONDS,
        epochLength: epochLength ?? defaultEpochLength,
        startTick: startTick ?? -92103,
        endTick: endTick ?? -69080,
        minProceeds: minProceedsStr ? parseEther(minProceedsStr) : parseEther('0.1'),
        maxProceeds: maxProceedsStr ? parseEther(maxProceedsStr) : parseEther('100'),
      });

      if (vestingDuration) {
        builder.withVesting({ duration: BigInt(vestingDuration) });
      }

      builder.withIntegrator(protocolFeeAddress);
      builder.withGovernance({ type: governance === 'noOp' ? 'noOp' : 'default' });
      builder.withMigration({ type: migration } as MigrationConfig);
      builder.withUserAddress(from as `0x${string}`);

      const params = builder.build();
      const createResult = await sdk.factory.createDynamicAuction(params);

      result = {
        tokenAddress: createResult.tokenAddress,
        hookAddress: createResult.hookAddress,
        poolId: createResult.poolId,
        hash: createResult.transactionHash,
      };
    } else {
      res.status(400).json({ error: `Unknown auction type: ${auctionType}` });
      return;
    }

    // Log the launch
    const txHash = result.hash || '';
    const description = userDescription || `Launched ${symbol} (${name}) via Doppler ${auctionType} auction`;

    await recordTransaction({
      walletAddress: from,
      txHash,
      type: 'launch',
      tokenAddress: result.tokenAddress || undefined,
      from,
      to: result.poolAddress || result.hookAddress || addresses.airlock,
      description,
      chain: targetChain,
      logTitle: `Token Launch: ${symbol}`,
    });

    // Auto-track the launched token
    if (result.tokenAddress) {
      await autoTrackToken({
        walletAddress: from,
        tokenAddress: result.tokenAddress,
        chain: targetChain,
        symbol,
        name,
      });
    }

    // Log event
    const agentId = !isAdmin(auth) ? auth.token.agentId : undefined;
    logger.swap(from, 'ETH', symbol, '0', txHash, agentId); // Reuse swap logger for now

    res.json({
      success: true,
      hash: txHash,
      from,
      tokenAddress: result.tokenAddress,
      ...(result.poolAddress && { poolAddress: result.poolAddress }),
      ...(result.hookAddress && { hookAddress: result.hookAddress }),
      ...(result.poolId && { poolId: result.poolId }),
      type: auctionType,
      name,
      symbol,
      chain: targetChain,
    });

  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// Helper: set up viem clients + Doppler SDK for fee collection
async function createSdkForWallet(from: string, targetChain: string) {
  const config = loadConfig();
  const chainConfig = config.chains[targetChain];
  if (!chainConfig) throw new Error(`Unknown chain: ${targetChain}`);
  if (!isSupportedChainId(chainConfig.chainId)) {
    throw new Error(`Doppler does not support chain ${targetChain}`);
  }

  const hotWallet = await getHotWallet(from);
  const tempWallet = getTempWallet(from);
  if (!hotWallet && !tempWallet) throw new Error('Wallet not found');

  let privateKey: `0x${string}`;
  if (hotWallet) {
    const exported = await exportHotWallet(from);
    privateKey = exported.privateKey as `0x${string}`;
    if (!privateKey.startsWith('0x')) privateKey = `0x${privateKey}` as `0x${string}`;
  } else {
    privateKey = tempWallet!.privateKey as `0x${string}`;
    if (!privateKey.startsWith('0x')) privateKey = `0x${privateKey}` as `0x${string}`;
  }

  const rpcUrl = await getRpcUrl(targetChain);
  const viemChain = VIEM_CHAINS[targetChain];
  if (!viemChain) throw new Error(`No viem chain config for ${targetChain}`);

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain: viemChain, transport: http(rpcUrl), account });

  const sdk = new DopplerSDK({ publicClient, walletClient, chainId: chainConfig.chainId });
  return { sdk, hotWallet, tempWallet };
}

// POST /launch/collect-fees - Collect fees from ALL launched tokens
// No launch permission required — collectFees is permissionless on-chain,
// fees always go to configured beneficiaries. Caller only pays gas.
router.post('/collect-fees', requireWalletAuth, async (req: Request, res: Response) => {
  try {
    const { from, chain } = req.body as { from: string; chain?: string };
    const auth = req.auth!;

    if (!from || typeof from !== 'string') {
      res.status(400).json({ error: 'from address is required (wallet to pay gas)' });
      return;
    }

    const hotWallet = await getHotWallet(from);
    const tempWallet = getTempWallet(from);
    if (!hotWallet && !tempWallet) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    if (hotWallet) {
      const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, from);
      if (!isAdmin(auth) && !canAccess) {
        logger.permissionDenied('wallet_access', auth.token.agentId, '/launch/collect-fees');
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.LAUNCH_WALLET_ACCESS,
          error: 'Token does not have access to this wallet',
          required: ['wallet:access'],
          have: auth.token.permissions,
        });
        return;
      }
    }

    const config = loadConfig();
    const targetChain = chain || config.defaultChain;

    // Find all launched tokens on this chain
    const launches = await prisma.transaction.findMany({
      where: {
        type: 'launch',
        chain: targetChain,
        tokenAddress: { not: null },
      },
      select: { tokenAddress: true },
      distinct: ['tokenAddress'],
    });

    if (launches.length === 0) {
      res.json({ success: true, message: 'No launched tokens found', results: [] });
      return;
    }

    const { sdk } = await createSdkForWallet(from, targetChain);

    const results: Array<{
      tokenAddress: string;
      success: boolean;
      fees0?: string;
      fees1?: string;
      transactionHash?: string;
      error?: string;
    }> = [];

    for (const launch of launches) {
      const tokenAddr = launch.tokenAddress!;
      try {
        const pool = await sdk.getMulticurvePool(tokenAddr as `0x${string}`);
        const { fees0, fees1, transactionHash } = await pool.collectFees();
        results.push({
          tokenAddress: tokenAddr,
          success: true,
          fees0: fees0.toString(),
          fees1: fees1.toString(),
          transactionHash,
        });
      } catch (err) {
        results.push({
          tokenAddress: tokenAddr,
          success: false,
          error: getErrorMessage(err),
        });
      }
    }

    const collected = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    res.json({
      success: true,
      chain: targetChain,
      total: launches.length,
      collected,
      failed,
      results,
    });

  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

// POST /launch/:tokenAddress/collect-fees - Collect fees from a specific launched token
// No launch permission required — collectFees is permissionless on-chain,
// fees always go to configured beneficiaries. Caller only pays gas.
router.post('/:tokenAddress/collect-fees', requireWalletAuth, async (req: Request<{ tokenAddress: string }>, res: Response) => {
  try {
    const { tokenAddress } = req.params;
    const { from, chain } = req.body as { from: string; chain?: string };
    const auth = req.auth!;

    if (!from || typeof from !== 'string') {
      res.status(400).json({ error: 'from address is required (wallet to pay gas)' });
      return;
    }

    const hotWallet = await getHotWallet(from);
    const tempWallet = getTempWallet(from);
    if (!hotWallet && !tempWallet) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    if (hotWallet) {
      const canAccess = await tokenCanAccessWallet(auth.tokenHash, auth.token.walletAccess, from);
      if (!isAdmin(auth) && !canAccess) {
        logger.permissionDenied('wallet_access', auth.token.agentId, `/launch/${tokenAddress}/collect-fees`);
        await respondPermissionDenied({
          req,
          res,
          routeId: ESCALATION_ROUTE_IDS.LAUNCH_WALLET_ACCESS,
          error: 'Token does not have access to this wallet',
          required: ['wallet:access'],
          have: auth.token.permissions,
        });
        return;
      }
    }

    const config = loadConfig();
    const targetChain = chain || config.defaultChain;

    const { sdk } = await createSdkForWallet(from, targetChain);

    const pool = await sdk.getMulticurvePool(tokenAddress as `0x${string}`);
    const { fees0, fees1, transactionHash } = await pool.collectFees();

    // Log the fee collection
    await prisma.log.create({
      data: {
        walletAddress: from,
        title: `Fee Collection: ${tokenAddress}`,
        description: `Collected fees from launched token ${tokenAddress} (fees0: ${fees0}, fees1: ${fees1})`,
        txHash: transactionHash,
      }
    });

    res.json({
      success: true,
      tokenAddress,
      fees0: fees0.toString(),
      fees1: fees1.toString(),
      transactionHash,
      chain: targetChain,
    });

  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

export default router;
