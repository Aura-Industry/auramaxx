'use client';

import React, { useEffect, useState } from 'react';
import { Check, Copy, Link2 } from 'lucide-react';
import { Button, FilterDropdown, Modal, TextInput } from '@/components/design-system';
import { api, Api } from '@/lib/api';

interface CredentialShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  credentialId: string;
  credentialName: string;
}

type ExpiryPreset = '15m' | '1h' | '24h' | '7d' | '30d';
type AccessMode = 'anyone' | 'password';

const EXPIRY_OPTIONS: { value: ExpiryPreset; label: string }[] = [
  { value: '15m', label: '15 Minutes' },
  { value: '1h', label: '1 Hour' },
  { value: '24h', label: '24 Hours' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
];

const ACCESS_OPTIONS: { value: AccessMode; label: string }[] = [
  { value: 'anyone', label: 'Anyone with link' },
  { value: 'password', label: 'Set password' },
];

export const CredentialShareModal: React.FC<CredentialShareModalProps> = ({
  isOpen,
  onClose,
  credentialId,
  credentialName,
}) => {
  const [expiresAfter, setExpiresAfter] = useState<ExpiryPreset>('24h');
  const [accessMode, setAccessMode] = useState<AccessMode>('anyone');
  const [sharePassword, setSharePassword] = useState('');
  const [oneTimeOnly, setOneTimeOnly] = useState(false);

  const [gistCopied, setGistCopied] = useState(false);
  const [gistGenerating, setGistGenerating] = useState(false);
  const [gistError, setGistError] = useState<string | null>(null);
  const [gistLink, setGistLink] = useState('');

  const [linkCopied, setLinkCopied] = useState(false);
  const [linkGenerating, setLinkGenerating] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setGistError(null);
    setGistCopied(false);
    setGistLink('');
    setLinkError(null);
    setLinkCopied(false);
  }, [isOpen]);

  const resolveSharePageUrl = (token: string): string => `${window.location.origin}/share/${token}`;

  const validateOptions = (): string | null => {
    if (accessMode === 'password' && !sharePassword.trim()) {
      return 'Password is required when access mode is Set password';
    }
    return null;
  };

  const handleCopySecretGist = async () => {
    setGistError(null);
    const validationError = validateOptions();
    if (validationError) {
      setGistError(validationError);
      return;
    }

    try {
      setGistGenerating(true);
      setGistCopied(false);
      const res = await api.post<{
        success: boolean;
        gist: {
          url: string;
          marker: string;
          identifier: string;
          title: string;
        };
        share: {
          token: string;
          credentialId: string;
          expiresAt: number;
          accessMode: AccessMode;
          oneTimeOnly: boolean;
        };
        link: string;
      }>(Api.Wallet, '/credential-shares/gist', {
        credentialId,
        expiresAfter,
        accessMode,
        oneTimeOnly,
        shareBaseUrl: window.location.origin,
        ...(accessMode === 'password' ? { password: sharePassword } : {}),
      });

      setGistLink(res.gist.url);
      await navigator.clipboard.writeText(res.gist.url);
      setGistCopied(true);
      setTimeout(() => setGistCopied(false), 2000);
    } catch {
      setGistError(
        `Failed to create secret gist. Check "gh auth status" in terminal. If needed, run "gh auth login".`,
      );
    } finally {
      setGistGenerating(false);
    }
  };

  const handleCopyShareLink = async () => {
    setLinkError(null);
    const validationError = validateOptions();
    if (validationError) {
      setLinkError(validationError);
      return;
    }

    try {
      setLinkGenerating(true);
      const res = await api.post<{
        success: boolean;
        share: {
          token: string;
          credentialId: string;
          expiresAt: number;
          accessMode: AccessMode;
          oneTimeOnly: boolean;
        };
      }>(Api.Wallet, '/credential-shares', {
        credentialId,
        expiresAfter,
        accessMode,
        oneTimeOnly,
        ...(accessMode === 'password' ? { password: sharePassword } : {}),
      });

      const link = resolveSharePageUrl(res.share.token);
      await navigator.clipboard.writeText(link);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Failed to generate share link');
    } finally {
      setLinkGenerating(false);
    }
  };

  const handleClose = () => {
    setGistError(null);
    setGistCopied(false);
    setGistGenerating(false);
    setGistLink('');
    setLinkError(null);
    setLinkCopied(false);
    setLinkGenerating(false);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={`Sharing ${credentialName}`}
      icon={<Link2 size={16} className="text-[var(--color-text,#0a0a0a)]" />}
      size="md"
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={handleClose}>
            CLOSE
          </Button>
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="font-mono text-[8px] uppercase tracking-widest text-[var(--color-text-faint,#9ca3af)]">
            GitHub Gist (Recommended)
          </div>
          <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">
            Check <span className="text-[var(--color-text,#0a0a0a)]">`gh auth status`</span> first; run <span className="text-[var(--color-text,#0a0a0a)]">`gh auth login`</span> only if needed.
          </div>
          <div className="flex items-center justify-between gap-2">
            {gistLink ? (
              <a
                href={gistLink}
                target="_blank"
                rel="noreferrer"
                className="flex-1 min-w-0 font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] truncate hover:underline"
                title={gistLink}
              >
                {gistLink}
              </a>
            ) : (
              <div className="flex-1 min-w-0 font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] truncate">
                Click SHARE GIST to generate a link.
              </div>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleCopySecretGist}
              loading={gistGenerating}
              className="shrink-0 whitespace-nowrap"
            >
              {gistCopied ? <Check size={10} /> : <Copy size={10} />}
              {gistCopied ? 'COPIED' : 'SHARE GIST'}
            </Button>
          </div>
          {gistError && (
            <div className="font-mono text-[9px] text-[var(--color-danger,#ef4444)]">
              {gistError}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="font-mono text-[8px] uppercase tracking-widest text-[var(--color-text-faint,#9ca3af)]">
            Share Link (Local)
          </div>
          <FilterDropdown
            label="Link Expires After"
            options={EXPIRY_OPTIONS}
            value={expiresAfter}
            onChange={(value) => setExpiresAfter(value as ExpiryPreset)}
            compact
          />
          <FilterDropdown
            label="Available To"
            options={ACCESS_OPTIONS}
            value={accessMode}
            onChange={(value) => setAccessMode(value as AccessMode)}
            compact
          />
          {accessMode === 'password' && (
            <TextInput
              label="Share Password"
              type="password"
              value={sharePassword}
              onChange={(e) => setSharePassword(e.target.value)}
              placeholder="Enter password"
              compact
            />
          )}
          <div className="flex items-center justify-between gap-2">
            <label className="flex flex-1 min-w-0 items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={oneTimeOnly}
                onChange={(e) => setOneTimeOnly(e.target.checked)}
                className="accent-[var(--color-accent,#ccff00)]"
              />
              <span className="font-mono text-[10px] text-[var(--color-text,#0a0a0a)] truncate">
                Can only be viewed one time
              </span>
            </label>
            <Button
              variant="primary"
              size="sm"
              onClick={handleCopyShareLink}
              loading={linkGenerating}
              className="shrink-0 whitespace-nowrap"
            >
              {linkCopied ? <Check size={10} /> : <Copy size={10} />}
              {linkCopied ? 'COPIED' : 'COPY LINK'}
            </Button>
          </div>
          {linkError && (
            <div className="font-mono text-[9px] text-[var(--color-danger,#ef4444)]">
              {linkError}
            </div>
          )}
        </div>

      </div>
    </Modal>
  );
};
