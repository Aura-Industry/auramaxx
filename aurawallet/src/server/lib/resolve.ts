import { ethers } from 'ethers';
import { getRpcUrl } from './config';

/**
 * Resolve an ENS name (.eth) to an Ethereum address.
 * Uses ethers built-in provider.resolveName() which handles ENS natively.
 * ENS resolution always uses Ethereum mainnet (ENS is deployed on L1).
 */
export async function resolveName(name: string): Promise<{ address: string; name: string }> {
  if (!name || typeof name !== 'string') {
    throw new Error('Name is required');
  }

  // Only support .eth names for now (.sol is out of scope)
  if (!name.endsWith('.eth')) {
    throw new Error(`Unsupported name format: ${name}. Only .eth names are supported.`);
  }

  // ENS lives on Ethereum mainnet — always resolve against L1
  const rpcUrl = await getRpcUrl('ethereum');
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const address = await provider.resolveName(name);
  if (!address) {
    throw new Error(`Could not resolve: ${name}`);
  }

  return { address, name };
}

/**
 * Check if a string looks like an ENS name (contains a dot).
 */
export function looksLikeName(value: string): boolean {
  return value.includes('.') && !value.startsWith('0x') && !value.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
}
