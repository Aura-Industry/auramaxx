import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import { WalletInfo, EncryptedData } from '../types';
import { encryptPrivateKey, decryptPrivateKey } from './encrypt';
import { DATA_PATHS } from './config';
import { deriveSolanaColdKeypair } from './solana/wallet';
import { unlockCredentialAgent, lockCredentialAgent, lockAllCredentialAgents } from './credential-agent';
import { ensureDontLookForAgent, ensureOurSecretForAgent, ensureWorkingWithSecretsForAgent } from './oursecret';

// Cold wallet derivation path: m/44'/60'/0'/0/0
const COLD_PATH = "m/44'/60'/0'/0/0";
const COLD_FILE = 'cold.json';
const AGENT_PREFIX = 'agent-';
const PRIMARY_AGENT_ID = 'primary';
export const AGENT_AGENT_NAME = 'agent';

export type AgentMode = 'primary' | 'linked' | 'independent';

// ---------------------------------------------------------------------------
// Agent session stored in memory while a agent is unlocked
// ---------------------------------------------------------------------------
interface AgentSession {
  id: string;
  mnemonic: string;
  address: string;           // EVM
  solanaKeypair: Keypair;    // Solana
}

// In-memory storage - survives as long as process runs
const agentSessions = new Map<string, AgentSession>();
let primaryAgentId: string | null = null;
let primaryAgentPassword: string | null = null; // stored while primary is unlocked

// ---------------------------------------------------------------------------
// Agent file on disk
// ---------------------------------------------------------------------------
interface AgentFile {
  address: string;
  solanaAddress?: string;
  encrypted: EncryptedData;
  createdAt: string;
  name?: string;
  mode?: AgentMode;
  linkedTo?: string;
}

// ---------------------------------------------------------------------------
// Public agent info (safe to expose)
// ---------------------------------------------------------------------------
export interface AgentInfo {
  id: string;
  name?: string;
  address: string;
  solanaAddress?: string;
  mode: AgentMode;
  parentAgentId?: string;
  linkedTo?: string;
  isUnlocked: boolean;
  isPrimary: boolean;
  createdAt: string;
}

export interface CreateAgentResult {
  id: string;
  address: string;
  solanaAddress: string;
  mnemonic: string;
  name?: string;
  mode: AgentMode;
  parentAgentId?: string;
  linkedTo?: string;
}

export interface CreateAgentOptions {
  mode?: Exclude<AgentMode, 'primary'>;
  parentAgentId?: string;
  linkedTo?: string;
  seedOnboardingSecret?: boolean;
}

// ---------------------------------------------------------------------------
// File path helpers
// ---------------------------------------------------------------------------
function getAgentFilePath(id: string): string {
  return path.join(DATA_PATHS.wallets, `${AGENT_PREFIX}${id}.json`);
}

function getLegacyColdFilePath(): string {
  return path.join(DATA_PATHS.wallets, COLD_FILE);
}

/**
 * Auto-migrate cold.json → agent-primary.json if needed.
 * Called on first access that needs to list agents.
 */
let migrationDone = false;
function ensureMigration(): void {
  if (migrationDone) return;
  migrationDone = true;

  const legacyPath = getLegacyColdFilePath();
  const primaryPath = getAgentFilePath(PRIMARY_AGENT_ID);

  if (fs.existsSync(legacyPath) && !fs.existsSync(primaryPath)) {
    // Migrate: copy cold.json content into agent-primary.json
    const raw = fs.readFileSync(legacyPath, 'utf-8');
    fs.writeFileSync(primaryPath, raw);
    // Remove old file
    fs.unlinkSync(legacyPath);
  }

  // If primary agent file exists, ensure primaryAgentId is set
  if (fs.existsSync(primaryPath) && !primaryAgentId) {
    primaryAgentId = PRIMARY_AGENT_ID;
  }
}

function isAgentMode(value: unknown): value is AgentMode {
  return value === 'primary' || value === 'linked' || value === 'independent';
}

function readAgentFile(id: string): AgentFile {
  const filePath = getAgentFilePath(id);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AgentFile;
}

