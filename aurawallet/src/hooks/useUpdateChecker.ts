'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { getWalletBaseUrl } from '@/lib/api';

interface UpdateState {
  checking: boolean;
  updateAvailable: boolean;
  current: string | null;
  latest: string | null;
  updating: boolean;
  updateInProgress: boolean;
  updateOutput: string | null;
  updateError: string | null;
  apiServerDown: boolean;
  restartingServer: boolean;
  restartError: string | null;
}

const API_HEALTH_POLL_MS = 8000;
const API_HEALTH_RECOVERY_POLL_MS = 1500;
const UPDATE_PROGRESS_POLL_MS = 2500;

export function useUpdateChecker() {
  const walletBaseUrl = useMemo(() => getWalletBaseUrl(), []);
  const [state, setState] = useState<UpdateState>({
    checking: false,
    updateAvailable: false,
    current: null,
    latest: null,
    updating: false,
    updateInProgress: false,
    updateOutput: null,
    updateError: null,
    apiServerDown: false,
    restartingServer: false,
    restartError: null,
  });

  const checkForUpdate = useCallback(async () => {
    setState((prev) => ({ ...prev, checking: true }));
    try {
      const res = await fetch('/api/version', { cache: 'no-store' });
      if (!res.ok) {
        setState((prev) => ({ ...prev, checking: false }));
        return;
      }
      const data = await res.json() as {
        success: boolean;
        current: string;
        latest: string;
        updateAvailable: boolean;
      };
      if (data.success) {
        setState((prev) => ({
          ...prev,
          checking: false,
          updateAvailable: data.updateAvailable,
          current: data.current,
          latest: data.latest,
          updateInProgress: data.updateAvailable ? prev.updateInProgress : false,
        }));
      }
    } catch {
      setState((prev) => ({ ...prev, checking: false }));
    }
  }, []);

  const runUpdate = useCallback(async () => {
    setState((prev) => ({ ...prev, updating: true, updateError: null, updateOutput: null }));
    try {
      const res = await fetch('/api/update', { method: 'POST' });
      const bodyText = await res.text();
      const data = (() => {
        try {
          return JSON.parse(bodyText) as {
            success: boolean;
            deferred?: boolean;
            inProgress?: boolean;
            message?: string;
            output?: string;
            error?: string;
          };
        } catch {
          return {
            success: false,
            error: bodyText || `Update failed (${res.status})`,
          };
        }
      })() as {
        success: boolean;
        deferred?: boolean;
        inProgress?: boolean;
        message?: string;
        output?: string;
        error?: string;
      };
      if (res.status === 409 || data.inProgress) {
        setState((prev) => ({
          ...prev,
          updating: false,
          updateInProgress: true,
          updateError: null,
          updateOutput: data.output || data.message || data.error || 'Update is already running in the background.',
        }));
        return;
      }
      if (data.success) {
        if (data.deferred) {
          setState((prev) => ({
            ...prev,
            updating: false,
            updateInProgress: true,
            updateOutput: data.output || data.message || 'Update started in background.',
            updateError: null,
          }));
          return;
        }

        setState((prev) => ({
          ...prev,
          updating: false,
          updateInProgress: false,
          updateAvailable: false,
          updateOutput: data.output || 'Update completed successfully.',
        }));
      } else {
        setState((prev) => ({
          ...prev,
          updating: false,
          updateInProgress: false,
          updateError: data.error || 'Update failed.',
          updateOutput: data.output || null,
        }));
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        updating: false,
        updateInProgress: false,
        updateError: (err as Error).message || 'Update request failed.',
      }));
    }
  }, []);

  const checkApiHealth = useCallback(async () => {
    try {
      const res = await fetch(`${walletBaseUrl}/health`, { cache: 'no-store' });
      const down = !res.ok;
      setState((prev) => {
        if (prev.apiServerDown === down && (down || !prev.restartError)) return prev;
        return {
          ...prev,
          apiServerDown: down,
          restartError: down ? prev.restartError : null,
        };
      });
    } catch {
      setState((prev) => {
        if (prev.apiServerDown) return prev;
        return { ...prev, apiServerDown: true };
      });
    }
  }, [walletBaseUrl]);

  const runRestart = useCallback(async () => {
    setState((prev) => ({ ...prev, restartingServer: true, restartError: null }));
    try {
      const res = await fetch('/api/restart', { method: 'POST' });
      const data = await res.json().catch(() => ({ success: false, error: 'Invalid restart response.' })) as {
        success?: boolean;
        error?: string;
      };

      if (!res.ok || !data.success) {
        throw new Error(data.error || `Restart failed (${res.status})`);
      }

      setState((prev) => ({
        ...prev,
        restartingServer: false,
        apiServerDown: true,
        restartError: null,
      }));
      const refreshUrl = new URL(window.location.href);
      refreshUrl.searchParams.set('_aura_restart', Date.now().toString());
      window.location.replace(refreshUrl.toString());
    } catch (err) {
      setState((prev) => ({
        ...prev,
        restartingServer: false,
        restartError: (err as Error).message || 'Restart request failed.',
      }));
    }
  }, []);

  useEffect(() => {
    void checkForUpdate();
  }, [checkForUpdate]);

  useEffect(() => {
    void checkApiHealth();
    const timer = window.setInterval(() => {
      void checkApiHealth();
    }, API_HEALTH_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [checkApiHealth]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkApiHealth();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [checkApiHealth]);

  useEffect(() => {
    if (!state.updateInProgress) return;
    void checkForUpdate();
    const timer = window.setInterval(() => {
      void checkForUpdate();
    }, UPDATE_PROGRESS_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [state.updateInProgress, checkForUpdate]);

  useEffect(() => {
    if (!state.apiServerDown || state.restartingServer) return;
    const timer = window.setInterval(() => {
      void checkApiHealth();
    }, API_HEALTH_RECOVERY_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [state.apiServerDown, state.restartingServer, checkApiHealth]);

  return { ...state, runUpdate, checkForUpdate, runRestart, checkApiHealth };
}
