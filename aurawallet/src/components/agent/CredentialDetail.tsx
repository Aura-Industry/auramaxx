'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Star } from 'lucide-react';
import { Button, ConfirmationModal } from '@/components/design-system';
import { api, Api } from '@/lib/api';
import { CREDENTIAL_FIELD_KEYS, NOTE_CONTENT_KEY } from '@/lib/credential-field-schema';
import { CredentialField } from './CredentialField';
import { TOTPDisplay } from './TOTPDisplay';
import { LargeTypeModal } from './LargeTypeModal';
import { CredentialShareModal } from './CredentialShareModal';
import { CredentialWalletWidget } from './CredentialWalletWidget';
import { getCredentialDisplayName } from './credentialDisplayName';
import type { CredentialMeta, CredentialLifecycleFilter, WalletLinkMetaV1 } from './types';

interface CredentialDetailProps {
  credential: CredentialMeta;
  agentName: string;
  lifecycle: CredentialLifecycleFilter;
  onEdit: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onDuplicate?: () => void;
  onFavoriteChange?: (credentialId: string, favorite: boolean) => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export const CredentialDetail: React.FC<CredentialDetailProps> = ({
  credential,
  agentName,
  lifecycle,
  onEdit,
  onDelete,
  onRestore,
  onDuplicate,
  onFavoriteChange,
}) => {
  const [largeTypeValue, setLargeTypeValue] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [reauthMessage, setReauthMessage] = useState<string | null>(null);
  const [reauthLoading, setReauthLoading] = useState(false);
  const [reauthUrl, setReauthUrl] = useState<string | null>(null);
  const [reauthState, setReauthState] = useState<string | null>(null);
  const [reauthCode, setReauthCode] = useState('');
  const [isFavorite, setIsFavorite] = useState(Boolean(credential.meta.favorite));
  const [favoriteUpdating, setFavoriteUpdating] = useState(false);

  const handleShowLargeType = (value: string) => {
    setLargeTypeValue(value);
  };

  useEffect(() => {
    setReauthMessage(null);
    setReauthLoading(false);
    setReauthUrl(null);
    setReauthState(null);
    setReauthCode('');
    setIsFavorite(Boolean(credential.meta.favorite));
    setFavoriteUpdating(false);
  }, [credential.id, credential.meta.favorite]);

  const handleReauthStart = useCallback(async () => {
    setReauthLoading(true);
    setReauthMessage(null);
    try {
      const res = await api.post<{
        success: boolean;
        message?: string;
        authorization_url?: string;
        state?: string;
      }>(Api.Wallet, `/credentials/${credential.id}/reauth`);
      setReauthUrl(res.authorization_url || null);
      setReauthState(res.state || null);
      setReauthMessage(res.message || 'Authorization URL generated. Complete provider consent, then paste code.');
    } catch (err) {
      setReauthMessage(err instanceof Error ? err.message : 'Failed to start re-auth');
    } finally {
      setReauthLoading(false);
    }
  }, [credential.id]);

  const handleReauthComplete = useCallback(async () => {
    if (!reauthCode.trim() || !reauthState) {
      setReauthMessage('Enter authorization code after consent to complete re-auth.');
      return;
    }
    setReauthLoading(true);
    try {
      const res = await api.post<{ success: boolean; message?: string }>(Api.Wallet, `/credentials/${credential.id}/reauth`, {
        code: reauthCode.trim(),
        state: reauthState,
      });
      setReauthMessage(res.message || 'Re-auth complete. Refresh credential details.');
      setReauthCode('');
    } catch (err) {
      setReauthMessage(err instanceof Error ? err.message : 'Failed to complete re-auth');
    } finally {
      setReauthLoading(false);
    }
  }, [credential.id, reauthCode, reauthState]);

  const handleToggleFavorite = useCallback(async () => {
    if (favoriteUpdating) return;

    const nextFavorite = !isFavorite;
    setIsFavorite(nextFavorite);
    setFavoriteUpdating(true);

    try {
      await api.put(Api.Wallet, `/credentials/${credential.id}`, {
        meta: {
          ...credential.meta,
          favorite: nextFavorite,
        },
      });
      onFavoriteChange?.(credential.id, nextFavorite);
    } catch (err) {
      setIsFavorite(!nextFavorite);
      console.error('[CredentialDetail] failed to update favorite', err);
    } finally {
      setFavoriteUpdating(false);
    }
  }, [credential.id, credential.meta, favoriteUpdating, isFavorite, onFavoriteChange]);

  const typeLabelMap: Record<string, string> = {
    login: 'Login',
    card: 'Card',
    sso: 'SSO Login',
    note: 'Note',
    plain_note: 'Plain Note',
    hot_wallet: 'Hot Wallet',
    apikey: 'API Key',
    custom: 'Key / Value',
    oauth2: 'OAuth2',
    ssh: 'SSH Key',
    gpg: 'GPG Key',
  };
  const typeLabel = typeLabelMap[credential.type] || credential.type.charAt(0).toUpperCase() + credential.type.slice(1);
  // If sensitive_field_keys is present, use it to conditionally render optional fields like notes.
  // If absent (old credentials), default to empty — hides optional fields rather than showing broken ones.
  const sensitiveKeys: string[] = (credential.meta.sensitive_field_keys as string[] | undefined) ?? [];
  const walletLink = (credential.meta.walletLink as WalletLinkMetaV1 | undefined);
  const isActiveLifecycle = lifecycle === 'active';

  const deleteButtonLabel = isActiveLifecycle
    ? 'ARCHIVE'
    : lifecycle === 'archive'
      ? 'DELETE'
      : 'PURGE';
  const deleteConfirmLabel = lifecycle === 'recently_deleted' ? 'PURGE' : 'CONFIRM';
  const deleteModalTitle = isActiveLifecycle
    ? 'Archive Credential'
    : lifecycle === 'archive'
      ? 'Delete Credential'
      : 'Purge Credential';
  const deleteModalVariant = lifecycle === 'recently_deleted' ? 'danger' as const : 'warning' as const;
  const deleteMessage = isActiveLifecycle
    ? 'This credential will be moved to Archive.'
    : lifecycle === 'archive'
      ? 'This credential will be moved to Recently Deleted.'
      : 'This credential will be permanently deleted now.';
  const displayName = getCredentialDisplayName(credential);
  const restoreLabel = lifecycle === 'archive' ? 'RESTORE' : 'RESTORE TO ARCHIVE';
  const sensitiveFieldBehavior = {
    sensitiveClickBehavior: 'copy' as const,
  };

  return (
    <div className="h-full min-h-0 p-6 flex flex-col relative">
      {/* Vertical classification label */}
      <div className="absolute top-6 -left-1 text-vertical label-specimen-sm text-[var(--color-text-faint,#9ca3af)] select-none opacity-40 hidden lg:block">
        CLASSIFIED
      </div>

      {/* Header */}
      <div className="mb-6">
        <div className="group/title flex items-center gap-2">
          <h2 className="font-mono font-bold text-lg text-[var(--color-text,#0a0a0a)]">
            {displayName}
          </h2>
          <button
            type="button"
            onClick={() => void handleToggleFavorite()}
            disabled={favoriteUpdating}
            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            data-testid="favorite-toggle"
            className={`inline-flex h-5 w-5 items-center justify-center transition-opacity disabled:opacity-60 ${
              isFavorite ? 'opacity-100' : 'opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100'
            }`}
          >
            <Star
              size={13}
              className={`flex-shrink-0 text-[var(--color-favorite,#ff4d00)] ${
                isFavorite ? 'fill-[var(--color-favorite,#ff4d00)]' : 'fill-transparent'
              }`}
            />
          </button>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="shard-start inline-block bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] font-mono text-[8px] font-bold uppercase tracking-widest px-2 py-0.5">
            {typeLabel}
          </span>
          <span className="font-mono text-[9px] uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
            {agentName}
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pr-1">
        {/* Fields */}
        <div className="space-y-0.5">
        {credential.type === 'login' && (
          <>
            <CredentialField
              label="URL"
              value={credential.meta.url}
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.login.url}
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            <CredentialField
              label="Username"
              value={credential.meta.username}
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.login.username}
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            <CredentialField
              label="Password"
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.login.password}
              isSensitive={true}
              onShowLargeType={handleShowLargeType}
              {...sensitiveFieldBehavior}
            />
            {isActiveLifecycle && <TOTPDisplay credentialId={credential.id} />}
            {(sensitiveKeys.includes(CREDENTIAL_FIELD_KEYS.login.notes)) && (
              <CredentialField
                label="Notes"
                credentialId={credential.id}
                fieldKey={CREDENTIAL_FIELD_KEYS.login.notes}
                isSensitive={true}
                onShowLargeType={handleShowLargeType}
                {...sensitiveFieldBehavior}
              />
            )}
          </>
        )}

        {credential.type === 'card' && (
          <>
            <CredentialField
              label="Cardholder"
              value={credential.meta.cardholder}
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.card.cardholder}
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            <CredentialField
              label="Brand"
              value={credential.meta.brand}
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.card.brand}
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            {credential.meta.last4 && (
              <CredentialField
                label="Card"
                value={`•••• ${credential.meta.last4}`}
                credentialId={credential.id}
                fieldKey={CREDENTIAL_FIELD_KEYS.card.last4}
                isSensitive={false}
                onShowLargeType={handleShowLargeType}
              />
            )}
            <CredentialField
              label="Number"
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.card.number}
              isSensitive={true}
              onShowLargeType={handleShowLargeType}
              {...sensitiveFieldBehavior}
            />
            <CredentialField
              label="Expiry"
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.card.expiry}
              isSensitive={true}
              onShowLargeType={handleShowLargeType}
              {...sensitiveFieldBehavior}
            />
            <CredentialField
              label="CVV"
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.card.cvv}
              isSensitive={true}
              onShowLargeType={handleShowLargeType}
              {...sensitiveFieldBehavior}
            />
            <CredentialField
              label="Billing ZIP"
              value={credential.meta.billing_zip as string | undefined}
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.card.billingZip}
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            {(sensitiveKeys.includes(CREDENTIAL_FIELD_KEYS.card.notes)) && (
              <CredentialField
                label="Notes"
                credentialId={credential.id}
                fieldKey={CREDENTIAL_FIELD_KEYS.card.notes}
                isSensitive={true}
                onShowLargeType={handleShowLargeType}
                {...sensitiveFieldBehavior}
              />
            )}
          </>
        )}

        {credential.type === 'sso' && (
          <>
            <CredentialField
              label="Website"
              value={credential.meta.website as string | undefined}
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.sso.website}
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            <CredentialField
              label="Provider"
              value={credential.meta.provider as string | undefined}
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.sso.provider}
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            {credential.meta.identifier && (
              <CredentialField
                label="Identifier"
                value={credential.meta.identifier as string | undefined}
                credentialId={credential.id}
                fieldKey={CREDENTIAL_FIELD_KEYS.sso.identifier}
                isSensitive={false}
                onShowLargeType={handleShowLargeType}
              />
            )}
          </>
        )}

        {credential.type === 'note' && (
          <CredentialField
            label="Content"
            credentialId={credential.id}
            fieldKey={NOTE_CONTENT_KEY}
            isSensitive={true}
            onShowLargeType={handleShowLargeType}
            sensitiveInteractionMode="markdown-hover-copy"
            disableLargeType
          />
        )}

        {credential.type === 'plain_note' && (
          <CredentialField
            label="Content"
            value={(credential.meta[NOTE_CONTENT_KEY] as string | undefined) || (credential.meta.value as string | undefined)}
            credentialId={credential.id}
            fieldKey={NOTE_CONTENT_KEY}
            isSensitive={false}
            onShowLargeType={handleShowLargeType}
            renderMarkdown
            disableLargeType
          />
        )}

        {credential.type === 'apikey' && (
          <>
            <CredentialField
              label="Key"
              value={credential.meta.key as string | undefined}
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.apikey.key}
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            <CredentialField
              label="Value"
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.apikey.value}
              isSensitive={true}
              onShowLargeType={handleShowLargeType}
              sensitiveClickBehavior="copy"
            />
          </>
        )}

        {credential.type === 'hot_wallet' && (
          <>
            <CredentialField
              label="Address"
              value={(credential.meta.address as string | undefined) || walletLink?.walletAddress}
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.hot_wallet.address}
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            <CredentialField
              label="Chain"
              value={(credential.meta.chain as string | undefined) || walletLink?.chain}
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.hot_wallet.chain}
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            <CredentialField
              label="Private Key"
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.hot_wallet.privateKey}
              isSensitive={true}
              onShowLargeType={handleShowLargeType}
              {...sensitiveFieldBehavior}
            />
          </>
        )}


        {credential.type === 'custom' && (
          <>
            <CredentialField
              label="Key"
              value={(credential.meta.primaryKey as string | undefined) || 'value'}
              credentialId={credential.id}
              fieldKey="primaryKey"
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            <CredentialField
              label="Value"
              credentialId={credential.id}
              fieldKey={(credential.meta.primaryKey as string | undefined) || CREDENTIAL_FIELD_KEYS.custom.value}
              isSensitive={true}
              onShowLargeType={handleShowLargeType}
              {...sensitiveFieldBehavior}
            />
          </>
        )}
        {credential.type === 'ssh' && (
          <>
            <CredentialField label="Fingerprint" value={credential.meta.fingerprint as string | undefined} credentialId={credential.id} fieldKey={CREDENTIAL_FIELD_KEYS.ssh.fingerprint} isSensitive={false} onShowLargeType={handleShowLargeType} />
            <CredentialField label="Key Type" value={credential.meta.key_type as string | undefined} credentialId={credential.id} fieldKey={CREDENTIAL_FIELD_KEYS.ssh.keyType} isSensitive={false} onShowLargeType={handleShowLargeType} />
            <CredentialField label="Hosts" value={Array.isArray(credential.meta.hosts) ? (credential.meta.hosts as string[]).join(', ') : undefined} credentialId={credential.id} fieldKey={CREDENTIAL_FIELD_KEYS.ssh.hosts} isSensitive={false} onShowLargeType={handleShowLargeType} />
            <CredentialField label="Public Key" value={credential.meta.public_key as string | undefined} credentialId={credential.id} fieldKey={CREDENTIAL_FIELD_KEYS.ssh.publicKey} isSensitive={false} onShowLargeType={handleShowLargeType} />
            <CredentialField label="Private Key" credentialId={credential.id} fieldKey={CREDENTIAL_FIELD_KEYS.ssh.privateKey} isSensitive={true} onShowLargeType={handleShowLargeType} {...sensitiveFieldBehavior} />
            <CredentialField label="Passphrase" credentialId={credential.id} fieldKey={CREDENTIAL_FIELD_KEYS.ssh.passphrase} isSensitive={true} onShowLargeType={handleShowLargeType} {...sensitiveFieldBehavior} />
          </>
        )}

        {credential.type === 'gpg' && (
          <>
            <CredentialField label="Fingerprint" value={credential.meta.fingerprint as string | undefined} credentialId={credential.id} fieldKey={CREDENTIAL_FIELD_KEYS.gpg.fingerprint} isSensitive={false} onShowLargeType={handleShowLargeType} />
            <CredentialField label="Key ID" value={credential.meta.key_id as string | undefined} credentialId={credential.id} fieldKey={CREDENTIAL_FIELD_KEYS.gpg.keyId} isSensitive={false} onShowLargeType={handleShowLargeType} />
            <CredentialField label="UID Email" value={credential.meta.uid_email as string | undefined} credentialId={credential.id} fieldKey={CREDENTIAL_FIELD_KEYS.gpg.uidEmail} isSensitive={false} onShowLargeType={handleShowLargeType} />
            <CredentialField label="Expires At" value={credential.meta.expires_at as string | undefined} credentialId={credential.id} fieldKey={CREDENTIAL_FIELD_KEYS.gpg.expiresAt} isSensitive={false} onShowLargeType={handleShowLargeType} />
            <CredentialField label="Public Key" value={credential.meta.public_key as string | undefined} credentialId={credential.id} fieldKey={CREDENTIAL_FIELD_KEYS.gpg.publicKey} isSensitive={false} onShowLargeType={handleShowLargeType} />
            <CredentialField label="Private Key" credentialId={credential.id} fieldKey={CREDENTIAL_FIELD_KEYS.gpg.privateKey} isSensitive={true} onShowLargeType={handleShowLargeType} {...sensitiveFieldBehavior} />
          </>
        )}
        {credential.type === 'oauth2' && (
          <>
            <CredentialField
              label="Token Endpoint"
              value={credential.meta.token_endpoint as string | undefined}
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.oauth2.tokenEndpoint}
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            <CredentialField
              label="Scopes"
              value={credential.meta.scopes as string | undefined}
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.oauth2.scopes}
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            <CredentialField
              label="Auth Method"
              value={credential.meta.auth_method as string | undefined}
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.oauth2.authMethod}
              isSensitive={false}
              onShowLargeType={handleShowLargeType}
            />
            {(credential.meta.needs_reauth || reauthUrl) && (
              <div className="px-2 py-2 my-1 border border-[var(--color-danger,#ef4444)]/30 bg-[var(--color-danger,#ef4444)]/10 text-[var(--color-danger,#ef4444)] font-mono text-[10px]">
                ⚠️ Re-authentication required
                {!!credential.meta.reauth_reason && (
                  <span className="block text-[9px] text-[var(--color-danger,#ef4444)]/70 mt-0.5">
                    {String(credential.meta.reauth_reason as string)}
                  </span>
                )}
                <button
                  className="mt-1 px-2 py-0.5 bg-[var(--color-danger,#ef4444)]/20 hover:bg-[var(--color-danger,#ef4444)]/30 text-[var(--color-danger,#ef4444)] text-[9px] font-bold uppercase tracking-wider disabled:opacity-50"
                  onClick={handleReauthStart}
                  disabled={reauthLoading}
                >
                  {reauthLoading ? 'Loading…' : 'Start Re-auth'}
                </button>
                {reauthUrl && (
                  <a
                    href={reauthUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 ml-2 inline-block px-2 py-0.5 bg-[var(--color-danger,#ef4444)]/20 hover:bg-[var(--color-danger,#ef4444)]/30 text-[var(--color-danger,#ef4444)] text-[9px] font-bold uppercase tracking-wider"
                  >
                    Open Consent
                  </a>
                )}
                {reauthState && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      value={reauthCode}
                      onChange={(e) => setReauthCode(e.target.value)}
                      placeholder="Paste authorization code"
                      className="flex-1 px-2 py-1 border border-[var(--color-danger,#ef4444)]/30 bg-transparent text-[9px]"
                    />
                    <button
                      className="px-2 py-1 bg-[var(--color-danger,#ef4444)]/20 hover:bg-[var(--color-danger,#ef4444)]/30 text-[var(--color-danger,#ef4444)] text-[9px] font-bold uppercase tracking-wider disabled:opacity-50"
                      onClick={handleReauthComplete}
                      disabled={reauthLoading || !reauthCode.trim()}
                    >
                      Complete Re-auth
                    </button>
                  </div>
                )}
                {reauthMessage && (
                  <div className="mt-1 text-[9px] text-[var(--color-danger,#ef4444)]/90 break-words">
                    {reauthMessage}
                  </div>
                )}
              </div>
            )}
            {credential.meta.last_refreshed && (
              <div className="px-1 py-1">
                <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
                  Last Refreshed:{' '}
                </span>
                <span className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">
                  {new Date(String(credential.meta.last_refreshed)).toLocaleString()}
                </span>
              </div>
            )}
            {(() => {
              const expiresAt = credential.meta.expires_at as number | null | undefined;
              const now = Math.floor(Date.now() / 1000);
              const isExpired = !expiresAt || now >= expiresAt;
              const expiryLabel = !expiresAt
                ? 'No token yet'
                : isExpired
                  ? 'Expired — will auto-refresh on next read'
                  : `Valid for ${Math.floor((expiresAt - now) / 60)}m`;
              return (
                <div className="px-1 py-2">
                  <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted,#6b7280)]">
                    Token Status:{' '}
                  </span>
                  <span
                    className="font-mono text-[10px] font-bold"
                    style={{ color: isExpired ? 'var(--color-danger,#ef4444)' : 'var(--color-success,#00c853)' }}
                  >
                    {expiryLabel}
                  </span>
                </div>
              );
            })()}
            <CredentialField
              label="Access Token"
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.oauth2.accessToken}
              isSensitive={true}
              onShowLargeType={handleShowLargeType}
              {...sensitiveFieldBehavior}
            />
            <CredentialField
              label="Refresh Token"
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.oauth2.refreshToken}
              isSensitive={true}
              onShowLargeType={handleShowLargeType}
              {...sensitiveFieldBehavior}
            />
            <CredentialField
              label="Client ID"
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.oauth2.clientId}
              isSensitive={true}
              onShowLargeType={handleShowLargeType}
              {...sensitiveFieldBehavior}
            />
            <CredentialField
              label="Client Secret"
              credentialId={credential.id}
              fieldKey={CREDENTIAL_FIELD_KEYS.oauth2.clientSecret}
              isSensitive={true}
              onShowLargeType={handleShowLargeType}
              {...sensitiveFieldBehavior}
            />
          </>
        )}
        </div>

        {walletLink && <CredentialWalletWidget walletLink={walletLink} />}

        {/* Tags */}
        {credential.meta.tags && credential.meta.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {credential.meta.tags.map((tag) => (
              <span
                key={tag}
                className="inline-block font-mono text-[9px] px-2 py-0.5 bg-[var(--color-accent,#ccff00)]/10 text-[var(--color-text-muted,#6b7280)]"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        </div>

      {/* Metadata footer */}
      <div className="mt-4 pt-3 border-t border-[var(--color-border,#d4d4d8)] shrink-0">
        <div className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] space-y-0.5">
          <div>Created {formatDate(credential.createdAt)}</div>
          <div>Updated {formatDate(credential.updatedAt)}</div>
          {credential.archivedAt && <div>Archived {formatDate(credential.archivedAt)}</div>}
          {credential.deletedAt && <div>Deleted {formatDate(credential.deletedAt)}</div>}
          <div>Agent: {agentName}</div>
        </div>
      </div>

      {/* Actions bar */}
      <div className="mt-4 flex gap-2 shrink-0">
        {isActiveLifecycle && (
          <Button variant="secondary" size="sm" onClick={() => setShareOpen(true)}>
            SHARE
          </Button>
        )}
        {isActiveLifecycle && (
          <Button variant="secondary" size="sm" onClick={onEdit}>
            EDIT
          </Button>
        )}
        {isActiveLifecycle && onDuplicate && (
          <Button variant="secondary" size="sm" onClick={onDuplicate}>
            DUPLICATE
          </Button>
        )}
        {!isActiveLifecycle && (
          <Button variant="secondary" size="sm" onClick={onRestore}>
            {restoreLabel}
          </Button>
        )}
        <Button
          variant="danger"
          size="sm"
          onClick={() => setDeleteOpen(true)}
        >
          {deleteButtonLabel}
        </Button>
      </div>

      <ConfirmationModal
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => {
          setDeleteOpen(false);
          onDelete();
        }}
        title={deleteModalTitle}
        message={deleteMessage}
        confirmText={deleteConfirmLabel}
        variant={deleteModalVariant}
      />

      {/* Large type modal */}
      <LargeTypeModal
        isOpen={largeTypeValue != null}
        onClose={() => setLargeTypeValue(null)}
        value={largeTypeValue ?? ''}
      />

      <CredentialShareModal
        isOpen={shareOpen}
        onClose={() => setShareOpen(false)}
        credentialId={credential.id}
        credentialName={displayName}
      />
    </div>
  );
};
