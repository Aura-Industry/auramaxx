'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/design-system';
import { useUpdateChecker } from '@/hooks/useUpdateChecker';

const UPDATE_BANNER_DISMISS_KEY = 'aura:update-banner:dismissed';

export function UpdateBanner() {
  const {
    updateAvailable,
    current,
    latest,
    updating,
    updateInProgress,
    updateError,
    updateOutput,
    runUpdate,
    apiServerDown,
    restartingServer,
    restartError,
    runRestart,
  } = useUpdateChecker();
  const [dismissedBannerKey, setDismissedBannerKey] = useState<string | null>(null);

  const activeBannerKey = useMemo(() => {
    if (apiServerDown || restartError) return null;
    if (updateOutput && !updateAvailable) return `update-success:${latest || 'unknown'}`;
    if (updateAvailable || updateError) return `update-available:${current || 'unknown'}:${latest || 'unknown'}`;
    return null;
  }, [apiServerDown, restartError, updateOutput, updateAvailable, latest, current, updateError]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(UPDATE_BANNER_DISMISS_KEY);
    setDismissedBannerKey(stored);
  }, []);

  const dismissBanner = useCallback(() => {
    if (!activeBannerKey || typeof window === 'undefined') return;
    window.localStorage.setItem(UPDATE_BANNER_DISMISS_KEY, activeBannerKey);
    setDismissedBannerKey(activeBannerKey);
  }, [activeBannerKey]);

  const isDismissed = Boolean(activeBannerKey && dismissedBannerKey === activeBannerKey);

  if (!apiServerDown && !restartError && !updateAvailable && !updateOutput && !updateError) return null;
  if (isDismissed) return null;

  if (apiServerDown || restartError) {
    return (
      <div
        className="fixed top-0 left-0 right-0 z-[9999] px-4 py-2.5 font-mono text-[11px] flex items-center justify-between gap-3"
        style={{
          background: 'var(--color-warning, #ff4d00)',
          color: '#fff',
        }}
      >
        <span>
          API SERVER OFFLINE. RUN: auramaxx restart (or npx --yes auramaxx@latest restart)
        </span>
        <Button
          type="button"
          onClick={() => { void runRestart(); }}
          loading={restartingServer}
          variant="primary"
          size="sm"
        >
          RESTART NOW
        </Button>
        {restartError && (
          <span
            className="text-[10px]"
            style={{ color: '#fff', opacity: 0.9 }}
          >
            {restartError}
          </span>
        )}
      </div>
    );
  }

  // Success state after update
  if (updateOutput && !updateAvailable) {
    return (
      <div
        className="fixed top-0 left-0 right-0 z-[100] px-3 py-2 border text-[9px] font-mono tracking-widest flex items-center justify-center gap-3"
        style={{
          color: 'var(--color-accent-foreground, #0a0a0a)',
          borderColor: 'var(--color-accent, #ccff00)',
          background: 'var(--color-accent, #ccff00)',
        }}
      >
        <span>
          UPDATE INSTALLED — RESTART MANUALLY TO APPLY
          {latest ? ` (${latest})` : ''}
        </span>
        <span>RUN: auramaxx restart</span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="primary"
            loading={restartingServer}
            onClick={() => { void runRestart(); }}
          >
            RESTART NOW
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={dismissBanner}
            aria-label="Dismiss update banner"
            className="text-[var(--color-accent-foreground,#0a0a0a)] hover:bg-black/10"
          >
            <X size={12} />
          </Button>
        </div>
      </div>
    );
  }

  const currentIsUnknown = !current || current.trim().toLowerCase() === 'unknown';

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[9999] px-4 py-2.5 font-mono text-[11px] flex items-center justify-between gap-3"
      style={{
        background: 'var(--color-warning, #ff4d00)',
        color: '#fff',
      }}
    >
      <span>
        {currentIsUnknown
          ? `New update available. Update to latest version${latest ? ` (${latest})` : ''}.`
          : `Update available: ${current} → ${latest}`}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={() => { void runUpdate(); }}
          loading={updating || updateInProgress}
          variant="primary"
          size="sm"
        >
          {updateInProgress ? 'UPDATING...' : 'UPDATE NOW'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={dismissBanner}
          aria-label="Dismiss update banner"
          className="text-white/90 hover:text-white hover:bg-white/10"
        >
          <X size={12} />
        </Button>
      </div>
      {updateError && (
        <span
          className="text-[10px]"
          style={{ color: '#fff', opacity: 0.9 }}
        >
          {updateError}
        </span>
      )}
    </div>
  );
}
