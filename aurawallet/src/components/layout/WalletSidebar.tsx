'use client';

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Shield, Flame, Send, ArrowDownToLine, Lock, Unlock, Copy, ExternalLink, LockKeyhole, RefreshCw, KeyRound, Trash2, Zap, Search, X, Loader2, Plus, Eye, EyeOff, PanelLeftClose, PanelLeftOpen, Settings, Moon, Sun, BookOpen, Code2 } from 'lucide-react';
import { usePrice } from '@/context/PriceContext';
import { useAuth } from '@/context/AuthContext';
import { useWebSocket } from '@/context/WebSocketContext';
import { api, Api, unlockWallet, setupWallet } from '@/lib/api';
import { encryptPassword } from '@/lib/crypto';
import { Button, TextInput, ConfirmationModal, ChainSelector, Popover } from '@/components/design-system';
import { useTheme } from '@/hooks/useTheme';

interface Wallet {
  address: string;
  tier: 'cold' | 'hot' | 'temp';
  chain: string;
  balance?: string;
  label?: string;
  name?: string;
  color?: string;
  emoji?: string;
  description?: string;
  hidden?: boolean;
  tokenHash?: string;
  createdAt?: string;
}

interface AgentInfo {
  id: string;
  name?: string;
  address: string;
  solanaAddress?: string;
  isUnlocked: boolean;
  isPrimary: boolean;
  createdAt: string;
}

interface WalletSidebarProps {
  // Action callbacks
  onSend?: () => void;
  onReceive?: () => void;
  onLogs?: () => void;
  onAgentKeys?: () => void;
  onAppStore?: () => void;
  onWalletClick?: (wallet: Wallet) => void;
  onImportSeed?: () => void;
  onSettings?: () => void;
  // External state sync (optional)
  pendingActionCount?: number;
  onStateChange?: (state: { configured: boolean; unlocked: boolean; wallets: Wallet[] }) => void;
}

interface AppState {
  configured: boolean;
  unlocked: boolean;
  wallets: Wallet[];
  agents: AgentInfo[];
}

// CSS animation keyframes for wallet list
const walletAnimationStyles = `
@keyframes wallet-slide-in {
  0% {
    opacity: 0;
    transform: translateX(-20px) scale(0.95);
  }
  100% {
    opacity: 1;
    transform: translateX(0) scale(1);
  }
}
`;

