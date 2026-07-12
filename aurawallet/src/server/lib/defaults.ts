/**
 * Centralized System Defaults
 * ===========================
 * Key-value store for configurable limits, permissions, TTLs, rate limits, etc.
 * Backed by Prisma SystemDefault table with in-memory cache for fast reads.
 *
 * Usage:
 *   const limit = await getDefault('limits.fund', 0);
 *   const perms = getDefaultSync('permissions.default', ['swap']);
 *   await setDefault('limits.fund', 0.05);
 */

import { prisma } from './db';

// ─── Seed Defaults ──────────────────────────────────────────────────
// Canonical seed values — used for reset and as fallback when DB is empty.

export interface SeedDefault {
  key: string;
  value: unknown;
  type: string;
  label: string;
  description?: string;
}

export const SEED_DEFAULTS: SeedDefault[] = [
  // Permissions
  { key: 'permissions.default', value: ['wallet:create:hot', 'send:hot', 'swap', 'fund', 'action:create', 'secret:read', 'secret:write'], type: 'permissions', label: 'Default Agent Permissions', description: 'Permissions granted to new agent tokens by default' },
  { key: 'permissions.agent_tier', value: 'admin', type: 'permissions', label: 'Default Agent Permission Tier', description: 'Agent-chat permission level: admin (full access) or restricted (approval required)' },

  // Financial limits
  { key: 'limits.fund', value: 0, type: 'financial', label: 'Default Fund Limit (ETH)', description: 'Default ETH limit for cold→hot transfers' },
  { key: 'limits.send', value: 0, type: 'financial', label: 'Default Send Limit (ETH)', description: 'Default ETH limit for hot wallet sends' },
  { key: 'limits.swap', value: 0, type: 'financial', label: 'Default Swap Limit (ETH)', description: 'Default ETH limit for token swaps' },
  { key: 'gas.evm_buffer', value: 0.001, type: 'financial', label: 'EVM Gas Buffer (ETH)', description: 'Reserved ETH buffer for max-send in UI' },
  { key: 'gas.sol_buffer', value: 0.000005, type: 'financial', label: 'Solana Gas Buffer (SOL)', description: 'Reserved SOL buffer for max-send in UI' },

  // TTLs
  { key: 'ttl.agent', value: 604800, type: 'ttl', label: 'Agent Token TTL (seconds)', description: 'Default time-to-live for agent tokens (7 days)' },
  { key: 'ttl.admin', value: 2592000, type: 'ttl', label: 'Admin Token TTL (seconds)', description: 'Time-to-live for admin tokens (30 days)' },
  { key: 'ttl.app', value: 86400, type: 'ttl', label: 'App Token TTL (seconds)', description: 'Time-to-live for app tokens (24h)' },
  { key: 'ttl.action', value: 3600, type: 'ttl', label: 'Action Token TTL (seconds)', description: 'Default time-to-live for action tokens (1 hour)' },

  // Strategy runtime (cron-owned)
  { key: 'strategy.cron_enabled', value: true, type: 'strategy', label: 'Enable Cron-Owned Strategy Runtime', description: 'When true, strategy ticks and message hooks are owned by the cron process only' },
  { key: 'strategy.tick_interval', value: 1000, type: 'strategy', label: 'Strategy Scheduler Interval (ms)', description: 'Main cron loop interval for strategy ticks and queued messages' },
  { key: 'strategy.message_batch_size', value: 20, type: 'strategy', label: 'Strategy Message Batch Size', description: 'Maximum queued app messages processed per strategy loop' },
  { key: 'strategy.message_timeout_ms', value: 120000, type: 'strategy', label: 'App Message Timeout (ms)', description: 'How long API waits for cron-owned app message processing' },
  { key: 'strategy.health_stale_ms', value: 30000, type: 'strategy', label: 'Strategy Runtime Health Stale Threshold (ms)', description: 'How long a cron heartbeat can be stale before strategy runtime is considered unhealthy' },

  // Polymarket scanner
  { key: 'polymarket.scan_enabled', value: false, type: 'scanner', label: 'Enable Polymarket Scanner', description: 'When true, the cron server scans Polymarket for read-only complete-set trade candidates' },
  { key: 'polymarket.scan_interval', value: 300000, type: 'scanner', label: 'Polymarket Scan Interval (ms)', description: 'How often the read-only Polymarket scanner polls markets' },
  { key: 'polymarket.market_limit', value: 200, type: 'scanner', label: 'Polymarket Market Fetch Limit', description: 'Maximum number of active markets fetched from the Polymarket Gamma API per scan' },
  { key: 'polymarket.book_scan_limit', value: 40, type: 'scanner', label: 'Polymarket Book Scan Limit', description: 'Maximum number of filtered markets whose CLOB books are inspected per scan' },
  { key: 'polymarket.min_liquidity_usd', value: 10000, type: 'scanner', label: 'Polymarket Minimum Liquidity (USD)', description: 'Minimum market liquidity required before the scanner inspects a market book' },
  { key: 'polymarket.max_days_to_expiry', value: 30, type: 'scanner', label: 'Polymarket Maximum Days To Expiry', description: 'Ignore markets resolving farther out than this many days' },
  { key: 'polymarket.min_gross_edge_pct', value: 2, type: 'scanner', label: 'Polymarket Minimum Gross Edge (%)', description: 'Minimum gross complete-set edge before the scanner proposes a trade candidate' },
  { key: 'polymarket.min_top_book_shares', value: 25, type: 'scanner', label: 'Polymarket Minimum Top-Book Shares', description: 'Minimum matched top-of-book share size required for a candidate' },
  { key: 'polymarket.max_candidates', value: 10, type: 'scanner', label: 'Polymarket Maximum Candidates', description: 'Maximum number of candidates kept in the latest scan snapshot' },
  { key: 'polymarket.notify_top_n', value: 3, type: 'scanner', label: 'Polymarket Notification Count', description: 'How many top candidates per scan are turned into notifications' },

  // Rate limits (format: "max,windowMs")
  { key: 'rate.brute_force', value: '5,900000', type: 'rate_limit', label: 'Brute Force Limit', description: 'Max attempts per 15-minute window for auth endpoints' },
  { key: 'rate.auth_request', value: '10,60000', type: 'rate_limit', label: 'Auth Request Limit', description: 'Max auth requests per 1-minute window' },
  { key: 'rate.app_message', value: '10,60000', type: 'rate_limit', label: 'App Message Limit', description: 'Max messages per 1-minute window per app' },
  { key: 'rate.app_fetch', value: '60,60000', type: 'rate_limit', label: 'App Fetch Limit', description: 'Max fetch proxy requests per 1-minute window per app' },
  { key: 'rate.app_callback', value: '3,120000', type: 'rate_limit', label: 'App Callback Limit', description: 'Max auto-execute callbacks per 2-minute window per app' },

  // Swap / slippage
  { key: 'swap.max_slippage', value: 50, type: 'swap', label: 'Max Slippage (%)', description: 'Maximum allowed slippage percentage' },
  { key: 'swap.min_slippage_admin', value: 0.5, type: 'swap', label: 'Min Slippage Admin (%)', description: 'Minimum slippage floor for admin tokens' },
  { key: 'swap.min_slippage_agent', value: 1.0, type: 'swap', label: 'Min Slippage Agent (%)', description: 'Minimum slippage floor for agent tokens' },

  // AI provider & model
  { key: 'ai.provider', value: 'claude-cli', type: 'ai', label: 'AI provider mode', description: 'Which AI provider to use for hooks and ticks' },

  // AI safety
  { key: 'ai.max_tool_calls', value: 10, type: 'ai_safety', label: 'Max Tool Calls', description: 'Maximum tool calls per hook invocation' },
  { key: 'ai.max_followup_depth', value: 3, type: 'ai_safety', label: 'Max Follow-up Depth', description: 'Maximum recursive intent follow-up depth' },

  // Launch defaults
  { key: 'launch.initial_supply', value: '1000000000', type: 'launch', label: 'Initial Token Supply', description: 'Default initial supply for token launches' },
  { key: 'launch.sell_percent', value: 90, type: 'launch', label: 'Sell Percentage', description: 'Default percentage of supply to sell in auction' },
  { key: 'launch.epoch_length', value: 3600, type: 'launch', label: 'Epoch Length (seconds)', description: 'Default epoch length for dynamic auctions' },

  // Protocol
  { key: 'protocol.fee_address', value: '0xa931533E0E0cCE34fc0FafB25ea2046d391eCAA5', type: 'protocol', label: 'Protocol Fee Address', description: 'Address that receives protocol fees from swaps and launches' },

  // App constraints
  { key: 'app.max_file_size_mb', value: 5, type: 'app', label: 'Max App File Size (MB)', description: 'Maximum file size for installed apps' },
  { key: 'app.max_total_size_mb', value: 20, type: 'app', label: 'Max App Total Size (MB)', description: 'Maximum total size for installed apps' },

  // Asset discovery
  { key: 'discovery.enabled', value: true, type: 'discovery', label: 'Enable Asset Discovery', description: 'Master toggle for incoming asset auto-discovery' },
  { key: 'discovery.scan_interval', value: 60000, type: 'discovery', label: 'Discovery Scan Interval (ms)', description: 'How often to scan for incoming transfers' },
  { key: 'discovery.max_blocks_per_tick', value: 2000, type: 'discovery', label: 'Max Blocks Per Scan', description: 'Maximum blocks to scan per tick per chain' },
  { key: 'discovery.min_value_usd', value: 0.5, type: 'discovery', label: 'Min Value USD', description: 'Minimum USD value to auto-track a discovered token' },
  { key: 'discovery.min_liquidity_usd', value: 1000, type: 'discovery', label: 'Min Liquidity USD', description: 'Minimum pool liquidity to auto-track a discovered token' },
  { key: 'discovery.safety_enabled', value: true, type: 'discovery', label: 'Enable Safety Check', description: 'Run honeypot/tax checks on discovered tokens' },
  { key: 'discovery.max_initial_lookback', value: 302400, type: 'discovery', label: 'Max Initial Lookback (blocks)', description: 'How far back to scan on first run (~7 days on Base)' },

  // Trust / auto-approve defaults
  { key: 'trust.localAutoApprove', value: true, type: 'trust', label: 'Auto-Approve Local Socket Connections', description: 'Auto-approve auth requests from same-UID processes via Unix socket (0600 permission = same user = trusted)' },
  { key: 'trust.localProfile', value: 'admin', type: 'trust', label: 'Local Socket Agent Profile', description: 'Built-in profile used for local socket-issued agent tokens (strict/dev/admin). Default is admin.' },
  { key: 'trust.localProfileVersion', value: 'v1', type: 'trust', label: 'Local Socket Agent Profile Version', description: 'Version for local socket profile resolution' },
  { key: 'trust.localProfileOverrides', value: null, type: 'trust', label: 'Local Socket Agent Profile Overrides', description: 'Optional tighten-only overrides for the local socket profile' },
  { key: 'trust.projectScopeMode', value: 'off', type: 'trust', label: 'Project Scope Mode', description: 'Project allowlist policy for secret resolution (auto/strict/off). Default is off.' },
  { key: 'trust.localPermissions', value: ['extension:*'], type: 'trust', label: 'Auto-Approve Token Permissions', description: 'Permissions granted to auto-approved local tokens' },
  { key: 'trust.localLimits', value: { fund: 0, send: 0, swap: 0 }, type: 'trust', label: 'Auto-Approve Token Limits', description: 'Spending limits for auto-approved local tokens (0 = no financial operations)' },
  { key: 'trust.localTtl', value: 3600, type: 'trust', label: 'Auto-Approve Token TTL (seconds)', description: 'Time-to-live for auto-approved local tokens' },

  // Credential agent defaults
  { key: 'defaults.credential.access.read', value: ['*'], type: 'credential', label: 'Default Credential Read Scopes', description: 'Default scopes for credential read access on new tokens' },
  { key: 'defaults.credential.access.write', value: ['*'], type: 'credential', label: 'Default Credential Write Scopes', description: 'Default scopes for credential write access on new tokens' },
  { key: 'defaults.credential.excludeFields.card', value: ['cvv'], type: 'credential', label: 'Card Excluded Fields', description: 'Fields excluded by default when reading card credentials' },
  { key: 'defaults.credential.excludeFields.login', value: ['password'], type: 'credential', label: 'Login Excluded Fields', description: 'Fields excluded by default when reading login credentials' },
  { key: 'defaults.credential.excludeFields.note', value: [], type: 'credential', label: 'Note Excluded Fields', description: 'Fields excluded by default when reading note credentials' },

  // Social
  { key: 'social.hub_url', value: 'https://hub.auramaxx.com', type: 'social', label: 'Hub URL', description: 'Base URL for the auramaxx hub (registration, sync, credentials)' },
  { key: 'social.required_credentials', value: [], type: 'social', label: 'Required Credentials for Social Writes', description: 'Credential type slugs an agent must have verified before posting (empty = no requirement)' },

  // Balance sync
  { key: 'sync.active_interval', value: 15000, type: 'sync', label: 'Active Sync Interval (ms)', description: 'Interval for syncing active/cold wallets' },
  { key: 'sync.background_interval', value: 120000, type: 'sync', label: 'Background Sync Interval (ms)', description: 'Interval for syncing background wallets' },
  { key: 'sync.dormant_interval', value: 600000, type: 'sync', label: 'Dormant Sync Interval (ms)', description: 'Interval for syncing dormant wallets' },
  { key: 'sync.active_ttl', value: 60000, type: 'sync', label: 'Active Tier TTL (ms)', description: 'How long a wallet stays in active tier after focus' },
  { key: 'sync.enabled', value: true, type: 'sync', label: 'Enable Balance Sync', description: 'Master switch for the cron balance sync' },
  { key: 'sync.max_assets_per_call', value: 200, type: 'sync', label: 'Max Assets Per Multicall', description: 'Maximum ERC-20 assets per multicall batch' },
];

