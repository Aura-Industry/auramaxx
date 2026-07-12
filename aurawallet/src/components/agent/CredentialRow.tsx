'use client';

import React from 'react';
import { Key, CreditCard, FileText, Star, RefreshCw, Terminal, ShieldCheck, Wallet, Globe } from 'lucide-react';
import type { CredentialMeta } from './types';
import { getCredentialDisplayName } from './credentialDisplayName';

interface CredentialRowProps {
  credential: CredentialMeta;
  selected: boolean;
  onClick: () => void;
}

const typeIcons: Record<string, React.FC<{ size: number; className?: string }>> = {
  login: Key,
  card: CreditCard,
  sso: Globe,
  note: FileText,
  hot_wallet: Wallet,
  plain_note: FileText,
  apikey: Key,
  oauth2: RefreshCw,
  ssh: Terminal,
  gpg: ShieldCheck,
};

function getSubtitle(credential: CredentialMeta): string {
  switch (credential.type) {
    case 'login':
      return credential.meta.username || credential.meta.url || '';
    case 'card':
      return credential.meta.last4 ? `\u2022\u2022\u2022\u2022 ${credential.meta.last4}` : '';
    case 'sso': {
      const provider = String(credential.meta.provider || '').trim();
      const website = String(credential.meta.website || '').trim();
      if (provider && website) return `${provider} • ${website}`;
      return provider || website || 'SSO Login';
    }
    case 'note':
      return 'Secure Note';
    case 'hot_wallet':
      return (credential.meta.address as string) || (credential.meta.chain as string) || 'Hot Wallet';
    case 'plain_note':
      return (credential.meta.content as string) || (credential.meta.value as string) || 'Plain Note';
    case 'apikey':
      return (credential.meta.key as string) || 'API Key';
    case 'oauth2':
      return (credential.meta.scopes as string) || 'OAuth2';
    case 'ssh':
      return (credential.meta.fingerprint as string) || (credential.meta.key_type as string) || 'SSH Key';
    case 'gpg':
      return (credential.meta.key_id as string) || (credential.meta.uid_email as string) || 'GPG Key';
    default:
      return '';
  }
}

function getOAuth2ExpiryBadge(credential: CredentialMeta): { label: string; color: string; background: string } | null {
  if (credential.type !== 'oauth2') return null;
  const expiresAt = credential.meta.expires_at as number | null | undefined;
  if (!expiresAt) {
    return {
      label: 'No token',
      color: 'var(--color-text-muted,#6b7280)',
      background: 'var(--color-background-alt,#f4f4f5)',
    };
  }
  const now = Math.floor(Date.now() / 1000);
  if (now >= expiresAt) {
    return {
      label: 'Expired',
      color: 'var(--color-danger,#ef4444)',
      background: 'color-mix(in srgb, var(--color-danger,#ef4444) 12%, transparent)',
    };
  }
  const remaining = expiresAt - now;
  if (remaining < 300) {
    return {
      label: '<5m',
      color: 'var(--color-warning,#ff4d00)',
      background: 'color-mix(in srgb, var(--color-warning,#ff4d00) 12%, transparent)',
    };
  }
  return {
    label: remaining < 3600 ? `${Math.floor(remaining / 60)}m` : `${Math.floor(remaining / 3600)}h`,
    color: 'var(--color-success,#00c853)',
    background: 'color-mix(in srgb, var(--color-success,#00c853) 12%, transparent)',
  };
}

export const CredentialRow: React.FC<CredentialRowProps> = ({ credential, selected, onClick }) => {
  const Icon = typeIcons[credential.type] || FileText;
  const subtitle = getSubtitle(credential);
  const displayName = getCredentialDisplayName(credential);
  const isFavorite = credential.meta.favorite;

  return (
    <div
      onClick={onClick}
      className={`flex items-center cursor-pointer border-b border-[var(--color-credential-array-border,#8d8d95)] transition-all hover:bg-[var(--color-background-alt,#f4f4f5)] hover:shadow-mech-hover ${selected ? 'corner-marks' : ''}`}
      style={{
        gap: 'var(--space-sm)',
        padding: 'var(--space-sm) var(--space-md)',
        borderLeft: selected ? '2px solid var(--color-accent, #ccff00)' : '2px solid transparent',
        background: selected ? 'var(--color-background-alt, #f4f4f5)' : undefined,
      }}
    >
      <Icon size={14} className="text-[var(--color-text-muted,#6b7280)] flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-mono text-[11px] font-semibold text-[var(--color-text,#0a0a0a)] truncate">
          {displayName}
        </div>
        {subtitle && (
          <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] truncate">
            {subtitle}
          </div>
        )}
      </div>
      {(() => {
        const badge = getOAuth2ExpiryBadge(credential);
        return badge ? (
          <span
            className="flex-shrink-0 font-mono text-[8px] font-semibold px-1.5 py-0.5 rounded-sm"
            style={{ color: badge.color, background: badge.background, borderRadius: 'var(--radius-sm)' }}
          >
            {badge.label}
          </span>
        ) : null;
      })()}
      {isFavorite && (
        <Star
          size={10}
          className="flex-shrink-0 text-[var(--color-favorite,#ff4d00)] fill-[var(--color-favorite,#ff4d00)]"
        />
      )}
    </div>
  );
};
