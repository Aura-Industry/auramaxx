/**
 * Native Price Sync Job
 * Fetches ETH and SOL USD prices from CoinGecko free API.
 * One HTTP call, two DB upserts.
 */

import type { CronJob, CronContext } from '../job';

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,solana&vs_currencies=usd';

export const nativePriceJob: CronJob = {
  id: 'native-price',
  name: 'Native Price Sync',
  intervalKey: 'sync.active_interval',
  defaultInterval: 15_000,

  async run(ctx: CronContext): Promise<void> {
    const enabled = ctx.defaults.get<boolean>('sync.enabled', true);
    if (!enabled) return;

    let data: { ethereum?: { usd?: number }; solana?: { usd?: number } };

    try {
      const res = await fetch(COINGECKO_URL, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        ctx.log.warn({ status: res.status }, 'CoinGecko returned non-OK status');
        return;
      }
      data = await res.json();
    } catch (err) {
      ctx.log.warn({ err }, 'CoinGecko fetch failed (keeping stale price)');
      return;
    }

    const ethPrice = data.ethereum?.usd;
    const solPrice = data.solana?.usd;

    const upserts: Promise<unknown>[] = [];

    if (ethPrice != null) {
      upserts.push(
        ctx.prisma.nativePrice.upsert({
          where: { currency: 'ETH' },
          create: { currency: 'ETH', priceUsd: ethPrice.toString() },
          update: { priceUsd: ethPrice.toString() },
        })
      );
    }

    if (solPrice != null) {
      upserts.push(
        ctx.prisma.nativePrice.upsert({
          where: { currency: 'SOL' },
          create: { currency: 'SOL', priceUsd: solPrice.toString() },
          update: { priceUsd: solPrice.toString() },
        })
      );
    }

    await Promise.all(upserts);

    ctx.log.debug(
      { ethPrice, solPrice },
      'Native prices updated'
    );
  },
};
