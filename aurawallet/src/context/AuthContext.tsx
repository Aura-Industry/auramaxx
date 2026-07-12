'use client';

import { createContext, useContext, useState, useCallback, ReactNode, useEffect } from 'react';
import { api, Api } from '@/lib/api';
import { discardAgentKeypair } from '@/lib/agent-crypto';

export interface ApiKey {
  id: string;
  service: string;
  name: string;
  key: string;
  keyMasked: string;
  createdAt?: string;
}

export interface ChainConfig {
  rpc: string;
  chainId: number;
  explorer: string;
}

type TokenPersistence = 'session' | 'local';

interface SetTokenOptions {
  persist?: TokenPersistence;
}

// Alchemy RPC paths by chain
const ALCHEMY_PATHS: Record<string, { path: string; chainId: number; explorer: string }> = {
  base: { path: 'base-mainnet', chainId: 8453, explorer: 'https://basescan.org' },
  ethereum: { path: 'eth-mainnet', chainId: 1, explorer: 'https://etherscan.io' },
  arbitrum: { path: 'arb-mainnet', chainId: 42161, explorer: 'https://arbiscan.io' },
  optimism: { path: 'opt-mainnet', chainId: 10, explorer: 'https://optimistic.etherscan.io' },
  solana: { path: 'solana-mainnet', chainId: 0, explorer: 'https://solscan.io' },
  'solana-devnet': { path: 'solana-devnet', chainId: 0, explorer: 'https://solscan.io/?cluster=devnet' },
};

// Public RPC fallbacks (default chains: base, ethereum, and solana)
const PUBLIC_RPCS: Record<string, ChainConfig> = {
  base: { rpc: 'https://mainnet.base.org', chainId: 8453, explorer: 'https://basescan.org' },
  ethereum: { rpc: 'https://eth.llamarpc.com', chainId: 1, explorer: 'https://etherscan.io' },
  solana: { rpc: 'https://api.mainnet-beta.solana.com', chainId: 0, explorer: 'https://solscan.io' },
  'solana-devnet': { rpc: 'https://api.devnet.solana.com', chainId: 0, explorer: 'https://solscan.io/?cluster=devnet' },
};

