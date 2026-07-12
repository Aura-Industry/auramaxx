'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useWebSocket } from '@/context/WebSocketContext';
import { WALLET_EVENTS, type WalletEvent, type TokenCreatedData, type TokenRevokedData, type TokenSpentData, type ActionCreatedData, type ActionResolvedData } from '@/lib/events';
import { api, Api } from '@/lib/api';

export interface HumanAction {
  id: string;
  type: string;
  fromTier: string;
  toAddress: string | null;
  amount: string | null;
  chain: string;
  status: string;
  createdAt: string;
  metadata?: string;
  rawPayload?: string | null;
  humanSummary?: {
    actionLabel: string;
    oneLiner: string;
    can: string[];
    cannot: string[];
    scope: string[];
    expiresIn: string;
    riskHint: string;
    profileLabel?: string;
  };
}

export interface AgentToken {
  tokenHash: string;
  agentId: string;
  limit: number;
  spent: number;
  remaining: number;
  permissions: string[];
  expiresAt: number;
  isExpired: boolean;
  isRevoked: boolean;
  isActive: boolean; // true = valid in memory, false = DB record only (server restarted)
  isAdmin?: boolean; // true = admin token (UI session token)
}

interface DashboardData {
  requests: HumanAction[];
  history?: HumanAction[];
  tokens: {
    active: AgentToken[];
    inactive: AgentToken[];
  };
  counts: {
    pendingActions: number;
    historyActions?: number;
    activeTokens: number;
    inactiveTokens: number;
  };
}

interface UseAgentActionsOptions {
  autoFetch?: boolean;
}

const LOCAL_RACE_GRACE_MS = 15_000;
const MAX_HISTORY_ITEMS = 80;
const DISMISSED_NOTIFICATION_STORAGE_KEY = 'auramaxx:dismissed-notification-ids';

function parseMeta(metadata?: string): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function prependUniqueAction(list: HumanAction[], next: HumanAction, max = MAX_HISTORY_ITEMS): HumanAction[] {
  const deduped = [next, ...list.filter((item) => item.id !== next.id)];
  return deduped.slice(0, max);
}

function sortNewestFirst(actions: HumanAction[]): HumanAction[] {
  return [...actions].sort((a, b) => {
    const aTs = new Date(a.createdAt).getTime();
    const bTs = new Date(b.createdAt).getTime();
    return bTs - aTs;
  });
}

function loadDismissedNotificationIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_NOTIFICATION_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0));
  } catch {
    return new Set();
  }
}

function normalizeNotificationId(id: unknown): string {
  if (typeof id === 'string') return id;
  if (typeof id === 'number') return String(id);
  return '';
}

function mergePendingRequests(server: HumanAction[], local: HumanAction[]): HumanAction[] {
  const now = Date.now();
  const merged = new Map<string, HumanAction>();

  server
    .filter((action) => action.status === 'pending')
    .forEach((action) => merged.set(action.id, action));

  local
    .filter((action) => action.status === 'pending')
    .filter((action) => !merged.has(action.id))
    .filter((action) => now - new Date(action.createdAt).getTime() <= LOCAL_RACE_GRACE_MS)
    .forEach((action) => merged.set(action.id, action));

  return sortNewestFirst(Array.from(merged.values()));
}

function mergeActionHistory(server: HumanAction[], local: HumanAction[]): HumanAction[] {
  const now = Date.now();
  const merged = new Map<string, HumanAction>();

  server
    .filter((action) => action.status !== 'pending')
    .forEach((action) => merged.set(action.id, action));

  local
    .filter((action) => action.status !== 'pending')
    .filter((action) => !merged.has(action.id))
    .filter((action) => now - new Date(action.createdAt).getTime() <= LOCAL_RACE_GRACE_MS)
    .forEach((action) => merged.set(action.id, action));

  return sortNewestFirst(Array.from(merged.values())).slice(0, MAX_HISTORY_ITEMS);
}

interface ApprovalResult {
  success: boolean;
  token?: string;
  agentId?: string;
  limit?: number;
  permissions?: string[];
  expiresIn?: number;
  txHash?: string;
  message?: string;
}