export const WalletSidebar: React.FC<WalletSidebarProps> = ({
  onSend,
  onReceive,
  onLogs,
  onAppStore,
  onWalletClick,
  onImportSeed,
  onSettings,
  onStateChange,
}) => {
  const { ethPrice, solPrice, formatUsd, formatUsdForChain } = usePrice();
  const { getConfiguredChains, token, setToken } = useAuth();
  const { subscribe } = useWebSocket();
  const { theme, setTheme } = useTheme();
  const isDarkTheme = theme === 'dark';
  const handleThemeToggle = useCallback(() => {
    setTheme(isDarkTheme ? 'default' : 'dark');
  }, [isDarkTheme, setTheme]);

  // Chain helpers
  const isSolanaChain = (chain: string) => chain === 'solana' || chain === 'solana-devnet';
  const getCurrencySymbol = (chain: string) => {
    if (isSolanaChain(chain)) return 'SOL';
    if (chain === 'polygon') return 'MATIC';
    return 'ETH';
  };
  const getExplorerLink = (address: string, chain: string) => {
    if (isSolanaChain(chain)) return `https://solscan.io/account/${address}`;
    if (chain === 'polygon') return `https://polygonscan.com/address/${address}`;
    return `https://basescan.org/address/${address}`;
  };

  // Use ref for callback to avoid infinite loops
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  // Internal state
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedChain, setSelectedChain] = useState('base');
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // Lock/unlock state
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [locking, setLocking] = useState(false);
  // Per-agent unlock
  const [agentUnlockId, setAgentUnlockId] = useState<string | null>(null);
  const [agentUnlockPassword, setAgentUnlockPassword] = useState('');
  const [agentUnlocking, setAgentUnlocking] = useState(false);

  // Setup state
  const [setupPassword, setSetupPassword] = useState('');
  const [setupLoading, setSetupLoading] = useState(false);

  // Nuke state
  const [showNukeModal, setShowNukeModal] = useState(false);
  const [nuking, setNuking] = useState(false);

  // Create wallet state
  const [creatingWallet, setCreatingWallet] = useState(false);
  const [showAddPopover, setShowAddPopover] = useState(false);
  const [addPopoverView, setAddPopoverView] = useState<'menu' | 'new-agent'>('menu');
  const [newAgentPassword, setNewAgentPassword] = useState('');
  const [newAgentName, setNewAgentName] = useState('');
  const [creatingAgent, setCreatingAgent] = useState(false);

  // Collapse state — persist to localStorage
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('sidebar-collapsed') === '1';
  });
  const toggleCollapsed = useCallback((val: boolean) => {
    setCollapsed(val);
    localStorage.setItem('sidebar-collapsed', val ? '1' : '0');
  }, []);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  const chains = getConfiguredChains();
  const shortAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  // Use backend-provided balances directly (no separate RPC fetch)
  const wallets = state?.wallets || [];
  const agents = state?.agents || [];

  // Find cold wallets matching the selected chain (from wallet list, not agents)
  const coldWallets = useMemo(() => {
    return wallets.filter(w => w.tier === 'cold' && (
      isSolanaChain(selectedChain) ? isSolanaChain(w.chain) : !isSolanaChain(w.chain)
    ));
  }, [wallets, selectedChain]);

  // Filter hot wallets by chain family
  const hotWallets = useMemo(() => {
    return wallets.filter(w => w.tier === 'hot' && (
      isSolanaChain(selectedChain) ? isSolanaChain(w.chain) : !isSolanaChain(w.chain)
    ));
  }, [wallets, selectedChain]);
  // Show unlock form if wallet is configured AND (server locked OR no frontend token)
  const isLocked = state?.configured && (!state?.unlocked || !token);
  const isConfigured = state?.configured ?? false;

  // Fetch state from server
  const fetchState = useCallback(async () => {
    try {
      const data = await api.get<{ wallets: Wallet[]; unlocked: boolean; agents: AgentInfo[] }>(
        Api.Wallet,
        '/wallets',
        { includeHidden: true }
      );

      const configured = data.wallets.some(w => w.tier === 'cold') || (data.agents && data.agents.length > 0);
      const newState = {
        configured,
        unlocked: data.unlocked,
        wallets: data.wallets,
        agents: data.agents || [],
      };

      setState(newState);
      onStateChangeRef.current?.({
        configured: newState.configured,
        unlocked: newState.unlocked,
        wallets: newState.wallets,
      });
    } catch (err) {
      console.error('[WalletSidebar] Failed to fetch state:', err);
      setState({ configured: false, unlocked: false, wallets: [], agents: [] });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchState();
  }, [fetchState]);

  // WebSocket subscription for wallet events (created + updated)
  useEffect(() => {
    const unsubscribe = subscribe('wallet:changed', () => {
      fetchState();
    });
    return unsubscribe;
  }, [subscribe, fetchState]);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Filter hot wallets
  const filteredHotWallets = useMemo(() => {
    let filtered: Wallet[];
    if (!debouncedQuery.trim()) {
      filtered = hotWallets.filter(w => !w.hidden);
    } else {
      const query = debouncedQuery.toLowerCase();
      filtered = hotWallets.filter(w =>
        w.address.toLowerCase().includes(query) ||
        w.name?.toLowerCase().includes(query) ||
        w.label?.toLowerCase().includes(query)
      );
    }
    return [...filtered].sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA || a.address.localeCompare(b.address);
    });
  }, [hotWallets, debouncedQuery]);

  // Calculate total balance (only for selected chain)
  const totalBalance = useMemo(() => {
    let total = 0;
    const chainWallets = wallets.filter(w =>
      !w.hidden && (isSolanaChain(selectedChain) ? isSolanaChain(w.chain) : !isSolanaChain(w.chain))
    );
    chainWallets.forEach(w => {
      if (w.balance) {
        total += parseFloat(w.balance) || 0;
      }
    });
    return total.toFixed(4);
  }, [wallets, selectedChain]);

  // Handlers
  const handleRefresh = () => {
    setRefreshing(true);
    fetchState();
  };

  const handleChainChange = (chain: string) => {
    setSelectedChain(chain);
  };

  const copyAddress = (address: string) => {
    navigator.clipboard.writeText(address);
    setCopied(address);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unlockPassword) return;

    setUnlocking(true);
    try {
      const data = await unlockWallet(unlockPassword);
      if (data.token) {
        setToken(data.token);
      }
      setUnlockPassword('');
      fetchState();
    } catch (err) {
      console.error('[WalletSidebar] Unlock failed:', err);
    } finally {
      setUnlocking(false);
    }
  };

  const handleAgentUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentUnlockId || !agentUnlockPassword) return;

    setAgentUnlocking(true);
    try {
      const data = await unlockWallet(agentUnlockPassword, agentUnlockId);
      if (data.token) {
        setToken(data.token);
      }
      setAgentUnlockId(null);
      setAgentUnlockPassword('');
      fetchState();
    } catch (err) {
      console.error('[WalletSidebar] Agent unlock failed:', err);
    } finally {
      setAgentUnlocking(false);
    }
  };

  const handleAgentLock = async (agentId: string) => {
    try {
      await api.post(Api.Wallet, `/lock/${agentId}`, {});
      fetchState();
    } catch (err) {
      console.error('[WalletSidebar] Agent lock failed:', err);
    }
  };

  const handleLock = async () => {
    setLocking(true);
    try {
      await api.post(Api.Wallet, '/lock', {});
      fetchState();
    } catch (err) {
      console.error('[WalletSidebar] Lock failed:', err);
    } finally {
      setLocking(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (setupPassword.length < 8) return;

    setSetupLoading(true);
    try {
      const result = await setupWallet(setupPassword);
      if (result.token) setToken(result.token);
      setSetupPassword('');
      fetchState();
    } catch (err) {
      console.error('[WalletSidebar] Setup failed:', err);
    } finally {
      setSetupLoading(false);
    }
  };

  const handleNuke = async () => {
    setNuking(true);
    try {
      await api.post(Api.Wallet, '/nuke', {});
      setShowNukeModal(false);
      fetchState();
    } catch (err) {
      console.error('[WalletSidebar] Nuke failed:', err);
    } finally {
      setNuking(false);
    }
  };

  const handleCreateHotWallet = async () => {
    setCreatingWallet(true);
    try {
      await api.post(Api.Wallet, '/wallet/create', {
        tier: 'hot',
        chain: selectedChain,
      });
      // fetchState will be triggered by wallet:created WS event
    } catch (err) {
      console.error('[WalletSidebar] Create hot wallet failed:', err);
    } finally {
      setCreatingWallet(false);
    }
  };

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newAgentPassword.length < 8) return;

    setCreatingAgent(true);
    try {
      const { publicKey } = await api.get<{ publicKey: string }>(Api.Wallet, '/auth/connect');
      const encrypted = await encryptPassword(newAgentPassword, publicKey);
      await api.post(Api.Wallet, '/setup/agent', {
        encrypted,
        name: newAgentName || undefined,
      });
      setNewAgentPassword('');
      setNewAgentName('');
      setAddPopoverView('menu');
      setShowAddPopover(false);
      fetchState();
    } catch (err) {
      console.error('[WalletSidebar] Create agent failed:', err);
    } finally {
      setCreatingAgent(false);
    }
  };

  const handleToggleHidden = async (address: string, currentlyHidden: boolean) => {
    try {
      await api.post(Api.Wallet, '/wallet/rename', {
        address,
        hidden: !currentlyHidden,
      });
      // fetchState triggered by wallet:changed WS event
    } catch (err) {
      console.error('[WalletSidebar] Toggle hidden failed:', err);
    }
  };

  // Get cold wallet balance for a agent by matching addresses
  const getAgentBalance = (agent: AgentInfo): string => {
    const chainAddr = isSolanaChain(selectedChain) ? agent.solanaAddress : agent.address;
    if (!chainAddr) return '0';
    const w = wallets.find(w => w.tier === 'cold' && w.address === chainAddr);
    return w?.balance || '0';
  };

  // Loading state
  if (loading) {
    return (
      <div className={`${collapsed ? 'w-[48px]' : 'w-[280px]'} h-full bg-[var(--color-surface,#f4f4f2)] border-r border-[var(--color-border,#d4d4d8)] shadow-lg flex items-center justify-center transition-all duration-200`}>
        <Loader2 size={24} className="animate-spin text-[var(--color-text-muted,#6b7280)]" />
      </div>
    );
  }

  // Collapsed sidebar - thin icon bar
  if (collapsed) {
    return (
      <div className="w-[48px] h-full bg-[var(--color-surface,#f4f4f2)] border-r border-[var(--color-border,#d4d4d8)] shadow-lg flex flex-col items-center relative transition-all duration-200">
        {/* QR Noise Texture */}
        <div className="absolute inset-0 opacity-[0.02] pointer-events-none bg-[radial-gradient(var(--color-text,#000)_1px,transparent_1px)] bg-[size:4px_4px]" />

        {/* Logo */}
        <div className="py-3 relative z-10">
          <img
            src="/logo.webp"
            alt="AuraWallet"
            className="w-10 h-10 object-contain"
          />
        </div>

        {/* Icon buttons */}
        <div className="flex flex-col items-center gap-1 relative z-10">
          {isConfigured && !isLocked && (
            <>
              <button onClick={onSend} className="p-2 hover:bg-[var(--color-surface-alt,#f5f5f5)] transition-colors" title="Send">
                <Send size={14} className="text-[var(--color-text-muted,#6b7280)]" />
              </button>
              <button onClick={onReceive} className="p-2 hover:bg-[var(--color-surface-alt,#f5f5f5)] transition-colors" title="Receive">
                <ArrowDownToLine size={14} className="text-[var(--color-text-muted,#6b7280)]" />
              </button>
            </>
          )}
        </div>

        {/* Bottom controls */}
        <div className="mt-auto flex flex-col items-center gap-1 relative z-10">
          <a href="/docs" className="p-2 hover:bg-[var(--color-surface-alt,#f5f5f5)] transition-colors" title="Docs">
            <BookOpen size={14} className="text-[var(--color-text-muted,#6b7280)]" />
          </a>
          <a href="/docs?doc=internal/not-ready/EXTENSION.md" className="p-2 hover:bg-[var(--color-surface-alt,#f5f5f5)] transition-colors" title="Extension">
            <ExternalLink size={14} className="text-[var(--color-text-muted,#6b7280)]" />
          </a>
          <a href="/api" className="p-2 hover:bg-[var(--color-surface-alt,#f5f5f5)] transition-colors" title="API">
            <Code2 size={14} className="text-[var(--color-text-muted,#6b7280)]" />
          </a>
          <button onClick={handleThemeToggle} className="p-2 hover:bg-[var(--color-surface-alt,#f5f5f5)] transition-colors" title={isDarkTheme ? 'Switch to default theme' : 'Switch to dark mode'}>
            {!isDarkTheme ? (
              <Moon size={14} className="text-[var(--color-text-muted,#6b7280)]" />
            ) : (
              <Sun size={14} className="text-[var(--color-text-muted,#a1a1aa)]" />
            )}
          </button>
        </div>

        {/* Status dot */}
        <div className="pb-3 relative z-10">
          {!isConfigured ? (
            <div className="w-2 h-2 bg-[var(--color-text-muted,#6b7280)]" />
          ) : isLocked ? (
            <div className="w-2 h-2 bg-[var(--color-warning,#ff4d00)]" />
          ) : (
            <div className="w-2 h-2 bg-[var(--color-accent,#ccff00)] animate-pulse" />
          )}
        </div>

        {/* Expand button */}
        <button
          onClick={() => toggleCollapsed(false)}
          className="w-full py-2 border-t border-[var(--color-border,#d4d4d8)] hover:bg-[var(--color-surface-alt,#f5f5f5)] transition-colors relative z-10 flex items-center justify-center"
          title="Expand sidebar"
        >
          <PanelLeftOpen size={14} className="text-[var(--color-text-muted,#6b7280)]" />
        </button>
      </div>
    );
  }

  return (
    <div className="w-[280px] h-full bg-[var(--color-surface,#f4f4f2)] border-r border-[var(--color-border,#d4d4d8)] shadow-lg flex flex-col relative overflow-hidden font-mono">
      <style>{walletAnimationStyles}</style>

      {/* QR Noise Texture */}
      <div className="absolute inset-0 opacity-[0.02] pointer-events-none bg-[radial-gradient(var(--color-text,#000)_1px,transparent_1px)] bg-[size:4px_4px]" />

      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] relative z-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10">
              <img src="/logo.webp" alt="AuraWallet" className="w-full h-full object-contain" />
            </div>
            <div className="leading-tight">
              <div className="flex items-baseline gap-1.5">
                <span className="font-black text-[11px] tracking-tight text-[var(--color-text,#0a0a0a)] lowercase">aurawallet</span>
                <span className="text-[8px] text-[var(--color-text-muted,#6b7280)] uppercase tracking-widest">from</span>
              </div>
              <a
                href="https://x.com/nicoletteduclar"
                target="_blank"
                rel="noopener noreferrer"
                className="block text-[8px] text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
              >
                @nicoletteduclar, with love
              </a>
            </div>
          </div>
          <button
            onClick={() => toggleCollapsed(true)}
            className="p-1.5 hover:bg-[var(--color-surface,#ffffff)]/50 transition-colors"
            title="Collapse sidebar"
          >
            <PanelLeftClose size={12} className="text-[var(--color-text-muted,#6b7280)]" />
          </button>
        </div>

        {/* Chain Selector */}
        {!isLocked && Object.keys(chains).length > 0 && (
          <div className="mt-2 flex items-center gap-1.5">
            <ChainSelector
              value={selectedChain}
              onChange={handleChainChange}
              chains={Object.keys(chains)}
              size="sm"
            />
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="p-1.5 border border-[var(--color-border,#d4d4d8)] hover:border-[var(--color-text,#0a0a0a)] bg-[var(--color-surface-alt,#f5f5f5)] hover:bg-[var(--color-background-alt,#e8e8e6)] transition-colors disabled:opacity-50"
            >
              <RefreshCw size={10} className={`${refreshing ? 'animate-spin' : ''} text-[var(--color-text-muted,#6b7280)]`} />
            </button>
          </div>
        )}
      </div>

      {/* Total Balance / Lock Status / Setup */}
      <div className="p-4 border-b border-[var(--color-border,#d4d4d8)] relative z-10">
        {!isConfigured ? (
          /* Setup */
          <>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 bg-[var(--color-accent,#ccff00)]/20 flex items-center justify-center">
                <Zap size={14} className="text-[var(--color-text,#0a0a0a)]" />
              </div>
              <div>
                <div className="font-mono text-[9px] text-[var(--color-text,#0a0a0a)] tracking-widest font-bold">INITIALIZE_AGENT</div>
                <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">Create your secure wallet</div>
              </div>
            </div>

            <div className="mb-3 p-2 bg-[var(--color-surface-alt,#fafafa)] border border-[var(--color-border,#d4d4d8)] space-y-2">
              <div className="flex items-start gap-2">
                <Shield size={10} className="text-[var(--color-info,#0047ff)] mt-0.5 flex-shrink-0" />
                <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)] leading-relaxed">
                  <span className="text-[var(--color-info,#0047ff)] font-bold">COLD_AGENT</span> - Encrypted seed
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Flame size={10} className="text-[var(--color-warning,#ff4d00)] mt-0.5 flex-shrink-0" />
                <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)] leading-relaxed">
                  <span className="text-[var(--color-warning,#ff4d00)] font-bold">HOT_WALLETS</span> - Derived keys
                </div>
              </div>
            </div>

            <form onSubmit={handleSetup} className="space-y-2">
              <TextInput
                label="ENCRYPTION_PASSWORD"
                type="password"
                value={setupPassword}
                onChange={(e) => setSetupPassword(e.target.value)}
                placeholder="Min 8 characters"
                minLength={8}
                compact
              />
              <Button
                type="submit"
                disabled={setupLoading || setupPassword.length < 8}
                loading={setupLoading}
                icon={!setupLoading ? <Zap size={12} /> : undefined}
                className="w-full"
                size="lg"
              >
                {setupLoading ? 'INITIALIZING...' : 'INITIALIZE'}
              </Button>
            </form>

            <div className="mt-3 pt-3 border-t border-[var(--color-border,#d4d4d8)]">
              <Button
                variant="secondary"
                size="md"
                onClick={onImportSeed}
                icon={<KeyRound size={10} />}
                className="w-full"
              >
                IMPORT_EXISTING_SEED
              </Button>
            </div>
          </>
        ) : isLocked ? (
          /* Locked */
          <>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 bg-[var(--color-warning,#ff4d00)]/10 flex items-center justify-center">
                <LockKeyhole size={14} className="text-[var(--color-warning,#ff4d00)]" />
              </div>
              <div>
                <div className="font-mono text-[9px] text-[var(--color-warning,#ff4d00)] tracking-widest font-bold">{state?.unlocked ? 'AUTHENTICATE' : 'AGENT_LOCKED'}</div>
                <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">{state?.unlocked ? 'Enter password to reconnect workspace' : 'Unlock all workspace agents'}</div>
              </div>
            </div>
            <form onSubmit={handleUnlock} className="space-y-2">
              <TextInput
                label="PASSWORD"
                type="password"
                value={unlockPassword}
                onChange={(e) => setUnlockPassword(e.target.value)}
                placeholder="Enter password"
                compact
              />
              <Button
                type="submit"
                disabled={unlocking || !unlockPassword}
                loading={unlocking}
                icon={!unlocking ? <Unlock size={12} /> : undefined}
                className="w-full"
                size="lg"
              >
                {unlocking ? 'UNLOCKING...' : 'UNLOCK WORKSPACE'}
              </Button>
            </form>
            <div className="mt-2 font-mono text-[7px] text-[var(--color-text-faint,#9ca3af)]">
              UNLOCK WORKSPACE unlocks workspace-linked agents. Use each agent row to unlock this agent only.
            </div>

          </>
        ) : (
          /* Unlocked */
          <>
            <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] tracking-widest mb-1">TOTAL_BALANCE</div>
            <div className="font-black text-2xl text-[var(--color-text,#0a0a0a)] tracking-tight">{totalBalance} {getCurrencySymbol(selectedChain)}</div>
            {formatUsdForChain(totalBalance, selectedChain) && (
              <div className="font-mono text-sm text-[var(--color-text-muted,#6b7280)] mt-0.5">{formatUsdForChain(totalBalance, selectedChain)}</div>
            )}
            <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] mt-2 flex items-center justify-between">
              <div className="flex items-center gap-1">
                <div className="w-1 h-1 bg-[var(--color-accent,#ccff00)]" />
                {selectedChain.toUpperCase()}
              </div>
              {isSolanaChain(selectedChain) ? (
                solPrice && <span className="text-[var(--color-info,#0047ff)]">SOL ${solPrice.toLocaleString()}</span>
              ) : (
                ethPrice && <span className="text-[var(--color-info,#0047ff)]">ETH ${ethPrice.toLocaleString()}</span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Primary Actions */}
      {isConfigured && !isLocked && (
        <div className="px-3 py-2 border-b border-[var(--color-border,#d4d4d8)] relative z-10">
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={onSend} icon={<Send size={10} />} className="flex-1">
              SEND
            </Button>
            <Button variant="secondary" size="md" onClick={onReceive} icon={<ArrowDownToLine size={10} />} className="flex-1">
              RECEIVE
            </Button>
          </div>
        </div>
      )}

      {/* Wallet List */}
      <div className="flex-1 overflow-y-auto relative z-10">
        {!isConfigured ? (
          <div className="p-4 flex items-center justify-center h-full">
            <div className="text-center opacity-50">
              <Zap size={32} className="mx-auto mb-2 text-[var(--color-text-muted,#6b7280)]" />
              <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">AWAITING_INIT</div>
            </div>
          </div>
        ) : isLocked ? (
          <div className="p-4 flex items-center justify-center h-full">
            <div className="text-center opacity-30">
              <Lock size={32} className="mx-auto mb-2 text-[var(--color-text-muted,#6b7280)]" />
              <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">ASSETS_HIDDEN</div>
            </div>
          </div>
        ) : (
          <div className="p-4">
            <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] tracking-widest mb-3">ASSETS</div>

            {/* Search + Add */}
            <div className="mb-3 flex gap-1.5">
              <div className="relative flex-1">
                <div className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none">
                  <Search size={10} className="text-[var(--color-text-muted,#6b7280)]" />
                </div>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search wallets..."
                  className="w-full pl-7 pr-7 py-1.5 border border-[var(--color-border,#d4d4d8)] font-mono text-[9px] text-[var(--color-text,#0a0a0a)] focus:outline-none focus:border-[var(--color-border-focus,#0a0a0a)] bg-[var(--color-surface,#ffffff)] placeholder-[var(--color-text-faint,#9ca3af)]"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-[var(--color-surface-alt,#f5f5f5)] rounded"
                  >
                    <X size={10} className="text-[var(--color-text-muted,#6b7280)]" />
                  </button>
                )}
              </div>
              <div className="relative">
                <button
                  onClick={() => setShowAddPopover(!showAddPopover)}
                  className="h-full px-2 border border-[var(--color-border,#d4d4d8)] hover:border-[var(--color-text,#0a0a0a)] bg-[var(--color-surface-alt,#f5f5f5)] hover:bg-[var(--color-background-alt,#e8e8e6)] transition-colors"
                  title="Add wallet"
                >
                  <Plus size={10} className="text-[var(--color-text-muted,#6b7280)]" />
                </button>
                <Popover isOpen={showAddPopover} onClose={() => { setShowAddPopover(false); setAddPopoverView('menu'); setNewAgentPassword(''); setNewAgentName(''); }} title={addPopoverView === 'menu' ? 'ADD_WALLET' : 'NEW_AGENT'} anchor="right">
                  {addPopoverView === 'menu' ? (
                    <div className="space-y-1 min-w-[160px]">
                      <button
                        onClick={() => setAddPopoverView('new-agent')}
                        className="w-full flex items-center gap-2 px-2 py-2 hover:bg-[var(--color-surface-alt,#f5f5f5)] transition-colors text-left"
                      >
                        <Shield size={10} className="text-[var(--color-info,#0047ff)]" />
                        <div>
                          <div className="font-mono text-[9px] font-bold text-[var(--color-text,#0a0a0a)]">NEW_AGENT</div>
                          <div className="font-mono text-[7px] text-[var(--color-text-muted,#6b7280)]">Generate new seed phrase</div>
                        </div>
                      </button>
                      <button
                        onClick={() => { setShowAddPopover(false); setAddPopoverView('menu'); onImportSeed?.(); }}
                        className="w-full flex items-center gap-2 px-2 py-2 hover:bg-[var(--color-surface-alt,#f5f5f5)] transition-colors text-left"
                      >
                        <KeyRound size={10} className="text-[var(--color-info,#0047ff)]" />
                        <div>
                          <div className="font-mono text-[9px] font-bold text-[var(--color-text,#0a0a0a)]">IMPORT_AGENT</div>
                          <div className="font-mono text-[7px] text-[var(--color-text-muted,#6b7280)]">From existing seed phrase</div>
                        </div>
                      </button>
                      <button
                        onClick={() => { setShowAddPopover(false); handleCreateHotWallet(); }}
                        disabled={creatingWallet}
                        className="w-full flex items-center gap-2 px-2 py-2 hover:bg-[var(--color-surface-alt,#f5f5f5)] transition-colors text-left disabled:opacity-50"
                      >
                        <Flame size={10} className="text-[var(--color-warning,#ff4d00)]" />
                        <div>
                          <div className="font-mono text-[9px] font-bold text-[var(--color-text,#0a0a0a)]">ADD_HOT_WALLET</div>
                          <div className="font-mono text-[7px] text-[var(--color-text-muted,#6b7280)]">New agent-accessible wallet</div>
                        </div>
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={handleCreateAgent} className="space-y-2 min-w-[200px]">
                      <input
                        type="text"
                        value={newAgentName}
                        onChange={(e) => setNewAgentName(e.target.value)}
                        placeholder="Agent name (optional)"
                        className="w-full px-2 py-1.5 border border-[var(--color-border,#d4d4d8)] font-mono text-[9px] text-[var(--color-text,#0a0a0a)] focus:outline-none focus:border-[var(--color-info,#0047ff)] bg-[var(--color-surface,#ffffff)] placeholder-[var(--color-text-faint,#9ca3af)]"
                      />
                      <input
                        type="password"
                        value={newAgentPassword}
                        onChange={(e) => setNewAgentPassword(e.target.value)}
                        placeholder="Password (min 8 chars)"
                        className="w-full px-2 py-1.5 border border-[var(--color-border,#d4d4d8)] font-mono text-[9px] text-[var(--color-text,#0a0a0a)] focus:outline-none focus:border-[var(--color-info,#0047ff)] bg-[var(--color-surface,#ffffff)] placeholder-[var(--color-text-faint,#9ca3af)]"
                      />
                      <div className="flex gap-1">
                        <Button type="submit" size="sm" disabled={creatingAgent || newAgentPassword.length < 8} loading={creatingAgent} className="flex-1">
                          CREATE
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => { setAddPopoverView('menu'); setNewAgentPassword(''); setNewAgentName(''); }}>
                          <X size={9} />
                        </Button>
                      </div>
                    </form>
                  )}
                </Popover>
              </div>
            </div>

            {/* Agents */}
            {agents.map((agent) => {
              const balance = getAgentBalance(agent);
              const agentAddr = isSolanaChain(selectedChain) ? agent.solanaAddress : agent.address;
              if (!agentAddr) return null;

              return (
                <div key={agent.id} className="mb-3 border-2 border-[var(--color-info,#0047ff)] bg-gradient-to-r from-[var(--color-info,#0047ff)]/10 to-transparent p-3 relative">
                  <div className="absolute top-0 left-0 w-full h-0.5 bg-[var(--color-info,#0047ff)]" />
                  {agent.isUnlocked && (
                    <div className="absolute top-1 right-1 w-1.5 h-1.5 bg-[var(--color-info,#0047ff)] animate-pulse" />
                  )}
                  {!agent.isUnlocked && (
                    <div className="absolute top-1 right-1 w-1.5 h-1.5 bg-[var(--color-warning,#ff4d00)]" />
                  )}
                  <div className="flex items-center gap-2 mb-2">
                    <Shield size={12} className="text-[var(--color-info,#0047ff)]" />
                    <span className="font-mono text-[9px] text-[var(--color-info,#0047ff)] tracking-widest font-bold truncate flex-1">
                      {agent.name || (agent.isPrimary ? 'PRIMARY_AGENT' : `AGENT_${agent.id.toUpperCase()}`)}
                    </span>
                    {agent.isUnlocked ? (
                      <button
                        onClick={() => handleAgentLock(agent.id)}
                        className="p-1 hover:bg-[var(--color-info,#0047ff)]/10 transition-colors"
                        title="Lock this agent"
                      >
                        <Lock size={9} className="text-[var(--color-text-muted,#6b7280)]" />
                      </button>
                    ) : (
                      <button
                        onClick={() => setAgentUnlockId(agent.id)}
                        className="p-1 hover:bg-[var(--color-info,#0047ff)]/10 transition-colors"
                        title="Unlock this agent"
                      >
                        <Unlock size={9} className="text-[var(--color-warning,#ff4d00)]" />
                      </button>
                    )}
                  </div>

                  {/* Per-agent unlock form */}
                  {agentUnlockId === agent.id && !agent.isUnlocked && (
                    <form onSubmit={handleAgentUnlock} className="mb-2 space-y-1.5">
                      <input
                        type="password"
                        value={agentUnlockPassword}
                        onChange={(e) => setAgentUnlockPassword(e.target.value)}
                        placeholder="Password for this agent"
                        className="w-full px-2 py-1 border border-[var(--color-border,#d4d4d8)] font-mono text-[9px] text-[var(--color-text,#0a0a0a)] focus:outline-none focus:border-[var(--color-info,#0047ff)] bg-[var(--color-surface,#ffffff)]"
                      />
                      <div className="flex gap-1">
                        <Button type="submit" size="sm" disabled={agentUnlocking || !agentUnlockPassword} loading={agentUnlocking} className="flex-1">
                          UNLOCK AGENT
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => { setAgentUnlockId(null); setAgentUnlockPassword(''); }}>
                          <X size={9} />
                        </Button>
                      </div>
                    </form>
                  )}

                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">{shortAddress(agentAddr)}</div>
                      <div className="font-bold text-sm text-[var(--color-text,#0a0a0a)] mt-0.5">{balance} {getCurrencySymbol(selectedChain)}</div>
                      {formatUsdForChain(balance, selectedChain) && (
                        <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">{formatUsdForChain(balance, selectedChain)}</div>
                      )}
                    </div>
                    <div className="flex gap-1">
                      {!agent.isUnlocked && (
                        <span className="font-mono text-[7px] text-[var(--color-warning,#ff4d00)] bg-[var(--color-warning,#ff4d00)]/10 px-1 py-0.5 self-center">LOCKED</span>
                      )}
                      <button onClick={() => copyAddress(agentAddr)} className="p-1.5 hover:bg-[var(--color-info,#0047ff)]/10 transition-colors">
                        <Copy size={10} className={copied === agentAddr ? 'text-[var(--color-accent,#ccff00)]' : 'text-[var(--color-text-muted,#6b7280)]'} />
                      </button>
                      <a href={getExplorerLink(agentAddr, selectedChain)} target="_blank" className="p-1.5 hover:bg-[var(--color-info,#0047ff)]/10 transition-colors">
                        <ExternalLink size={10} className="text-[var(--color-text-muted,#6b7280)]" />
                      </a>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Hot Wallets */}
            <div className="space-y-1">
              {filteredHotWallets.map((wallet) => {
                const walletColor = wallet.color || '#ff4d00';
                return (
                  <div
                    key={wallet.address}
                    onClick={() => onWalletClick?.(wallet)}
                    className={`bg-[var(--color-surface,#ffffff)] p-2.5 relative group hover:border-[var(--color-warning,#ff4d00)] cursor-pointer ${wallet.hidden ? 'opacity-60' : ''}`}
                    style={{
                      borderWidth: '1px',
                      borderColor: `${walletColor}4D`,
                      borderTopWidth: wallet.color ? '3px' : '1px',
                      borderTopColor: wallet.color || `${walletColor}4D`,
                      transition: 'transform 0.3s ease-out, opacity 0.3s ease-out, border-color 0.15s ease',
                      animation: wallet.createdAt && (Date.now() - new Date(wallet.createdAt).getTime() < 2000)
                        ? 'wallet-slide-in 0.3s ease-out'
                        : undefined,
                    }}
                  >
                    <div className="absolute top-1 right-1 w-1.5 h-1.5" style={{ backgroundColor: walletColor, opacity: 0.7 }} />
                    <div className="flex items-center gap-2">
                      {wallet.emoji && <span className="text-[10px]">{wallet.emoji}</span>}
                      <span className="font-mono text-[9px] font-bold truncate flex-1" style={{ color: walletColor }}>
                        {wallet.name || wallet.label || 'HOT'}
                      </span>
                      {wallet.hidden && (
                        <span className="font-mono text-[7px] text-[var(--color-text-muted,#6b7280)] bg-[var(--color-surface-alt,#f5f5f5)] px-1">HIDDEN</span>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggleHidden(wallet.address, !!wallet.hidden); }}
                        className="p-1 hover:bg-[var(--color-warning,#ff4d00)]/10 transition-colors opacity-0 group-hover:opacity-100"
                        title={wallet.hidden ? 'Show wallet' : 'Hide wallet'}
                      >
                        {wallet.hidden
                          ? <Eye size={9} className="text-[var(--color-text-muted,#6b7280)]" />
                          : <EyeOff size={9} className="text-[var(--color-text-muted,#6b7280)]" />
                        }
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); copyAddress(wallet.address); }}
                        className="p-1 hover:bg-[var(--color-warning,#ff4d00)]/10 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <Copy size={9} className={copied === wallet.address ? 'text-[var(--color-accent,#ccff00)]' : 'text-[var(--color-text-muted,#6b7280)]'} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">{shortAddress(wallet.address)}</span>
                      <div className="text-right">
                        <span className="font-mono text-[10px] font-bold text-[var(--color-text,#0a0a0a)]">{wallet.balance || '0'} {getCurrencySymbol(wallet.chain)}</span>
                        {formatUsdForChain(wallet.balance, wallet.chain) && (
                          <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">{formatUsdForChain(wallet.balance, wallet.chain)}</div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-[var(--color-border,#d4d4d8)] relative z-10">
        <div className="flex items-center justify-between">
          {isConfigured && !isLocked ? (
            <Button variant="ghost" size="sm" onClick={handleLock} disabled={locking} loading={locking} icon={!locking ? <Lock size={10} /> : undefined}>
              LOCK ALL
            </Button>
          ) : (
            <div className="flex items-center gap-1.5">
              {!isConfigured ? (
                <>
                  <div className="w-1.5 h-1.5 bg-[var(--color-text-muted,#6b7280)]" />
                  <span className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">UNINITIALIZED</span>
                </>
              ) : (
                <>
                  <div className="w-1.5 h-1.5 bg-[var(--color-warning,#ff4d00)]" />
                  <span className="font-mono text-[8px] text-[var(--color-warning,#ff4d00)]">{state?.unlocked ? 'NO_SESSION' : 'LOCKED'}</span>
                </>
              )}
            </div>
          )}
          <div className="flex items-center gap-0.5">
            <a href="/docs" className="px-1.5 py-1.5 font-mono text-[8px] tracking-widest text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">DOCS</a>
            <a href="/docs?doc=internal/not-ready/EXTENSION.md" className="px-1.5 py-1.5 font-mono text-[8px] tracking-widest text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">EXTENSION</a>
            <a href="/api" className="px-1.5 py-1.5 font-mono text-[8px] tracking-widest text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">API</a>
            <button
              onClick={handleThemeToggle}
              className="p-1.5 hover:bg-[var(--color-surface-alt,#f5f5f5)] transition-colors"
              title={isDarkTheme ? 'Switch to default theme' : 'Switch to dark mode'}
            >
              {!isDarkTheme ? (
                <Moon size={12} className="text-[var(--color-text-muted,#6b7280)]" />
              ) : (
                <Sun size={12} className="text-[var(--color-text-muted,#a1a1aa)]" />
              )}
            </button>
          </div>
        </div>
        {isConfigured && !isLocked && (
          <div className="flex items-center gap-1.5 mt-2">
            <div className="w-1.5 h-1.5 bg-[var(--color-accent,#ccff00)] animate-pulse" />
            <span className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">
              {agents.length > 1
                ? `${agents.filter(v => v.isUnlocked).length}/${agents.length} AGENTS`
                : 'OPERATIONAL'}
            </span>
          </div>
        )}
      </div>

      {/* Barcode + Stripe */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--color-border,#d4d4d8)] relative z-10">
        <div className="h-4 flex-1 bg-[repeating-linear-gradient(90deg,var(--color-text,#000),var(--color-text,#000)_1px,transparent_1px,transparent_3px)] opacity-30" />
      </div>
      <div className="h-2 w-full relative z-10" style={{
        backgroundImage: 'repeating-linear-gradient(45deg, var(--color-text, #000), var(--color-text, #000) 5px, transparent 5px, transparent 10px)',
        opacity: 0.1,
      }} />

      {/* Nuke Modal */}
      <ConfirmationModal
        isOpen={showNukeModal}
        onClose={() => setShowNukeModal(false)}
        onConfirm={handleNuke}
        title="Nuke Everything"
        message="This will permanently delete your cold wallet, all hot wallets, credentials, and configuration. Make sure you have backed up your seed phrase before proceeding."
        confirmText="NUKE"
        variant="danger"
        loading={nuking}
      />
    </div>
  );
};
