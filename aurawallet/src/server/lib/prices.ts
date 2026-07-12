/**
 * Price helpers — read cached native currency prices from DB.
 * Prices are written by the cron server's native-price job.
 */

import { prisma } from './db';

/**
 * Get cached ETH→USD price. Returns null if no cached price exists.
 */
export async function getEthToUsd(): Promise<number | null> {
  try {
    const row = await prisma.nativePrice.findUnique({ where: { currency: 'ETH' } });
    if (!row) return null;
    const price = parseFloat(row.priceUsd);
    return isNaN(price) ? null : price;
  } catch {
    return null;
  }
}

/**
 * Get cached SOL→USD price. Returns null if no cached price exists.
 */
export async function getSolToUsd(): Promise<number | null> {
  try {
    const row = await prisma.nativePrice.findUnique({ where: { currency: 'SOL' } });
    if (!row) return null;
    const price = parseFloat(row.priceUsd);
    return isNaN(price) ? null : price;
  } catch {
    return null;
  }
}
