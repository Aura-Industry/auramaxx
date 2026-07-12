'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useWebSocket } from '@/context/WebSocketContext';
import { WALLET_EVENTS, type WalletEvent, type NotificationCreatedData } from '@/lib/events';
import { api, Api } from '@/lib/api';

export interface SocialNotification {
  id: string;
  type: string;
  category: string;
  title: string;
  message: string;
  read: boolean;
  dismissed: boolean;
  metadata: string | null;
  hash: string | null;
  createdAt: string;
  agentId: string | null;
}

interface SocialNotificationMeta {
  socialType?: 'reaction' | 'reply' | 'follow';
  actorAuraId?: number;
  actorPublicKey?: string;
  eventHash?: string;
}

interface FetchResponse {
  success: boolean;
  notifications: SocialNotification[];
  total: number;
}

interface UpdateResponse {
  success: boolean;
  updated: number;
}

export function parseSocialMeta(raw: string | null): SocialNotificationMeta {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as SocialNotificationMeta;
  } catch {
    return {};
  }
}

export function useSocialNotifications(agentId: string | null) {
  const [notifications, setNotifications] = useState<SocialNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  const { subscribe, connected } = useWebSocket();

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const qs = agentId ? `agentId=${encodeURIComponent(agentId)}&limit=50` : 'limit=50';
      const data = await api.get<FetchResponse>(Api.Wallet, `/social/notifications?${qs}`);
      if (mountedRef.current && data.success) {
        setNotifications(data.notifications);
      }
    } catch {
      // Silently ignore - social may not be enabled
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [agentId]);

  // Initial fetch
  useEffect(() => {
    mountedRef.current = true;
    fetchNotifications();
    return () => { mountedRef.current = false; };
  }, [agentId, fetchNotifications]);

  // Refetch on reconnect
  useEffect(() => {
    if (connected) fetchNotifications();
  }, [connected, agentId, fetchNotifications]);

  // Listen for real-time notification:created events
  useEffect(() => {
    const unsub = subscribe(WALLET_EVENTS.NOTIFICATION_CREATED, (event) => {
      const data = (event as WalletEvent).data as NotificationCreatedData;
      if (data.category !== 'social') return;
      if (agentId && data.agentId !== agentId) return;
      // Refetch to get full notification data
      fetchNotifications();
    });
    return unsub;
  }, [subscribe, agentId, fetchNotifications]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read && !n.dismissed).length,
    [notifications],
  );

  const markRead = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    setNotifications((prev) => prev.map((n) => ids.includes(n.id) ? { ...n, read: true } : n));
    try {
      await api.post<UpdateResponse>(Api.Wallet, '/social/notifications/read', { ids });
    } catch { /* best-effort */ }
  }, []);

  const dismiss = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    setNotifications((prev) => prev.map((n) => ids.includes(n.id) ? { ...n, dismissed: true, read: true } : n));
    try {
      await api.post<UpdateResponse>(Api.Wallet, '/social/notifications/dismiss', { ids });
    } catch { /* best-effort */ }
  }, []);

  return {
    notifications,
    unreadCount,
    loading,
    markRead,
    dismiss,
    refresh: fetchNotifications,
  };
}
