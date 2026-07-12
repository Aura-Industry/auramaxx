-- CreateTable
CREATE TABLE "Log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "txHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "HotWallet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "address" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "coldWalletId" TEXT,
    "name" TEXT,
    "color" TEXT,
    "description" TEXT,
    "emoji" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "chain" TEXT NOT NULL DEFAULT 'base',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "HumanAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "fromTier" TEXT NOT NULL,
    "toAddress" TEXT,
    "amount" TEXT,
    "chain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "metadata" TEXT
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "category" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "dismissed" BOOLEAN NOT NULL DEFAULT false,
    "actions" TEXT,
    "metadata" TEXT,
    "humanActionId" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'system',
    "agentId" TEXT,
    CONSTRAINT "Notification_humanActionId_fkey" FOREIGN KEY ("humanActionId") REFERENCES "HumanAction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "limit" REAL NOT NULL,
    "spent" REAL NOT NULL DEFAULT 0,
    "permissions" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "isRevoked" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "icon" TEXT,
    "emoji" TEXT,
    "color" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isCloseable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkspaceApp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "appType" TEXT NOT NULL,
    "x" INTEGER NOT NULL DEFAULT 20,
    "y" INTEGER NOT NULL DEFAULT 20,
    "width" INTEGER NOT NULL DEFAULT 320,
    "height" INTEGER NOT NULL DEFAULT 280,
    "zIndex" INTEGER NOT NULL DEFAULT 10,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "config" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkspaceApp_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ThemeConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "activeThemeId" TEXT NOT NULL DEFAULT 'light',
    "accentColor" TEXT NOT NULL DEFAULT '#ccff00',
    "customThemes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkspaceTheme" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "mode" TEXT,
    "accent" TEXT,
    "overrides" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkspaceTheme_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "service" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "metadata" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT NOT NULL,
    "txHash" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "amount" TEXT,
    "tokenAddress" TEXT,
    "tokenAmount" TEXT,
    "from" TEXT,
    "to" TEXT,
    "description" TEXT,
    "blockNumber" INTEGER,
    "chain" TEXT NOT NULL DEFAULT 'base',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "executedAt" DATETIME
);

-- CreateTable
CREATE TABLE "TrackedAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT,
    "tokenAddress" TEXT NOT NULL,
    "symbol" TEXT,
    "name" TEXT,
    "decimals" INTEGER NOT NULL DEFAULT 18,
    "lastBalance" TEXT,
    "lastBalanceAt" DATETIME,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "chain" TEXT NOT NULL DEFAULT 'base',
    "poolAddress" TEXT,
    "poolVersion" TEXT,
    "icon" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NativeBalance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "balance" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NativePrice" (
    "currency" TEXT NOT NULL PRIMARY KEY,
    "priceUsd" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chain" TEXT NOT NULL,
    "lastSyncAt" DATETIME,
    "lastSyncStatus" TEXT NOT NULL DEFAULT 'idle',
    "lastError" TEXT,
    "syncCount" INTEGER NOT NULL DEFAULT 0,
    "lastBlock" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "templateId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'headless',
    "manifest" TEXT NOT NULL,
    "config" TEXT,
    "state" TEXT,
    "schedule" TEXT,
    "permissions" TEXT NOT NULL DEFAULT '[]',
    "limits" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" TEXT NOT NULL DEFAULT 'human',
    "provenance" TEXT,
    "appId" TEXT,
    "lastTickAt" DATETIME,
    "lastError" TEXT,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StrategyRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "strategyId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "metadata" TEXT,
    CONSTRAINT "StrategyRun_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppStorage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TokenMetadata" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenAddress" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "symbol" TEXT,
    "name" TEXT,
    "decimals" INTEGER NOT NULL DEFAULT 18,
    "icon" TEXT,
    "description" TEXT,
    "priceUsd" TEXT,
    "marketCap" REAL,
    "fdv" REAL,
    "liquidity" REAL,
    "volume24h" REAL,
    "dexId" TEXT,
    "pairAddress" TEXT,
    "websites" TEXT,
    "socials" TEXT,
    "lastAccessedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PoolMetadata" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poolAddress" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "token0" TEXT,
    "token1" TEXT,
    "fee" INTEGER,
    "dex" TEXT
);

-- CreateTable
CREATE TABLE "AddressLabel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "address" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "emoji" TEXT,
    "color" TEXT,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT 'human',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SystemDefault" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AppConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "chainConfig" TEXT,
    "adapterConfig" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Log_walletAddress_idx" ON "Log"("walletAddress");