function writeAgentFile(id: string, data: AgentFile): void {
  const filePath = getAgentFilePath(id);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function clearNukeStateMarker(): void {
  try {
    if (fs.existsSync(DATA_PATHS.nukeStateMarker)) {
      fs.unlinkSync(DATA_PATHS.nukeStateMarker);
    }
  } catch {
    // Best-effort cleanup.
  }
}

function resolveAgentMode(id: string, data: AgentFile): AgentMode {
  if (id === PRIMARY_AGENT_ID || id === primaryAgentId) return 'primary';
  if (isAgentMode(data.mode) && data.mode !== 'primary') return data.mode;
  return 'independent';
}

function resolveParentAgentId(id: string, data: AgentFile, mode: AgentMode): string | undefined {
  if (mode !== 'linked') return undefined;
  if (typeof data.linkedTo === 'string' && data.linkedTo.trim()) return data.linkedTo.trim();
  // Default linked target is primary when omitted.
  return primaryAgentId || PRIMARY_AGENT_ID;
}

// ---------------------------------------------------------------------------
// Agent CRUD
// ---------------------------------------------------------------------------

/**
 * List all agent files on disk. Returns AgentInfo for each.
 */
export function listAgents(): AgentInfo[] {
  ensureMigration();

  const walletsDir = DATA_PATHS.wallets;
  if (!fs.existsSync(walletsDir)) return [];

  const files = fs.readdirSync(walletsDir);
  const agents: AgentInfo[] = [];

  for (const file of files) {
    if (!file.startsWith(AGENT_PREFIX) || !file.endsWith('.json')) continue;
    const id = file.slice(AGENT_PREFIX.length, -5); // strip prefix and .json

    try {
      const raw = fs.readFileSync(path.join(walletsDir, file), 'utf-8');
      const data: AgentFile = JSON.parse(raw);
      const mode = resolveAgentMode(id, data);
      const parentAgentId = resolveParentAgentId(id, data, mode);
      agents.push({
        id,
        name: data.name,
        address: data.address,
        solanaAddress: data.solanaAddress,
        mode,
        parentAgentId,
        linkedTo: parentAgentId,
        isUnlocked: agentSessions.has(id),
        isPrimary: id === primaryAgentId || id === PRIMARY_AGENT_ID,
        createdAt: data.createdAt,
      });
    } catch {
      // skip corrupt files
    }
  }

  // Sort: primary first, linked next, then independent by createdAt
  agents.sort((a, b) => {
    if (a.isPrimary) return -1;
    if (b.isPrimary) return 1;
    if (a.mode === 'linked' && b.mode !== 'linked') return -1;
    if (b.mode === 'linked' && a.mode !== 'linked') return 1;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  return agents;
}

/**
 * Create a new agent with a fresh mnemonic.
 */
export function createAgent(password: string, name?: string, options: CreateAgentOptions = {}): CreateAgentResult {
  ensureMigration();

  const id = generateAgentId();
  const filePath = getAgentFilePath(id);

  if (fs.existsSync(filePath)) {
    throw new Error(`Agent file already exists: ${id}`);
  }

  const mnemonic = ethers.Mnemonic.entropyToPhrase(ethers.randomBytes(16));
  const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, COLD_PATH);
  const solanaKeypair = deriveSolanaColdKeypair(mnemonic);
  const solanaAddress = solanaKeypair.publicKey.toBase58();

  const mode: Exclude<AgentMode, 'primary'> = options.mode || 'independent';
  const parentAgentId = mode === 'linked'
    ? (options.parentAgentId || options.linkedTo || primaryAgentId || PRIMARY_AGENT_ID)
    : undefined;
  if (mode === 'linked') {
    if (!parentAgentId) throw new Error('linked agent requires a parent agent target');
    if (!fs.existsSync(getAgentFilePath(parentAgentId))) {
      throw new Error(`parent agent not found: ${parentAgentId}`);
    }
  }

  const encrypted = encryptPrivateKey(mnemonic, password);

  const agentFile: AgentFile = {
    address: hdNode.address,
    solanaAddress,
    encrypted,
    createdAt: new Date().toISOString(),
    name,
    mode,
    linkedTo: parentAgentId,
  };

  fs.writeFileSync(filePath, JSON.stringify(agentFile, null, 2));

  // Auto-unlock
  agentSessions.set(id, {
    id,
    mnemonic,
    address: hdNode.address,
    solanaKeypair,
  });
  unlockCredentialAgent(id);

  if (options.seedOnboardingSecret !== false) {
    try {
      ensureOurSecretForAgent(id);
    } catch (err) {
      console.warn('[cold] Failed to seed OURSECRET onboarding note:', err);
    }
  }

  return {
    id,
    address: hdNode.address,
    solanaAddress,
    mnemonic,
    name,
    mode,
    parentAgentId,
    linkedTo: parentAgentId,
  };
}

/**
 * Import a agent from an existing mnemonic.
 */
export function importAgent(mnemonic: string, password: string, name?: string, options: CreateAgentOptions = {}): AgentInfo {
  ensureMigration();

  // Normalize
  const normalizedMnemonic = mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
  if (!ethers.Mnemonic.isValidMnemonic(normalizedMnemonic)) {
    throw new Error('Invalid seed phrase');
  }

  const id = generateAgentId();
  const filePath = getAgentFilePath(id);

  const hdNode = ethers.HDNodeWallet.fromPhrase(normalizedMnemonic, undefined, COLD_PATH);
  const solanaKeypair = deriveSolanaColdKeypair(normalizedMnemonic);
  const solanaAddress = solanaKeypair.publicKey.toBase58();

  const mode: Exclude<AgentMode, 'primary'> = options.mode || 'independent';
  const parentAgentId = mode === 'linked'
    ? (options.parentAgentId || options.linkedTo || primaryAgentId || PRIMARY_AGENT_ID)
    : undefined;
  if (mode === 'linked') {
    if (!parentAgentId) throw new Error('linked agent requires a parent agent target');
    if (!fs.existsSync(getAgentFilePath(parentAgentId))) {
      throw new Error(`parent agent not found: ${parentAgentId}`);
    }
  }

  const encrypted = encryptPrivateKey(normalizedMnemonic, password);

  const agentFile: AgentFile = {
    address: hdNode.address,
    solanaAddress,
    encrypted,
    createdAt: new Date().toISOString(),
    name,
    mode,
    linkedTo: parentAgentId,
  };

  fs.writeFileSync(filePath, JSON.stringify(agentFile, null, 2));

  // Auto-unlock
  agentSessions.set(id, {
    id,
    mnemonic: normalizedMnemonic,
    address: hdNode.address,
    solanaKeypair,
  });
  unlockCredentialAgent(id);

  if (options.seedOnboardingSecret !== false) {
    try {
      ensureOurSecretForAgent(id);
    } catch (err) {
      console.warn('[cold] Failed to seed OURSECRET onboarding note:', err);
    }
  }

  return {
    id,
    name,
    address: hdNode.address,
    solanaAddress,
    mode,
    parentAgentId,
    linkedTo: parentAgentId,
    isUnlocked: true,
    isPrimary: false,
    createdAt: agentFile.createdAt,
  };
}

/**
 * Unlock a specific agent.
 */
export function unlockAgent(id: string, password: string): boolean {
  ensureMigration();

  const filePath = getAgentFilePath(id);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Agent not found: ${id}`);
  }

  const data: AgentFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  try {
    const mnemonic = decryptPrivateKey(data.encrypted, password);
    const solanaKeypair = deriveSolanaColdKeypair(mnemonic);

    agentSessions.set(id, {
      id,
      mnemonic,
      address: data.address,
      solanaKeypair,
    });
    unlockCredentialAgent(id);

    // Cache primary password while unlocked so linked agents can auto-unlock.
    if (id === primaryAgentId || id === PRIMARY_AGENT_ID) {
      primaryAgentPassword = password;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Lock a specific agent.
 */
export function lockAgent(id: string): void {
  agentSessions.delete(id);
  lockCredentialAgent(id);
  if (id === primaryAgentId || id === PRIMARY_AGENT_ID) {
    primaryAgentPassword = null;
  }
}

/**
 * Lock ALL agents.
 */
export function lockAllAgents(): void {
  agentSessions.clear();
  primaryAgentPassword = null;
  lockAllCredentialAgents();
}

/**
 * Get the mnemonic for a specific agent (must be unlocked).
 */
export function getAgentMnemonic(id: string): string | null {
  return agentSessions.get(id)?.mnemonic ?? null;
}

/**
 * Check if a specific agent is unlocked.
 */
export function isAgentUnlocked(id: string): boolean {
  return agentSessions.has(id);
}

/**
 * Get a agent's EVM address (from file, doesn't need unlock).
 */
export function getAgentAddress(id: string): string | null {
  const session = agentSessions.get(id);
  if (session) return session.address;

  const filePath = getAgentFilePath(id);
  if (!fs.existsSync(filePath)) return null;

  const data: AgentFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return data.address;
}

/**
 * Get a agent's Solana address (from file, doesn't need unlock).
 */
export function getAgentSolanaAddress(id: string): string | null {
  const session = agentSessions.get(id);
  if (session) return session.solanaKeypair.publicKey.toBase58();

  const filePath = getAgentFilePath(id);
  if (!fs.existsSync(filePath)) return null;

  const data: AgentFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return data.solanaAddress || null;
}

/**
 * Get a agent's Solana keypair (requires unlock).
 */
export function getAgentSolanaKeypair(id: string): Keypair | null {
  return agentSessions.get(id)?.solanaKeypair ?? null;
}

/**
 * Delete a agent file and lock it.
 */
export function deleteAgent(id: string): void {
  lockAgent(id);

  const filePath = getAgentFilePath(id);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  if (primaryAgentId === id) {
    primaryAgentId = null;
  }
}

/**
 * Export seed for a specific agent (must be unlocked).
 */
export function exportAgentSeed(id: string): string | null {
  return getAgentMnemonic(id);
}

/**
 * Sign an EVM transaction with a specific agent.
 */
export async function signWithAgent(
  agentId: string,
  transaction: ethers.TransactionRequest,
  provider: ethers.Provider
): Promise<string> {
  const session = agentSessions.get(agentId);
  if (!session) {
    throw new Error(`Agent ${agentId} is locked. Unlock it first.`);
  }

  const hdNode = ethers.HDNodeWallet.fromPhrase(session.mnemonic, undefined, COLD_PATH);
  const wallet = hdNode.connect(provider);
  const tx = await wallet.sendTransaction(transaction);
  return tx.hash;
}

/**
 * Sign a Solana transaction with a specific agent's keypair.
 */
export function signSolanaAgentTransaction(agentId: string, tx: Transaction): void {
  const session = agentSessions.get(agentId);
  if (!session) {
    throw new Error(`Agent ${agentId} is locked. Unlock it first.`);
  }
  tx.partialSign(session.solanaKeypair);
}

// ---------------------------------------------------------------------------
// Generate short agent ID
// ---------------------------------------------------------------------------
function generateAgentId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const bytes = ethers.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    id += chars[bytes[i] % chars.length];
  }
  return id;
}

/**
 * Get the cached primary agent password (available while primary is unlocked).
 */
export function getPrimaryAgentPassword(): string | null {
  const rootAgentId = primaryAgentId || PRIMARY_AGENT_ID;
  if (!isAgentUnlocked(rootAgentId)) {
    primaryAgentPassword = null;
    return null;
  }
  return primaryAgentPassword;
}

/**
 * Ensure the legacy linked "agent" vault exists under primary.
 * Kept for backward compatibility and explicit callers.
 */
export function ensureDefaultLinkedAgentAgent(): { created: boolean; agentId: string | null } {
  ensureMigration();
  if (!primaryAgentId || !primaryAgentPassword) {
    return { created: false, agentId: null };
  }

  const agents = listAgents();
  const existing = agents.find(
    v => (v.name || '').trim().toLowerCase() === AGENT_AGENT_NAME && (v.parentAgentId || v.linkedTo) === primaryAgentId,
  ) || agents.find(v => (v.name || '').trim().toLowerCase() === AGENT_AGENT_NAME);

  if (existing) {
    return { created: false, agentId: existing.id };
  }

  const created = createAgent(primaryAgentPassword, AGENT_AGENT_NAME, {
    mode: 'linked',
    parentAgentId: primaryAgentId,
    seedOnboardingSecret: false,
  });
  return { created: true, agentId: created.id };
}


function sortAgentsByCreatedAt(a: AgentInfo, b: AgentInfo): number {
  const createdDelta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  if (createdDelta !== 0) return createdDelta;
  return a.id.localeCompare(b.id);
}

function buildChildrenMap(agents: AgentInfo[]): Map<string, AgentInfo[]> {
  const byParent = new Map<string, AgentInfo[]>();
  for (const agent of agents) {
    if (agent.mode !== 'linked') continue;
    const parentAgentId = agent.parentAgentId || agent.linkedTo;
    if (!parentAgentId) continue;
    const bucket = byParent.get(parentAgentId) || [];
    bucket.push(agent);
    byParent.set(parentAgentId, bucket);
  }
  for (const children of byParent.values()) {
    children.sort(sortAgentsByCreatedAt);
  }
  return byParent;
}

function collectDescendantAgentIds(rootAgentId: string, agents: AgentInfo[]): string[] {
  const byParent = buildChildrenMap(agents);
  const descendants: string[] = [];
  const queue = [...(byParent.get(rootAgentId) || [])];
  const visited = new Set<string>([rootAgentId]);

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (visited.has(next.id)) continue;
    visited.add(next.id);
    descendants.push(next.id);
    const children = byParent.get(next.id);
    if (children) queue.push(...children);
  }

  return descendants;
}

/**
 * Unlock all descendant child agents for a parent using the same password.
 * Returns number of child agents newly unlocked in this call.
 */
export function autoUnlockChildAgents(parentAgentId: string, password: string): number {
  const agents = listAgents();
  const byParent = buildChildrenMap(agents);
  const queue = [...(byParent.get(parentAgentId) || [])];
  const visited = new Set<string>([parentAgentId]);
  let unlocked = 0;

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (visited.has(next.id)) continue;
    visited.add(next.id);

    if (!isAgentUnlocked(next.id)) {
      try {
        if (unlockAgent(next.id, password)) unlocked++;
      } catch (err) {
        console.warn(
          `[cold] Child agent unlock failed for "${next.id}"${next.name ? ` (${next.name})` : ''}: ${String(err)}`
        );
      }
    }

    const children = byParent.get(next.id);
    if (children) queue.push(...children);
  }

  return unlocked;
}

/**
 * Auto-unlock linked agents when primary is unlocked.
 * Independent agents remain locked until explicitly unlocked with their own password.
 */
export function autoUnlockLinkedAgents(): number {
  const rootAgentId = primaryAgentId || PRIMARY_AGENT_ID;
  if (!isAgentUnlocked(rootAgentId)) {
    primaryAgentPassword = null;
    return 0;
  }
  if (!primaryAgentPassword) return 0;
  return autoUnlockChildAgents(rootAgentId, primaryAgentPassword);
}

/**
 * Resolve agent subtree for UI filtering.
 * - Selecting any agent returns that agent plus all descendants.
 */
export function getLinkedAgentGroup(agentId: string): string[] {
  const agents = listAgents();
  const selected = agents.find(v => v.id === agentId);
  if (!selected) return [agentId];
  return [selected.id, ...collectDescendantAgentIds(selected.id, agents)];
}

// ---------------------------------------------------------------------------
// Reset for testing (clears all module state)
// ---------------------------------------------------------------------------
export function _resetForTesting(): void {
  agentSessions.clear();
  primaryAgentId = null;
  primaryAgentPassword = null;
  migrationDone = false;
}

// ===========================================================================
// BACKWARD COMPATIBILITY — all original exports still work via primary agent
// ===========================================================================

/**
 * Get the primary agent ID (or null if none exists).
 */
export function getPrimaryAgentId(): string | null {
  ensureMigration();
  return primaryAgentId;
}

export function hasColdWallet(): boolean {
  ensureMigration();
  if (primaryAgentId && fs.existsSync(getAgentFilePath(primaryAgentId))) {
    return true;
  }
  // Also check legacy path as fallback
  return fs.existsSync(getLegacyColdFilePath());
}

export function isUnlocked(): boolean {
  // Returns true if ANY agent is unlocked (backward compat)
  return agentSessions.size > 0;
}

export interface CreateWalletResult extends WalletInfo {
  mnemonic: string;
}

export function createColdWallet(password: string): CreateWalletResult {
  ensureMigration();

  if (hasColdWallet()) {
    throw new Error('Primary agent already exists. Delete it first if you want to recreate.');
  }

  // Create as the primary agent
  const result = createAgent(password, undefined, { seedOnboardingSecret: false });

  // Set as primary
  primaryAgentId = result.id;

  // Rename to agent-primary.json
  const currentPath = getAgentFilePath(result.id);
  const primaryPath = getAgentFilePath(PRIMARY_AGENT_ID);
  fs.renameSync(currentPath, primaryPath);

  // Update session key
  const session = agentSessions.get(result.id)!;
  agentSessions.delete(result.id);
  agentSessions.set(PRIMARY_AGENT_ID, { ...session, id: PRIMARY_AGENT_ID });
  primaryAgentId = PRIMARY_AGENT_ID;
  primaryAgentPassword = password;
  unlockCredentialAgent(PRIMARY_AGENT_ID);

  // Persist primary mode metadata after rename.
  try {
    const primaryFile = readAgentFile(PRIMARY_AGENT_ID);
    primaryFile.mode = 'primary';
    delete primaryFile.linkedTo;
    writeAgentFile(PRIMARY_AGENT_ID, primaryFile);
  } catch (err) {
    console.warn('[cold] Failed to persist primary agent mode metadata:', err);
  }

  // Seed primary onboarding secret after final agent ID is stable.
  try {
    ensureOurSecretForAgent(PRIMARY_AGENT_ID);
  } catch (err) {
    console.warn('[cold] Failed to seed primary OURSECRET onboarding note:', err);
  }
  try {
    ensureDontLookForAgent(PRIMARY_AGENT_ID);
  } catch (err) {
    console.warn('[cold] Failed to seed primary DONTLOOK onboarding note:', err);
  }
  try {
    ensureWorkingWithSecretsForAgent(PRIMARY_AGENT_ID);
  } catch (err) {
    console.warn('[cold] Failed to seed primary WORKING_WITH_SECRETS onboarding note:', err);
  }

  clearNukeStateMarker();

  return {
    address: result.address,
    tier: 'cold',
    chain: 'all',
    createdAt: new Date().toISOString(),
    mnemonic: result.mnemonic,
  };
}

export function exportSeed(): string | null {
  if (!primaryAgentId) return null;
  return getAgentMnemonic(primaryAgentId);
}

export function unlock(password: string): boolean {
  ensureMigration();

  if (!primaryAgentId) {
    throw new Error('No cold wallet found');
  }

  return unlockAgent(primaryAgentId, password);
}

/**
 * Rotate the primary agent password by re-encrypting the stored mnemonic wrapper.
 * Returns false when the current password is invalid.
 */
export function rotatePrimaryAgentPassword(currentPassword: string, newPassword: string): boolean {
  ensureMigration();

  const agentId = primaryAgentId || PRIMARY_AGENT_ID;
  const filePath = getAgentFilePath(agentId);
  if (!fs.existsSync(filePath)) {
    throw new Error('No cold wallet found');
  }
  if (newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const agentFile = readAgentFile(agentId);
  let mnemonic: string;
  try {
    mnemonic = decryptPrivateKey(agentFile.encrypted, currentPassword);
  } catch {
    return false;
  }

  agentFile.encrypted = encryptPrivateKey(mnemonic, newPassword);
  writeAgentFile(agentId, agentFile);

  if (primaryAgentPassword === currentPassword) {
    primaryAgentPassword = newPassword;
  }

  return true;
}

/**
 * Recover primary agent access by proving ownership of the seed phrase,
 * then re-encrypting it with a new password and unlocking the agent.
 */
export function recoverPrimaryAgentWithMnemonic(mnemonic: string, newPassword: string): boolean {
  ensureMigration();

  const agentId = primaryAgentId || PRIMARY_AGENT_ID;
  const filePath = getAgentFilePath(agentId);
  if (!fs.existsSync(filePath)) {
    throw new Error('No cold wallet found');
  }
  if (newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const normalizedMnemonic = mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
  if (!ethers.Mnemonic.isValidMnemonic(normalizedMnemonic)) {
    return false;
  }

  const agentFile = readAgentFile(agentId);
  const derived = ethers.HDNodeWallet.fromPhrase(normalizedMnemonic, undefined, COLD_PATH);
  if (derived.address.toLowerCase() !== agentFile.address.toLowerCase()) {
    return false;
  }

  agentFile.encrypted = encryptPrivateKey(normalizedMnemonic, newPassword);
  writeAgentFile(agentId, agentFile);

  const solanaKeypair = deriveSolanaColdKeypair(normalizedMnemonic);
  agentSessions.set(agentId, {
    id: agentId,
    mnemonic: normalizedMnemonic,
    address: agentFile.address,
    solanaKeypair,
  });
  unlockCredentialAgent(agentId);

  if (agentId === (primaryAgentId || PRIMARY_AGENT_ID)) {
    primaryAgentPassword = newPassword;
  }

  return true;
}

export function lock(): void {
  lockAllAgents();
}

export function getColdWalletAddress(): string | null {
  if (!primaryAgentId) {
    ensureMigration();
    if (!primaryAgentId) return null;
  }
  return getAgentAddress(primaryAgentId);
}

export function getMnemonic(): string | null {
  if (!primaryAgentId) return null;
  return getAgentMnemonic(primaryAgentId);
}

export async function signWithColdWallet(
  transaction: ethers.TransactionRequest,
  provider: ethers.Provider
): Promise<string> {
  if (!primaryAgentId) {
    throw new Error('No primary agent configured');
  }
  return signWithAgent(primaryAgentId, transaction, provider);
}

export function getColdWalletInfo(): WalletInfo | null {
  ensureMigration();
  if (!primaryAgentId) return null;

  const filePath = getAgentFilePath(primaryAgentId);
  if (!fs.existsSync(filePath)) return null;

  const data: AgentFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  return {
    address: data.address,
    tier: 'cold',
    chain: 'all',
    createdAt: data.createdAt,
  };
}

export function getSolanaColdAddress(): string | null {
  if (!primaryAgentId) {
    ensureMigration();
    if (!primaryAgentId) return null;
  }
  return getAgentSolanaAddress(primaryAgentId);
}

export function getSolanaColdKeypair(): Keypair | null {
  if (!primaryAgentId) return null;
  return getAgentSolanaKeypair(primaryAgentId);
}

export function signSolanaColdTransaction(tx: Transaction): void {
  if (!primaryAgentId) {
    throw new Error('No primary agent configured');
  }
  signSolanaAgentTransaction(primaryAgentId, tx);
}

export function deleteColdWallet(): void {
  if (primaryAgentId) {
    deleteAgent(primaryAgentId);
  }
  // Also remove legacy file if it exists
  const legacyPath = getLegacyColdFilePath();
  if (fs.existsSync(legacyPath)) {
    fs.unlinkSync(legacyPath);
  }
}

export function importColdWallet(mnemonic: string, password: string): WalletInfo {
  ensureMigration();

  if (hasColdWallet()) {
    throw new Error('Primary agent already exists. Delete it first if you want to import.');
  }

  const info = importAgent(mnemonic, password, undefined, { seedOnboardingSecret: false });

  // Make it the primary agent
  const currentPath = getAgentFilePath(info.id);
  const primaryPath = getAgentFilePath(PRIMARY_AGENT_ID);
  fs.renameSync(currentPath, primaryPath);

  // Update session key
  const session = agentSessions.get(info.id)!;
  agentSessions.delete(info.id);
  agentSessions.set(PRIMARY_AGENT_ID, { ...session, id: PRIMARY_AGENT_ID });
  primaryAgentId = PRIMARY_AGENT_ID;
  primaryAgentPassword = password;
  unlockCredentialAgent(PRIMARY_AGENT_ID);

  // Persist primary mode metadata after rename.
  try {
    const primaryFile = readAgentFile(PRIMARY_AGENT_ID);
    primaryFile.mode = 'primary';
    delete primaryFile.linkedTo;
    writeAgentFile(PRIMARY_AGENT_ID, primaryFile);
  } catch (err) {
    console.warn('[cold] Failed to persist primary agent mode metadata:', err);
  }

  // Seed primary onboarding secret after final agent ID is stable.
  try {
    ensureOurSecretForAgent(PRIMARY_AGENT_ID);
  } catch (err) {
    console.warn('[cold] Failed to seed primary OURSECRET onboarding note:', err);
  }
  try {
    ensureDontLookForAgent(PRIMARY_AGENT_ID);
  } catch (err) {
    console.warn('[cold] Failed to seed primary DONTLOOK onboarding note:', err);
  }
  try {
    ensureWorkingWithSecretsForAgent(PRIMARY_AGENT_ID);
  } catch (err) {
    console.warn('[cold] Failed to seed primary WORKING_WITH_SECRETS onboarding note:', err);
  }

  clearNukeStateMarker();

  return {
    address: info.address,
    tier: 'cold',
    chain: 'all',
    createdAt: info.createdAt,
  };
}

// Derive a hot wallet at a specific index
// Hot wallets use path: m/44'/60'/1'/0/N
export function deriveHotWallet(index: number): ethers.HDNodeWallet {
  if (!primaryAgentId) {
    throw new Error('No primary agent configured');
  }
  const mnemonic = getAgentMnemonic(primaryAgentId);
  if (!mnemonic) {
    throw new Error('Primary agent is locked. Unlock it first.');
  }

  const hotPath = `m/44'/60'/1'/0/${index}`;
  return ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, hotPath);
}
