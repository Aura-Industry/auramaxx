/**
 * TransactionsApp — Global transaction list across all wallets.
 *
 * Fetches from GET /wallets/transactions with filter/pagination support.
 * Subscribes to tx:created WebSocket events for live updates.
 * Clicking a token address opens the token app; clicking a wallet opens walletDetail.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { ArrowUpDown, ExternalLink, Loader2, Search } from 'lucide-react';
import { api, Api } from '@/lib/api';
import { useWebSocket } from '@/context/WebSocketContext';
import { useWorkspace } from '@/context/WorkspaceContext';
import { useAuth } from '@/context/AuthContext';
import { FilterDropdown, TextInput, ChainSelector } from '@/components/design-system';

// ------------------------------------------------------------------
// Constants (duplicated locally — matches codebase convention)
// ------------------------------------------------------------------

const TX_TYPE_COLORS: Record<string, string> = {
  send: 'var(--color-warning, #ff4d00)',
  receive: 'var(--color-success, #00c853)',
  swap: 'var(--color-info, #0047ff)',
  contract: 'var(--color-text-muted, #888)',
  manual: 'var(--color-text-muted, #888)',
  launch: 'var(--color-accent, #8b5cf6)',
};

const TX_TYPE_OPTIONS = [
  { value: 'all', label: 'ALL' },
  { value: 'send', label: 'SEND' },
  { value: 'receive', label: 'RECEIVE' },
  { value: 'swap', label: 'SWAP' },
  { value: 'contract', label: 'CONTRACT' },
  { value: 'manual', label: 'MANUAL' },
  { value: 'launch', label: 'LAUNCH' },
];

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

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

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
  chain: string;
  createdAt: string;
}

interface TransactionsResponse {
  success: boolean;
  transactions: Transaction[];
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
}

interface WalletInfo {
  address: string;
  name: string | null;
  emoji: string | null;
  chain: string;
}

interface TxCreatedData {
  walletAddress: string;
  id: string;
  type: string;
  txHash?: string;
  amount?: string;
  tokenAddress?: string;
  tokenAmount?: string;
  description?: string;
}

interface TransactionsAppProps {
  config?: {
    defaultWallet?: string;
    defaultType?: string;
    defaultChain?: string;
  };
}

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

function TransactionsApp({ config }: TransactionsAppProps) {
  const { subscribe } = useWebSocket();
  const { addApp } = useWorkspace();
  const { getConfiguredChains, getChainConfig } = useAuth();

  // Chain options for the selector
  const chainOptions = Object.keys(getConfiguredChains()).map(c => c);

  // State
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  // Filters
  const [typeFilter, setTypeFilter] = useState(config?.defaultType || 'all');
  const [chainFilter, setChainFilter] = useState(config?.defaultChain || '');
  const [search, setSearch] = useState('');
  const [walletFilter] = useState(config?.defaultWallet || '');

  // Wallet lookup map (address → name/emoji)
  const [walletMap, setWalletMap] = useState<Record<string, WalletInfo>>({});

  // Debounce search
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(searchTimerRef.current);
  }, [search]);

  // Fetch wallet map for name lookups
  useEffect(() => {
    (async () => {
      try {
        const data = await api.get<{ wallets: WalletInfo[] }>(Api.Wallet, '/wallets');
        const map: Record<string, WalletInfo> = {};
        for (const w of data.wallets || []) {
          map[w.address.toLowerCase()] = w;
        }
        setWalletMap(map);
      } catch {
        // non-critical
      }
    })();
  }, []);

  // Fetch transactions
  const fetchTransactions = useCallback(async (reset = false) => {
    setLoading(true);
    try {
      const skip = reset ? 0 : offset;
      const params: Record<string, string | number> = {
        limit: 50,
        offset: skip,
        sortBy: 'createdAt',
        sortDir: 'desc',
      };
      if (typeFilter !== 'all') params.type = typeFilter;
      if (chainFilter) params.chain = chainFilter;
      if (debouncedSearch) params.search = debouncedSearch;
      if (walletFilter) params.wallet = walletFilter;

      const data = await api.get<TransactionsResponse>(Api.Wallet, '/wallets/transactions', params);
      if (data.success) {
        if (reset) {
          setTransactions(data.transactions);
          setOffset(data.transactions.length);
        } else {
          setTransactions(prev => [...prev, ...data.transactions]);
          setOffset(skip + data.transactions.length);
        }
        setHasMore(data.pagination.hasMore);
      }
    } catch (err) {
      console.error('[TransactionsApp] Failed to fetch:', err);
    } finally {
      setLoading(false);
    }
  }, [offset, typeFilter, chainFilter, debouncedSearch, walletFilter]);

  // Reset + refetch when filters change
  useEffect(() => {
    fetchTransactions(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, chainFilter, debouncedSearch, walletFilter]);

  // WebSocket: prepend new transactions
  useEffect(() => {
    const unsub = subscribe('tx:created', (event) => {
      const data = event.data as TxCreatedData;

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
        chain: 'base',
        createdAt: new Date().toISOString(),
      };

      setTransactions(prev => [newTx, ...prev]);
    });
    return unsub;
  }, [subscribe]);

  // Handlers
  const handleLoadMore = () => fetchTransactions(false);

  const openTokenApp = (tokenAddr: string, chain: string) => {
    addApp('token', { defaultAddress: tokenAddr, defaultChain: chain });
  };

  const openWalletApp = (addr: string) => {
    addApp('walletDetail', { walletAddress: addr }, undefined, `walletDetail-${addr}`);
  };

  return (
    <div className="flex flex-col h-full gap-2 p-2 overflow-hidden">
      {/* Filter row */}
      <div className="flex gap-1.5 shrink-0">
        <div className="w-24">
          <FilterDropdown
            options={TX_TYPE_OPTIONS}
            value={typeFilter}
            onChange={setTypeFilter}
            compact
          />
        </div>
        <div className="w-28">
          <ChainSelector
            value={chainFilter || chainOptions[0]}
            onChange={(c) => setChainFilter(c === chainOptions[0] && !chainFilter ? '' : c)}
            chains={chainOptions}
            size="sm"
          />
        </div>
        <div className="flex-1">
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            leftElement={<Search size={10} />}
            compact
          />
        </div>
      </div>

      {/* Transaction list */}
      <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
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
        ) : transactions.length === 0 ? (
          <div className="py-6 text-center">
            <ArrowUpDown size={24} className="mx-auto mb-2" style={{ color: 'var(--color-text-muted, #888)' }} />
            <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #888)' }}>
              NO TRANSACTIONS
            </div>
            <div className="font-mono text-[8px] mt-1" style={{ color: 'var(--color-text-faint, #aaa)' }}>
              {debouncedSearch ? 'Try a different search' : 'Transactions will appear here'}
            </div>
          </div>
        ) : (
          <>
            {transactions.map((tx) => {
              const typeColor = TX_TYPE_COLORS[tx.type] || 'var(--color-text-muted, #888)';
              const wallet = walletMap[tx.walletAddress.toLowerCase()];
              const walletLabel = wallet
                ? `${wallet.emoji || ''} ${wallet.name || tx.walletAddress.slice(0, 8)}`.trim()
                : tx.walletAddress.slice(0, 8) + '...';
              const explorerUrl = getChainConfig(tx.chain).explorer;

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
                              {parseFloat(tx.amount).toFixed(4)}
                            </span>
                          )}
                          {/* Wallet badge — clickable */}
                          <button
                            onClick={() => openWalletApp(tx.walletAddress)}
                            className="font-mono text-[8px] px-1 py-0.5 rounded-sm transition-colors truncate max-w-[100px]"
                            style={{
                              background: 'var(--color-background-alt, #f5f5f5)',
                              color: 'var(--color-text-muted, #888)',
                            }}
                            title={tx.walletAddress}
                          >
                            {walletLabel}
                          </button>
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          {tx.description && (
                            <div
                              className="font-mono text-[8px] truncate max-w-[200px]"
                              style={{ color: 'var(--color-text-muted, #888)' }}
                            >
                              {tx.description}
                            </div>
                          )}
                          {/* Token address — clickable */}
                          {tx.tokenAddress && (
                            <button
                              onClick={() => openTokenApp(tx.tokenAddress!, tx.chain)}
                              className="font-mono text-[7px] underline transition-colors shrink-0"
                              style={{ color: 'var(--color-info, #0047ff)' }}
                              title={tx.tokenAddress}
                            >
                              {tx.tokenAddress.slice(0, 6)}...{tx.tokenAddress.slice(-4)}
                            </button>
                          )}
                        </div>
                        {tx.txHash && (
                          <div className="flex items-center gap-1 mt-0.5">
                            <span
                              className="font-mono text-[7px]"
                              style={{ color: 'var(--color-text-faint, #aaa)' }}
                            >
                              tx:
                            </span>
                            {explorerUrl ? (
                              <a
                                href={`${explorerUrl}/tx/${tx.txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-mono text-[7px] transition-colors"
                                style={{ color: 'var(--color-text-faint, #aaa)' }}
                                title={tx.txHash}
                              >
                                {tx.txHash.slice(0, 10)}...{tx.txHash.slice(-6)}
                              </a>
                            ) : (
                              <span
                                className="font-mono text-[7px]"
                                style={{ color: 'var(--color-text-faint, #aaa)' }}
                                title={tx.txHash}
                              >
                                {tx.txHash.slice(0, 10)}...{tx.txHash.slice(-6)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="font-mono text-[7px]" style={{ color: 'var(--color-text-faint, #aaa)' }}>
                        {formatTimeAgo(tx.createdAt)}
                      </span>
                      {tx.txHash && explorerUrl && (
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

            {hasMore && (
              <button
                onClick={handleLoadMore}
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
          </>
        )}
      </div>
    </div>
  );
}

export { TransactionsApp };
export default TransactionsApp;
