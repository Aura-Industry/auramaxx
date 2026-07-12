'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, Wallet } from 'lucide-react';
import { api, Api } from '@/lib/api';
import type { WalletLinkMetaV1 } from './types';

interface WalletSummary {
  address: string;
  tier: 'cold' | 'hot' | 'temp';
  chain: string;
  balance?: string;
  name?: string;
  label?: string;
}

interface CredentialWalletWidgetProps {
  walletLink: WalletLinkMetaV1;
}

const shortAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

function explorerUrl(chain: string, address: string): string {
  if (chain === 'solana' || chain === 'solana-devnet') return `https://solscan.io/account/${address}`;
  if (chain === 'polygon') return `https://polygonscan.com/address/${address}`;
  if (chain === 'ethereum') return `https://etherscan.io/address/${address}`;
  return `https://basescan.org/address/${address}`;
}

export const CredentialWalletWidget: React.FC<CredentialWalletWidgetProps> = ({ walletLink }) => {
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [copyOk, setCopyOk] = useState(false);
  const normalizedChain = walletLink.chain.toLowerCase();

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await api.get<{ wallets: WalletSummary[] }>(Api.Wallet, '/wallets');
        const match = (res.wallets || []).find((w) =>
          w.address.toLowerCase() === walletLink.walletAddress.toLowerCase() && w.chain.toLowerCase() === normalizedChain,
        ) || null;
        if (mounted) setWallet(match);
      } catch {
        if (mounted) setWallet(null);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [walletLink.walletAddress, normalizedChain, walletLink.chain]);

  const resolvedName = useMemo(() => wallet?.name || wallet?.label || walletLink.label || 'Linked Wallet', [wallet, walletLink.label]);

  return (
    <div className="mt-2 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background-alt,#f4f4f5)] p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)] inline-flex items-center gap-1">
          <Wallet size={11} /> Linked Wallet
        </div>
        <div className="font-mono text-[8px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
          {walletLink.tier} · {walletLink.chain}
        </div>
      </div>

      <div className="font-mono text-[11px] text-[var(--color-text,#0a0a0a)] mb-1">{resolvedName}</div>
      <div className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)] mb-2 break-all">
        {walletLink.walletAddress}
      </div>

      {loading ? (
        <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">Loading wallet state…</div>
      ) : wallet ? (
        <div className="font-mono text-[9px] text-[var(--color-success,#22c55e)] mb-2">Wallet resolved{wallet.balance ? ` · Balance: ${wallet.balance}` : ''}</div>
      ) : (
        <div className="font-mono text-[9px] text-[var(--color-warning,#f59e0b)] mb-2">Stale link: wallet not found in current wallet list</div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          className="px-2 py-1 border border-[var(--color-border,#d4d4d8)] font-mono text-[9px]"
          onClick={async () => {
            await navigator.clipboard.writeText(walletLink.walletAddress);
            setCopyOk(true);
            setTimeout(() => setCopyOk(false), 1200);
          }}
        >
          <span className="inline-flex items-center gap-1"><Copy size={10} /> {copyOk ? 'COPIED' : shortAddress(walletLink.walletAddress)}</span>
        </button>
        <a
          href={explorerUrl(normalizedChain, walletLink.walletAddress)}
          target="_blank"
          rel="noreferrer"
          className="px-2 py-1 border border-[var(--color-border,#d4d4d8)] font-mono text-[9px] inline-flex items-center gap-1"
        >
          <ExternalLink size={10} /> Explorer
        </a>
      </div>
    </div>
  );
};
