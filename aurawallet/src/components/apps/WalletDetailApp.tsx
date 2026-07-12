'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Copy,
  Edit2,
  Save,
  EyeOff,
  Eye,
  X,
  RefreshCw,
  Coins,
  ArrowUpDown,
  Search,
  Loader2,
  ExternalLink,
  Wifi,
  WifiOff,
  Plus,
  Trash2,
  Lock,
} from 'lucide-react';
import { Button, ChainSelector, FilterDropdown, Popover, TextInput } from '@/components/design-system';
import { useWebSocket } from '@/context/WebSocketContext';
import { usePrice } from '@/context/PriceContext';
import { useAuth } from '@/context/AuthContext';
import { api, Api, type AssetsResponse, type TrackedAsset, type TransactionsResponse } from '@/lib/api';
import { useBalance } from '@/hooks/useBalance';
import { fetchTokenData, fetchSolanaTokenData, calculateUsdValue, formatUsdValue, type TokenData } from '@/lib/tokenData';
import { WALLET_EVENTS, type AssetChangedData, type BalanceUpdatedData, type TxCreatedData } from '@/lib/events';

interface WalletData {
  address: string;
  tier: 'cold' | 'hot' | 'temp';
  chain: string;
  balance?: string;
  name?: string;
  color?: string;
  emoji?: string;
  description?: string;
  hidden?: boolean;
  tokenHash?: string;
  createdAt?: string;
}


interface Transaction {
  id: string;
  walletAddress: string;
  txHash: string | null;
  type: string;
  status: string;
  amount: string | null;
  tokenAddress: string | null;
  tokenAmount: string | null;
  from: string | null;
  to: string | null;
  description: string | null;
  blockNumber: number | null;
  chain: string;
  createdAt: string;
  updatedAt: string;
  executedAt: string | null;
}

// Self-contained app - only needs config with walletAddress
interface WalletDetailAppProps {
  config?: {
    walletAddress?: string;
  };
}

const EMOJI_OPTIONS = ['🔥', '💎', '🚀', '⚡', '🌙', '🌟', '💰', '🎯', '🔮', '🌈'];
const COLOR_OPTIONS = ['#ff4d00', '#0047ff', '#00c853', '#ffab00', '#9c27b0', '#00bcd4', '#e91e63', '#607d8b'];

type TabType = 'assets' | 'transactions';

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function shortenAddress(address: string, chars = 6): string {
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

function isSolanaChain(chain: string): boolean {
  return chain === 'solana' || chain === 'solana-devnet';
}

/** Chain-aware address comparison: case-insensitive for EVM hex, exact for Solana base58 */
function addressesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.startsWith('0x') || b.startsWith('0x')) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

const TX_TYPE_COLORS: Record<string, string> = {
  send: 'var(--color-warning, #ff4d00)',
  receive: 'var(--color-success, #00c853)',
  swap: 'var(--color-info, #0047ff)',
  contract: 'var(--color-text-muted, #888)',
  manual: 'var(--color-text-muted, #888)',
};

const TX_TYPE_OPTIONS = [
  { value: 'all', label: 'ALL' },
  { value: 'send', label: 'SEND' },
  { value: 'receive', label: 'RECEIVE' },
  { value: 'swap', label: 'SWAP' },
  { value: 'contract', label: 'CONTRACT' },
  { value: 'manual', label: 'MANUAL' },
];