interface AuthContextValue {
  token: string | null;
  isUnlocked: boolean;
  setToken: (token: string | null, options?: SetTokenOptions) => void;
  clearToken: () => void;
  apiKeys: ApiKey[];
  apiKeysLoading: boolean;
  refreshApiKeys: () => Promise<void>;
  getApiKey: (service: string, name?: string) => string | null;
  getRpcUrl: (chain?: string) => string;
  getChainConfig: (chain?: string) => ChainConfig;
  // Chain overrides (custom RPC URLs stored in DB)
  chainOverrides: Record<string, ChainConfig>;
  chainOverridesLoading: boolean;
  refreshChainOverrides: () => Promise<void>;
  saveChainOverride: (chain: string, config: ChainConfig) => Promise<void>;
  removeChainOverride: (chain: string) => Promise<void>;
  // All configured chains (public defaults + DB overrides)
  getConfiguredChains: () => Record<string, ChainConfig>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Storage key for persisting token across page reloads
const TOKEN_STORAGE_KEY = 'auramaxx_admin_token';

const getStoredToken = (): { token: string | null; persist: TokenPersistence | null } => {
  if (typeof window === 'undefined') return { token: null, persist: null };
  const localToken = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (localToken) return { token: localToken, persist: 'local' };
  const sessionToken = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  if (sessionToken) return { token: sessionToken, persist: 'session' };
  return { token: null, persist: null };
};

const clearStoredToken = () => {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(TOKEN_STORAGE_KEY);
};

const persistToken = (token: string, persist: TokenPersistence) => {
  if (typeof window === 'undefined') return;
  if (persist === 'local') {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  localStorage.removeItem(TOKEN_STORAGE_KEY);
};

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [token, setTokenState] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [chainOverrides, setChainOverrides] = useState<Record<string, ChainConfig>>({});
  const [chainOverridesLoading, setChainOverridesLoading] = useState(false);

  // Load token from storage on mount (local preferred over session)
  useEffect(() => {
    const { token: storedToken } = getStoredToken();
    if (storedToken) {
      setTokenState(storedToken);
    }
  }, []);

  // Fetch API keys when token is available
  const refreshApiKeys = useCallback(async () => {
    if (!token) {
      setApiKeys([]);
      return;
    }
    setApiKeysLoading(true);
    try {
      const data = await api.get<{ success: boolean; apiKeys: ApiKey[] }>(Api.Wallet, '/apikeys');
      if (data.success && data.apiKeys) {
        setApiKeys(data.apiKeys);
      }
    } catch (err) {
      // If the token is invalid/expired (server restarted, new SIGNING_KEY), clear it
      const status = (err as Error & { status?: number }).status;
      if (status === 401 || status === 403) {
        setTokenState(null);
        clearStoredToken();
        setApiKeys([]);
      }
      console.error('[AuthContext] Failed to fetch API keys:', err);
    } finally {
      setApiKeysLoading(false);
    }
  }, [token]);

  // Load API keys when token changes
  useEffect(() => {
    if (token) {
      refreshApiKeys();
    } else {
      setApiKeys([]);
    }
  }, [token, refreshApiKeys]);

  // Fetch chain overrides from workspace config
  const refreshChainOverrides = useCallback(async () => {
    if (!token) {
      setChainOverrides({});
      setChainOverridesLoading(false);
      return;
    }

    setChainOverridesLoading(true);
    try {
      const data = await api.get<{ success: boolean; config: { chainOverrides: Record<string, ChainConfig> } }>(
        Api.Workspace,
        '/workspace/config'
      );
      if (data.success && data.config) {
        setChainOverrides(data.config.chainOverrides || {});
      }
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 401 || status === 403 || status === 404) {
        setChainOverrides({});
      } else {
        console.error('[AuthContext] Failed to fetch chain overrides:', err);
      }
    } finally {
      setChainOverridesLoading(false);
    }
  }, [token]);

  // Load chain overrides when auth state changes
  useEffect(() => {
    if (token) {
      refreshChainOverrides();
      return;
    }
    setChainOverrides({});
    setChainOverridesLoading(false);
  }, [token, refreshChainOverrides]);

  // Save a chain override
  const saveChainOverride = useCallback(async (chain: string, config: ChainConfig) => {
    const newOverrides = { ...chainOverrides, [chain]: config };
    try {
      const data = await api.post<{ success: boolean; config: { chainOverrides: Record<string, ChainConfig> } }>(
        Api.Workspace,
        '/workspace/config',
        { chainOverrides: newOverrides }
      );
      if (data.success && data.config) {
        setChainOverrides(data.config.chainOverrides || {});
      }
    } catch (err) {
      console.error('[AuthContext] Failed to save chain override:', err);
      throw err;
    }
  }, [chainOverrides]);

  // Remove a chain override
  const removeChainOverride = useCallback(async (chain: string) => {
    const newOverrides = { ...chainOverrides };
    delete newOverrides[chain];
    try {
      const data = await api.post<{ success: boolean; config: { chainOverrides: Record<string, ChainConfig> } }>(
        Api.Workspace,
        '/workspace/config',
        { chainOverrides: newOverrides }
      );
      if (data.success && data.config) {
        setChainOverrides(data.config.chainOverrides || {});
      }
    } catch (err) {
      console.error('[AuthContext] Failed to remove chain override:', err);
      throw err;
    }
  }, [chainOverrides]);

  const setToken = useCallback((newToken: string | null, options?: SetTokenOptions) => {
    setTokenState(newToken);
    if (!newToken) {
      clearStoredToken();
      return;
    }
    const currentPersistence = getStoredToken().persist;
    const persist = options?.persist ?? currentPersistence ?? 'session';
    persistToken(newToken, persist);
  }, []);

  const clearToken = useCallback(() => {
    discardAgentKeypair();
    setToken(null);
  }, [setToken]);

