/**
 * Credential Agent — Subkey Derivation & Session Management
 * =========================================================
 *
 * Derives a credential-specific encryption key from the wallet mnemonic.
 * The derived key is held in memory while the agent is unlocked and used
 * to encrypt/decrypt credential files. Hooks into the agent lifecycle
 * (unlock/lock) in cold.ts.
 *
 * Key derivation: SHA256("credential-v1:" + agentId + ":" + mnemonic)
 * This produces a deterministic 256-bit key unique to each agent.
 */

import CryptoJS from 'crypto-js';
import { getAgentMnemonic } from './cold';

// In-memory storage of derived credential keys (agentId → hex key)
const credentialAgentSessions = new Map<string, string>();

/**
 * Derive a credential encryption key from a agent's mnemonic.
 * Uses SHA-256 of a domain-separated string for deterministic derivation.
 */
export function deriveCredentialKey(agentId: string, mnemonic: string): string {
  const input = `credential-v1:${agentId}:${mnemonic}`;
  return CryptoJS.SHA256(input).toString(CryptoJS.enc.Hex);
}

/**
 * Unlock the credential agent for a given agent ID.
 * Reads the mnemonic from the already-unlocked wallet agent session
 * and derives + stores the credential subkey.
 */
export function unlockCredentialAgent(agentId: string): boolean {
  const mnemonic = getAgentMnemonic(agentId);
  if (!mnemonic) return false;

  const key = deriveCredentialKey(agentId, mnemonic);
  credentialAgentSessions.set(agentId, key);
  return true;
}

/**
 * Lock the credential agent for a given agent ID.
 * Removes the derived key from memory.
 */
export function lockCredentialAgent(agentId: string): void {
  credentialAgentSessions.delete(agentId);
}

/**
 * Lock all credential agents.
 */
export function lockAllCredentialAgents(): void {
  credentialAgentSessions.clear();
}

/**
 * Get the derived credential key for a agent (or null if locked).
 */
export function getCredentialAgentKey(agentId: string): string | null {
  return credentialAgentSessions.get(agentId) ?? null;
}

/**
 * Check if a credential agent is unlocked.
 */
export function isCredentialAgentUnlocked(agentId: string): boolean {
  return credentialAgentSessions.has(agentId);
}

/**
 * Reset all credential agent state (for testing only).
 */
export function _resetCredentialAgentForTesting(): void {
  credentialAgentSessions.clear();
}
