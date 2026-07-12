import fs from 'fs';
import path from 'path';
import os from 'os';
import { HttpError } from './error';

// Production data lives in ~/.auramaxx/ (outside repo, safe from tests)
// Tests override via WALLET_DATA_DIR=server/test-data
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.auramaxx');

// Lazy — read env at access time so tests can override WALLET_DATA_DIR
function getDataDir(): string {
  const dir = process.env.WALLET_DATA_DIR || DEFAULT_DATA_DIR;
  // Safety: never let tests write to the real user data directory.
  if (dir === DEFAULT_DATA_DIR && (process.env.VITEST || process.env.NODE_ENV === 'test')) {
    throw new Error(
      `WALLET_DATA_DIR is not set — refusing to use ${DEFAULT_DATA_DIR} in test environment. ` +
      'Set WALLET_DATA_DIR to a temp directory before running tests.'
    );
  }
  return dir;
}
function getConfigPath(): string {
  return path.join(getDataDir(), 'config.json');
}

/**
 * Get the database file path (inside the data dir).
 * Tests override via DATABASE_URL env var.
 */
export function getDbPath(): string {
  return path.join(getDataDir(), 'auramaxx.db');
}

/**
 * Backups dir — stored outside the main data dir so that nuking
 * ~/.auramaxx/ doesn't destroy backups.
 *
 * Production: ~/.aurabak/
 * Tests:      <WALLET_DATA_DIR>/backups  (stays inside the temp dir)
 */
const DEFAULT_BACKUPS_DIR = path.join(os.homedir(), '.aurabak');
const NUKE_STATE_MARKER_FILENAME = '.nuke-state.json';

export function getBackupsDir(): string {
  const dataDir = process.env.WALLET_DATA_DIR;
  // In test environments, keep backups inside the test data dir
  if (dataDir && (process.env.VITEST || process.env.NODE_ENV === 'test')) {
    return path.join(dataDir, 'backups');
  }
  return DEFAULT_BACKUPS_DIR;
}

/**
 * Get DATABASE_URL for Prisma, pointing to the data dir.
 * Returns the env override if set to a non-default value.
 */
export function getDbUrl(): string {
  const envUrl = process.env.DATABASE_URL;
  // If explicitly set (e.g. tests), use it
  if (envUrl) {
    return envUrl;
  }
  return `file:${getDbPath()}`;
}

export interface ChainConfig {
  rpc: string;
  chainId: number;
  explorer: string;
  nativeCurrency: string;
}

export interface WalletConfig {
  chains: Record<string, ChainConfig>;
  defaultChain: string;
  server: {
    port: number;
    host: string;
  };
}

const DEFAULT_CONFIG: WalletConfig = {
  chains: {
    base: {
      rpc: 'https://mainnet.base.org',
      chainId: 8453,
      explorer: 'https://basescan.org',
      nativeCurrency: 'ETH'
    },
    ethereum: {
      rpc: 'https://eth.llamarpc.com',
      chainId: 1,
      explorer: 'https://etherscan.io',
      nativeCurrency: 'ETH'
    },
    solana: {
      rpc: 'https://api.mainnet-beta.solana.com',
      chainId: 0,
      explorer: 'https://solscan.io',
      nativeCurrency: 'SOL'
    },
    'solana-devnet': {
      rpc: 'https://api.devnet.solana.com',
      chainId: 0,
      explorer: 'https://solscan.io/?cluster=devnet',
      nativeCurrency: 'SOL'
    }
  },
  defaultChain: 'base',
  server: {
    port: 4242,
    host: '127.0.0.1'
  }
};

export function ensureDataDir(): void {
  const dataDir = getDataDir();
  const dirs = [
    dataDir,
    path.join(dataDir, 'hot'),
    path.join(dataDir, 'pending'),
    path.join(dataDir, 'credentials'),
    path.join(dataDir, 'credentials-archive'),
    path.join(dataDir, 'credentials-recently-deleted'),
    path.join(dataDir, 'credential-shares'),
  ];
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      // Ensure correct permissions on existing dirs
      try { fs.chmodSync(dir, 0o700); } catch {}
    }
  });

  // Auto-migrate from legacy in-repo data/ to ~/.auramaxx/
  if (dataDir === DEFAULT_DATA_DIR) {
    migrateFromLegacyDir();
  }
}

/**
 * One-time migration: copy agent files, hot wallets, config from old data/ to ~/.auramaxx/.
 * Only runs if ~/.auramaxx/.migrated marker doesn't exist and data/ has content.
 */
