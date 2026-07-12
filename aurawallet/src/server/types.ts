export type WalletTier = 'cold' | 'hot' | 'temp';

export interface WalletInfo {
  address: string;
  tier: WalletTier;
  chain: string;
  createdAt: string;
  name?: string;
  color?: string;
  description?: string;
  emoji?: string;
  tokenHash?: string;
  balance?: string;
}

export interface EncryptedData {
  ciphertext: string;
  iv: string;
  salt: string;
  mac: string; // AEAD auth tag (legacy key name kept for envelope compatibility)
}

/** Limit value: plain number (single-currency, backward compat) or address-keyed (multi-currency) */
export type LimitValue = number | Record<string, number>;

/**
 * Agent token payload - issued to AI agents with specific permissions and limits
 */
export interface AgentTokenPayload {
  agentId: string;
  permissions: string[];      // Route permissions (e.g., 'wallet:list', 'send:hot')
  exp: number;                // Expiry timestamp (ms)

  // Per-permission limits (optional, in native currency units)
  // Plain number = legacy single-currency limit
  // Record<string, number> = address-keyed multi-currency limit
  //   e.g. { "0x0000...0000": 1.0, "So111...112": 10.0 }
  limits?: {
    fund?: LimitValue;
    send?: LimitValue;
    swap?: LimitValue;
    launch?: LimitValue;
  };

  // Wallet access grants (access existing wallets not created by this token)
  walletAccess?: string[];    // Array of wallet addresses

  // Token issued-at timestamp (ms) — used for credential TTL calculations
  iat?: number;

  // Credential agent access grants
  credentialAccess?: {
    read?: string[];           // Scopes for reading credentials (e.g., ["*"], ["tag:api"], ["cred-abc123"])
    write?: string[];          // Scopes for writing credentials
    excludeFields?: string[];  // Fields to exclude from reads (e.g., ["password", "cvv"])
    ttl?: number;              // Max seconds from iat this token can read credentials
    maxReads?: number;         // Max number of credential read operations
  };

  // Agent's public key (for future E2E encryption)
  agentPubkey?: string;

  // Optional deterministic one-shot retry binding.
  // When present, the server must only accept this token for the bound operation.
  oneShotBinding?: {
    reqId?: string;
    approvalScope?: 'one_shot_read' | 'session_token';
    policyHash: string;
    compilerVersion: string;
    actorId: string;
    method: string;
    routeId: string;
    resourceHash: string;
    bodyHash: string;
    bindingHash: string;
  };

  // Legacy compatibility
  limit?: number;             // Legacy: Max spend in ETH (maps to limits.fund)
}

/**
 * Token payload type (admin tokens are just AgentTokenPayload with admin:* permission)
 */
export type TokenPayload = AgentTokenPayload;

/** Spent value: plain number (single-currency) or address-keyed (multi-currency) */
export type SpentValue = number | Record<string, number>;

export interface TokenSession {
  token: AgentTokenPayload;
  spent: number;
  // Per-permission spending tracking
  // Plain number = legacy single-currency tracking
  // Record<string, number> = address-keyed multi-currency tracking
  spentByType?: {
    fund?: SpentValue;
    send?: SpentValue;
    swap?: SpentValue;
    launch?: SpentValue;
  };
  // Credential agent access tracking
  credentialReads?: number;
  tokenIssuedAt?: number;
}

export interface HumanAction {
  id: string;
  type: 'fund' | 'send' | 'agent_access' | 'auth' | 'permission_update' | 'action' | 'notify';
  fromTier: WalletTier | 'system';
  toAddress?: string;
  amount?: string;
  chain: string;
  status: 'pending' | 'approved' | 'rejected' | 'acknowledged';
  createdAt: string;
  resolvedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SendRequest {
  from: string;
  to: string;
  amount: string;
  chain?: string;
}

export interface CreateWalletRequest {
  tier: 'hot' | 'temp';
  chain?: string;
  label?: string;
}

export interface FundRequest {
  toHotAddress: string;
  amount: string;
  chain?: string;
}

// ─── Credential Agent Types ──────────────────────────────────────────

export type CredentialType = 'login' | 'card' | 'sso' | 'note' | 'plain_note' | 'hot_wallet' | 'api' | 'apikey' | 'custom' | 'passkey' | 'oauth2' | 'ssh' | 'gpg';

export interface CredentialField {
  key: string;
  value: string;
  type: 'text' | 'secret' | 'url' | 'email' | 'number';
  sensitive: boolean;
}

export interface CredentialFile {
  id: string;
  agentId: string;
  type: CredentialType;
  name: string;
  meta: Record<string, unknown>;
  encrypted: EncryptedData;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deletedAt?: string;
}
