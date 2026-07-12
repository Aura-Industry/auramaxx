import { Router, Request, Response } from 'express';
import { getTokenPrice } from '../lib/price';
import { loadConfig } from '../lib/config';
import { isSolanaChain } from '../lib/address';
import { getErrorMessage } from '../lib/error';

const router = Router();

// GET /price/:address — Public endpoint (no auth required)
router.get('/:address', async (req: Request, res: Response) => {
  try {
    const address = String(req.params.address);
    const config = loadConfig();
    const chain = (req.query.chain as string) || config.defaultChain;

    // Validate chain
    if (!config.chains[chain]) {
      res.status(400).json({ success: false, error: `Unknown chain: ${chain}` });
      return;
    }

    // Validate address format (skip for 'native')
    if (address !== 'native') {
      if (isSolanaChain(chain)) {
        // Base58: alphanumeric (no 0, O, I, l), 32-44 chars
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
          res.status(400).json({ success: false, error: 'Invalid Solana address format' });
          return;
        }
      } else {
        // EVM: 0x-prefixed hex, 42 chars
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
          res.status(400).json({ success: false, error: 'Invalid EVM address format' });
          return;
        }
      }
    }

    const result = await getTokenPrice(address, chain);

    if (!result) {
      res.status(404).json({
        success: false,
        error: `No price found for ${address} on ${chain}`,
      });
      return;
    }

    res.json({
      success: true,
      token: address,
      chain,
      priceUsd: result.priceUsd,
      source: result.source,
      cached: result.cached,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
