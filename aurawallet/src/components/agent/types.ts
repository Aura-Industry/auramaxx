export interface CredentialMeta {
  id: string;
  agentId: string;
  type: string;
  name: string;
  meta: {
    url?: string;
    username?: string;
    tags?: string[];
    favorite?: boolean;
    last4?: string;
    brand?: string;
    cardholder?: string;
    [k: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deletedAt?: string;
}

export interface AgentInfo {
  id: string;
  name?: string;
  mode: 'primary' | 'linked' | 'independent';
  parentAgentId?: string;
  linkedTo?: string;
  isUnlocked: boolean;
  isPrimary: boolean;
  credentialCount: number;
}

export interface WalletLinkMetaV1 {
  version: 1;
  walletAddress: string;
  chain: string;
  tier: 'cold' | 'hot';
  label?: string;
  source: 'existing' | 'created';
  linkedAt: string;
}

export type CredentialType = 'login' | 'card' | 'sso' | 'note' | 'plain_note' | 'hot_wallet' | 'api' | 'apikey' | 'custom' | 'passkey' | 'oauth2' | 'ssh' | 'gpg';
export type CredentialLifecycleFilter = 'active' | 'archive' | 'recently_deleted';
export type CredentialWithLocation = CredentialMeta & { location: CredentialLifecycleFilter };

export type CategoryFilter = 'all' | 'login' | 'card' | 'sso' | 'note' | 'plain_note' | 'hot_wallet' | 'api' | 'apikey' | 'custom' | 'passkey' | 'oauth2' | 'ssh' | 'gpg';

export interface AgentFilters {
  agentId: string | null;
  category: CategoryFilter;
  tag: string | null;
  search: string;
  favoritesOnly: boolean;
  lifecycle: CredentialLifecycleFilter;
}