// ─── In-Memory Cache ────────────────────────────────────────────────

const cache = new Map<string, unknown>();
let cacheLoaded = false;

/**
 * Invalidate one key or the entire defaults cache.
 */
export function invalidateCache(key?: string): void {
  if (key) {
    cache.delete(key);
    return;
  }
  cache.clear();
}

// ─── Change Listeners ───────────────────────────────────────────────

type ChangeListener = (key: string, value: unknown) => void;
const listeners = new Map<string, Set<ChangeListener>>();

/**
 * Register a listener that fires when a specific key changes.
 * Use '*' to listen to all changes.
 */
export function onDefaultChanged(key: string, callback: ChangeListener): () => void {
  if (!listeners.has(key)) {
    listeners.set(key, new Set());
  }
  listeners.get(key)!.add(callback);
  return () => { listeners.get(key)?.delete(callback); };
}

function notifyListeners(key: string, value: unknown): void {
  // Notify specific key listeners
  listeners.get(key)?.forEach(cb => {
    try { cb(key, value); } catch { /* listener errors don't propagate */ }
  });
  // Notify wildcard listeners
  listeners.get('*')?.forEach(cb => {
    try { cb(key, value); } catch { /* listener errors don't propagate */ }
  });
}

// ─── Core API ───────────────────────────────────────────────────────

