'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Send, Loader2, Check, Wallet, RefreshCw, AlertTriangle, Lock } from 'lucide-react';
import { parseEther } from 'ethers';
import { api, Api } from '@/lib/api';
import { Button, TextInput, FilterDropdown } from '@/components/design-system';
import { useBalance } from '@/hooks/useBalance';
import { useAuth } from '@/context/AuthContext';

interface WalletData {
  address: string;
  tier: 'cold' | 'hot' | 'temp';
  balance?: string;
  label?: string;
  name?: string;
  tokenHash?: string;
}

interface TokenSpendingInfo {
  tokenHash: string;
  limit: number;
  spent: number;
  remaining: number;
}

interface SendAppProps {
  config?: {
    defaultFrom?: string;
    defaultTo?: string;
  };
}

interface DefaultItem {
  key: string;
  value: unknown;
}

interface DefaultsResponse {
  success: boolean;
  defaults: Record<string, DefaultItem[]>;
}

export default function SendApp({ config }: SendAppProps) {
  const { isUnlocked } = useAuth();
  const [wallets, setWallets] = useState<WalletData[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendFrom, setSendFrom] = useState(config?.defaultFrom || '');
  const [sendTo, setSendTo] = useState(config?.defaultTo || '');
  const [sendAmount, setSendAmount] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [tokenSpending, setTokenSpending] = useState<TokenSpendingInfo[]>([]);
  const [gasBuffers, setGasBuffers] = useState({ evm: 0.001, sol: 0.000005 });

  // Determine chain from selected wallet
  const selectedChain = useMemo(() => {
    const w = wallets.find(w => w.address === sendFrom);
    return (w as WalletData & { chain?: string })?.chain;
  }, [wallets, sendFrom]);

  const isSolana = selectedChain === 'solana' || selectedChain === 'solana-devnet';
  const nativeCurrency = isSolana ? 'SOL' : 'ETH';
  const gasBuffer = isSolana ? gasBuffers.sol : gasBuffers.evm;

  // Fetch balance from RPC for selected wallet
  const { balance, loading: balanceLoading, refetch: refetchBalance } = useBalance(sendFrom || undefined, selectedChain);

  // Get selected wallet metadata
  const selectedWallet = useMemo(() => {
    return wallets.find(w => w.address === sendFrom);
  }, [wallets, sendFrom]);

  // Find spending info for the selected wallet's token
  const walletSpending = useMemo(() => {
    if (!selectedWallet?.tokenHash) return null;
    return tokenSpending.find(t => t.tokenHash === selectedWallet.tokenHash) ?? null;
  }, [selectedWallet, tokenSpending]);

  // Parse balance as number for MAX button
  const availableBalance = useMemo(() => {
    if (!balance) return 0;
    const parsed = parseFloat(balance);
    return isNaN(parsed) ? 0 : parsed;
  }, [balance]);

  useEffect(() => {
    if (!isUnlocked) {
      setLoading(false);
      return;
    }
    async function fetchWallets() {
      try {
        const data = await api.get<{ wallets: WalletData[] }>(Api.Wallet, '/wallets', { includeHidden: true });
        if (data.wallets) {
          const hotWallets = data.wallets.filter((w: WalletData) => w.tier === 'hot');
          setWallets(hotWallets);
          if (!sendFrom && hotWallets.length > 0) {
            setSendFrom(hotWallets[0].address);
          }
        }
      } catch (err) {
        console.error('Failed to fetch wallets:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchWallets();
  }, [sendFrom, isUnlocked]);

  // Fetch agent token spending data
  useEffect(() => {
    if (!isUnlocked) return;
    async function fetchTokenSpending() {
      try {
        const data = await api.get<{
          success: boolean;
          tokens?: { active: Array<{ tokenHash: string; limit: number; spent: number; remaining: number }> };
        }>(Api.Wallet, '/dashboard');
        if (data.success && data.tokens?.active) {
          setTokenSpending(data.tokens.active.map(t => ({
            tokenHash: t.tokenHash,
            limit: t.limit,
            spent: t.spent,
            remaining: t.remaining,
          })));
        }
      } catch {
        // Non-critical - spending display is informational
      }
    }
    fetchTokenSpending();
  }, [isUnlocked]);

  useEffect(() => {
    if (!isUnlocked) return;
    async function fetchDefaults() {
      try {
        const data = await api.get<DefaultsResponse>(Api.Wallet, '/defaults');
        const flat = Object.values(data.defaults || {}).flat();
        const byKey = new Map(flat.map((item) => [item.key, item.value]));
        const evm = Number(byKey.get('gas.evm_buffer'));
        const sol = Number(byKey.get('gas.sol_buffer'));
        setGasBuffers({
          evm: Number.isFinite(evm) ? evm : 0.001,
          sol: Number.isFinite(sol) ? sol : 0.000005,
        });
      } catch {
        // Optional defaults endpoint; keep local fallbacks.
      }
    }
    void fetchDefaults();
  }, [isUnlocked]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    setSendResult(null);
    setError(null);

    try {
      // Convert user input (ETH/SOL decimal) to wei/lamports for the API
      let amountWei: string;
      if (isSolana) {
        // SOL has 9 decimals (lamports)
        amountWei = BigInt(Math.round(parseFloat(sendAmount) * 1e9)).toString();
      } else {
        // ETH has 18 decimals (wei)
        amountWei = parseEther(sendAmount).toString();
      }
      const data = await api.post<{ success: boolean; error?: string; hash?: string }>(Api.Wallet, '/send', { from: sendFrom, to: sendTo, amount: amountWei, chain: selectedChain });
      if (!data.success) throw new Error(data.error);
      setSendResult(data.hash ?? null);
      setSendTo('');
      setSendAmount('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSending(false);
    }
  };

  const handleMax = () => {
    const maxAmount = Math.max(0, availableBalance - gasBuffer);
    setSendAmount(maxAmount.toFixed(6));
  };

  if (!isUnlocked) {
    return (
      <div className="py-6 text-center">
        <Lock size={20} className="mx-auto mb-2" style={{ color: 'var(--color-text-muted, #6b7280)' }} />
        <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #6b7280)' }}>AGENT LOCKED</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="py-6 text-center">
        <Loader2 size={20} className="mx-auto mb-2 animate-spin" style={{ color: 'var(--color-text-muted, #6b7280)' }} />
        <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #6b7280)' }}>LOADING...</div>
      </div>
    );
  }

  if (wallets.length === 0) {
    return (
      <div className="py-6 text-center">
        <Send size={20} className="mx-auto mb-2" style={{ color: 'var(--color-text-muted, #6b7280)' }} />
        <div className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #6b7280)' }}>NO HOT WALLETS</div>
        <div className="font-mono text-[8px] mt-1" style={{ color: 'var(--color-text-faint, #9ca3af)' }}>Create a hot wallet first</div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSend} className="space-y-3">
      {/* Wallet selector */}
      <FilterDropdown
        label="FROM"
        value={sendFrom}
        onChange={setSendFrom}
        options={wallets.map((w) => ({
          value: w.address,
          label: w.name || w.label || 'HOT',
        }))}
        compact
      />

      {/* Balance display */}
      {selectedWallet && (
        <div
          className="p-2 rounded-sm"
          style={{
            backgroundColor: 'var(--color-background-alt, #f4f4f5)',
            border: '1px solid var(--color-border, #d4d4d8)',
          }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Wallet size={12} style={{ color: 'var(--color-text-muted, #6b7280)' }} />
              <span className="font-mono text-[9px]" style={{ color: 'var(--color-text-muted, #6b7280)' }}>
                BALANCE
              </span>
            </div>
            <div className="flex items-center gap-2">
              {balanceLoading ? (
                <Loader2 size={12} className="animate-spin" style={{ color: 'var(--color-text-muted, #6b7280)' }} />
              ) : (
                <span className="font-mono text-[11px] font-bold" style={{ color: 'var(--color-text, #0a0a0a)' }}>
                  {availableBalance.toFixed(isSolana ? 9 : 8)} {nativeCurrency}
                </span>
              )}
              <button
                type="button"
                onClick={refetchBalance}
                disabled={balanceLoading}
                className="p-0.5 transition-colors disabled:opacity-50"
              >
                <RefreshCw size={10} className={balanceLoading ? 'animate-spin' : ''} style={{ color: 'var(--color-text-muted, #6b7280)' }} />
              </button>
            </div>
          </div>
          {!balanceLoading && availableBalance < 0.001 && (
            <div className="flex items-center gap-1 mt-1.5">
              <AlertTriangle size={10} style={{ color: 'var(--color-warning, #ff4d00)' }} />
              <span className="font-mono text-[8px]" style={{ color: 'var(--color-warning, #ff4d00)' }}>
                Insufficient balance for gas
              </span>
            </div>
          )}
          {/* Agent spending limit */}
          {walletSpending && walletSpending.limit > 0 && (
            <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--color-border, #d4d4d8)' }}>
              <div
                className="h-1.5 rounded-full overflow-hidden"
                style={{ background: 'var(--color-background-alt, #f4f4f5)' }}
              >
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min((walletSpending.spent / walletSpending.limit) * 100, 100)}%`,
                    background:
                      walletSpending.spent / walletSpending.limit > 0.8
                        ? 'var(--color-warning, #ff4d00)'
                        : 'var(--color-info, #0047ff)',
                  }}
                />
              </div>
              <div className="flex justify-between mt-1">
                <span
                  className="font-mono text-[8px]"
                  style={{ color: 'var(--color-text-muted, #6b7280)' }}
                >
                  REMAINING
                </span>
                <span
                  className="font-mono text-[8px] font-medium"
                  style={{ color: 'var(--color-info, #0047ff)' }}
                >
                  {walletSpending.remaining.toFixed(4)} / {walletSpending.limit} {nativeCurrency}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      <TextInput
        label="TO"
        value={sendTo}
        onChange={(e) => setSendTo(e.target.value)}
        placeholder="0x..."
        required
        compact
      />

      {/* Amount with MAX button */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label
            className="font-mono text-[9px] font-bold uppercase tracking-widest"
            style={{ color: 'var(--color-text-muted, #6b7280)' }}
          >
            AMOUNT ({nativeCurrency})
          </label>
          <button
            type="button"
            onClick={handleMax}
            className="font-mono text-[8px] font-bold px-1.5 py-0.5 transition-colors"
            style={{
              backgroundColor: 'var(--color-background-alt, #f4f4f5)',
              color: 'var(--color-info, #0047ff)',
              border: '1px solid var(--color-border, #d4d4d8)',
            }}
          >
            MAX
          </button>
        </div>
        <TextInput
          type="number"
          step="0.0001"
          value={sendAmount}
          onChange={(e) => setSendAmount(e.target.value)}
          placeholder="0.01"
          required
          compact
        />
      </div>

      {error && (
        <div
          className="p-2"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--color-warning, #ff4d00) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-warning, #ff4d00) 30%, transparent)',
          }}
        >
          <div className="font-mono text-[9px]" style={{ color: 'var(--color-warning, #ff4d00)' }}>{error}</div>
        </div>
      )}

      {sendResult && (
        <div
          className="p-2"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--color-accent, #ccff00) 20%, transparent)',
            border: '1px solid var(--color-accent, #ccff00)',
          }}
        >
          <div className="flex items-center gap-1 mb-1">
            <Check size={10} style={{ color: 'var(--color-text, #0a0a0a)' }} />
            <span className="font-mono text-[9px] font-bold" style={{ color: 'var(--color-text, #0a0a0a)' }}>SENT</span>
          </div>
          <div className="font-mono text-[8px]" style={{ color: 'var(--color-text-muted, #6b7280)' }}>
            TX: {sendResult.slice(0, 20)}...
          </div>
        </div>
      )}

      <Button
        type="submit"
        disabled={sending || !sendFrom}
        loading={sending}
        icon={!sending ? <Send size={10} /> : undefined}
        className="w-full"
      >
        {sending ? 'SENDING...' : 'SEND'}
      </Button>
    </form>
  );
}