  // Get an API key by service and optional name
  const getApiKey = useCallback((service: string, name?: string): string | null => {
    const key = apiKeys.find(k =>
      k.service.toLowerCase() === service.toLowerCase() &&
      (!name || k.name.toLowerCase() === name.toLowerCase())
    );
    return key?.key || null;
  }, [apiKeys]);

  // Get RPC URL for a chain: override → Alchemy → public fallback
  const getRpcUrl = useCallback((chain: string = 'base'): string => {
    // 1. Check for custom override
    if (chainOverrides[chain]?.rpc) {
      return chainOverrides[chain].rpc;
    }

    // 2. Check for Alchemy API key
    const alchemyKey = getApiKey('alchemy');
    const alchemyConfig = ALCHEMY_PATHS[chain];
    if (alchemyKey && alchemyConfig) {
      return `https://${alchemyConfig.path}.g.alchemy.com/v2/${alchemyKey}`;
    }

    // 3. Fallback to public RPC
    return PUBLIC_RPCS[chain]?.rpc || PUBLIC_RPCS.base.rpc;
  }, [chainOverrides, getApiKey]);

  // Get full chain config: override → Alchemy → public fallback
  const getChainConfig = useCallback((chain: string = 'base'): ChainConfig => {
    // 1. Check for custom override
    if (chainOverrides[chain]) {
      return chainOverrides[chain];
    }

    // 2. Check for Alchemy API key
    const alchemyKey = getApiKey('alchemy');
    const alchemyConfig = ALCHEMY_PATHS[chain];
    if (alchemyKey && alchemyConfig) {
      return {
        rpc: `https://${alchemyConfig.path}.g.alchemy.com/v2/${alchemyKey}`,
        chainId: alchemyConfig.chainId,
        explorer: alchemyConfig.explorer,
      };
    }

    // 3. Fallback to public RPC
    return PUBLIC_RPCS[chain] || PUBLIC_RPCS.base;
  }, [chainOverrides, getApiKey]);

  // Get all configured chains (merges overrides, Alchemy-supported, and public RPCs)
  // Get all configured chains: public defaults + DB overrides
  // RPC resolution for each: DB custom RPC → Alchemy → public fallback
  const getConfiguredChains = useCallback((): Record<string, ChainConfig> => {
    const result: Record<string, ChainConfig> = {};
    const alchemyKey = getApiKey('alchemy');

    // Helper to resolve RPC URL for a chain
    const resolveRpc = (chain: string, baseConfig: ChainConfig): string => {
      // 1. If chain has custom RPC in DB, use it
      if (chainOverrides[chain]?.rpc) {
        return chainOverrides[chain].rpc;
      }
      // 2. If Alchemy key exists and chain is supported, use Alchemy
      const alchemyConfig = ALCHEMY_PATHS[chain];
      if (alchemyKey && alchemyConfig) {
        return `https://${alchemyConfig.path}.g.alchemy.com/v2/${alchemyKey}`;
      }
      // 3. Fallback to hardcoded public RPC
      return baseConfig.rpc;
    };

    // Add public defaults (base, ethereum) with resolved RPCs
    for (const [chain, config] of Object.entries(PUBLIC_RPCS)) {
      result[chain] = {
        ...config,
        rpc: resolveRpc(chain, config),
      };
    }

    // Add any user-added chains from DB (not in PUBLIC_RPCS)
    for (const [chain, config] of Object.entries(chainOverrides)) {
      if (!PUBLIC_RPCS[chain]) {
        result[chain] = config;
      }
    }

    return result;
  }, [chainOverrides, getApiKey]);

  const value: AuthContextValue = {
    token,
    isUnlocked: !!token,
    setToken,
    clearToken,
    apiKeys,
    apiKeysLoading,
    refreshApiKeys,
    getApiKey,
    getRpcUrl,
    getChainConfig,
    chainOverrides,
    chainOverridesLoading,
    refreshChainOverrides,
    saveChainOverride,
    removeChainOverride,
    getConfiguredChains,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