let migrationAttempted = false;
function migrateFromLegacyDir(): void {
  if (migrationAttempted) return;
  migrationAttempted = true;

  const marker = path.join(DEFAULT_DATA_DIR, '.migrated');
  if (fs.existsSync(marker)) return;

  // Look for legacy data/ in common locations
  const candidates = [
    path.join(process.cwd(), 'data'),
    path.join(process.cwd(), 'server', 'data'),
  ];

  for (const legacyDir of candidates) {
    if (!fs.existsSync(legacyDir)) continue;

    const files = fs.readdirSync(legacyDir);
    const hasAgentFiles = files.some(f => f.startsWith('agent-') || f === 'cold.json' || f === 'config.json');
    if (!hasAgentFiles) continue;

    console.log(`Migrating wallet data: ${legacyDir} → ${DEFAULT_DATA_DIR}`);

    // Copy files (don't delete originals — user can do that manually)
    for (const file of files) {
      const src = path.join(legacyDir, file);
      const dest = path.join(DEFAULT_DATA_DIR, file);
      const stat = fs.statSync(src);

      if (stat.isFile() && !fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        console.log(`  copied ${file}`);
      } else if (stat.isDirectory()) {
        // Copy subdirectories (hot/, pending/)
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
        const subFiles = fs.readdirSync(src);
        for (const sub of subFiles) {
          const subSrc = path.join(src, sub);
          const subDest = path.join(dest, sub);
          if (fs.statSync(subSrc).isFile() && !fs.existsSync(subDest)) {
            fs.copyFileSync(subSrc, subDest);
            console.log(`  copied ${file}/${sub}`);
          }
        }
      }
    }

    // Also migrate dev.db if it exists nearby
    const dbCandidates = [
      path.join(legacyDir, '..', 'dev.db'),
      path.join(legacyDir, '..', 'prisma', 'dev.db'),
    ];
    const destDb = path.join(DEFAULT_DATA_DIR, 'auramaxx.db');
    if (!fs.existsSync(destDb)) {
      for (const dbSrc of dbCandidates) {
        if (fs.existsSync(dbSrc) && fs.statSync(dbSrc).size > 0) {
          fs.copyFileSync(dbSrc, destDb);
          console.log(`  copied database → auramaxx.db`);
          break;
        }
      }
    }

    break; // Only migrate from first found
  }

  // Write marker so we don't re-run
  fs.writeFileSync(marker, new Date().toISOString());
}

export function loadConfig(): WalletConfig {
  ensureDataDir();
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const fileConfig = JSON.parse(raw);
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    // Deep-merge chains so defaults (e.g. solana) aren't lost
    chains: { ...DEFAULT_CONFIG.chains, ...fileConfig.chains },
  };
}

