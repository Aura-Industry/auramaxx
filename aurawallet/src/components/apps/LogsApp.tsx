'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Clock,
  Loader2,
  RefreshCw,
  ChevronDown,
  Filter,
  Wifi,
  WifiOff,
  Lock,
} from 'lucide-react';
import { useWebSocket } from '@/context/WebSocketContext';
import { useAuth } from '@/context/AuthContext';
import { api, Api } from '@/lib/api';
import type { WalletEvent } from '@/lib/events';

interface EventLog {
  id: string;
  type: string;
  source: 'express' | 'nextjs';
  data: Record<string, unknown>;
  timestamp: number;
  isNew?: boolean;
}

interface LogsAppProps {
  maxHeight?: number;
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  'action:created': 'var(--color-warning, #ff4d00)',
  'action:resolved': 'var(--color-success, #00c853)',
  'token:created': 'var(--color-info, #0047ff)',
  'token:revoked': 'var(--color-warning, #ff4d00)',
  'token:spent': 'var(--color-accent, #ffab00)',
  'wallet:created': 'var(--color-info, #00bcd4)',
  'wallet:changed': 'var(--color-info, #00bcd4)',
};

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 10) return 'just now';
  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function getEventLabel(type: string): string {
  const labels: Record<string, string> = {
    'action:created': 'ACTION',
    'action:resolved': 'RESOLVED',
    'token:created': 'TOKEN+',
    'token:revoked': 'REVOKED',
    'token:spent': 'SPENT',
    'wallet:created': 'WALLET+',
    'wallet:changed': 'WALLET~',
  };
  return labels[type] || type.split(':').pop()?.toUpperCase() || type;
}

function getEventSummary(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case 'action:created':
      return `Action "${data.type || data.actionType}" from ${data.agentId || 'agent'}`;
    case 'action:resolved':
      return `Action ${(data.id as string)?.slice(0, 8)}... ${data.approved ? 'approved' : 'rejected'}`;
    case 'token:created':
      return `Token for "${data.agentId}" (${data.limit} ETH)`;
    case 'token:revoked':
      return `Token ${(data.tokenHash as string)?.slice(0, 8)}... revoked`;
    case 'token:spent':
      return `Spent ${data.amount} ETH (${data.remaining} left)`;
    case 'wallet:changed':
      return `${(data.tier as string)?.toUpperCase()} wallet ${(data.address as string)?.slice(0, 10)}... updated`;
    case 'wallet:created':
      return `${(data.tier as string)?.toUpperCase()} wallet ${(data.address as string)?.slice(0, 10)}...`;
    default:
      return data ? JSON.stringify(data).slice(0, 50) : 'No data';
  }
}