/**
 * Load all defaults from DB into cache. Call once at startup before app.listen().
 */
export async function preloadCache(): Promise<void> {
  try {
    const rows = await prisma.systemDefault.findMany();
    for (const row of rows) {
      cache.set(row.key, parseValue(row.value));
    }
    cacheLoaded = true;
  } catch {
    // DB may not have been migrated yet — seed defaults will be used as fallback
    cacheLoaded = true;
  }
}

/**
 * Get a default value (async). Reads: cache → DB → fallback.
 */
export async function getDefault<T>(key: string, fallback: T): Promise<T> {
  // Cache hit
  if (cache.has(key)) {
    return cache.get(key) as T;
  }

  // DB lookup
  try {
    const row = await prisma.systemDefault.findUnique({ where: { key } });
    if (row) {
      const val = parseValue(row.value);
      cache.set(key, val);
      return val as T;
    }
  } catch {
    // DB error — fall through to seed/fallback
  }

  // Seed default
  const seed = SEED_DEFAULTS.find(s => s.key === key);
  if (seed !== undefined) {
    cache.set(key, seed.value);
    return seed.value as T;
  }

  return fallback;
}

/**
 * Get a default value synchronously from cache only.
 * Requires preloadCache() to have been called at startup.
 * Falls back to seed default → provided fallback.
 */