-- CreateIndex
CREATE INDEX "Log_createdAt_idx" ON "Log"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "HotWallet_address_key" ON "HotWallet"("address");

-- CreateIndex
CREATE INDEX "HotWallet_address_idx" ON "HotWallet"("address");

-- CreateIndex
CREATE INDEX "HotWallet_tokenHash_idx" ON "HotWallet"("tokenHash");

-- CreateIndex
CREATE INDEX "HotWallet_hidden_idx" ON "HotWallet"("hidden");

-- CreateIndex
CREATE INDEX "HotWallet_coldWalletId_idx" ON "HotWallet"("coldWalletId");

-- CreateIndex
CREATE INDEX "HumanAction_status_idx" ON "HumanAction"("status");

-- CreateIndex
CREATE INDEX "HumanAction_createdAt_idx" ON "HumanAction"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_humanActionId_key" ON "Notification"("humanActionId");

-- CreateIndex
CREATE INDEX "Notification_read_dismissed_idx" ON "Notification"("read", "dismissed");

-- CreateIndex
CREATE INDEX "Notification_type_idx" ON "Notification"("type");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "Event_type_idx" ON "Event"("type");

-- CreateIndex
CREATE INDEX "Event_timestamp_idx" ON "Event"("timestamp");

-- CreateIndex
CREATE INDEX "Event_source_idx" ON "Event"("source");

-- CreateIndex
CREATE UNIQUE INDEX "AgentToken_tokenHash_key" ON "AgentToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AgentToken_agentId_idx" ON "AgentToken"("agentId");

-- CreateIndex
CREATE INDEX "AgentToken_isRevoked_idx" ON "AgentToken"("isRevoked");

-- CreateIndex
CREATE INDEX "AgentToken_expiresAt_idx" ON "AgentToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "WorkspaceApp_workspaceId_idx" ON "WorkspaceApp"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceTheme_workspaceId_key" ON "WorkspaceTheme"("workspaceId");

-- CreateIndex
CREATE INDEX "ApiKey_service_idx" ON "ApiKey"("service");

-- CreateIndex
CREATE INDEX "ApiKey_isActive_idx" ON "ApiKey"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_service_name_key" ON "ApiKey"("service", "name");

-- CreateIndex
CREATE INDEX "Transaction_walletAddress_idx" ON "Transaction"("walletAddress");