const LogsApp: React.FC<LogsAppProps> = ({ maxHeight = 320 }) => {
  const [logs, setLogs] = useState<EventLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [limit, setLimit] = useState(50);

  const { subscribe, connected } = useWebSocket();
  const { isUnlocked } = useAuth();

  // Fetch initial logs from backend API
  const fetchLogs = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { limit };
      if (filter !== 'all') {
        params.type = filter;
      }
      const data = await api.get<{ success: boolean; events: Array<{ id: string; type: string; source: string; data: string | Record<string, unknown>; timestamp: string }>; error?: string }>(Api.Events, '/events', params);
      if (data.success) {
        // Convert API response to EventLog format
        const apiLogs: EventLog[] = data.events.map((event) => ({
          id: event.id,
          type: event.type,
          source: event.source as 'express' | 'nextjs',
          data: typeof event.data === 'string' ? JSON.parse(event.data) : event.data,
          timestamp: new Date(event.timestamp).getTime(),
        }));
        setLogs(apiLogs);
        setError(null);
      } else {
        setError(data.error || 'Failed to fetch logs');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch logs');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter, limit]);

  // Initial fetch (skip if locked)
  useEffect(() => {
    if (!isUnlocked) {
      setLoading(false);
      return;
    }
    fetchLogs();
  }, [fetchLogs, isUnlocked]);

  // Subscribe to all WebSocket events for real-time updates
  useEffect(() => {
    const unsubscribe = subscribe('*', (event) => {
      // Only handle wallet events, not workspace/app/system events
      const eventType = (event as { type?: string }).type;
      if (!eventType ||
          eventType.startsWith('workspace:') ||
          eventType.startsWith('app:') ||
          eventType.startsWith('theme:') ||
          eventType === 'error' ||
          eventType === 'connected') {
        return;
      }
      const walletEvent = event as WalletEvent;
      const newLog: EventLog = {
        id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: walletEvent.type,
        source: walletEvent.source,
        data: walletEvent.data as unknown as Record<string, unknown>,
        timestamp: walletEvent.timestamp,
        isNew: true,
      };

      setLogs((prev) => {
        // Add to beginning, remove duplicates by checking recent timestamps
        const filtered = prev.filter(
          (log) => !(log.type === newLog.type && Math.abs(log.timestamp - newLog.timestamp) < 1000)
        );
        return [newLog, ...filtered].slice(0, limit + 50); // Keep some buffer
      });

      // Clear "new" flag after 5 seconds
      setTimeout(() => {
        setLogs((prev) =>
          prev.map((log) =>
            log.id === newLog.id ? { ...log, isNew: false } : log
          )
        );
      }, 5000);
    });

    return unsubscribe;
  }, [subscribe, limit]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchLogs();
  };

  const eventTypes = [
    { value: 'all', label: 'ALL' },
    { value: 'action:created', label: 'ACTIONS' },
    { value: 'action:resolved', label: 'RESOLVED' },
    { value: 'token:created', label: 'TOKENS' },
    { value: 'token:revoked', label: 'REVOKED' },
    { value: 'token:spent', label: 'SPENT' },
    { value: 'wallet:created', label: 'WALLETS' },
  ];

  // Filter logs based on selected filter
  const filteredLogs = filter === 'all' ? logs : logs.filter((log) => log.type === filter);

  if (!isUnlocked) {
    return (
      <div className="py-6 text-center">
        <Lock size={20} className="mx-auto mb-2 text-[var(--color-text-faint,#9ca3af)]" />
        <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">AGENT LOCKED</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="py-6 text-center">
        <Loader2 size={20} className="mx-auto mb-2 text-[var(--color-text-faint,#9ca3af)] animate-spin" />
        <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">LOADING LOGS...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-6 text-center">
        <div className="font-mono text-[9px] text-[var(--color-warning,#ff4d00)] mb-2">{error}</div>
        <button
          onClick={handleRefresh}
          className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] flex items-center gap-1 mx-auto"
        >
          <RefreshCw size={10} />
          RETRY
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Header with filter and refresh */}
      <div className="flex items-center justify-between">
        <div className="relative">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="flex items-center gap-1 px-2 py-1 border border-[var(--color-border,#d4d4d8)] font-mono text-[8px] text-[var(--color-text-muted,#6b7280)] hover:border-[var(--color-border-focus,#0a0a0a)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
          >
            <Filter size={9} />
            {eventTypes.find((t) => t.value === filter)?.label || 'ALL'}
            <ChevronDown size={8} className={showFilters ? 'rotate-180' : ''} />
          </button>
          {showFilters && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowFilters(false)} />
              <div className="absolute left-0 top-full mt-1 bg-[var(--color-surface,#ffffff)] border border-[var(--color-border-focus,#0a0a0a)] shadow-lg z-50 min-w-[100px]">
                {eventTypes.map((type) => (
                  <button
                    key={type.value}
                    onClick={() => {
                      setFilter(type.value);
                      setShowFilters(false);
                    }}
                    className={`w-full text-left px-2 py-1 font-mono text-[8px] hover:bg-[var(--color-accent,#ccff00)] hover:text-[var(--color-text,#0a0a0a)] ${
                      filter === type.value ? 'bg-[var(--color-surface-alt,#fafafa)] font-bold' : ''
                    }`}
                  >
                    {type.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Connection status */}
          <div className="flex items-center gap-1">
            {connected ? (
              <Wifi size={9} className="text-[var(--color-success,#00c853)]" />
            ) : (
              <WifiOff size={9} className="text-[var(--color-text-muted,#6b7280)]" />
            )}
            <span className="font-mono text-[7px] text-[var(--color-text-muted,#6b7280)]">
              {connected ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>
          <span className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">{filteredLogs.length}</span>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="p-1 hover:bg-[var(--color-surface-alt,#fafafa)] transition-colors"
          >
            <RefreshCw size={10} className={`text-[var(--color-text-muted,#6b7280)] ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Logs list */}
      {filteredLogs.length === 0 ? (
        <div className="py-6 text-center">
          <Clock size={20} className="mx-auto mb-2 text-[var(--color-text-faint,#9ca3af)]" />
          <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">NO EVENTS YET</div>
        </div>
      ) : (
        <div className="space-y-1 overflow-y-auto" style={{ maxHeight }}>
          {filteredLogs.map((log) => {
            const color = EVENT_TYPE_COLORS[log.type] || 'var(--color-text-muted, #666)';
            const summary = getEventSummary(log.type, log.data);

            return (
              <div
                key={log.id}
                className={`border p-2 transition-all group ${
                  log.isNew
                    ? 'border-[var(--color-accent,#ccff00)] bg-[var(--color-accent,#ccff00)]/10 animate-pulse'
                    : 'border-[var(--color-border-muted,#e5e5e5)] hover:border-[var(--color-border,#d4d4d8)]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <div
                      className="w-1.5 h-1.5 shrink-0"
                      style={{ backgroundColor: color }}
                    />
                    <span
                      className="font-mono text-[8px] font-bold shrink-0"
                      style={{ color }}
                    >
                      {getEventLabel(log.type)}
                    </span>
                    <span className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)] truncate">
                      {summary}
                    </span>
                  </div>
                  <span className="font-mono text-[7px] text-[var(--color-text-muted,#6b7280)] shrink-0">
                    {formatTimeAgo(log.timestamp)}
                  </span>
                </div>
                {/* Expandable details on hover */}
                <div className="hidden group-hover:block mt-1.5 pt-1.5 border-t border-[var(--color-border-muted,#e5e5e5)]">
                  <div className="font-mono text-[7px] text-[var(--color-text-muted,#6b7280)] break-all">
                    {JSON.stringify(log.data, null, 0)}
                  </div>
                </div>
              </div>
            );
          })}
          {filteredLogs.length >= limit && (
            <button
              onClick={() => setLimit((l) => l + 50)}
              className="w-full py-2 font-mono text-[8px] text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-surface-alt,#fafafa)] transition-colors"
            >
              LOAD MORE
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export { LogsApp };
export default LogsApp;
