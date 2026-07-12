'use client';

import React, { useEffect, useState, Suspense } from 'react';

import { Shield, Flame, Plus, Send, Rocket, Copy, Loader2, Check, X, AlertTriangle, Trash2, Home as HomeIcon, KeyRound, Code, Database, RotateCcw, Lock, Settings, Bot } from 'lucide-react';
import { TextInput, Drawer, Modal, ConfirmationModal, Button, Popover, TyvekCollapsibleSection } from '@/components/design-system';
import { WalletSidebar, TabBar, WorkspaceTab, AppStoreDrawer, LeftRail, CreateViewModal } from '@/components/layout';
import { DEFAULT_VIEWS, SOCIAL_VIEW, getDefaultActiveViewId, type ViewDefinition } from '@/lib/view-registry';
import { DraggableApp, type AppColor } from '@/components/apps';
import { useAgentActions } from '@/hooks/useAgentActions';
import { HumanActionBar } from '@/components/HumanActionBar';
import { PasskeyEnrollmentPrompt } from '@/components/PasskeyEnrollmentPrompt';
import { useWorkspace, type AppState as WorkspaceAppState } from '@/context/WorkspaceContext';
import { useAuth, type ApiKey, type ChainConfig } from '@/context/AuthContext';
import { useWebSocket } from '@/context/WebSocketContext';
import { getAppDefinition } from '@/lib/app-registry';
import SystemDefaults, { AiEngineSection } from '@/components/apps/SystemDefaultsApp';
import { WALLET_EVENTS, WalletCreatedData } from '@/lib/events';
import { api, Api } from '@/lib/api';

// Known chains with Alchemy support - used for auto-fill when adding chains
const KNOWN_CHAINS: Record<string, { chainId: number; alchemyPath: string; explorer: string }> = {
  base: { chainId: 8453, alchemyPath: 'base-mainnet', explorer: 'https://basescan.org' },
  ethereum: { chainId: 1, alchemyPath: 'eth-mainnet', explorer: 'https://etherscan.io' },
  arbitrum: { chainId: 42161, alchemyPath: 'arb-mainnet', explorer: 'https://arbiscan.io' },
  optimism: { chainId: 10, alchemyPath: 'opt-mainnet', explorer: 'https://optimistic.etherscan.io' },
  polygon: { chainId: 137, alchemyPath: 'polygon-mainnet', explorer: 'https://polygonscan.com' },
  zksync: { chainId: 324, alchemyPath: 'zksync-mainnet', explorer: 'https://explorer.zksync.io' },
};

interface WalletData {
  address: string;
  tier: 'cold' | 'hot' | 'temp';
  chain: string;
  balance?: string;
  label?: string;
  spentToday?: number;
  name?: string;
  color?: string;
  emoji?: string;
  description?: string;
  hidden?: boolean;
  tokenHash?: string;
  createdAt?: string;
}

interface DashboardState {
  configured: boolean;
  isUnlocked: boolean;
  wallets: WalletData[];
}

interface AppPosition {
  x: number;
  y: number;
}

