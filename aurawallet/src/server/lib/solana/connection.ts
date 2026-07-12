import { Connection } from '@solana/web3.js';
import { getRpcUrl } from '../config';

// Cached connections by chain
const connections = new Map<string, Connection>();

/**
 * Get a Solana Connection for the given chain.
 * Caches connection instances (same pattern as EVM providers).
 */
export async function getSolanaConnection(chain: string = 'solana'): Promise<Connection> {
  const cached = connections.get(chain);
  if (cached) return cached;

  const rpcUrl = await getRpcUrl(chain);
  const connection = new Connection(rpcUrl, 'confirmed');
  connections.set(chain, connection);
  return connection;
}

/**
 * Clear cached connections (for testing).
 */
export function clearSolanaConnections(): void {
  connections.clear();
}