-- CreateIndex
CREATE INDEX "Transaction_walletAddress_createdAt_idx" ON "Transaction"("walletAddress", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_type_idx" ON "Transaction"("type");

-- CreateIndex
CREATE INDEX "Transaction_tokenAddress_idx" ON "Transaction"("tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_txHash_chain_key" ON "Transaction"("txHash", "chain");

-- CreateIndex
CREATE INDEX "TrackedAsset_walletAddress_idx" ON "TrackedAsset"("walletAddress");

-- CreateIndex
CREATE INDEX "TrackedAsset_walletAddress_updatedAt_idx" ON "TrackedAsset"("walletAddress", "updatedAt");

-- CreateIndex
CREATE INDEX "TrackedAsset_tokenAddress_idx" ON "TrackedAsset"("tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedAsset_walletAddress_tokenAddress_chain_key" ON "TrackedAsset"("walletAddress", "tokenAddress", "chain");

-- CreateIndex
CREATE INDEX "NativeBalance_walletAddress_idx" ON "NativeBalance"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "NativeBalance_walletAddress_chain_key" ON "NativeBalance"("walletAddress", "chain");

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_chain_key" ON "SyncState"("chain");

-- CreateIndex
CREATE INDEX "Strategy_enabled_status_idx" ON "Strategy"("enabled", "status");

-- CreateIndex
CREATE INDEX "Strategy_templateId_idx" ON "Strategy"("templateId");

-- CreateIndex
CREATE INDEX "Strategy_appId_idx" ON "Strategy"("appId");

-- CreateIndex
CREATE INDEX "StrategyRun_strategyId_startedAt_idx" ON "StrategyRun"("strategyId", "startedAt");

-- CreateIndex
CREATE INDEX "AppStorage_appId_idx" ON "AppStorage"("appId");

-- CreateIndex
CREATE UNIQUE INDEX "AppStorage_appId_key_key" ON "AppStorage"("appId", "key");

-- CreateIndex
CREATE INDEX "TokenMetadata_tokenAddress_idx" ON "TokenMetadata"("tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "TokenMetadata_tokenAddress_chain_key" ON "TokenMetadata"("tokenAddress", "chain");

-- CreateIndex
CREATE INDEX "PoolMetadata_poolAddress_idx" ON "PoolMetadata"("poolAddress");

-- CreateIndex
CREATE UNIQUE INDEX "PoolMetadata_poolAddress_chain_key" ON "PoolMetadata"("poolAddress", "chain");

-- CreateIndex
CREATE UNIQUE INDEX "AddressLabel_address_key" ON "AddressLabel"("address");

-- CreateIndex
CREATE INDEX "AddressLabel_label_idx" ON "AddressLabel"("label");

-- CreateIndex
CREATE INDEX "SystemDefault_type_idx" ON "SystemDefault"("type");


-- Seed default values (preserved from prior migrations)
INSERT INTO "SystemDefault" ("key", "value", "type", "label", "description", "updatedAt") VALUES
  ('permissions.default', '["wallet:create:hot","send:hot","swap","fund","action:create"]', 'permissions', 'Default Agent Permissions', 'Permissions granted to new agent tokens by default', datetime('now')),
  ('limits.fund', '0.1', 'financial', 'Default Fund Limit (ETH)', 'Default ETH spending limit for agent tokens', datetime('now')),
  ('gas.evm_buffer', '0.001', 'financial', 'EVM Gas Buffer (ETH)', 'Reserved ETH buffer for max-send in UI', datetime('now')),
  ('gas.sol_buffer', '0.000005', 'financial', 'Solana Gas Buffer (SOL)', 'Reserved SOL buffer for max-send in UI', datetime('now')),
  ('ttl.agent', '3600', 'ttl', 'Agent Token TTL (seconds)', 'Default time-to-live for agent tokens', datetime('now')),
  ('ttl.admin', '2592000', 'ttl', 'Admin Token TTL (seconds)', 'Time-to-live for admin tokens (30 days)', datetime('now')),
  ('ttl.app', '86400', 'ttl', 'App Token TTL (seconds)', 'Time-to-live for app tokens (24h)', datetime('now')),
  ('ttl.action', '60', 'ttl', 'Action Token TTL (seconds)', 'Default time-to-live for action tokens', datetime('now')),
  ('rate.brute_force', '5,900000', 'rate_limit', 'Brute Force Limit', 'Max attempts per 15-minute window for auth endpoints', datetime('now')),
  ('rate.auth_request', '10,60000', 'rate_limit', 'Auth Request Limit', 'Max auth requests per 1-minute window', datetime('now')),
  ('rate.app_message', '10,60000', 'rate_limit', 'App Message Limit', 'Max messages per 1-minute window per app', datetime('now')),
  ('rate.app_fetch', '60,60000', 'rate_limit', 'App Fetch Limit', 'Max fetch proxy requests per 1-minute window per app', datetime('now')),
  ('rate.app_callback', '3,120000', 'rate_limit', 'App Callback Limit', 'Max auto-execute callbacks per 2-minute window per app', datetime('now')),
  ('swap.max_slippage', '50', 'swap', 'Max Slippage (%)', 'Maximum allowed slippage percentage', datetime('now')),
  ('swap.min_slippage_admin', '0.5', 'swap', 'Min Slippage Admin (%)', 'Minimum slippage floor for admin tokens', datetime('now')),
  ('swap.min_slippage_agent', '1.0', 'swap', 'Min Slippage Agent (%)', 'Minimum slippage floor for agent tokens', datetime('now')),
  ('ai.max_tool_calls', '10', 'ai_safety', 'Max Tool Calls', 'Maximum tool calls per hook invocation', datetime('now')),
  ('ai.max_followup_depth', '3', 'ai_safety', 'Max Follow-up Depth', 'Maximum recursive intent follow-up depth', datetime('now')),
  ('launch.initial_supply', '1000000000', 'launch', 'Initial Token Supply', 'Default initial supply for token launches', datetime('now')),
  ('launch.sell_percent', '90', 'launch', 'Sell Percentage', 'Default percentage of supply to sell in auction', datetime('now')),
  ('launch.epoch_length', '3600', 'launch', 'Epoch Length (seconds)', 'Default epoch length for dynamic auctions', datetime('now')),
  ('app.max_file_size_mb', '5', 'app', 'Max App File Size (MB)', 'Maximum file size for installed apps', datetime('now')),
  ('app.max_total_size_mb', '20', 'app', 'Max App Total Size (MB)', 'Maximum total size for installed apps', datetime('now')),
  ('protocol.fee_address', '"0xa931533E0E0cCE34fc0FafB25ea2046d391eCAA5"', 'protocol', 'Protocol Fee Address', 'Address that receives protocol fees from swaps and launches', datetime('now'));