export default function Home() {
  const {
    token,
    apiKeys: authApiKeys,
    apiKeysLoading: authApiKeysLoading,
    refreshApiKeys,
    getApiKey,
    chainOverrides,
    saveChainOverride,
    removeChainOverride,
    getConfiguredChains,
  } = useAuth();
  const { subscribe } = useWebSocket();
  const [state, setState] = useState<DashboardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const lastToastRef = React.useRef<{ message: string; at: number } | null>(null);

  // Experimental wallet multi-view shell state
  const [experimentalWallet, setExperimentalWallet] = useState(false);
  const [socialEnabled, setSocialEnabled] = useState(false);
  const [activeViewId, setActiveViewId] = useState(getDefaultActiveViewId());
  const [createViewOpen, setCreateViewOpen] = useState(false);

  const reportNonInlineError = React.useCallback((message: string) => {
    const normalized = message.trim() || 'Something went wrong';
    const now = Date.now();
    const last = lastToastRef.current;
    if (last && last.message === normalized && now - last.at < 3000) return;
    lastToastRef.current = { message: normalized, at: now };
    setError(normalized);
  }, []);

  // Agent requests - only need count for sidebar badge (app is self-contained)
  // Only auto-fetch when we have a token (wallet is unlocked)
  const { requests, notifications, dismissNotification, resolveAction, actionLoading } = useAgentActions({ autoFetch: !!token });
  const [copied, setCopied] = useState<string | null>(null);
  const [activeDrawer, setActiveDrawer] = useState<'settings' | 'receive' | null>(null);
  const [showAppStore, setShowAppStore] = useState(false);
  const [nuking, setNuking] = useState(false);
  const [confirmNuke, setConfirmNuke] = useState(false);

  const [sendFrom, setSendFrom] = useState('');

  const [seedPhrase, setSeedPhrase] = useState<string | null>(null);
  const [seedConfirmed, setSeedConfirmed] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportedSeed, setExportedSeed] = useState<string | null>(null);

  // Import seed state
  const [showImportSeedModal, setShowImportSeedModal] = useState(false);
  const [importSeedPhrase, setImportSeedPhrase] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [importConfirmPassword, setImportConfirmPassword] = useState('');
  const [importing, setImporting] = useState(false);

  // Chain state
  const [chains, setChains] = useState<Record<string, { rpc: string; chainId: number; explorer: string; nativeCurrency: string }>>({});
  const [editingChainRpc, setEditingChainRpc] = useState<string | null>(null);
  const [customRpc, setCustomRpc] = useState('');
  const [savingConfig] = useState(false);
  const [showAddChainModal, setShowAddChainModal] = useState(false);
  const [addChainAnchorEl, setAddChainAnchorEl] = useState<HTMLElement | null>(null);
  const [newChain, setNewChain] = useState({ name: '', chainId: '', rpc: '', explorer: '', nativeCurrency: 'ETH' });

  // API Keys state
  const [showAddApiKeyPopover, setShowAddApiKeyPopover] = useState(false);
  const [addApiKeyAnchorEl, setAddApiKeyAnchorEl] = useState<HTMLElement | null>(null);
  const [newApiKey, setNewApiKey] = useState({ service: '', name: '', key: '' });
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [deletingApiKey, setDeletingApiKey] = useState<string | null>(null);
  const [showRevokeAllApiKeysPopover, setShowRevokeAllApiKeysPopover] = useState(false);
  const [revokeAllApiKeysAnchorEl, setRevokeAllApiKeysAnchorEl] = useState<HTMLElement | null>(null);
  const [revokingAllApiKeys, setRevokingAllApiKeys] = useState(false);

  // Backup state
  interface BackupInfo {
    filename: string;
    timestamp: string;
    size: number;
    date: string;
  }
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null);

  // Workspace context for programmatic workspace control
  const {
    workspaces,
    activeWorkspaceId,
    apps: workspaceApps,
    loading: workspaceLoading,
    createWorkspace,
    deleteWorkspace,
    updateWorkspace,
    switchWorkspace,
    addApp,
    removeApp,
    updateApp,
    bringToFront,
    tidyApps,
  } = useWorkspace();

  // Convert workspaces to tabs format
  const tabs: WorkspaceTab[] = workspaces.map(ws => ({
    id: ws.id,
    label: ws.name,
    icon: ws.icon === 'Home' ? HomeIcon : undefined,
    emoji: ws.emoji,
    color: ws.color,
    closeable: ws.isCloseable,
    isDefault: ws.isDefault,
  }));

  // Handle workspace tab update (name, emoji, color)
  const handleTabUpdate = (tabId: string, data: { name?: string; emoji?: string; color?: string }) => {
    updateWorkspace(tabId, {
      name: data.name,
      emoji: data.emoji,
      color: data.color,
    });
  };

  const fetchState = async (retries = 10): Promise<void> => {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const setupData = await api.get<{ hasWallet: boolean; unlocked: boolean; address: string | null }>(
          Api.Wallet, '/setup', undefined, { signal: controller.signal },
        );
        clearTimeout(timeout);

        // Map new server response format
        const configured = setupData.hasWallet;
        const isUnlocked = setupData.unlocked;

        if (!configured) {
          setState({ configured: false, isUnlocked: false, wallets: [] });
          setLoading(false);
          return;
        }

        if (!isUnlocked) {
          setState({ configured: true, isUnlocked: false, wallets: [] });
          setLoading(false);
          return;
        }

        const walletsData = await api.get<{ wallets: WalletData[] }>(Api.Wallet, '/wallets', { includeHidden: true });

        setState({
          configured: true,
          isUnlocked: true,
          wallets: walletsData.wallets || [],
        });
        if (walletsData.wallets?.length > 0 && !sendFrom) {
          const hotWallet = walletsData.wallets.find((w: WalletData) => w.tier === 'hot');
          if (hotWallet) setSendFrom(hotWallet.address);
        }
        setLoading(false);
        return;
      } catch {
        // Server not ready yet — retry after a delay
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    // All retries exhausted
    reportNonInlineError('Failed to connect to wallet server');
    setLoading(false);
  };

  useEffect(() => { fetchState(); }, []);

  // Fetch feature flags for experimental wallet + social
  useEffect(() => {
    fetch('/flags')
      .then((r) => r.ok ? r.json() : {})
      .then((flags: Record<string, boolean>) => {
        if (flags.EXPERIMENTAL_WALLET) setExperimentalWallet(true);
        if (flags.SOCIAL) setSocialEnabled(true);
      })
      .catch(() => {});
  }, []);

  // Sync chains state from AuthContext (overrides + Alchemy + public fallbacks)
  useEffect(() => {
    const configuredChains = getConfiguredChains();
    const chainsWithNative: Record<string, { rpc: string; chainId: number; explorer: string; nativeCurrency: string }> = {};
    for (const [chain, config] of Object.entries(configuredChains)) {
      chainsWithNative[chain] = {
        ...config,
        nativeCurrency: 'ETH', // All supported chains use ETH
      };
    }
    setChains(chainsWithNative);
  }, [getConfiguredChains, chainOverrides, authApiKeys]);

  // Subscribe to WebSocket wallet events for real-time updates
  useEffect(() => {
    // Handle wallet:created - add new wallet to state
    const unsubscribeWalletCreated = subscribe(WALLET_EVENTS.WALLET_CREATED, (event) => {
      const data = event.data as WalletCreatedData;
      setState((prev) => {
        if (!prev) return prev;
        // Check if wallet already exists
        if (prev.wallets.some((w) => w.address === data.address)) {
          return prev;
        }
        // Add new wallet with createdAt timestamp
        const newWallet: WalletData = {
          address: data.address,
          tier: data.tier,
          chain: data.chain,
          name: data.name,
          tokenHash: data.tokenHash,
          balance: '0 ETH',
          createdAt: new Date().toISOString(),
        };
        return {
          ...prev,
          wallets: [...prev.wallets, newWallet],
        };
      });
    });

    return () => {
      unsubscribeWalletCreated();
    };
  }, [subscribe]);

  // Seed default apps on first setup (empty workspace + configured + unlocked)
  // Key is tied to cold wallet address so a new agent (e.g. sandbox) gets fresh defaults
  useEffect(() => {
    if (
      !state?.configured ||
      !state?.isUnlocked ||
      workspaceLoading ||
      workspaceApps.length > 0
    ) return;

    const coldWallet = state.wallets.find(w => w.tier === 'cold');
    const seedKey = `defaultAppsSeeded:${coldWallet?.address || 'unknown'}`;

    if (localStorage.getItem(seedKey)) return;

    // 1. Getting Started
    const dismissKey = `setupWizardDismissed:${coldWallet?.address || 'unknown'}`;
    if (!localStorage.getItem(dismissKey)) {
      addApp('setup', undefined, { x: 20, y: 20 });
    }

    // 2. Agent Chat
    addApp(
      'installed:agent-chat',
      { appPath: 'agent-chat', appName: 'Agent Chat' },
      { x: 460, y: 20 }
    );

    // 3. Wallet detail for cold wallet
    if (coldWallet) {
      addApp(
        'walletDetail',
        {
          walletAddress: coldWallet.address,
          walletName: coldWallet.name,
          walletEmoji: coldWallet.emoji,
          walletColor: coldWallet.color,
        },
        { x: 820, y: 20 },
        `walletDetail-${coldWallet.address}`
      );
    }

    localStorage.setItem(seedKey, 'true');
  }, [state?.configured, state?.isUnlocked, state?.wallets, workspaceLoading, workspaceApps.length, addApp]);

  const handleExportSeed = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setExporting(true);
    try {
      const data = await api.post<{ success: boolean; error?: string; mnemonic?: string }>(Api.Wallet, '/wallet/export-seed', { password: exportPassword });
      if (!data.success) throw new Error(data.error);
      setExportedSeed(data.mnemonic ?? null);
      setExportPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const copyAddress = (address: string) => {
    navigator.clipboard.writeText(address);
    setCopied(address);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleNuke = async () => {
    if (!confirmNuke) {
      setConfirmNuke(true);
      return;
    }
    setNuking(true);
    try {
      const data = await api.post<{ success: boolean; error?: string }>(Api.Wallet, '/nuke');
      if (!data.success) throw new Error(data.error);
      setState(null);
      setActiveDrawer(null);
      setConfirmNuke(false);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nuke failed');
    } finally {
      setNuking(false);
    }
  };

  const handleImportSeed = async (e: React.FormEvent) => {
    e.preventDefault();
    if (importPassword !== importConfirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (importPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (!importSeedPhrase.trim()) {
      setError('Please enter a seed phrase');
      return;
    }

    setImporting(true);
    try {
      const data = await api.post<{ success?: boolean; error?: string }>(Api.Wallet, '/nuke/import', {
        mnemonic: importSeedPhrase.trim(),
        password: importPassword
      });
      if (!data.success && data.error) throw new Error(data.error);

      setShowImportSeedModal(false);
      setImportSeedPhrase('');
      setImportPassword('');
      setImportConfirmPassword('');
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handleWalletClick = (wallet: WalletData) => {
    const appId = `walletDetail-${wallet.address}`;

    // Check if app for this wallet is already open
    const existingApp = workspaceApps.find(w => w.id === appId);
    if (existingApp) {
      // Bring to front
      bringToFront(appId);
      return;
    }

    // Count existing wallet detail apps for offset
    const walletAppCount = workspaceApps.filter(w => w.appType === 'walletDetail').length;
    const offset = walletAppCount * 30;

    // Add app through workspace system with wallet info for title/color
    addApp(
      'walletDetail',
      {
        walletAddress: wallet.address,
        walletName: wallet.name,
        walletEmoji: wallet.emoji,
        walletColor: wallet.color,
      },
      { x: 360 + offset, y: 20 + offset },
      appId
    );
  };


  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleWalletUpdate = async (
    address: string,
    updates: { name?: string; color?: string; emoji?: string; description?: string; hidden?: boolean }
  ) => {
    try {
      const data = await api.post<{ success: boolean; error?: string }>(Api.Wallet, '/wallet/rename', { address, ...updates });
      if (!data.success) throw new Error(data.error);

      // Update local state - wallet detail apps read from state.wallets
      if (state?.wallets) {
        const updatedWallets = state.wallets.map((w) =>
          w.address === address ? { ...w, ...updates } : w
        );
        setState((prev) => (prev ? { ...prev, wallets: updatedWallets } : null));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update wallet');
    }
  };

  const handleRemoveChain = async (chain: string) => {
    try {
      await removeChainOverride(chain);
    } catch {
      setError('Failed to remove chain');
    }
  };

  // Add new API key
  const handleAddApiKey = async () => {
    if (!newApiKey.service || !newApiKey.name || !newApiKey.key) {
      setError('Service, name, and key are required');
      return;
    }

    setSavingApiKey(true);
    try {
      const data = await api.post<{ success: boolean; error?: string }>(Api.Wallet, '/apikeys', {
        service: newApiKey.service.toLowerCase(),
        name: newApiKey.name,
        key: newApiKey.key
      });

      if (data.success) {
        // Refresh API keys list from AuthContext
        await refreshApiKeys();
        setNewApiKey({ service: '', name: '', key: '' });
        setShowAddApiKeyPopover(false);
      } else {
        reportNonInlineError(data.error || 'Failed to save API key');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key');
    } finally {
      setSavingApiKey(false);
    }
  };

  // Delete API key
  const handleDeleteApiKey = async (id: string) => {
    setDeletingApiKey(id);
    try {
      const data = await api.delete<{ success: boolean; error?: string }>(Api.Wallet, `/apikeys/${id}`);

      if (data.success) {
        await refreshApiKeys();
      } else {
        reportNonInlineError(data.error || 'Failed to delete API key');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete API key');
    } finally {
      setDeletingApiKey(null);
    }
  };

  const onOpenRevokeAllApiKeys = (anchorEl: HTMLElement) => {
    setRevokeAllApiKeysAnchorEl(anchorEl);
    setShowRevokeAllApiKeysPopover(true);
  };

  const onCloseRevokeAllApiKeys = () => {
    setShowRevokeAllApiKeysPopover(false);
    setRevokeAllApiKeysAnchorEl(null);
  };

  const handleRevokeAllApiKeys = async () => {
    setRevokingAllApiKeys(true);
    try {
      const data = await api.delete<{ success: boolean; revokedCount?: number; message?: string; error?: string }>(Api.Wallet, '/apikeys/revoke-all');
      if (!data.success) {
        reportNonInlineError(data.error || 'Failed to revoke all API keys');
        return;
      }
      await refreshApiKeys();
      onCloseRevokeAllApiKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke all API keys');
    } finally {
      setRevokingAllApiKeys(false);
    }
  };

  // Add Alchemy API key directly (for quick setup)
  const handleAddAlchemyKey = async (key: string): Promise<boolean> => {
    try {
      const data = await api.post<{ success: boolean; error?: string }>(Api.Wallet, '/apikeys', {
        service: 'alchemy',
        name: 'default',
        key
      });

      if (data.success) {
        await refreshApiKeys();
        return true;
      } else {
        reportNonInlineError(data.error || 'Failed to save Alchemy key');
        return false;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Alchemy key');
      return false;
    }
  };

  const handleAddChain = async () => {
    const chainName = newChain.name.toLowerCase().trim();
    if (!chainName || !newChain.chainId) {
      setError('Chain name and chain ID are required');
      return;
    }

    const chainId = parseInt(newChain.chainId, 10);
    const knownChain = KNOWN_CHAINS[chainName];
    const explorer = newChain.explorer || knownChain?.explorer || '';

    // If RPC is blank and we have Alchemy key + known chain, construct Alchemy URL
    let rpc = newChain.rpc.trim();
    if (!rpc) {
      const alchemyKey = getApiKey('alchemy');
      if (alchemyKey && knownChain?.alchemyPath) {
        rpc = `https://${knownChain.alchemyPath}.g.alchemy.com/v2/${alchemyKey}`;
      } else {
        setError('RPC URL is required (or add Alchemy key for known chains)');
        return;
      }
    }

    try {
      await saveChainOverride(chainName, { rpc, chainId, explorer });
      setNewChain({ name: '', chainId: '', rpc: '', explorer: '', nativeCurrency: 'ETH' });
      setShowAddChainModal(false);
    } catch {
      setError('Failed to add chain');
    }
  };

  const handleSaveCustomRpc = async (chain: string, rpc: string) => {
    if (!rpc) {
      setError('RPC URL is required');
      return;
    }
    try {
      // Get current chain config to preserve chainId and explorer
      const currentConfig = chains[chain];
      await saveChainOverride(chain, {
        rpc,
        chainId: currentConfig?.chainId || 0,
        explorer: currentConfig?.explorer || '',
      });
      setEditingChainRpc(null);
      setCustomRpc('');
    } catch {
      setError('Failed to save RPC override');
    }
  };

  const fetchBackups = async () => {
    // Skip if no auth token
    if (!token) {
      setBackups([]);
      return;
    }
    setBackupsLoading(true);
    try {
      const data = await api.get<{ success: boolean; backups: Array<{ filename: string; timestamp: string; size: number; date: string }> }>(Api.Wallet, '/backup');
      if (data.success) {
        setBackups(data.backups);
      }
    } catch (err) {
      console.error('Failed to fetch backups:', err);
      setBackups([]);
    } finally {
      setBackupsLoading(false);
    }
  };

  const handleCreateBackup = async () => {
    setCreatingBackup(true);
    try {
      const data = await api.post<{ success: boolean; error?: string }>(Api.Wallet, '/backup');
      if (data.success) {
        await fetchBackups();
      } else {
        reportNonInlineError(data.error || 'Failed to create backup');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create backup');
    } finally {
      setCreatingBackup(false);
    }
  };

  const handleRestoreBackup = async (filename: string) => {
    setRestoringBackup(filename);
    try {
      const data = await api.put<{ success: boolean; error?: string }>(Api.Wallet, '/backup', { filename });
      if (data.success) {
        window.location.reload();
      } else {
        reportNonInlineError(data.error || 'Failed to restore backup');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore backup');
    } finally {
      setRestoringBackup(null);
    }
  };

  const [exportingDb, setExportingDb] = useState(false);

  const handleExportDb = async () => {
    setExportingDb(true);
    try {
      const baseUrl = api.getBaseUrl(Api.Wallet);
      const authToken = token || '';
      const res = await fetch(`${baseUrl}/backup/export`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Export failed' }));
        reportNonInlineError(err.error || 'Export failed');
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
      const filename = filenameMatch ? filenameMatch[1] : 'auramaxx-export.db';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      reportNonInlineError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExportingDb(false);
    }
  };

  const handleNewTab = () => {
    createWorkspace('NEW');
  };

  const handleCloseTab = (tabId: string) => {
    deleteWorkspace(tabId);
  };

  const handleTabChange = (tabId: string) => {
    switchWorkspace(tabId);
  };

  const handleAppPositionChange = (id: string, pos: AppPosition) => {
    // Update context (will sync to DB)
    updateApp(id, { x: pos.x, y: pos.y });
  };

  const handleAppLockChange = (id: string, locked: boolean) => {
    updateApp(id, { isLocked: locked });
  };

  const handleAppSizeChange = (id: string, size: { width: number; height: number }) => {
    updateApp(id, { width: size.width, height: size.height });
  };

  const handleBringToFront = (id: string) => {
    bringToFront(id);
  };

  const handleDismissApp = (id: string) => {
    removeApp(id);
  };

  const handleOpenLogs = () => {
    // Check if logs app already exists
    const logsApp = workspaceApps.find(w => w.appType === 'logs');
    if (logsApp) {
      bringToFront(logsApp.id);
    } else {
      addApp('logs', undefined, { x: 700, y: 20 });
    }
  };

  const handleOpenApp = (type: string, position?: { x: number; y: number }) => {
    const existing = workspaceApps.find(w => w.appType === type);
    if (existing) {
      bringToFront(existing.id);
    } else {
      addApp(type, undefined, position);
    }
  };

  const handleAddAppFromStore = (appType: string, config?: Record<string, unknown>) => {
    addApp(appType, config, { x: 360, y: 20 });
    setShowAppStore(false);
  };

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-background,#f5f5f5)] relative">
        <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
          <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--color-border-muted,#e5e5e5)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-border-muted,#e5e5e5)_1px,transparent_1px)] bg-[size:4rem_4rem] opacity-30" />
        </div>
        <div className="font-mono text-sm text-[var(--color-text-muted,#6b7280)] animate-pulse relative z-10">INITIALIZING SYSTEM...</div>
      </div>
    );
  }

  // Seed backup screen
  if (seedPhrase && !seedConfirmed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--color-background,#f5f5f5)] relative">
        <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
          <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--color-border-muted,#e5e5e5)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-border-muted,#e5e5e5)_1px,transparent_1px)] bg-[size:4rem_4rem] opacity-30" />
        </div>
        <div className="w-full max-w-md bg-[var(--color-surface,#ffffff)] border border-[var(--color-border,#d4d4d8)] relative z-10">
          <div className="absolute top-2 left-2 w-4 h-4 border-l-2 border-t-2 border-[var(--color-border-focus,#0a0a0a)]" />
          <div className="absolute top-2 right-2 w-4 h-4 border-r-2 border-t-2 border-[var(--color-border-focus,#0a0a0a)]" />
          <div className="absolute bottom-2 left-2 w-4 h-4 border-l-2 border-b-2 border-[var(--color-border-focus,#0a0a0a)]" />
          <div className="absolute bottom-2 right-2 w-4 h-4 border-r-2 border-b-2 border-[var(--color-border-focus,#0a0a0a)]" />
          <div className="absolute inset-0 opacity-[0.02] pointer-events-none bg-[radial-gradient(var(--color-text,#000)_1px,transparent_1px)] bg-[size:4px_4px]" />

          <div className="p-8 relative z-10">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 bg-[var(--color-warning,#ff4d00)] flex items-center justify-center">
                <AlertTriangle size={16} className="text-white" />
              </div>
              <div>
                <div className="font-mono text-[10px] text-[var(--color-warning,#ff4d00)] tracking-widest">CRITICAL</div>
                <div className="font-black text-xl text-[var(--color-text,#0a0a0a)] tracking-tight">BACKUP SEED PHRASE</div>
              </div>
            </div>

            <div className="mb-4 p-3 bg-[var(--color-warning,#ff4d00)]/10 border border-[var(--color-warning,#ff4d00)]/30">
              <div className="font-mono text-[10px] text-[var(--color-warning,#ff4d00)] leading-relaxed">
                Write this down and store it safely. This is the ONLY way to recover your wallets. It will NOT be shown again.
              </div>
            </div>

            <div className="mb-6 p-4 bg-[var(--color-text,#0a0a0a)] border-2 border-[var(--color-border-focus,#0a0a0a)] relative">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(seedPhrase);
                  setCopied('seed');
                  setTimeout(() => setCopied(null), 2000);
                }}
                className="absolute top-2 right-2 p-1.5 bg-[var(--color-text,#0a0a0a)]/80 hover:bg-[var(--color-text,#0a0a0a)]/70 transition-colors"
              >
                <Copy size={12} className={copied === 'seed' ? 'text-[var(--color-accent,#ccff00)]' : 'text-[var(--color-text-muted,#6b7280)]'} />
              </button>
              <div className="font-mono text-sm text-[var(--color-accent,#ccff00)] leading-relaxed break-words select-all">
                {seedPhrase}
              </div>
            </div>

            <div className="space-y-3">
              <label className="flex items-start gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={seedConfirmed}
                  onChange={(e) => setSeedConfirmed(e.target.checked)}
                  className="mt-1 w-4 h-4 accent-[var(--color-accent,#ccff00)]"
                />
                <span className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)] leading-relaxed group-hover:text-[var(--color-text,#0a0a0a)]">
                  I have saved my seed phrase in a secure location.
                </span>
              </label>

              <button
                onClick={() => {
                  setSeedPhrase(null);
                  fetchState();
                }}
                disabled={!seedConfirmed}
                className="w-full h-14 bg-[var(--color-text,#0a0a0a)] text-white relative overflow-hidden disabled:opacity-30 disabled:cursor-not-allowed group"
              >
                <span className="relative z-10 font-mono font-bold text-xs uppercase tracking-[0.15em] group-hover:text-[var(--color-accent,#ccff00)] transition-colors">
                  CONTINUE
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Derived state for other components
  const coldWallets = state?.wallets.filter(w => w.tier === 'cold') || [];
  const isLocked = state?.configured && !state?.isUnlocked;
  const isConfigured = state?.configured ?? false;

  // MAIN LAYOUT - Sidebar + Tab Content
  return (
    <div className="h-screen flex bg-[var(--color-background,#f5f5f5)] overflow-hidden">
      {/* Experimental Wallet Left Rail */}
      {experimentalWallet && (
        <LeftRail
          views={socialEnabled ? [...DEFAULT_VIEWS, SOCIAL_VIEW] : DEFAULT_VIEWS}
          activeViewId={activeViewId}
          onSelectView={setActiveViewId}
          onCreateView={() => setCreateViewOpen(true)}
        />
      )}
      {experimentalWallet && (
        <CreateViewModal
          open={createViewOpen}
          onClose={() => setCreateViewOpen(false)}
          onSelect={(view: ViewDefinition) => setActiveViewId(view.id)}
        />
      )}
      {/* Background Pattern with AURA/MAXXING */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--color-border-muted,#e5e5e5)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-border-muted,#e5e5e5)_1px,transparent_1px)] bg-[size:4rem_4rem] opacity-30" />
        <div className="absolute inset-0 tyvek-texture opacity-40 mix-blend-multiply" />
        <div className="absolute top-[5%] left-[30%] opacity-[0.03] select-none">
          <div className="text-[15vw] font-black leading-none text-[var(--color-text,#0a0a0a)] font-mono tracking-tighter">AURA</div>
        </div>
        <div className="absolute bottom-[5%] right-[5%] opacity-[0.03] select-none">
          <div className="text-[12vw] font-black leading-none text-[var(--color-text,#0a0a0a)] font-mono tracking-tighter text-right">MAXXING</div>
        </div>
        {/* Lab Markings */}
        <div className="absolute top-10 left-[290px] w-24 h-24 border-l-4 border-t-4 border-[var(--color-text,#0a0a0a)] opacity-10">
          <div className="absolute top-2 left-2 w-3 h-3 bg-[var(--color-text,#0a0a0a)]" />
        </div>
        <div className="absolute bottom-10 right-10 w-24 h-24 border-r-4 border-b-4 border-[var(--color-text,#0a0a0a)] opacity-10 flex items-end justify-end">
          <div className="absolute bottom-2 right-2 w-3 h-3 bg-[var(--color-text,#0a0a0a)]" />
        </div>
      </div>

      {/* Wallet Sidebar - Self-contained component */}
      <WalletSidebar
        onSend={() => handleOpenApp('send', { x: 360, y: 20 })}
        onReceive={() => setActiveDrawer('receive')}
        onLogs={handleOpenLogs}
        onAgentKeys={() => handleOpenApp('agentKeys', { x: 360, y: 20 })}
        onAppStore={() => setShowAppStore(true)}
        onWalletClick={handleWalletClick}
        onImportSeed={() => setShowImportSeedModal(true)}
        onSettings={() => { setActiveDrawer(activeDrawer === 'settings' ? null : 'settings'); setConfirmNuke(false); }}
        pendingActionCount={notifications.filter((n) => n.status === 'pending' && n.type !== 'notify').length}
        onStateChange={(newState) => {
          setState(prev => prev ? {
            ...prev,
            configured: newState.configured,
            isUnlocked: newState.unlocked,
            wallets: newState.wallets,
          } : {
            configured: newState.configured,
            isUnlocked: newState.unlocked,
            wallets: newState.wallets,
          });
        }}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative z-10">
        {/* Error Toast */}
        {error && (
          <div
            data-testid="app-error-toast"
            className="absolute top-2 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3 py-2 border shadow-lg"
            style={{
              background: 'color-mix(in srgb, var(--color-warning,#ff4d00) 8%, var(--color-surface,#ffffff))',
              borderColor: 'color-mix(in srgb, var(--color-warning,#ff4d00) 40%, transparent)',
            }}
          >
            <span className="font-mono text-[10px] text-[var(--color-warning,#ff4d00)]">{error}</span>
            <button onClick={() => setError('')} className="text-[var(--color-warning,#ff4d00)] hover:opacity-70">
              <X size={10} />
            </button>
          </div>
        )}

        {isLocked || !isConfigured ? (
          /* Locked/unconfigured state - no workspace, no tabs, no apps */
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <Lock size={32} className="mx-auto mb-3 text-[var(--color-text-faint,#9ca3af)]" />
              <div className="font-mono text-sm text-[var(--color-text-muted,#6b7280)]">
                {!isConfigured ? 'WALLET NOT CONFIGURED' : 'AGENT LOCKED'}
              </div>
              <div className="font-mono text-[10px] text-[var(--color-text-faint,#9ca3af)] mt-1">
                {!isConfigured ? 'Set up your wallet using the sidebar' : 'Unlock workspace access in the sidebar. Unlock each agent row separately.'}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Tab Bar - only shown when unlocked */}
            <TabBar
              tabs={tabs}
              activeTab={activeWorkspaceId}
              onTabChange={handleTabChange}
              onTabClose={handleCloseTab}
              onNewTab={handleNewTab}
              onTabUpdate={handleTabUpdate}
              onTidy={tidyApps}
              onAppStore={() => setShowAppStore(true)}
              notifications={notifications}
              onDismissNotification={dismissNotification}
            />

            {/* Content Area - Freeform Canvas */}
            <div className="flex-1 relative overflow-y-auto overflow-x-hidden">
              {workspaceLoading ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center">
                    <Loader2 size={24} className="mx-auto mb-2 text-[var(--color-text-faint,#9ca3af)] animate-spin" />
                    <div className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">LOADING WORKSPACE...</div>
                  </div>
                </div>
              ) : (
                <div className="relative w-full h-full min-h-[800px]">
                  {/* Render apps from context */}
                  {workspaceApps.filter(w => w.isVisible).map((app) => (
                    <WorkspaceApp
                      key={app.id}
                      app={app}
                      onPositionChange={handleAppPositionChange}
                      onSizeChange={handleAppSizeChange}
                      onLockChange={handleAppLockChange}
                      onBringToFront={handleBringToFront}
                      onDismiss={handleDismissApp}
                    />
                  ))}

                  {/* Empty state */}
                  {workspaceApps.length === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="text-center">
                        <div className="font-mono text-sm text-[var(--color-text-muted,#6b7280)]">EMPTY WORKSPACE</div>
                        <div className="font-mono text-[10px] text-[var(--color-text-faint,#9ca3af)] mt-1">Apps can be added via WebSocket or sidebar</div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <HumanActionBar
              requests={requests}
              resolveAction={resolveAction}
              actionLoading={actionLoading}
            />
          </>
        )}
      </div>

      {/* Settings Drawer */}
      <Drawer
        isOpen={activeDrawer === 'settings'}
        onClose={() => setActiveDrawer(null)}
        title="SETTINGS"
        subtitle="System configuration"
        footerLabel=""
      >
        <SettingsContent
          chains={chains}
          editingChainRpc={editingChainRpc}
          setEditingChainRpc={setEditingChainRpc}
          customRpc={customRpc}
          setCustomRpc={setCustomRpc}
          savingConfig={savingConfig}
          handleSaveCustomRpc={handleSaveCustomRpc}
          handleRemoveChain={handleRemoveChain}
          exportedSeed={exportedSeed}
          setExportedSeed={setExportedSeed}
          exportPassword={exportPassword}
          setExportPassword={setExportPassword}
          exporting={exporting}
          handleExportSeed={handleExportSeed}
          copied={copied}
          setCopied={setCopied}
          confirmNuke={confirmNuke}
          nuking={nuking}
          handleNuke={handleNuke}
          backups={backups}
          backupsLoading={backupsLoading}
          creatingBackup={creatingBackup}
          restoringBackup={restoringBackup}
          onFetchBackups={fetchBackups}
          onCreateBackup={handleCreateBackup}
          onRestoreBackup={handleRestoreBackup}
          exportingDb={exportingDb}
          onExportDb={handleExportDb}
          showAddChainPopover={showAddChainModal}
          addChainAnchorEl={addChainAnchorEl}
          onOpenAddChain={(el) => { setAddChainAnchorEl(el); setShowAddChainModal(true); }}
          onCloseAddChain={() => { setShowAddChainModal(false); setAddChainAnchorEl(null); }}
          newChain={newChain}
          setNewChain={setNewChain}
          handleAddChain={handleAddChain}
          // Chain overrides props
          chainOverrides={chainOverrides}
          hasAlchemyKey={!!getApiKey('alchemy')}
          // Auth state
          isUnlocked={state?.isUnlocked ?? false}
          // API Keys props (from AuthContext)
          apiKeys={authApiKeys}
          apiKeysLoading={authApiKeysLoading}
          showAddApiKeyPopover={showAddApiKeyPopover}
          addApiKeyAnchorEl={addApiKeyAnchorEl}
          onOpenAddApiKey={(el) => { setAddApiKeyAnchorEl(el); setShowAddApiKeyPopover(true); }}
          onCloseAddApiKey={() => { setShowAddApiKeyPopover(false); setAddApiKeyAnchorEl(null); }}
          newApiKey={newApiKey}
          setNewApiKey={setNewApiKey}
          savingApiKey={savingApiKey}
          handleAddApiKey={handleAddApiKey}
          deletingApiKey={deletingApiKey}
          handleDeleteApiKey={handleDeleteApiKey}
          showRevokeAllApiKeysPopover={showRevokeAllApiKeysPopover}
          revokeAllApiKeysAnchorEl={revokeAllApiKeysAnchorEl}
          revokingAllApiKeys={revokingAllApiKeys}
          onOpenRevokeAllApiKeys={onOpenRevokeAllApiKeys}
          onCloseRevokeAllApiKeys={onCloseRevokeAllApiKeys}
          handleRevokeAllApiKeys={handleRevokeAllApiKeys}
          onAddAlchemyKey={handleAddAlchemyKey}
        />
      </Drawer>

      {/* Receive Drawer */}
      <Drawer
        isOpen={activeDrawer === 'receive'}
        onClose={() => setActiveDrawer(null)}
        title="RECEIVE"
        subtitle="Fund your wallets"
      >
        <ReceiveContent
          coldWallets={coldWallets}
          copyAddress={copyAddress}
          copied={copied}
        />
      </Drawer>

      {/* App Store Drawer - only accessible when unlocked */}
      <AppStoreDrawer
        isOpen={showAppStore && !isLocked && isConfigured}
        onClose={() => setShowAppStore(false)}
        onAddApp={handleAddAppFromStore}
      />

      {/* Import Seed Modal */}
      <Modal
        isOpen={showImportSeedModal}
        onClose={() => {
          setShowImportSeedModal(false);
          setImportSeedPhrase('');
          setImportPassword('');
          setImportConfirmPassword('');
        }}
        title="Import Seed Phrase"
        subtitle="Recovery"
        icon={<KeyRound size={20} className="text-[#0047ff]" />}
        size="md"
      >
        <form onSubmit={handleImportSeed} className="space-y-4">
          <div>
            <label className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] tracking-widest block mb-1">
              SEED_PHRASE
            </label>
            <textarea
              value={importSeedPhrase}
              onChange={(e) => setImportSeedPhrase(e.target.value)}
              placeholder="Enter your 12 or 24 word seed phrase..."
              rows={3}
              className="w-full px-3 py-2 border border-[var(--color-border,#d4d4d8)] font-mono text-xs focus:outline-none focus:border-[var(--color-border-focus,#0a0a0a)] bg-[var(--color-surface,#ffffff)] text-[var(--color-text,#0a0a0a)] resize-none"
            />
          </div>
          <div>
            <label className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] tracking-widest block mb-1">
              NEW_PASSWORD
            </label>
            <input
              type="password"
              value={importPassword}
              onChange={(e) => setImportPassword(e.target.value)}
              placeholder="Min 8 characters"
              className="w-full px-3 py-2 border border-[var(--color-border,#d4d4d8)] font-mono text-xs focus:outline-none focus:border-[var(--color-border-focus,#0a0a0a)] bg-[var(--color-surface,#ffffff)] text-[var(--color-text,#0a0a0a)]"
            />
          </div>
          <div>
            <label className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] tracking-widest block mb-1">
              CONFIRM_PASSWORD
            </label>
            <input
              type="password"
              value={importConfirmPassword}
              onChange={(e) => setImportConfirmPassword(e.target.value)}
              placeholder="Confirm password"
              className="w-full px-3 py-2 border border-[var(--color-border,#d4d4d8)] font-mono text-xs focus:outline-none focus:border-[var(--color-border-focus,#0a0a0a)] bg-[var(--color-surface,#ffffff)] text-[var(--color-text,#0a0a0a)]"
            />
          </div>
          <div className="p-3 bg-[var(--color-info,#0047ff)]/5 border border-[var(--color-info,#0047ff)]/30">
            <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] leading-relaxed">
              This will restore your wallet from the seed phrase. All hot wallets will be re-derived from this seed.
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setShowImportSeedModal(false);
                setImportSeedPhrase('');
                setImportPassword('');
                setImportConfirmPassword('');
              }}
              className="flex-1 h-10 border border-[var(--color-border,#d4d4d8)] font-mono text-[10px] tracking-widest text-[var(--color-text-muted,#6b7280)] hover:border-[var(--color-border-focus,#0a0a0a)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
            >
              CANCEL
            </button>
            <button
              type="submit"
              disabled={importing || !importSeedPhrase || !importPassword || !importConfirmPassword}
              className="flex-1 h-10 bg-[var(--color-text,#0a0a0a)] text-white font-mono text-[10px] tracking-widest flex items-center justify-center gap-2 disabled:opacity-50 hover:text-[var(--color-accent,#ccff00)] transition-colors"
            >
              {importing ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
              {importing ? 'IMPORTING...' : 'IMPORT'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Passkey Enrollment Prompt - shown after unlock if passkeys not yet registered */}
      <PasskeyEnrollmentPrompt isUnlocked={state?.isUnlocked ?? false} />
    </div>
  );
}

// WorkspaceApp - Renders a app from the workspace context
// All apps are self-contained and only receive config
interface WorkspaceAppProps {
  app: WorkspaceAppState;
  onPositionChange: (id: string, pos: { x: number; y: number }) => void;
  onSizeChange: (id: string, size: { width: number; height: number }) => void;
  onLockChange: (id: string, locked: boolean) => void;
  onBringToFront: (id: string) => void;
  onDismiss: (id: string) => void;
}

function WorkspaceApp({
  app,
  onPositionChange,
  onSizeChange,
  onLockChange,
  onBringToFront,
  onDismiss,
}: WorkspaceAppProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const isThirdParty = app.appType.startsWith('installed:');
  const definition = getAppDefinition(app.appType);

  if (!definition) {
    return (
      <DraggableApp
        id={app.id}
        title={`UNKNOWN: ${app.appType}`}
        icon={Code}
        color="gray"
        initialPosition={{ x: app.x, y: app.y }}
        initialSize={{ width: app.width, height: app.height }}
        locked={app.isLocked}
        onLockChange={onLockChange}
        dismissable
        onDismiss={() => onDismiss(app.id)}
        onPositionChange={onPositionChange}
        onSizeChange={onSizeChange}
        onBringToFront={onBringToFront}
        zIndex={app.zIndex}
      >
        <div className="py-4 text-center">
          <Code size={20} className="mx-auto mb-2 text-[var(--color-text-faint,#9ca3af)]" />
          <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">UNKNOWN APP TYPE</div>
          <div className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] mt-1">{app.appType}</div>
        </div>
      </DraggableApp>
    );
  }

  const AppComponent = definition.component;

  // All apps are self-contained - just pass config
  const renderContent = () => {
    const config = isThirdParty
      ? {
          appPath: app.appType.slice(10), // installed:agent-chat -> agent-chat
          ...app.config, // Explicit config (if present) wins
          _refreshKey: refreshKey,
        }
      : app.config;
    return (
      <Suspense fallback={<AppLoading />}>
        <AppComponent config={config} />
      </Suspense>
    );
  };

  // Get title for wallet detail apps (use config passed when app was opened)
  const getTitle = () => {
    if (app.appType === 'walletDetail') {
      const emoji = app.config?.walletEmoji as string | undefined;
      const name = app.config?.walletName as string | undefined;
      if (emoji || name) {
        return emoji ? `${emoji} ${name || 'WALLET'}` : (name || 'WALLET');
      }
    }
    return definition.title;
  };

  // Get color for wallet detail apps (use config passed when app was opened)
  const getColor = (): AppColor => {
    if (app.appType === 'walletDetail') {
      const color = app.config?.walletColor as string | undefined;
      if (color) {
        const colorMap: Record<string, AppColor> = {
          '#ff4d00': 'orange',
          '#0047ff': 'blue',
          '#00c853': 'teal',
          '#ffab00': 'orange',
          '#9c27b0': 'purple',
          '#00bcd4': 'teal',
          '#e91e63': 'rose',
          '#607d8b': 'gray',
        };
        return colorMap[color] || 'orange';
      }
    }
    return definition.color;
  };

  // Get subtitle for iframe apps (show URL hostname)
  const getSubtitle = () => {
    if (app.appType === 'iframe' && app.config?.url) {
      try {
        const url = new URL(app.config.url as string);
        return url.hostname;
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const getSubtitleLink = () => {
    if (app.appType === 'iframe' && app.config?.url) {
      return app.config.url as string;
    }
    return undefined;
  };

  return (
    <DraggableApp
      id={app.id}
      title={getTitle()}
      subtitle={getSubtitle()}
      subtitleLink={getSubtitleLink()}
      icon={definition.icon}
      color={getColor()}
      initialPosition={{ x: app.x, y: app.y }}
      initialSize={{ width: app.width, height: app.height }}
      locked={app.isLocked}
      onLockChange={onLockChange}
      onRefresh={isThirdParty ? () => setRefreshKey(k => k + 1) : undefined}
      dismissable
      onDismiss={() => onDismiss(app.id)}
      onPositionChange={onPositionChange}
      onSizeChange={onSizeChange}
      onBringToFront={onBringToFront}
      zIndex={app.zIndex}
    >
      {renderContent()}
    </DraggableApp>
  );
}

function AppLoading() {
  return (
    <div className="py-6 text-center">
      <Loader2 size={20} className="mx-auto mb-2 text-[var(--color-text-faint,#9ca3af)] animate-spin" />
      <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">LOADING...</div>
    </div>
  );
}

interface BackupInfo {
  filename: string;
  timestamp: string;
  size: number;
  date: string;
}

function SettingsContent({
  chains,
  editingChainRpc,
  setEditingChainRpc,
  customRpc,
  setCustomRpc,
  savingConfig,
  handleSaveCustomRpc,
  handleRemoveChain,
  exportedSeed,
  setExportedSeed,
  exportPassword,
  setExportPassword,
  exporting,
  handleExportSeed,
  copied,
  setCopied,
  confirmNuke,
  nuking,
  handleNuke,
  backups,
  backupsLoading,
  creatingBackup,
  restoringBackup,
  onFetchBackups,
  onCreateBackup,
  onRestoreBackup,
  exportingDb,
  onExportDb,
  showAddChainPopover,
  addChainAnchorEl,
  onOpenAddChain,
  onCloseAddChain,
  newChain,
  setNewChain,
  handleAddChain,
  // Chain overrides props
  chainOverrides,
  hasAlchemyKey,
  // Auth state
  isUnlocked,
  // API Keys props
  apiKeys,
  apiKeysLoading,
  showAddApiKeyPopover,
  addApiKeyAnchorEl,
  onOpenAddApiKey,
  onCloseAddApiKey,
  newApiKey,
  setNewApiKey,
  savingApiKey,
  handleAddApiKey,
  deletingApiKey,
  handleDeleteApiKey,
  showRevokeAllApiKeysPopover,
  revokeAllApiKeysAnchorEl,
  revokingAllApiKeys,
  onOpenRevokeAllApiKeys,
  onCloseRevokeAllApiKeys,
  handleRevokeAllApiKeys,
  onAddAlchemyKey,
}: {
  chains: Record<string, { rpc: string; chainId: number; explorer: string; nativeCurrency: string }>;
  editingChainRpc: string | null;
  setEditingChainRpc: (c: string | null) => void;
  customRpc: string;
  setCustomRpc: (r: string) => void;
  savingConfig: boolean;
  handleSaveCustomRpc: (chain: string, rpc: string) => void;
  handleRemoveChain: (chain: string) => void;
  exportedSeed: string | null;
  setExportedSeed: (s: string | null) => void;
  exportPassword: string;
  setExportPassword: (p: string) => void;
  exporting: boolean;
  handleExportSeed: (e: React.FormEvent) => void;
  copied: string | null;
  setCopied: (c: string | null) => void;
  confirmNuke: boolean;
  nuking: boolean;
  handleNuke: () => void;
  backups: BackupInfo[];
  backupsLoading: boolean;
  creatingBackup: boolean;
  restoringBackup: string | null;
  onFetchBackups: () => void;
  onCreateBackup: () => void;
  onRestoreBackup: (filename: string) => void;
  exportingDb: boolean;
  onExportDb: () => void;
  showAddChainPopover: boolean;
  addChainAnchorEl: HTMLElement | null;
  onOpenAddChain: (el: HTMLElement) => void;
  onCloseAddChain: () => void;
  newChain: { name: string; chainId: string; rpc: string; explorer: string; nativeCurrency: string };
  setNewChain: (c: { name: string; chainId: string; rpc: string; explorer: string; nativeCurrency: string }) => void;
  // Chain overrides types
  chainOverrides: Record<string, ChainConfig>;
  hasAlchemyKey: boolean;
  // Auth state
  isUnlocked: boolean;
  // API Keys types
  apiKeys: ApiKey[];
  apiKeysLoading: boolean;
  showAddApiKeyPopover: boolean;
  addApiKeyAnchorEl: HTMLElement | null;
  onOpenAddApiKey: (el: HTMLElement) => void;
  onCloseAddApiKey: () => void;
  newApiKey: { service: string; name: string; key: string };
  setNewApiKey: (k: { service: string; name: string; key: string }) => void;
  savingApiKey: boolean;
  handleAddApiKey: () => void;
  deletingApiKey: string | null;
  handleDeleteApiKey: (id: string) => void;
  showRevokeAllApiKeysPopover: boolean;
  revokeAllApiKeysAnchorEl: HTMLElement | null;
  revokingAllApiKeys: boolean;
  onOpenRevokeAllApiKeys: (el: HTMLElement) => void;
  onCloseRevokeAllApiKeys: () => void;
  handleRevokeAllApiKeys: () => void;
  handleAddChain: () => void;
  onAddAlchemyKey: (key: string) => Promise<boolean>;
}) {
  const [restoreConfirmOpen, setRestoreConfirmOpen] = React.useState<string | null>(null);
  const [restoreAnchorEl, setRestoreAnchorEl] = React.useState<HTMLElement | null>(null);
  const [alchemyKeyInput, setAlchemyKeyInput] = React.useState('');
  const [addingAlchemyKey, setAddingAlchemyKey] = React.useState(false);

  // Fetch backups when component mounts (only if unlocked)
  React.useEffect(() => {
    if (isUnlocked) {
      onFetchBackups();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUnlocked]);

  // Handle adding Alchemy API key
  const handleAlchemyKeySubmit = async () => {
    if (!alchemyKeyInput.trim()) return;
    setAddingAlchemyKey(true);
    const success = await onAddAlchemyKey(alchemyKeyInput.trim());
    if (success) {
      setAlchemyKeyInput('');
    }
    setAddingAlchemyKey(false);
  };

  const formatBackupDate = (timestamp: string) => {
    // timestamp format: YYYYMMDD_HHMMSS
    const year = timestamp.slice(0, 4);
    const month = timestamp.slice(4, 6);
    const day = timestamp.slice(6, 8);
    const hour = timestamp.slice(9, 11);
    const minute = timestamp.slice(11, 13);
    return `${year}-${month}-${day} ${hour}:${minute}`;
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };
  // Alchemy-supported chains
  const alchemyChains = ['base', 'ethereum', 'arbitrum', 'optimism'];

  // Get the RPC source for a chain (override, alchemy, or public)
  const getRpcSource = (chainName: string): 'override' | 'alchemy' | 'public' => {
    if (chainOverrides[chainName]) return 'override';
    if (hasAlchemyKey && alchemyChains.includes(chainName)) return 'alchemy';
    return 'public';
  };

  const [agentSectionOpen, setAgentSectionOpen] = React.useState(false);
  const [agentTier, setAgentTier] = React.useState<string>('admin');
  const [agentTierLoading, setAgentTierLoading] = React.useState(true);
  const [agentTierSaving, setAgentTierSaving] = React.useState(false);

  // Fetch agent tier on mount
  React.useEffect(() => {
    (async () => {
      try {
        const grouped = await api.get<Record<string, Array<{ key: string; value: unknown }>>>(Api.Wallet, '/defaults');
        const permsGroup = grouped.permissions || [];
        const tierRow = permsGroup.find((r: { key: string }) => r.key === 'permissions.agent_tier');
        if (tierRow) setAgentTier(tierRow.value as string);
      } catch { /* use default */ }
      finally { setAgentTierLoading(false); }
    })();
  }, []);

  const handleTierChange = async (tier: string) => {
    setAgentTier(tier);
    setAgentTierSaving(true);
    try {
      await api.patch(Api.Wallet, `/defaults/${encodeURIComponent('permissions.agent_tier')}`, { value: tier });
    } catch { /* revert on error */ setAgentTier(tier === 'admin' ? 'restricted' : 'admin'); }
    finally { setAgentTierSaving(false); }
  };

  const [systemDefaultsOpen, setSystemDefaultsOpen] = React.useState(false);
  const [rpcOpen, setRpcOpen] = React.useState(false);
  const [apiKeysOpen, setApiKeysOpen] = React.useState(false);
  const [exportSeedOpen, setExportSeedOpen] = React.useState(false);
  const [backupOpen, setBackupOpen] = React.useState(false);
  const [dangerOpen, setDangerOpen] = React.useState(false);

  return (
    <div className="space-y-4">
      {/* DEFAULT_AGENT — permission tier + AI model */}
      <TyvekCollapsibleSection
        title="DEFAULT_AGENT"
        icon={<Bot size={12} />}
        isOpen={agentSectionOpen}
        onToggle={() => setAgentSectionOpen(!agentSectionOpen)}
        contentClassName="p-4 pt-0 space-y-4"
      >
        {/* Permission Tier Toggle */}
        <div className="p-3 space-y-2 border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="font-mono text-[10px] text-[var(--color-text)]">Permission Tier</div>
          <div className="font-mono text-[8px] text-[var(--color-text-muted)]">
            Controls what the agent-chat app can do directly
          </div>
          {agentTierLoading ? (
            <div className="flex items-center gap-2 py-2">
              <Loader2 size={12} className="animate-spin text-[var(--color-text-muted)]" />
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => handleTierChange('admin')}
                disabled={agentTierSaving}
                variant={agentTier === 'admin' ? 'secondary' : 'ghost'}
                size="md"
                className={`flex-1 !h-auto !p-2 !justify-start border ${
                  agentTier === 'admin'
                    ? 'border-[var(--color-accent)] text-[var(--color-text)] bg-[var(--color-background-alt)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
                }`}
              >
                <div className="text-left">
                  <div className="font-bold text-[9px] tracking-normal">Full Admin</div>
                  <div className="text-[8px] tracking-normal text-[var(--color-text-muted)]">Agent can do everything directly</div>
                </div>
              </Button>
              <Button
                type="button"
                onClick={() => handleTierChange('restricted')}
                disabled={agentTierSaving}
                variant={agentTier === 'restricted' ? 'secondary' : 'ghost'}
                size="md"
                className={`flex-1 !h-auto !p-2 !justify-start border ${
                  agentTier === 'restricted'
                    ? 'border-[var(--color-accent)] text-[var(--color-text)] bg-[var(--color-background-alt)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
                }`}
              >
                <div className="text-left">
                  <div className="font-bold text-[9px] tracking-normal">Restricted</div>
                  <div className="text-[8px] tracking-normal text-[var(--color-text-muted)]">Approval required for actions</div>
                </div>
              </Button>
            </div>
          )}
        </div>

        {/* AI Model Selection (moved from SystemDefaults) */}
        <AiEngineSection />
      </TyvekCollapsibleSection>

      {/* System Defaults (limits, permissions, AI engine) — collapsible */}
      <TyvekCollapsibleSection
        title="SYSTEM_DEFAULTS"
        icon={<Settings size={12} />}
        isOpen={systemDefaultsOpen}
        onToggle={() => setSystemDefaultsOpen(!systemDefaultsOpen)}
      >
        <SystemDefaults />
      </TyvekCollapsibleSection>

      {/* RPC Configuration */}
      <TyvekCollapsibleSection
        title="RPC_CONFIGURATION"
        icon={<Code size={12} />}
        isOpen={rpcOpen}
        onToggle={() => setRpcOpen(!rpcOpen)}
        contentClassName="p-4 pt-0"
      >
        <div className="p-3 bg-[var(--color-background-alt)] border border-[var(--color-border)] space-y-4">
          {/* Quick Setup - Alchemy API Key */}
          <div className="p-3 border border-dashed border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="font-mono text-[9px] text-[var(--color-text-muted)] uppercase tracking-widest mb-2">ALCHEMY API KEY</div>
            {hasAlchemyKey ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Check size={12} className="text-[var(--color-success)]" />
                  <span className="font-mono text-[10px] text-[var(--color-success)]">Configured</span>
                  <span className="font-mono text-[8px] text-[var(--color-text-muted)]">
                    (auto-configures: {alchemyChains.join(', ')})
                  </span>
                </div>
                <div className="font-mono text-[8px] text-[var(--color-text-faint)] leading-relaxed">
                  Remove in API Keys section below. Custom overrides take priority.
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="font-mono text-[8px] text-[var(--color-text-muted)] leading-relaxed mb-2">
                  Get a free key at alchemy.com to auto-configure: {alchemyChains.join(', ')}
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <TextInput
                      label=""
                      type="password"
                      value={alchemyKeyInput}
                      onChange={(e) => setAlchemyKeyInput(e.target.value)}
                      placeholder="Paste your Alchemy API key..."
                      compact
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={handleAlchemyKeySubmit}
                    disabled={addingAlchemyKey || !alchemyKeyInput.trim()}
                    loading={addingAlchemyKey}
                    icon={!addingAlchemyKey ? <Plus size={10} /> : undefined}
                  >
                    ADD
                  </Button>
                </div>
                <div className="font-mono text-[8px] text-[var(--color-text-faint)] leading-relaxed">
                  Currently using public RPCs (may have rate limits).
                </div>
              </div>
            )}
          </div>

          {/* Chain Overrides */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="font-mono text-[9px] text-[var(--color-text-muted)] uppercase tracking-widest">CHAIN OVERRIDES</div>
              <div className="relative">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => onOpenAddChain(e.currentTarget)}
                  icon={<Plus size={10} />}
                >
                  ADD
                </Button>
                <Popover
                  isOpen={showAddChainPopover}
                  onClose={onCloseAddChain}
                  title="ADD_CHAIN"
                  anchorEl={addChainAnchorEl}
                  anchor="right"
                  className="w-64"
                >
                  <div className="space-y-3">
                    <div className="font-mono text-[8px] text-[var(--color-text-muted)] leading-relaxed">
                      Known chains: arbitrum, optimism, polygon, zksync
                    </div>
                    <TextInput
                      label="NAME"
                      type="text"
                      value={newChain.name}
                      onChange={(e) => setNewChain({ ...newChain, name: e.target.value })}
                      placeholder="arbitrum, polygon, zksync..."
                      compact
                    />
                    <TextInput
                      label="CHAIN_ID"
                      type="number"
                      value={newChain.chainId}
                      onChange={(e) => setNewChain({ ...newChain, chainId: e.target.value })}
                      placeholder="42161, 10, 137..."
                      compact
                    />
                    <TextInput
                      label="RPC (optional)"
                      type="text"
                      value={newChain.rpc}
                      onChange={(e) => setNewChain({ ...newChain, rpc: e.target.value })}
                      placeholder="blank = use Alchemy"
                      compact
                    />
                    <Button
                      size="md"
                      onClick={() => { handleAddChain(); onCloseAddChain(); }}
                      disabled={savingConfig || !newChain.name || !newChain.chainId}
                      loading={savingConfig}
                      icon={!savingConfig ? <Plus size={10} /> : undefined}
                      className="w-full"
                    >
                      ADD CHAIN
                    </Button>
                  </div>
                </Popover>
              </div>
            </div>
            <div className="space-y-2">
              {Object.entries(chains).map(([chainName, chainConfig]) => {
                const source = getRpcSource(chainName);
                // Can remove any chain except defaults (base, ethereum)
                const canRemove = !['base', 'ethereum'].includes(chainName);
                return (
                  <div key={chainName} className="flex items-center gap-2 p-2 bg-[var(--color-surface)] border border-[var(--color-border)]">
                    <div className="w-20 font-mono text-[10px] font-bold text-[var(--color-text)] uppercase flex items-center gap-1">
                      {chainName}
                      <span className={`font-mono text-[7px] px-1 py-0.5 rounded ${
                        source === 'override' ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]' :
                        source === 'alchemy' ? 'bg-[var(--color-success)]/20 text-[var(--color-success)]' :
                        'bg-[var(--color-text-muted)]/20 text-[var(--color-text-muted)]'
                      }`}>
                        {source === 'override' ? 'CUSTOM' : source === 'alchemy' ? 'ALCHEMY' : 'PUBLIC'}
                      </span>
                    </div>
                    {editingChainRpc === chainName ? (
                      <div className="flex-1">
                        <TextInput
                          label=""
                          type="text"
                          value={customRpc}
                          onChange={(e) => setCustomRpc(e.target.value)}
                          placeholder="https://..."
                          compact
                          autoFocus
                          rightElement={
                            <div className="flex gap-1">
                              <Button variant="ghost" size="sm" onClick={() => handleSaveCustomRpc(chainName, customRpc)} icon={<Check size={12} className="text-[var(--color-success)]" />}>
                                {''}
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => { setEditingChainRpc(null); setCustomRpc(''); }} icon={<X size={12} />}>
                                {''}
                              </Button>
                            </div>
                          }
                        />
                      </div>
                    ) : (
                      <>
                        <div className="flex-1" />
                        <Button variant="secondary" size="sm" onClick={() => { setEditingChainRpc(chainName); setCustomRpc(chainConfig.rpc); }}>
                          EDIT RPC
                        </Button>
                        {canRemove && (
                          <Button variant="ghost" size="sm" onClick={() => handleRemoveChain(chainName)} icon={<Trash2 size={10} />} className="hover:text-[var(--color-warning)]">
                            {''}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </TyvekCollapsibleSection>

      {/* API Keys */}
      <TyvekCollapsibleSection
        title="API_KEYS"
        icon={<KeyRound size={12} />}
        isOpen={apiKeysOpen}
        onToggle={() => setApiKeysOpen(!apiKeysOpen)}
        contentClassName="p-4 pt-0"
      >
        <div className="p-3 bg-[var(--color-background-alt)] border border-[var(--color-border)] space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-mono text-[9px] text-[var(--color-text-muted)]">
                  Store API keys for premium services (Alchemy, Infura, etc.)
                </div>
                <div className="flex items-center gap-1">
                  {apiKeys.length > 0 && (
                    <div className="relative">
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={(e) => onOpenRevokeAllApiKeys(e.currentTarget)}
                        disabled={revokingAllApiKeys}
                        icon={revokingAllApiKeys ? <Loader2 size={10} className="animate-spin" /> : <AlertTriangle size={10} />}
                      >
                        REVOKE ALL
                      </Button>
                      <ConfirmationModal
                        isOpen={showRevokeAllApiKeysPopover}
                        onClose={onCloseRevokeAllApiKeys}
                        onConfirm={handleRevokeAllApiKeys}
                        title="Revoke All API Keys"
                        message="Revoking all API keys can lock the agent by disabling services that depend on them. This action revokes every active API key immediately."
                        confirmText="REVOKE ALL"
                        variant="danger"
                        loading={revokingAllApiKeys}
                      />
                    </div>
                  )}
                  <div className="relative">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => onOpenAddApiKey(e.currentTarget)}
                      icon={<Plus size={10} />}
                    >
                      ADD
                    </Button>
                    <Popover
                      isOpen={showAddApiKeyPopover}
                      onClose={onCloseAddApiKey}
                      title="ADD_API_KEY"
                      anchorEl={addApiKeyAnchorEl}
                      anchor="right"
                      className="w-72"
                    >
                      <div className="space-y-3">
                        <TextInput
                          label="SERVICE"
                          type="text"
                          value={newApiKey.service}
                          onChange={(e) => setNewApiKey({ ...newApiKey, service: e.target.value })}
                          placeholder="alchemy, infura, etherscan..."
                          compact
                        />
                        <TextInput
                          label="NAME"
                          type="text"
                          value={newApiKey.name}
                          onChange={(e) => setNewApiKey({ ...newApiKey, name: e.target.value })}
                          placeholder="My API Key"
                          compact
                        />
                        <TextInput
                          label="API_KEY"
                          type="password"
                          value={newApiKey.key}
                          onChange={(e) => setNewApiKey({ ...newApiKey, key: e.target.value })}
                          placeholder="Enter your API key..."
                          compact
                        />
                        <Button
                          size="md"
                          onClick={handleAddApiKey}
                          disabled={savingApiKey || !newApiKey.service || !newApiKey.name || !newApiKey.key}
                          loading={savingApiKey}
                          icon={!savingApiKey ? <Plus size={10} /> : undefined}
                          className="w-full"
                        >
                          ADD KEY
                        </Button>
                      </div>
                    </Popover>
                  </div>
                </div>
              </div>

              {apiKeysLoading ? (
                <div className="py-4 flex items-center justify-center">
                  <Loader2 size={16} className="animate-spin text-[var(--color-text-muted)]" />
                </div>
              ) : apiKeys.length === 0 ? (
                <div className="py-4 text-center border border-dashed border-[var(--color-border)]">
                  <div className="font-mono text-[9px] text-[var(--color-text-muted)]">No API keys stored</div>
                  <div className="font-mono text-[8px] text-[var(--color-text-faint)] mt-1">Add keys for Alchemy, Infura, etc.</div>
                </div>
              ) : (
                <div className="space-y-2">
                  {apiKeys.map((apiKey) => (
                    <div key={apiKey.id} className="flex items-center gap-2 p-2 bg-[var(--color-surface)] border border-[var(--color-border)]">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] font-bold text-[var(--color-text)] uppercase">{apiKey.service}</span>
                          <span className="font-mono text-[9px] text-[var(--color-text-muted)]">{apiKey.name}</span>
                        </div>
                        <div className="font-mono text-[8px] text-[var(--color-text-faint)] truncate">
                          {apiKey.keyMasked || apiKey.key}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteApiKey(apiKey.id)}
                        disabled={deletingApiKey === apiKey.id}
                        icon={deletingApiKey === apiKey.id ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                        className="hover:text-[var(--color-warning)]"
                      >
                        {''}
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="pt-2 border-t border-dashed border-[var(--color-border)]">
                <div className="font-mono text-[8px] text-[var(--color-text-faint)] leading-relaxed">
                  Alchemy keys will automatically configure RPCs for supported chains.
                </div>
              </div>
            </div>
      </TyvekCollapsibleSection>

      {/* Export Seed */}
      <TyvekCollapsibleSection
        title="EXPORT_SEED"
        icon={<Shield size={12} />}
        isOpen={exportSeedOpen}
        onToggle={() => setExportSeedOpen(!exportSeedOpen)}
        contentClassName="p-4 pt-0"
      >
        {exportedSeed ? (
          <div className="space-y-3">
            <div className="p-3 bg-[var(--color-text)] border border-[var(--color-border-focus)] relative">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { navigator.clipboard.writeText(exportedSeed); setCopied('exported'); setTimeout(() => setCopied(null), 2000); }}
                className="absolute top-2 right-2 bg-[var(--color-text-muted)]/20 hover:bg-[var(--color-text-muted)]/40"
                icon={<Copy size={10} className={copied === 'exported' ? 'text-[var(--color-accent)]' : 'text-[var(--color-surface)]'} />}
              >
                {''}
              </Button>
              <div className="font-mono text-xs text-[var(--color-accent)] leading-relaxed break-words select-all pr-8">{exportedSeed}</div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setExportedSeed(null)}>
              HIDE
            </Button>
          </div>
        ) : (
          <form onSubmit={handleExportSeed}>
            <TextInput
              label="PASSWORD"
              type="password"
              value={exportPassword}
              onChange={(e) => setExportPassword(e.target.value)}
              placeholder="Enter password to export..."
              compact
              rightElement={
                <Button type="submit" size="sm" disabled={exporting || !exportPassword} loading={exporting}>
                  EXPORT
                </Button>
              }
            />
          </form>
        )}
      </TyvekCollapsibleSection>

      {/* Database Backup */}
      <TyvekCollapsibleSection
        title="DATABASE_BACKUP"
        icon={<Database size={12} />}
        isOpen={backupOpen}
        onToggle={() => setBackupOpen(!backupOpen)}
        contentClassName="p-4 pt-0"
      >
        <div className="space-y-3">
          <Button
            variant="secondary"
            size="lg"
            onClick={onCreateBackup}
            disabled={creatingBackup}
            loading={creatingBackup}
            icon={!creatingBackup ? <Plus size={12} /> : undefined}
            className="w-full"
          >
            {creatingBackup ? 'CREATING...' : 'CREATE BACKUP'}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            onClick={onExportDb}
            disabled={exportingDb}
            loading={exportingDb}
            icon={!exportingDb ? <Database size={12} /> : undefined}
            className="w-full"
          >
            {exportingDb ? 'EXPORTING...' : 'EXPORT DATABASE'}
          </Button>

          {backupsLoading ? (
            <div className="py-4 flex items-center justify-center">
              <Loader2 size={16} className="animate-spin text-[var(--color-text-muted)]" />
            </div>
          ) : backups.length === 0 ? (
            <div className="py-4 text-center">
              <div className="font-mono text-[9px] text-[var(--color-text-muted)]">No backups found</div>
            </div>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {backups.map((backup) => (
                <div key={backup.filename} className="relative">
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    onClick={(e) => {
                      setRestoreAnchorEl(e.currentTarget);
                      setRestoreConfirmOpen(backup.filename);
                    }}
                    className="w-full !h-auto !px-2 !py-2 !justify-between group"
                  >
                    <div className="flex items-center gap-2">
                      <RotateCcw size={10} className="text-[var(--color-text-muted)] group-hover:text-[var(--color-text)]" />
                      <span className="font-mono text-[10px] text-[var(--color-text)]">
                        {formatBackupDate(backup.timestamp)}
                      </span>
                    </div>
                    <span className="font-mono text-[9px] text-[var(--color-text-muted)]">
                      {formatSize(backup.size)}
                    </span>
                  </Button>
                  <ConfirmationModal
                    isOpen={restoreConfirmOpen === backup.filename}
                    onClose={() => {
                      setRestoreConfirmOpen(null);
                      setRestoreAnchorEl(null);
                    }}
                    onConfirm={() => {
                      onRestoreBackup(backup.filename);
                      setRestoreConfirmOpen(null);
                      setRestoreAnchorEl(null);
                    }}
                    title="Restore Backup"
                    message="Restore to this backup? You will lose all data since this backup was created."
                    confirmText="RESTORE"
                    variant="warning"
                    loading={restoringBackup === backup.filename}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="pt-2 border-t border-dashed border-[var(--color-border)]">
            <div className="font-mono text-[8px] text-[var(--color-text-faint)] leading-relaxed">
              Backups are tied to the current database schema. Restoring after migrations may cause issues.
            </div>
          </div>
        </div>
      </TyvekCollapsibleSection>

      {/* Danger Zone */}
      <TyvekCollapsibleSection
        title="DANGER_ZONE"
        icon={<AlertTriangle size={12} />}
        isOpen={dangerOpen}
        onToggle={() => setDangerOpen(!dangerOpen)}
        tone="warning"
        contentClassName="p-4 pt-0"
      >
        <div className="p-3 border-2 border-[var(--color-warning)] bg-[color-mix(in_srgb,var(--color-warning)_5%,transparent)]">
          <div className="font-mono text-[10px] text-[var(--color-text-muted)] mb-3">Delete ALL data. Irreversible.</div>
          <Button
            variant={confirmNuke ? 'primary' : 'danger'}
            size="lg"
            onClick={handleNuke}
            disabled={nuking}
            loading={nuking}
            icon={!nuking ? <Trash2 size={12} /> : undefined}
            className={`w-full ${confirmNuke ? '!bg-[var(--color-warning)] !border-[var(--color-warning)] hover:!bg-[var(--color-warning)]' : ''}`}
          >
            {nuking ? 'NUKING...' : confirmNuke ? 'CONFIRM' : 'NUKE'}
          </Button>
        </div>
      </TyvekCollapsibleSection>
    </div>
  );
}

function ReceiveContent({
  coldWallets,
  copyAddress,
  copied,
}: {
  coldWallets: WalletData[];
  copyAddress: (addr: string) => void;
  copied: string | null;
}) {
  if (coldWallets.length === 0) {
    return (
      <div className="text-center py-8">
        <div className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">No wallet found. Set up your wallet first.</div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {coldWallets.map((wallet) => (
        <div key={wallet.address} className="space-y-3">
          {/* Agent label */}
          <div className="flex items-center justify-center gap-2">
            <Shield size={12} style={{ color: 'var(--color-info, #0047ff)' }} />
            <span className="font-mono text-[9px] font-bold tracking-widest" style={{ color: 'var(--color-info, #0047ff)' }}>
              {wallet.name?.toUpperCase() || 'AGENT'}
              {wallet.chain ? ` (${wallet.chain.toUpperCase()})` : ''}
            </span>
          </div>

          {/* QR Code - white bg required for scanning */}
          <div className="flex justify-center">
            <div
              className="p-3 relative"
              style={{
                backgroundColor: 'var(--color-surface, #ffffff)',
                border: '1px solid var(--color-border, #d4d4d8)',
              }}
            >
              <div className="absolute top-1 left-1 w-2 h-2 border-l border-t" style={{ borderColor: 'var(--color-border-focus, #0a0a0a)' }} />
              <div className="absolute top-1 right-1 w-2 h-2 border-r border-t" style={{ borderColor: 'var(--color-border-focus, #0a0a0a)' }} />
              <div className="absolute bottom-1 left-1 w-2 h-2 border-l border-b" style={{ borderColor: 'var(--color-border-focus, #0a0a0a)' }} />
              <div className="absolute bottom-1 right-1 w-2 h-2 border-r border-b" style={{ borderColor: 'var(--color-border-focus, #0a0a0a)' }} />
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${wallet.address}&bgcolor=ffffff&color=0a0a0a&margin=0`}
                alt="Wallet QR Code"
                className="w-40 h-40"
              />
            </div>
          </div>

          {/* Address */}
          <div
            className="p-3 relative group cursor-pointer"
            onClick={() => copyAddress(wallet.address)}
            style={{
              backgroundColor: 'var(--color-background-alt, #f4f4f5)',
              border: '1px solid var(--color-border, #d4d4d8)',
            }}
          >
            <code
              className="font-mono text-[11px] break-all select-all block text-center leading-relaxed pr-6"
              style={{ color: 'var(--color-text, #0a0a0a)' }}
            >
              {wallet.address}
            </code>
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 opacity-60 group-hover:opacity-100 transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                copyAddress(wallet.address);
              }}
            >
              <Copy size={14} style={{ color: copied === wallet.address ? 'var(--color-success, #00c853)' : 'var(--color-info, #0047ff)' }} />
            </button>
          </div>
          {copied === wallet.address && (
            <div className="text-center">
              <span className="font-mono text-[9px]" style={{ color: 'var(--color-success, #00c853)' }}>COPIED TO CLIPBOARD</span>
            </div>
          )}

          {/* Divider between agents */}
          {coldWallets.length > 1 && wallet !== coldWallets[coldWallets.length - 1] && (
            <div className="border-t" style={{ borderColor: 'var(--color-border, #d4d4d8)' }} />
          )}
        </div>
      ))}

      {/* Instructions */}
      <div className="space-y-2 pt-2">
        <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)] tracking-widest">INSTRUCTIONS</div>
        <div className="space-y-1.5">
          <div className="flex items-start gap-2">
            <div className="w-4 h-4 bg-[var(--color-background-alt,#e8e8e6)] flex items-center justify-center shrink-0 mt-0.5">
              <span className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">1</span>
            </div>
            <span className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">Scan QR or copy address above</span>
          </div>
          <div className="flex items-start gap-2">
            <div className="w-4 h-4 bg-[var(--color-background-alt,#e8e8e6)] flex items-center justify-center shrink-0 mt-0.5">
              <span className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">2</span>
            </div>
            <span className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">Send ETH from exchange or another wallet</span>
          </div>
          <div className="flex items-start gap-2">
            <div className="w-4 h-4 bg-[var(--color-background-alt,#e8e8e6)] flex items-center justify-center shrink-0 mt-0.5">
              <span className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">3</span>
            </div>
            <span className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">Funds will appear after network confirmation</span>
          </div>
        </div>
      </div>

    </div>
  );
}