export function getDefaultSync<T>(key: string, fallback: T): T {
  if (cache.has(key)) {
    return cache.get(key) as T;
  }

  // Seed default as fallback
  const seed = SEED_DEFAULTS.find(s => s.key === key);
  if (seed !== undefined) {
    return seed.value as T;
  }

  return fallback;
}

/**
 * Update a default value. Upserts to DB + updates cache + notifies listeners.
 */
export async function setDefault(key: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);

  // Look up metadata from seed or existing row
  const seed = SEED_DEFAULTS.find(s => s.key === key);
  const type = seed?.type || 'custom';
  const label = seed?.label || key;

  await prisma.systemDefault.upsert({
    where: { key },
    update: { value: serialized },
    create: { key, value: serialized, type, label },
  });

  invalidateCache(key);
  cache.set(key, value);
  notifyListeners(key, value);
}

/**
 * Get all defaults grouped by type. Used by GET /defaults endpoint.
 */
export async function getAllDefaults(): Promise<Record<string, Array<{
  key: string;
  value: unknown;
  type: string;
  label: string;
  description: string | null;
  updatedAt: string;
}>>> {
  const rows = await prisma.systemDefault.findMany({ orderBy: { key: 'asc' } });
  const grouped: Record<string, Array<{
    key: string;
    value: unknown;
    type: string;
    label: string;
    description: string | null;
    updatedAt: string;
  }>> = {};

  const dbKeys = new Set<string>();
  for (const row of rows) {
    dbKeys.add(row.key);
    if (!grouped[row.type]) {
      grouped[row.type] = [];
    }
    grouped[row.type].push({
      key: row.key,
      value: parseValue(row.value),
      type: row.type,
      label: row.label,
      description: row.description,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  // Merge seed defaults for keys not yet persisted to DB
  for (const seed of SEED_DEFAULTS) {
    if (!dbKeys.has(seed.key)) {
      if (!grouped[seed.type]) {
        grouped[seed.type] = [];
      }
      grouped[seed.type].push({
        key: seed.key,
        value: seed.value,
        type: seed.type,
        label: seed.label,
        description: seed.description ?? null,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return grouped;
}

/**
 * Reset a default to its seed value. Pass '*' to reset all.
 */
export async function resetDefault(key: string): Promise<void> {
  if (key === '*') {
    // Reset all seed defaults
    for (const seed of SEED_DEFAULTS) {
      const serialized = JSON.stringify(seed.value);
      await prisma.systemDefault.upsert({
        where: { key: seed.key },
        update: { value: serialized },
        create: {
          key: seed.key,
          value: serialized,
          type: seed.type,
          label: seed.label,
          description: seed.description,
        },
      });
      invalidateCache(seed.key);
      cache.set(seed.key, seed.value);
      notifyListeners(seed.key, seed.value);
    }
    return;
  }

  const seed = SEED_DEFAULTS.find(s => s.key === key);
  if (!seed) {
    throw new Error(`No seed default for key: ${key}`);
  }

  const serialized = JSON.stringify(seed.value);
  await prisma.systemDefault.upsert({
    where: { key },
    update: { value: serialized },
    create: {
      key: seed.key,
      value: serialized,
      type: seed.type,
      label: seed.label,
      description: seed.description,
    },
  });

  invalidateCache(key);
  cache.set(key, seed.value);
  notifyListeners(key, seed.value);
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Parse a stored JSON string back to its value */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Parse a rate limit string "max,windowMs" into { max, windowMs }.
 */
export function parseRateLimit(value: unknown): { max: number; windowMs: number } {
  if (typeof value === 'string') {
    const [maxStr, windowStr] = value.split(',');
    return { max: parseInt(maxStr, 10), windowMs: parseInt(windowStr, 10) };
  }
  return { max: 10, windowMs: 60000 };
}

// ─── Convenience Accessors ──────────────────────────────────────────

/** Hub URL from defaults — single source of truth for all social/credential routes + cron. */
export function getHubUrl(): string {
  return getDefaultSync<string>('social.hub_url', 'https://hub.auramaxx.com');
}

// ─── Test Helpers ───────────────────────────────────────────────────

/** Reset cache state (for tests only) */
export function __resetCache(): void {
  cache.clear();
  listeners.clear();
  cacheLoaded = false;
}