interface UseAgentActionsReturn {
  requests: HumanAction[];
  notifications: HumanAction[];
  dismissNotification: (id: string) => void;
  activeTokens: AgentToken[];
  inactiveTokens: AgentToken[];
  loading: boolean;
  error: string | null;
  counts: {
    pendingActions: number;
    activeTokens: number;
  };
  refresh: () => Promise<void>;
  resolveAction: (id: string, approved: boolean) => Promise<ApprovalResult>;
  revokeToken: (tokenHash: string) => Promise<boolean>;
  actionLoading: string | null;
  lastApprovalResult: ApprovalResult | null;
  clearApprovalResult: () => void;
  connected: boolean;
}

export function useAgentActions(options: UseAgentActionsOptions = {}): UseAgentActionsReturn {
  const { autoFetch = true } = options;

  const [requests, setRequests] = useState<HumanAction[]>([]);
  const [actionHistory, setActionHistory] = useState<HumanAction[]>([]);
  const [alertNotifications, setAlertNotifications] = useState<HumanAction[]>([]);
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<Set<string>>(() => loadDismissedNotificationIds());
  const [activeTokens, setActiveTokens] = useState<AgentToken[]>([]);
  const [inactiveTokens, setInactiveTokens] = useState<AgentToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [counts, setCounts] = useState({ pendingActions: 0, activeTokens: 0 });
  const [lastApprovalResult, setLastApprovalResult] = useState<ApprovalResult | null>(null);

  const { subscribe, connected } = useWebSocket();
  const mountedRef = useRef(true);
  const requestsRef = useRef<HumanAction[]>([]);

  const clearApprovalResult = useCallback(() => {
    setLastApprovalResult(null);
  }, []);

  const dismissNotification = useCallback((id: string) => {
    const normalizedId = normalizeNotificationId(id);
    if (!normalizedId) return;
    setDismissedNotificationIds((prev) => {
      const next = new Set(prev);
      next.add(normalizedId);
      return next;
    });
    setAlertNotifications((prev) => prev.filter((n) => normalizeNotificationId(n.id) !== normalizedId));
  }, []);

  useEffect(() => {
    requestsRef.current = requests;
  }, [requests]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (dismissedNotificationIds.size === 0) {
        window.localStorage.removeItem(DISMISSED_NOTIFICATION_STORAGE_KEY);
        return;
      }
      window.localStorage.setItem(
        DISMISSED_NOTIFICATION_STORAGE_KEY,
        JSON.stringify(Array.from(dismissedNotificationIds)),
      );
    } catch {
      // Ignore localStorage failures (private mode / quota).
    }
  }, [dismissedNotificationIds]);

  const fetchDashboard = useCallback(async () => {
    try {
      const data = await api.get<{ success: boolean; error?: string } & DashboardData>(Api.Wallet, '/dashboard');

      if (!mountedRef.current) return;

      if (data.success) {
        setRequests((prev) => mergePendingRequests(data.requests || [], prev));
        setActionHistory((prev) => mergeActionHistory(data.history || [], prev));
        setActiveTokens(data.tokens?.active || []);
        setInactiveTokens(data.tokens?.inactive || []);
        setCounts({
          pendingActions: data.counts?.pendingActions || 0,
          activeTokens: data.counts?.activeTokens || 0,
        });
        setError(null);
      } else {
        setError(data.error || 'Failed to fetch dashboard');
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch dashboard');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    await fetchDashboard();
  }, [fetchDashboard]);

  const resolveAction = useCallback(async (id: string, approved: boolean): Promise<ApprovalResult> => {
    setActionLoading(`resolve-${id}`);
    try {
      const data = await api.post<{
        success: boolean;
        error?: string;
        token?: string;
        agentId?: string;
        limit?: number;
        permissions?: string[];
        expiresIn?: number;
        txHash?: string;
        message?: string;
      }>(Api.Wallet, `/actions/${id}/resolve`, { approved });

      if (data.success) {
        const result: ApprovalResult = {
          success: true,
          token: data.token,
          agentId: data.agentId,
          limit: data.limit,
          permissions: data.permissions,
          expiresIn: data.expiresIn,
          txHash: data.txHash,
          message: data.message,
        };
        // Set lastApprovalResult when a token is returned
        if (data.token) {
          setLastApprovalResult(result);
        }
        await refresh();
        return result;
      } else {
        setError(data.error || 'Action resolution failed');
        return { success: false, message: data.error };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action resolution failed';
      setError(message);
      return { success: false, message };
    } finally {
      setActionLoading(null);
    }
  }, [refresh]);

  const revokeToken = useCallback(async (tokenHash: string): Promise<boolean> => {
    setActionLoading(`revoke-${tokenHash}`);
    try {
      const data = await api.post<{ success: boolean; error?: string }>(Api.Wallet, '/actions/tokens/revoke', { tokenHash });

      if (data.success) {
        // WebSocket will update the UI, but refresh as fallback
        await refresh();
        return true;
      } else {
        setError(data.error || 'Revoke failed');
        return false;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed');
      return false;
    } finally {
      setActionLoading(null);
    }
  }, [refresh]);

  // Initial fetch
  useEffect(() => {
    mountedRef.current = true;
    if (autoFetch) {
      refresh();
    }
    return () => {
      mountedRef.current = false;
    };
  }, [autoFetch, refresh]);

  // Re-sync on websocket reconnect to avoid missing any action events.
  useEffect(() => {
    if (!autoFetch || !connected) return;
    void fetchDashboard();
  }, [autoFetch, connected, fetchDashboard]);

  // Periodic reconciliation catches missed broadcasts and keeps UI fresh.
  useEffect(() => {
    if (!autoFetch) return;
    const intervalMs = connected ? 2000 : 3000;
    const interval = setInterval(() => {
      void fetchDashboard();
    }, intervalMs);
    return () => clearInterval(interval);
  }, [autoFetch, connected, fetchDashboard]);

  // Subscribe to WebSocket events
  useEffect(() => {
    // Token created - add to active tokens
    const unsubTokenCreated = subscribe(WALLET_EVENTS.TOKEN_CREATED, (event) => {
      const data = (event as WalletEvent).data as TokenCreatedData;
      setActiveTokens((prev) => {
        // Check if already exists
        if (prev.some((t) => t.tokenHash === data.tokenHash)) return prev;
        return [
          {
            tokenHash: data.tokenHash,
            agentId: data.agentId,
            limit: data.limit,
            spent: 0,
            remaining: data.limit,
            permissions: data.permissions,
            expiresAt: data.expiresAt,
            isExpired: false,
            isRevoked: false,
            isActive: true,
          },
          ...prev,
        ];
      });
      setCounts((prev) => ({ ...prev, activeTokens: prev.activeTokens + 1 }));
    });

    // Token revoked - move from active to inactive
    const unsubTokenRevoked = subscribe(WALLET_EVENTS.TOKEN_REVOKED, (event) => {
      const data = (event as WalletEvent).data as TokenRevokedData;
      setActiveTokens((prev) => {
        const token = prev.find((t) => t.tokenHash === data.tokenHash);
        if (token) {
          // Move to inactive
          setInactiveTokens((inactive) => [
            { ...token, isRevoked: true, isActive: false },
            ...inactive,
          ]);
        }
        return prev.filter((t) => t.tokenHash !== data.tokenHash);
      });
      setCounts((prev) => ({
        ...prev,
        activeTokens: Math.max(0, prev.activeTokens - 1),
      }));
    });

    // Token spent - update spent/remaining
    const unsubTokenSpent = subscribe(WALLET_EVENTS.TOKEN_SPENT, (event) => {
      const data = (event as WalletEvent).data as TokenSpentData;
      setActiveTokens((prev) =>
        prev.map((t) =>
          t.tokenHash === data.tokenHash
            ? { ...t, spent: data.newSpent, remaining: data.remaining }
            : t
        )
      );
    });

    // Action created - route notify types to notifications, others to pending requests
    const unsubActionCreated = subscribe(WALLET_EVENTS.ACTION_CREATED, (event) => {
      const walletEvent = event as WalletEvent;
      const data = walletEvent.data as ActionCreatedData;
      const createdAtIso = new Date(walletEvent.timestamp || Date.now()).toISOString();

      // Notify actions go to the notifications list, not pending requests
      if (data.type === 'notify') {
        setAlertNotifications((prev) => {
          if (prev.some((n) => n.id === data.id)) return prev;
          return prependUniqueAction(prev, {
            id: data.id,
            type: data.type,
            fromTier: 'system',
            toAddress: null,
            amount: null,
            chain: 'base',
            status: 'acknowledged',
            createdAt: createdAtIso,
            metadata: JSON.stringify({
              ...data.metadata,
              source: data.source,
              summary: data.summary,
            }),
          });
        });
        return;
      }

      setRequests((prev) => {
        if (prev.some((r) => r.id === data.id)) return prev;
        return prependUniqueAction(prev, {
          id: data.id,
          type: data.type,
          fromTier: 'system',
          toAddress: null,
          amount: null,
          chain: 'base',
          status: 'pending',
          createdAt: createdAtIso,
          metadata: JSON.stringify({
            ...data.metadata,
            source: data.source,
            summary: data.summary,
            expiresAt: data.expiresAt,
          }),
        });
      });
      setActionHistory((prev) => prev.filter((action) => action.id !== data.id));
      setCounts((prev) => ({ ...prev, pendingActions: prev.pendingActions + 1 }));
    });

    // Action resolved - remove from pending and move into local history stream
    const unsubActionResolved = subscribe(WALLET_EVENTS.ACTION_RESOLVED, (event) => {
      const walletEvent = event as WalletEvent;
      const data = walletEvent.data as ActionResolvedData;
      const request = requestsRef.current.find((r) => r.id === data.id);
      if (!request) {
        // Missed a prior event (or loaded after resolution) - refresh once for consistency.
        void fetchDashboard();
        return;
      }

      const resolvedAtIso = new Date(walletEvent.timestamp || Date.now()).toISOString();
      const requestMeta = parseMeta(request.metadata);
      const resolvedAction: HumanAction = {
        ...request,
        status: data.approved ? 'approved' : 'rejected',
        createdAt: resolvedAtIso,
        metadata: JSON.stringify({
          ...requestMeta,
          approved: data.approved,
          resolvedBy: data.resolvedBy,
          resolvedAt: resolvedAtIso,
        }),
      };

      setRequests((prev) => prev.filter((r) => r.id !== data.id));
      setActionHistory((prev) => prependUniqueAction(prev, resolvedAction));
      setCounts((prev) => ({
        ...prev,
        pendingActions: Math.max(0, prev.pendingActions - 1),
      }));
    });

    return () => {
      unsubTokenCreated();
      unsubTokenRevoked();
      unsubTokenSpent();
      unsubActionCreated();
      unsubActionResolved();
    };
  }, [fetchDashboard, subscribe]);

  const notifications = useMemo(() => {
    const map = new Map<string, HumanAction>();

    const include = (action: HumanAction) => {
      const notificationId = normalizeNotificationId(action.id);
      if (!notificationId || dismissedNotificationIds.has(notificationId)) return;
      const current = map.get(notificationId);
      if (!current) {
        map.set(notificationId, action);
        return;
      }
      // Prefer pending actions over history/alerts for same id.
      if (current.status !== 'pending' && action.status === 'pending') {
        map.set(notificationId, action);
      }
    };

    requests.forEach(include);
    actionHistory.forEach(include);
    alertNotifications.forEach(include);

    return sortNewestFirst(Array.from(map.values()));
  }, [actionHistory, alertNotifications, dismissedNotificationIds, requests]);

  return {
    requests,
    notifications,
    dismissNotification,
    activeTokens,
    inactiveTokens,
    loading,
    error,
    counts,
    refresh,
    resolveAction,
    revokeToken,
    actionLoading,
    lastApprovalResult,
    clearApprovalResult,
    connected,
  };
}