export function saveConfig(config: WalletConfig): void {
  ensureDataDir();
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

export const DATA_PATHS = {
  get config() { return getConfigPath(); },
  get wallets() { return getDataDir(); },
  get nukeStateMarker() { return path.join(getDataDir(), NUKE_STATE_MARKER_FILENAME); },
  get hotWallets() { return path.join(getDataDir(), 'hot'); },
  get pending() { return path.join(getDataDir(), 'pending'); },
  get credentials() { return path.join(getDataDir(), 'credentials'); },
  get credentialsArchive() { return path.join(getDataDir(), 'credentials-archive'); },
  get credentialsRecentlyDeleted() { return path.join(getDataDir(), 'credentials-recently-deleted'); },
  get credentialShares() { return path.join(getDataDir(), 'credential-shares'); },
};

export const SERVER_PORT = process.env.WALLET_SERVER_PORT
  ? parseInt(process.env.WALLET_SERVER_PORT, 10)
  : 4242;

// Fallback public RPCs for common chains
const PUBLIC_RPCS: Record<string, ChainConfig> = {
  base: {
    rpc: 'https://mainnet.base.org',
    chainId: 8453,
    explorer: 'https://basescan.org',
    nativeCurrency: 'ETH',
  },
  ethereum: {
    rpc: 'https://eth.llamarpc.com',
    chainId: 1,
    explorer: 'https://etherscan.io',
    nativeCurrency: 'ETH',
  },
  arbitrum: {
    rpc: 'https://arb1.arbitrum.io/rpc',
    chainId: 42161,
    explorer: 'https://arbiscan.io',
    nativeCurrency: 'ETH',
  },
  optimism: {
    rpc: 'https://mainnet.optimism.io',
    chainId: 10,
    explorer: 'https://optimistic.etherscan.io',
    nativeCurrency: 'ETH',
  },
  polygon: {
    rpc: 'https://polygon-rpc.com',
    chainId: 137,
    explorer: 'https://polygonscan.com',
    nativeCurrency: 'MATIC',
  },
  solana: {
    rpc: 'https://api.mainnet-beta.solana.com',
    chainId: 0,
    explorer: 'https://solscan.io',
    nativeCurrency: 'SOL',
  },
  'solana-devnet': {
    rpc: 'https://api.devnet.solana.com',
    chainId: 0,
    explorer: 'https://solscan.io/?cluster=devnet',
    nativeCurrency: 'SOL',
  },
};

// Alchemy paths for chains
export const ALCHEMY_PATHS: Record<string, { path: string; chainId: number; explorer: string }> = {
  base: { path: 'base-mainnet', chainId: 8453, explorer: 'https://basescan.org' },
  ethereum: { path: 'eth-mainnet', chainId: 1, explorer: 'https://etherscan.io' },
  arbitrum: { path: 'arb-mainnet', chainId: 42161, explorer: 'https://arbiscan.io' },
  optimism: { path: 'opt-mainnet', chainId: 10, explorer: 'https://optimistic.etherscan.io' },
  polygon: { path: 'polygon-mainnet', chainId: 137, explorer: 'https://polygonscan.com' },
  solana: { path: 'solana-mainnet', chainId: 0, explorer: 'https://solscan.io' },
  'solana-devnet': { path: 'solana-devnet', chainId: 0, explorer: 'https://solscan.io/?cluster=devnet' },
};

// Import prisma lazily to avoid circular deps
let _prisma: typeof import('./db').prisma | null = null;
async function getPrisma() {
  if (!_prisma) {
    const { prisma } = await import('./db');
    _prisma = prisma;
  }
  return _prisma;
}

/**
 * Get Alchemy API key from agent-backed API key credentials.
 */
export async function getAlchemyKey(): Promise<string | null> {
  try {
    const {
      ensureApiKeysMigrated,
      readApiKeyValueByService,
    } = await import('./apikey-migration');
    await ensureApiKeysMigrated();
    return readApiKeyValueByService('alchemy');
  } catch {
    return null;
  }
}

/**
 * Get chain overrides from database (AppConfig.chainConfig)
 */
async function getChainOverrides(): Promise<Record<string, ChainConfig>> {
  try {
    const prisma = await getPrisma();
    const appConfig = await prisma.appConfig.findUnique({
      where: { id: 'global' },
    });
    if (appConfig?.chainConfig) {
      return JSON.parse(appConfig.chainConfig);
    }
  } catch {
    // Ignore errors
  }
  return {};
}

/**
 * Get RPC URL for a chain with priority:
 * 1. User-configured override (from DB)
 * 2. Alchemy API key (if available)
 * 3. File config
 * 4. Public RPC fallback
 */
export async function getRpcUrl(chain: string = 'base'): Promise<string> {
  // 1. Check DB overrides
  const overrides = await getChainOverrides();
  if (overrides[chain]?.rpc) {
    return overrides[chain].rpc;
  }

  // 2. Check for Alchemy key
  const alchemyKey = await getAlchemyKey();
  const alchemyConfig = ALCHEMY_PATHS[chain];
  if (alchemyKey && alchemyConfig) {
    return `https://${alchemyConfig.path}.g.alchemy.com/v2/${alchemyKey}`;
  }

  // 3. Check file config
  const config = loadConfig();
  if (config.chains[chain]?.rpc) {
    return config.chains[chain].rpc;
  }

  // 4. Fallback to public RPC
  return PUBLIC_RPCS[chain]?.rpc || PUBLIC_RPCS.base.rpc;
}

/**
 * Sync version of getRpcUrl - uses file config only (no DB)
 * Use this when you can't await (e.g., in sync contexts)
 */
export function getRpcUrlSync(chain: string = 'base'): string {
  const config = loadConfig();
  if (config.chains[chain]?.rpc) {
    return config.chains[chain].rpc;
  }
  return PUBLIC_RPCS[chain]?.rpc || PUBLIC_RPCS.base.rpc;
}

/**
 * Resolve chain name to config. Uses defaultChain when chain is omitted.
 * Throws HttpError(400) if the chain is unknown.
 */
export function resolveChain(chain?: string): { targetChain: string; chainConfig: ChainConfig } {
  const config = loadConfig();
  const targetChain = chain || config.defaultChain;
  const chainConfig = config.chains[targetChain];
  if (!chainConfig) {
    throw new HttpError(400, `Unknown chain: ${targetChain}`);
  }
  return { targetChain, chainConfig };
}