export const WalletDetailApp: React.FC<WalletDetailAppProps> = ({ config }) => {
  const [manualAddress, setManualAddress] = useState('');
  const [committedAddress, setCommittedAddress] = useState('');
  const walletAddress = config?.walletAddress || committedAddress || undefined;
  const { getRpcUrl, getConfiguredChains, getChainConfig, isUnlocked } = useAuth();
  const chainOptions = Object.keys(getConfiguredChains()).map(c => ({ value: c, label: c.toUpperCase() }));
  const { subscribe, connected } = useWebSocket();
  const { ethPrice, formatUsd } = usePrice();

  // Wallet data (fetched from API)
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [walletLoading, setWalletLoading] = useState(!!walletAddress);
  const [walletError, setWalletError] = useState<string | null>(null);

  // Copy state (internal)
  const [copied, setCopied] = useState(false);

  // Edit mode
  const [isEditMode, setIsEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('assets');

  // Edit form state (initialized empty, updated when wallet loads)
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editEmoji, setEditEmoji] = useState('');
  const [editColor, setEditColor] = useState('');
  const [editHidden, setEditHidden] = useState(false);

  // Assets state
  const [assets, setAssets] = useState<TrackedAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsSearch, setAssetsSearch] = useState('');
  const [tokenDataMap, setTokenDataMap] = useState<Map<string, TokenData>>(new Map());
  const [balancesLoading, setBalancesLoading] = useState(false);

  // Add asset popover state
  const [showAddAsset, setShowAddAsset] = useState(false);
  const [addAssetAnchor, setAddAssetAnchor] = useState<HTMLElement | null>(null);
  const [addAssetForm, setAddAssetForm] = useState({ tokenAddress: '', symbol: '', name: '', chain: 'base' });
  const [addingAsset, setAddingAsset] = useState(false);

  // Chain filter state
  const [selectedChain, setSelectedChain] = useState<string>('');

  // Balance from RPC (via hook) — always uses the wallet's own chain, not the filter
  const { balance, loading: balanceLoading, currency } = useBalance(wallet?.address, wallet?.chain);

  // Transactions state
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [txSearch, setTxSearch] = useState('');
  const [txTypeFilter, setTxTypeFilter] = useState('all');
  const [txHasMore, setTxHasMore] = useState(false);
  const [txOffset, setTxOffset] = useState(0);

  // Fetch wallet data from API
  const fetchWallet = useCallback(async () => {
    if (!walletAddress || !isUnlocked) return;

    setWalletLoading(true);
    setWalletError(null);
    try {
      const data = await Promise.race([
        api.get<WalletData>(Api.Wallet, `/wallet/${walletAddress}`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Server unreachable')), 5000)),
      ]);
      setWallet(data);
      // Initialize edit form with fetched data
      setEditName(data.name || '');
      setEditDescription(data.description || '');
      setEditEmoji(data.emoji || '');
      setEditColor(data.color || '');
      setEditHidden(data.hidden || false);
      setSelectedChain(data.chain || 'base');
      setAddAssetForm(prev => ({ ...prev, chain: data.chain || 'base' }));
    } catch (err) {
      console.error('[WalletDetail] Failed to fetch wallet:', err);
      setWalletError(err instanceof Error ? err.message : 'Failed to fetch wallet');
    } finally {
      setWalletLoading(false);
    }
  }, [walletAddress, isUnlocked]);

  // Copy address to clipboard
  const copyAddress = useCallback(() => {
    if (wallet?.address) {
      navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [wallet?.address]);

  // Fetch wallet on mount
  useEffect(() => {
    fetchWallet();
  }, [fetchWallet]);

  // Fetch assets from backend API
  const fetchAssets = useCallback(async () => {
    if (!wallet || !selectedChain) return;
    setAssetsLoading(true);
    try {
      const data = await api.get<AssetsResponse>(Api.Wallet, `/wallet/${wallet.address}/assets`, {
        sortBy: 'updatedAt',
        sortDir: 'desc',
        limit: 100,
        chain: selectedChain,
      });
      if (data.success) {
        setAssets(data.assets);
      }
    } catch (err) {
      console.error('[WalletDetail] Failed to fetch assets:', err);
    } finally {
      setAssetsLoading(false);
    }
  }, [wallet, selectedChain]);

  // Fetch token balances (EVM uses batch eth_call, Solana uses getParsedTokenAccountsByOwner)
  const fetchBalances = useCallback(async (assetList: TrackedAsset[]) => {
    if (assetList.length === 0 || !wallet || !selectedChain) return;

    setBalancesLoading(true);
    try {
      const assetInfos = assetList.map(a => ({
        tokenAddress: a.tokenAddress,
        decimals: a.decimals,
        poolAddress: a.poolAddress,
        poolVersion: a.poolVersion,
      }));

      const rpcUrl = getRpcUrl(selectedChain);
      const data = isSolanaChain(selectedChain)
        ? await fetchSolanaTokenData(wallet.address, assetInfos, rpcUrl)
        : await fetchTokenData(wallet.address, assetInfos, rpcUrl);
      setTokenDataMap(data);
    } catch (err) {
      console.error('[WalletDetail] Failed to fetch balances:', err);
    } finally {
      setBalancesLoading(false);
    }
  }, [wallet, selectedChain, getRpcUrl]);

  // Fetch transactions from backend API
  const fetchTransactions = useCallback(async (reset = false) => {
    if (!wallet || !selectedChain) return;
    setTxLoading(true);
    try {
      const offset = reset ? 0 : txOffset;
      const params: Record<string, string | number> = {
        limit: 50,
        offset,
        sortBy: 'createdAt',
        sortDir: 'desc',
        chain: selectedChain,
      };
      if (txTypeFilter !== 'all') {
        params.type = txTypeFilter;
      }
      if (txSearch) {
        params.search = txSearch;
      }

      const data = await api.get<TransactionsResponse>(Api.Wallet, `/wallet/${wallet.address}/transactions`, params);
      if (data.success) {
        if (reset) {
          setTransactions(data.transactions);
          setTxOffset(data.transactions.length);
        } else {
          setTransactions(prev => [...prev, ...data.transactions]);
          setTxOffset(offset + data.transactions.length);
        }
        setTxHasMore(data.pagination.hasMore);
      }
    } catch (err) {
      console.error('[WalletDetail] Failed to fetch transactions:', err);
    } finally {
      setTxLoading(false);
    }
  }, [wallet, selectedChain, txTypeFilter, txSearch, txOffset]);

  // Refetch all data when selectedChain changes (also handles initial load)
  useEffect(() => {
    if (wallet && selectedChain) {
      fetchAssets();
      fetchTransactions(true);
    }
  }, [selectedChain]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch balances when assets change
  useEffect(() => {
    if (assets.length > 0) {
      fetchBalances(assets);
    }
  }, [assets, fetchBalances]);

  // Refetch transactions when filter changes
  useEffect(() => {
    fetchTransactions(true);
  }, [txTypeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // WebSocket subscriptions
  useEffect(() => {
    if (!wallet) return;

    const unsubscribeAsset = subscribe('asset:changed', (event) => {
      const data = event.data as AssetChangedData;
      if (!addressesMatch(data.walletAddress, wallet.address)) return;

      // Handle removal
      if (data.removed) {
        setAssets(prev => prev.filter(
          a => !addressesMatch(a.tokenAddress, data.tokenAddress)
        ));
        return;
      }

      // Update or add asset in local state
      setAssets(prev => {
        const existingIndex = prev.findIndex(
          a => addressesMatch(a.tokenAddress, data.tokenAddress)
        );

        if (existingIndex >= 0) {
          // Update existing
          const updated = [...prev];
          updated[existingIndex] = {
            ...updated[existingIndex],
            symbol: data.symbol ?? updated[existingIndex].symbol,
            name: data.name ?? updated[existingIndex].name,
            poolAddress: data.poolAddress ?? updated[existingIndex].poolAddress,
            poolVersion: data.poolVersion ?? updated[existingIndex].poolVersion,
            icon: data.icon ?? updated[existingIndex].icon,
            updatedAt: new Date().toISOString(),
          };
          // Re-sort by updatedAt
          return updated.sort((a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          );
        } else {
          // Add new (will need to refetch to get full data)
          fetchAssets();
          return prev;
        }
      });
    });

    // Subscribe to balance:updated events from cron server
    const unsubscribeBalance = subscribe(WALLET_EVENTS.BALANCE_UPDATED, (event) => {
      const data = event.data as BalanceUpdatedData;

      if (data.type === 'token') {
        // Update token balances in the assets list
        setAssets(prev => {
          let changed = false;
          const updated = prev.map(asset => {
            const match = data.balances.find(b =>
              addressesMatch(b.walletAddress, wallet.address) &&
              b.tokenAddress && addressesMatch(b.tokenAddress, asset.tokenAddress)
            );
            if (match) {
              changed = true;
              return { ...asset, lastBalance: match.balance, lastBalanceAt: new Date().toISOString() };
            }
            return asset;
          });
          return changed ? updated : prev;
        });
      }
    });

    const unsubscribeTx = subscribe('tx:created', (event) => {
      const data = event.data as TxCreatedData;
      if (!addressesMatch(data.walletAddress, wallet.address)) return;

      // Prepend new transaction to local state
      const newTx: Transaction = {
        id: data.id,
        walletAddress: data.walletAddress,
        txHash: data.txHash ?? null,
        type: data.type,
        status: 'confirmed',
        amount: data.amount ?? null,
        tokenAddress: data.tokenAddress ?? null,
        tokenAmount: data.tokenAmount ?? null,
        from: null,
        to: null,
        description: data.description ?? null,
        blockNumber: null,
        chain: wallet.chain || 'base',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        executedAt: new Date().toISOString(),
      };

      setTransactions(prev => [newTx, ...prev]);
    });

    return () => {
      unsubscribeAsset();
      unsubscribeBalance();
      unsubscribeTx();
    };
  }, [subscribe, wallet, fetchAssets]);

  const handleSave = async () => {
    if (!wallet) return;
    setSaving(true);
    try {
      await api.post(Api.Wallet, '/wallet/rename', {
        address: wallet.address,
        name: editName || undefined,
        description: editDescription || undefined,
        emoji: editEmoji || undefined,
        color: editColor || undefined,
        hidden: editHidden,
      });
      // Update local wallet state
      setWallet(prev => prev ? {
        ...prev,
        name: editName || undefined,
        description: editDescription || undefined,
        emoji: editEmoji || undefined,
        color: editColor || undefined,
        hidden: editHidden,
      } : null);
      setIsEditMode(false);
    } catch (err) {
      console.error('[WalletDetail] Failed to save:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (!wallet) return;
    setEditName(wallet.name || '');
    setEditDescription(wallet.description || '');
    setEditEmoji(wallet.emoji || '');
    setEditColor(wallet.color || '');
    setEditHidden(wallet.hidden || false);
    setIsEditMode(false);
  };

  const handleRefreshAssets = () => {
    fetchAssets();
  };

  const handleRefreshTx = () => {
    fetchTransactions(true);
  };

  const handleChainChange = (chain: string) => {
    setSelectedChain(chain);
    setAddAssetForm(prev => ({ ...prev, chain }));
  };

  // Add asset handler
  const handleAddAsset = async () => {
    if (!addAssetForm.tokenAddress || !wallet) return;

    setAddingAsset(true);
    try {
      const data = await api.post<{ success: boolean; asset?: TrackedAsset; error?: string }>(
        Api.Wallet,
        `/wallet/${wallet.address}/asset`,
        {
          tokenAddress: addAssetForm.tokenAddress,
          symbol: addAssetForm.symbol || undefined,
          name: addAssetForm.name || undefined,
          chain: addAssetForm.chain,
        }
      );

      if (data.success) {
        setShowAddAsset(false);
        setAddAssetForm({ tokenAddress: '', symbol: '', name: '', chain: wallet.chain || 'base' });
        fetchAssets(); // Refresh the list
      } else {
        console.error('[WalletDetail] Failed to add asset:', data.error);
      }
    } catch (err) {
      console.error('[WalletDetail] Failed to add asset:', err);
    } finally {
      setAddingAsset(false);
    }
  };

  // Remove asset handler
  const handleRemoveAsset = async (assetId: string) => {
    if (!wallet) return;

    try {
      const data = await api.delete<{ success: boolean; error?: string }>(
        Api.Wallet,
        `/wallet/${wallet.address}/asset/${assetId}`
      );

      if (!data.success) {
        console.error('[WalletDetail] Failed to remove asset:', data.error);
      }
      // WebSocket event will update the UI
    } catch (err) {
      console.error('[WalletDetail] Failed to remove asset:', err);
    }
  };

  // Filter assets by search
  const filteredAssets = assets.filter(a => {
    // Search filter
    if (assetsSearch) {
      const search = assetsSearch.toLowerCase();
      return (
        (a.symbol?.toLowerCase().includes(search)) ||
        (a.name?.toLowerCase().includes(search)) ||
        (a.tokenAddress.toLowerCase().includes(search))
      );
    }
    return true;
  });

  // Locked state
  if (!isUnlocked) {
    return (
      <div className="py-8 text-center">
        <Lock
          size={24}
          className="mx-auto mb-3"
          style={{ color: 'var(--color-text-muted, #888)' }}
        />
        <div
          className="font-mono text-[10px] tracking-wider"
          style={{ color: 'var(--color-text-muted, #888)' }}
        >
          AGENT LOCKED
        </div>
      </div>
    );
  }

  // No address configured - show input
  if (!walletAddress) {
    return (
      <div className="space-y-3 py-4 px-1">
        <div className="text-center">
          <Search
            size={20}
            className="mx-auto mb-2"
            style={{ color: 'var(--color-text-muted, #888)' }}
          />
          <div
            className="font-mono text-[10px] tracking-wider"
            style={{ color: 'var(--color-text-muted, #888)' }}
          >
            ENTER WALLET ADDRESS
          </div>
        </div>
        <div className="space-y-2">
          <TextInput
            value={manualAddress}
            onChange={(e) => setManualAddress(e.target.value)}
            placeholder="0x... or base58 address"
            compact
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manualAddress.trim()) {
                setCommittedAddress(manualAddress.trim());
                setWalletLoading(true);
              }
            }}
          />
          <Button
            variant="primary"
            onClick={() => {
              if (manualAddress.trim()) {
                setCommittedAddress(manualAddress.trim());
                setWalletLoading(true);
              }
            }}
            disabled={!manualAddress.trim()}
            className="w-full"
            size="sm"
          >
            LOAD WALLET
          </Button>
        </div>
      </div>
    );
  }

  // Loading state
  if (walletLoading) {
    return (
      <div className="py-8 text-center">
        <Loader2
          size={24}
          className="mx-auto mb-3 animate-spin"
          style={{ color: 'var(--color-text-muted, #888)' }}
        />
        <div
          className="font-mono text-[10px] tracking-wider"
          style={{ color: 'var(--color-text-muted, #888)' }}
        >
          LOADING WALLET...
        </div>
      </div>
    );
  }

  // Error state
  if (walletError || !wallet) {
    return (
      <div className="py-8 text-center">
        <div
          className="font-mono text-[10px] tracking-wider"
          style={{ color: 'var(--color-warning, #ff4d00)' }}
        >
          {walletError || 'WALLET NOT FOUND'}
        </div>
        <div
          className="font-mono text-[8px] mt-1"
          style={{ color: 'var(--color-text-muted, #888)' }}
        >
          {walletAddress}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Balance - Prominent at top */}
      <div className="text-center py-2">
        <div
          className="font-mono text-2xl font-bold"
          style={{ color: 'var(--color-text, #0a0a0a)' }}
        >
          {balanceLoading ? (
            <Loader2 size={20} className="inline animate-spin" style={{ color: 'var(--color-text-muted, #888)' }} />
          ) : (
            <>{balance || '0'} <span className="text-sm">{currency}</span></>
          )}
        </div>
        {ethPrice && balance && !balanceLoading && !isSolanaChain(wallet.chain) && (
          <div className="font-mono text-sm" style={{ color: 'var(--color-text-muted, #888)' }}>
            {formatUsd(balance)}
          </div>
        )}
      </div>

      {/* Compact Header: Name, Address, Tier */}
      <div className="flex items-center gap-2">
        {wallet.emoji && <span className="text-xs">{wallet.emoji}</span>}
        <span
          className="font-mono text-[9px] font-bold truncate"
          style={{ color: 'var(--color-text, #0a0a0a)' }}
        >
          {wallet.name || 'HOT WALLET'}
        </span>
        {wallet.color && (
          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: wallet.color }} />
        )}
        <span
          className="font-mono text-[8px] uppercase px-1 py-0.5"
          style={{
            background: 'var(--color-warning, #ff4d00)',
            color: 'var(--color-surface, #fff)',
          }}
        >
          {wallet.tier}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {connected ? (
            <Wifi size={9} style={{ color: 'var(--color-success, #00c853)' }} />
          ) : (
            <WifiOff size={9} style={{ color: 'var(--color-text-muted, #888)' }} />
          )}
          <button
            onClick={() => setIsEditMode(true)}
            className="p-1 transition-colors"
            style={{ color: 'var(--color-text-muted, #888)' }}
          >
            <Edit2 size={10} />
          </button>
        </div>
      </div>

      {/* Compact Address with Copy */}
      <div className="flex items-center gap-1.5">
        <code
          className="flex-1 font-mono text-[9px] truncate select-all"
          style={{ color: 'var(--color-text-muted, #888)' }}
        >
          {wallet.address}
        </code>
        <button
          onClick={copyAddress}
          className="p-1 transition-colors shrink-0"
          style={{
            background: copied ? 'var(--color-success, #00c853)' : 'var(--color-background-alt, #f5f5f5)',
            color: copied ? 'var(--color-surface, #fff)' : 'var(--color-text-muted, #888)',
          }}
        >
          <Copy size={10} />
        </button>
      </div>

      {/* Hidden Badge */}
      {wallet.hidden && !isEditMode && (
        <div
          className="flex items-center gap-1.5 px-2 py-1"
          style={{
            background: 'color-mix(in srgb, var(--color-warning, #ff4d00) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-warning, #ff4d00) 30%, transparent)',
          }}
        >
          <EyeOff size={9} style={{ color: 'var(--color-warning, #ff4d00)' }} />
          <span className="font-mono text-[8px]" style={{ color: 'var(--color-warning, #ff4d00)' }}>
            HIDDEN - Excluded from totals
          </span>
        </div>
      )}

      {/* Description */}
      {wallet.description && !isEditMode && (
        <div
          className="font-mono text-[9px] leading-relaxed"
          style={{ color: 'var(--color-text-muted, #888)' }}
        >
          {wallet.description}
        </div>
      )}

      {/* Edit Mode */}
      {isEditMode ? (
        <div
          className="space-y-2 pt-2"
          style={{ borderTop: '1px solid var(--color-border, #e5e5e5)' }}
        >
          <div>
            <label
              className="font-mono text-[7px] tracking-widest block mb-0.5"
              style={{ color: 'var(--color-text-muted, #888)' }}
            >
              NAME
            </label>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Wallet name..."
              className="w-full px-2 py-1.5 font-mono text-[10px] focus:outline-none"
              style={{
                background: 'var(--color-surface, #fff)',
                border: '1px solid var(--color-border, #e5e5e5)',
                color: 'var(--color-text, #0a0a0a)',
              }}
            />
          </div>

          <div>
            <label
              className="font-mono text-[7px] tracking-widest block mb-0.5"
              style={{ color: 'var(--color-text-muted, #888)' }}
            >
              DESCRIPTION
            </label>
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder="Add a description..."
              rows={2}
              className="w-full px-2 py-1.5 font-mono text-[10px] focus:outline-none resize-none"
              style={{
                background: 'var(--color-surface, #fff)',
                border: '1px solid var(--color-border, #e5e5e5)',
                color: 'var(--color-text, #0a0a0a)',
              }}
            />
          </div>

          <div>
            <label
              className="font-mono text-[7px] tracking-widest block mb-0.5"
              style={{ color: 'var(--color-text-muted, #888)' }}
            >
              EMOJI
            </label>
            <div className="flex flex-wrap gap-0.5">
              <button
                onClick={() => setEditEmoji('')}
                className="w-6 h-6 flex items-center justify-center transition-colors"
                style={{
                  border: !editEmoji
                    ? '1px solid var(--color-text, #0a0a0a)'
                    : '1px solid var(--color-border, #e5e5e5)',
                  background: !editEmoji ? 'var(--color-background-alt, #f5f5f5)' : 'transparent',
                }}
              >
                <X size={10} style={{ color: 'var(--color-text-muted, #888)' }} />
              </button>
              {EMOJI_OPTIONS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => setEditEmoji(emoji)}
                  className="w-6 h-6 flex items-center justify-center text-xs transition-colors"
                  style={{
                    border: editEmoji === emoji
                      ? '1px solid var(--color-text, #0a0a0a)'
                      : '1px solid var(--color-border, #e5e5e5)',
                    background: editEmoji === emoji ? 'var(--color-background-alt, #f5f5f5)' : 'transparent',
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label
              className="font-mono text-[7px] tracking-widest block mb-0.5"
              style={{ color: 'var(--color-text-muted, #888)' }}
            >
              COLOR
            </label>
            <div className="flex flex-wrap gap-0.5">
              <button
                onClick={() => setEditColor('')}
                className="w-6 h-6 flex items-center justify-center transition-colors"
                style={{
                  border: !editColor
                    ? '1px solid var(--color-text, #0a0a0a)'
                    : '1px solid var(--color-border, #e5e5e5)',
                }}
              >
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ background: 'var(--color-border, #e5e5e5)' }}
                />
              </button>
              {COLOR_OPTIONS.map((color) => (
                <button
                  key={color}
                  onClick={() => setEditColor(color)}
                  className="w-6 h-6 flex items-center justify-center transition-colors"
                  style={{
                    border: editColor === color
                      ? '1px solid var(--color-text, #0a0a0a)'
                      : '1px solid var(--color-border, #e5e5e5)',
                  }}
                >
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                </button>
              ))}
            </div>
          </div>

          <div>
            <label
              className="font-mono text-[7px] tracking-widest block mb-0.5"
              style={{ color: 'var(--color-text-muted, #888)' }}
            >
              VISIBILITY
            </label>
            <button
              onClick={() => setEditHidden(!editHidden)}
              className="flex items-center gap-1.5 px-2 py-1.5 w-full transition-colors"
              style={{
                border: editHidden
                  ? '1px solid var(--color-warning, #ff4d00)'
                  : '1px solid var(--color-border, #e5e5e5)',
                background: editHidden
                  ? 'color-mix(in srgb, var(--color-warning, #ff4d00) 5%, transparent)'
                  : 'transparent',
                color: editHidden ? 'var(--color-warning, #ff4d00)' : 'var(--color-text, #0a0a0a)',
              }}
            >
              {editHidden ? <EyeOff size={10} /> : <Eye size={10} />}
              <span className="font-mono text-[9px]">
                {editHidden ? 'HIDDEN' : 'VISIBLE'}
              </span>
            </button>
          </div>

          <div className="flex gap-1.5 pt-1">
            <Button variant="secondary" onClick={handleCancel} className="flex-1">
              CANCEL
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
              loading={saving}
              icon={<Save size={9} />}
              className="flex-1"
            >
              SAVE
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Tab Navigation */}
          <div className="flex items-center gap-2">
            <div
              className="flex flex-1 rounded-sm overflow-hidden"
              style={{
                background: 'var(--color-background-alt, #f5f5f5)',
                border: '1px solid var(--color-border, #e5e5e5)',
              }}
            >
              <TabButton
                active={activeTab === 'assets'}
                onClick={() => setActiveTab('assets')}
                icon={<Coins size={12} />}
                label="ASSETS"
                badge={assets.length > 0 ? assets.length : undefined}
              />
              <TabButton
                active={activeTab === 'transactions'}
                onClick={() => setActiveTab('transactions')}
                icon={<ArrowUpDown size={12} />}
                label="TRANSACTIONS"
                badge={transactions.length > 0 ? transactions.length : undefined}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={activeTab === 'assets' ? handleRefreshAssets : handleRefreshTx}
              disabled={activeTab === 'assets' ? (assetsLoading || balancesLoading) : txLoading}
              icon={<RefreshCw size={12} className={(activeTab === 'assets' ? (assetsLoading || balancesLoading) : txLoading) ? 'animate-spin' : ''} />}
            />
          </div>

          {/* Tab Content */}
          {activeTab === 'assets' ? (
            <AssetsTab
              assets={filteredAssets}
              loading={assetsLoading || balancesLoading}
              search={assetsSearch}
              onSearchChange={setAssetsSearch}
              tokenDataMap={tokenDataMap}
              ethPrice={ethPrice}
              showAddAsset={showAddAsset}
              addAssetAnchor={addAssetAnchor}
              onShowAddAsset={(show, anchor) => {
                setShowAddAsset(show);
                setAddAssetAnchor(anchor || null);
              }}
              addAssetForm={addAssetForm}
              onAddAssetFormChange={setAddAssetForm}
              onAddAsset={handleAddAsset}
              addingAsset={addingAsset}
              chainOptions={chainOptions}
              selectedChain={selectedChain}
              onChainChange={handleChainChange}
              onRemoveAsset={handleRemoveAsset}
              nativeCurrency={isSolanaChain(selectedChain) ? 'SOL' : 'ETH'}
            />
          ) : (
            <TransactionsTab
              transactions={transactions}
              loading={txLoading}
              search={txSearch}
              onSearchChange={setTxSearch}
              typeFilter={txTypeFilter}
              onTypeFilterChange={setTxTypeFilter}
              hasMore={txHasMore}
              onLoadMore={() => fetchTransactions(false)}
              nativeCurrency={isSolanaChain(selectedChain) ? 'SOL' : 'ETH'}
              explorerUrl={getChainConfig(selectedChain).explorer}
            />
          )}
        </>
      )}
    </div>
  );
};

function TabButton({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className="flex-1 py-2 px-3 font-mono text-[9px] tracking-widest transition-all flex items-center justify-center gap-1.5"
      style={{
        background: active ? 'var(--color-surface, #fff)' : 'transparent',
        color: active ? 'var(--color-text, #0a0a0a)' : 'var(--color-text-muted, #888)',
        boxShadow: active ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
      }}
    >
      {icon}
      {label}
      {badge !== undefined && (
        <span
          className="ml-1 px-1.5 py-0.5 rounded-sm text-[8px] font-bold"
          style={{
            background: 'var(--color-info, #0047ff)',
            color: 'var(--color-surface, #fff)',
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function AssetsTab({
  assets,
  loading,
  search,
  onSearchChange,
  tokenDataMap,
  ethPrice,
  showAddAsset,
  addAssetAnchor,
  onShowAddAsset,
  addAssetForm,
  onAddAssetFormChange,
  onAddAsset,
  addingAsset,
  chainOptions,
  selectedChain,
  onChainChange,
  onRemoveAsset,
  nativeCurrency,
}: {
  assets: TrackedAsset[];
  loading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  tokenDataMap: Map<string, TokenData>;
  ethPrice: number | null;
  showAddAsset: boolean;
  addAssetAnchor: HTMLElement | null;
  onShowAddAsset: (show: boolean, anchor?: HTMLElement) => void;
  addAssetForm: { tokenAddress: string; symbol: string; name: string; chain: string };
  onAddAssetFormChange: (form: { tokenAddress: string; symbol: string; name: string; chain: string }) => void;
  onAddAsset: () => void;
  addingAsset: boolean;
  chainOptions: { value: string; label: string }[];
  selectedChain: string;
  onChainChange: (chain: string) => void;
  onRemoveAsset: (assetId: string) => void;
  nativeCurrency: string;
}) {
  return (
    <div className="space-y-2">
      {/* Chain selector, Search, and Add - all on same line */}
      <div className="flex items-center gap-2">
        <div className="w-28">
          <ChainSelector
            value={selectedChain}
            onChange={onChainChange}
            chains={chainOptions.map(o => o.value)}
            size="sm"
          />
        </div>
        <div className="flex-1">
          <TextInput
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search tokens..."
            leftElement={<Search size={10} />}
            compact
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={(e) => onShowAddAsset(true, e.currentTarget as HTMLElement)}
          icon={<Plus size={10} />}
        />
      </div>

      {/* Add Asset Popover */}
      <Popover
        isOpen={showAddAsset}
        onClose={() => onShowAddAsset(false)}
        anchorEl={addAssetAnchor}
        title="ADD ASSET"
        anchor="right"
      >
        <div className="space-y-2 w-56">
          <div>
            <label className="font-mono text-[8px] tracking-widest block mb-1" style={{ color: 'var(--color-text-muted, #888)' }}>
              TOKEN ADDRESS *
            </label>
            <input
              type="text"
              value={addAssetForm.tokenAddress}
              onChange={(e) => onAddAssetFormChange({ ...addAssetForm, tokenAddress: e.target.value })}
              placeholder="0x..."
              className="w-full px-2 py-1.5 font-mono text-[9px] focus:outline-none"
              style={{
                background: 'var(--color-surface, #fff)',
                border: '1px solid var(--color-border, #e5e5e5)',
                color: 'var(--color-text, #0a0a0a)',
              }}
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="font-mono text-[8px] tracking-widest block mb-1" style={{ color: 'var(--color-text-muted, #888)' }}>
                SYMBOL
              </label>
              <input
                type="text"
                value={addAssetForm.symbol}
                onChange={(e) => onAddAssetFormChange({ ...addAssetForm, symbol: e.target.value })}
                placeholder="TKN"
                className="w-full px-2 py-1.5 font-mono text-[9px] focus:outline-none"
                style={{
                  background: 'var(--color-surface, #fff)',
                  border: '1px solid var(--color-border, #e5e5e5)',
                  color: 'var(--color-text, #0a0a0a)',
                }}
              />
            </div>
            <div className="w-28">
              <ChainSelector
                label="CHAIN"
                value={addAssetForm.chain}
                onChange={(chain) => onAddAssetFormChange({ ...addAssetForm, chain })}
                chains={chainOptions.map(o => o.value)}
                size="sm"
              />
            </div>
          </div>
          <div>
            <label className="font-mono text-[8px] tracking-widest block mb-1" style={{ color: 'var(--color-text-muted, #888)' }}>
              NAME
            </label>
            <input
              type="text"
              value={addAssetForm.name}
              onChange={(e) => onAddAssetFormChange({ ...addAssetForm, name: e.target.value })}
              placeholder="Token Name"
              className="w-full px-2 py-1.5 font-mono text-[9px] focus:outline-none"
              style={{
                background: 'var(--color-surface, #fff)',
                border: '1px solid var(--color-border, #e5e5e5)',
                color: 'var(--color-text, #0a0a0a)',
              }}
            />
          </div>
          <Button
            onClick={onAddAsset}
            disabled={!addAssetForm.tokenAddress || addingAsset}
            loading={addingAsset}
            className="w-full"
            size="sm"
          >
            {addingAsset ? 'ADDING...' : 'ADD ASSET'}
          </Button>
        </div>
      </Popover>

      {/* Assets List */}
      {loading && assets.length === 0 ? (
        <div className="py-6 text-center">
          <Loader2
            size={20}
            className="mx-auto mb-2 animate-spin"
            style={{ color: 'var(--color-text-muted, #888)' }}
          />
          <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #888)' }}>
            LOADING ASSETS...
          </div>
        </div>
      ) : assets.length === 0 ? (
        <div className="py-6 text-center">
          <Coins size={24} className="mx-auto mb-2" style={{ color: 'var(--color-text-muted, #888)' }} />
          <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #888)' }}>
            NO TRACKED ASSETS
          </div>
          <div className="font-mono text-[8px] mt-1" style={{ color: 'var(--color-text-faint, #aaa)' }}>
            Swap tokens to auto-track them
          </div>
        </div>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {assets.map((asset) => {
            const tokenKey = isSolanaChain(selectedChain) ? asset.tokenAddress : asset.tokenAddress.toLowerCase();
            const tokenData = tokenDataMap.get(tokenKey);
            const balance = tokenData?.balance ?? asset.lastBalance ?? '0';
            const priceInEth = tokenData?.priceInEth ?? null;
            const usdValue = calculateUsdValue(balance, priceInEth, ethPrice);
            // Staleness indicator
            const balanceAge = asset.lastBalanceAt
              ? Date.now() - new Date(asset.lastBalanceAt).getTime()
              : null;
            const stalenessColor = balanceAge === null ? 'var(--color-text-faint, #ccc)'
              : balanceAge < 30_000 ? 'var(--color-success, #00c853)'
              : balanceAge < 300_000 ? 'var(--color-info, #0047ff)'
              : 'var(--color-warning, #ff4d00)';

            return (
              <div
                key={asset.id}
                className="p-2 rounded-sm group"
                style={{
                  background: 'var(--color-surface, #fff)',
                  border: '1px solid var(--color-border, #e5e5e5)',
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Token icon placeholder */}
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold"
                      style={{
                        background: 'var(--color-background-alt, #f5f5f5)',
                        color: 'var(--color-text-muted, #888)',
                      }}
                    >
                      {asset.symbol?.charAt(0) || '?'}
                    </div>
                    <div className="min-w-0">
                      <div
                        className="font-mono text-[10px] font-bold truncate"
                        style={{ color: 'var(--color-text, #0a0a0a)' }}
                      >
                        {asset.symbol || shortenAddress(asset.tokenAddress, 4)}
                      </div>
                      {asset.name && (
                        <div
                          className="font-mono text-[8px] truncate"
                          style={{ color: 'var(--color-text-muted, #888)' }}
                        >
                          {asset.name}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-right shrink-0">
                      <div className="flex items-center gap-1 justify-end">
                        <div
                          className="w-1 h-1 rounded-full shrink-0"
                          style={{ background: stalenessColor }}
                          title={asset.lastBalanceAt ? `Updated ${formatTimeAgo(asset.lastBalanceAt)}` : 'No cached balance'}
                        />
                        <span
                          className="font-mono text-[10px] font-bold"
                          style={{ color: 'var(--color-text, #0a0a0a)' }}
                        >
                          {parseFloat(balance).toFixed(4)}
                        </span>
                      </div>
                      {usdValue !== null && (
                        <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-muted, #888)' }}>
                          {formatUsdValue(usdValue)}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => onRemoveAsset(asset.id)}
                      className="p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ color: 'var(--color-warning, #ff4d00)' }}
                      title="Remove asset"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
                {/* Pool info badge */}
                {asset.poolVersion && (
                  <div className="mt-1.5 flex items-center gap-1">
                    <span
                      className="font-mono text-[7px] px-1 py-0.5 rounded-sm uppercase"
                      style={{
                        background: 'var(--color-background-alt, #f5f5f5)',
                        color: 'var(--color-text-muted, #888)',
                      }}
                    >
                      {asset.poolVersion}
                    </span>
                    {priceInEth !== null && (
                      <span className="font-mono text-[7px]" style={{ color: 'var(--color-text-muted, #888)' }}>
                        {priceInEth.toFixed(8)} {nativeCurrency}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TransactionsTab({
  transactions,
  loading,
  search,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
  hasMore,
  onLoadMore,
  nativeCurrency,
  explorerUrl,
}: {
  transactions: Transaction[];
  loading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  typeFilter: string;
  onTypeFilterChange: (value: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  nativeCurrency: string;
  explorerUrl: string;
}) {
  // Client-side search filter
  const filteredTx = search
    ? transactions.filter(tx =>
        (tx.description?.toLowerCase().includes(search.toLowerCase())) ||
        (tx.txHash?.toLowerCase().includes(search.toLowerCase()))
      )
    : transactions;

  return (
    <div className="space-y-2">
      {/* Type Filter and Search */}
      <div className="flex gap-2">
        <div className="w-24">
          <FilterDropdown
            options={TX_TYPE_OPTIONS}
            value={typeFilter}
            onChange={onTypeFilterChange}
            compact
          />
        </div>
        <div className="flex-1">
          <TextInput
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search tx..."
            leftElement={<Search size={10} />}
            compact
          />
        </div>
      </div>

      {/* Transactions List */}
      {loading && transactions.length === 0 ? (
        <div className="py-6 text-center">
          <Loader2
            size={20}
            className="mx-auto mb-2 animate-spin"
            style={{ color: 'var(--color-text-muted, #888)' }}
          />
          <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #888)' }}>
            LOADING TRANSACTIONS...
          </div>
        </div>
      ) : filteredTx.length === 0 ? (
        <div className="py-6 text-center">
          <ArrowUpDown size={24} className="mx-auto mb-2" style={{ color: 'var(--color-text-muted, #888)' }} />
          <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #888)' }}>
            NO TRANSACTIONS
          </div>
          <div className="font-mono text-[8px] mt-1" style={{ color: 'var(--color-text-faint, #aaa)' }}>
            {search ? 'Try a different search' : 'Transactions will appear here'}
          </div>
        </div>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {filteredTx.map((tx) => {
            const typeColor = TX_TYPE_COLORS[tx.type] || 'var(--color-text-muted, #888)';

            return (
              <div
                key={tx.id}
                className="p-2 rounded-sm"
                style={{
                  background: 'var(--color-surface, #fff)',
                  border: '1px solid var(--color-border, #e5e5e5)',
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: typeColor }}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="font-mono text-[8px] font-bold uppercase"
                          style={{ color: typeColor }}
                        >
                          {tx.type}
                        </span>
                        {tx.amount && (
                          <span
                            className="font-mono text-[9px] font-bold"
                            style={{ color: 'var(--color-text, #0a0a0a)' }}
                          >
                            {parseFloat(tx.amount).toFixed(4)} {nativeCurrency}
                          </span>
                        )}
                        {tx.tokenAmount && (
                          <span
                            className="font-mono text-[9px] font-bold"
                            style={{ color: 'var(--color-text, #0a0a0a)' }}
                          >
                            {parseFloat(tx.tokenAmount).toFixed(4)}
                          </span>
                        )}
                      </div>
                      {tx.description && (
                        <div
                          className="font-mono text-[8px] truncate max-w-[180px]"
                          style={{ color: 'var(--color-text-muted, #888)' }}
                        >
                          {tx.description}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="font-mono text-[7px]" style={{ color: 'var(--color-text-faint, #aaa)' }}>
                      {formatTimeAgo(tx.createdAt)}
                    </span>
                    {tx.txHash && (
                      <a
                        href={`${explorerUrl}/tx/${tx.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-0.5 transition-colors"
                        style={{ color: 'var(--color-text-muted, #888)' }}
                      >
                        <ExternalLink size={9} />
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {hasMore && !search && (
            <button
              onClick={onLoadMore}
              disabled={loading}
              className="w-full py-2 font-mono text-[8px] transition-colors"
              style={{
                color: 'var(--color-text-muted, #888)',
                background: 'var(--color-background-alt, #f5f5f5)',
              }}
            >
              {loading ? 'LOADING...' : 'LOAD MORE'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default WalletDetailApp;
