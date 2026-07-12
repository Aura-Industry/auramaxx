'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Copy, RefreshCw } from 'lucide-react';
import { api, Api, type DashboardResponse } from '@/lib/api';
import { Button, ConfirmationModal, FilterDropdown } from '@/components/design-system';
import { useWebSocket } from '@/context/WebSocketContext';
import { WALLET_EVENTS } from '@/lib/events';
import {
  dedupeAuditEvents,
  fromLegacyLog,
  fromTask40Row,
  type UiAuditEvent,
  type UiDecision,
} from '@/lib/audit-console-adapter';

type DashboardToken = DashboardResponse['tokens']['active'][number] & {
  createdAt?: string;
};
type TokenStatusFilter = 'active' | 'revoked' | 'expired' | 'all';
type TokenStatus = 'active' | 'revoked' | 'expired' | 'inactive';
type TimeWindow = '1h' | '24h' | '7d';

const PAGE_SIZE = 50;
const HARD_CAP = 500;
const STATUS_OPTIONS: { value: TokenStatusFilter; label: string }[] = [
  { value: 'active', label: 'ACTIVE' },
  { value: 'revoked', label: 'REVOKED' },
  { value: 'expired', label: 'EXPIRED' },
  { value: 'all', label: 'ALL' },
];
const WINDOW_OPTIONS: { value: TimeWindow; label: string }[] = [
  { value: '1h', label: '1 HOUR' },
  { value: '24h', label: '24 HOURS' },
  { value: '7d', label: '7 DAYS' },
];
const DECISION_OPTIONS: { value: UiDecision | 'all'; label: string }[] = [
  { value: 'all', label: 'ALL' },
  { value: 'ALLOW', label: 'ALLOW' },
  { value: 'DENY', label: 'DENY' },
  { value: 'RATE_LIMIT', label: 'RATE_LIMIT' },
  { value: 'ERROR', label: 'ERROR' },
  { value: 'UNKNOWN', label: 'UNKNOWN' },
];

function toMs(value: string | number | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value < 1_000_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toWindowMs(window: TimeWindow): number {
  if (window === '1h') return 60 * 60 * 1000;
  if (window === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function classifyTokenStatus(token: DashboardToken): TokenStatus {
  if (token.isRevoked) return 'revoked';
  const expiresAtMs = toMs(token.expiresAt);
  if (token.isExpired || (expiresAtMs !== null && expiresAtMs <= Date.now())) return 'expired';
  if (token.isActive) return 'active';
  return 'inactive';
}

function shortHash(hash: string | undefined): string {
  if (!hash) return '—';
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

function formatDate(value: string | number | undefined): string {
  const ms = toMs(value);
  if (ms === null) return '—';
  return new Date(ms).toLocaleString();
}

function formatRelative(value: string | number | undefined): string {
  const ms = toMs(value);
  if (ms === null) return '—';
  const diff = ms - Date.now();
  if (diff <= 0) return 'expired';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function statusTone(status: TokenStatus): string {
  if (status === 'active') return 'text-[var(--color-success,#16a34a)]';
  if (status === 'revoked') return 'text-[var(--color-warning,#ff4d00)]';
  if (status === 'expired') return 'text-[var(--color-text-faint,#9ca3af)]';
  return 'text-[var(--color-text-muted,#6b7280)]';
}

function permissionsSummary(permissions: string[]): string {
  if (!permissions || permissions.length === 0) return '—';
  if (permissions.length <= 2) return permissions.join(', ');
  return `${permissions.slice(0, 2).join(', ')} +${permissions.length - 2}`;
}

export function AuditConsole(): React.JSX.Element {
  const { subscribe } = useWebSocket();
  const [tokens, setTokens] = useState<DashboardToken[]>([]);
  const [events, setEvents] = useState<UiAuditEvent[]>([]);
  const [statusFilter, setStatusFilter] = useState<TokenStatusFilter>('active');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('24h');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTokenKey, setSelectedTokenKey] = useState<string>('all');
  const [decisionFilter, setDecisionFilter] = useState<UiDecision | 'all'>('all');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revokingTokenKey, setRevokingTokenKey] = useState<string | null>(null);
  const [copiedTokenKey, setCopiedTokenKey] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ tokenKey: string; tokenHash: string } | null>(null);
  const activitySectionRef = useRef<HTMLDivElement | null>(null);
  const liveRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dashboard, access, legacy] = await Promise.all([
        api.get<{ success: boolean; tokens: { active: DashboardToken[]; inactive: DashboardToken[] } }>(Api.Wallet, '/dashboard'),
        api.get<{ success: boolean; rows: Record<string, unknown>[] }>(Api.Wallet, '/security/credential-access/recent', { limit: HARD_CAP }),
        api.get<{ success: boolean; logs: Record<string, unknown>[] }>(Api.Wallet, '/logs', { category: 'agent', limit: 200 }),
      ]);

      const dashboardTokens = dashboard.success
        ? [...(dashboard.tokens.active ?? []), ...(dashboard.tokens.inactive ?? [])]
        : [];

      const task40Rows = access.success ? access.rows.map(fromTask40Row) : [];
      const legacyRows = legacy.success
        ? legacy.logs
            .filter((row) => {
              const data = (row.data ?? {}) as Record<string, unknown>;
              return data.action === 'credential_access_decision';
            })
            .map(fromLegacyLog)
        : [];

      const now = Date.now();
      const merged = dedupeAuditEvents([...task40Rows, ...legacyRows]).filter((row) => row.timestamp <= now);

      setTokens(dashboardTokens);
      setEvents(merged.slice(0, HARD_CAP));
      setPage(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit console');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const scheduleLiveRefresh = useCallback(() => {
    if (liveRefreshTimerRef.current) return;
    liveRefreshTimerRef.current = setTimeout(() => {
      liveRefreshTimerRef.current = null;
      void fetchAll();
    }, 120);
  }, [fetchAll]);

  useEffect(() => {
    const unsubs = [
      subscribe(WALLET_EVENTS.TOKEN_CREATED, scheduleLiveRefresh),
      subscribe(WALLET_EVENTS.TOKEN_REVOKED, scheduleLiveRefresh),
      subscribe(WALLET_EVENTS.TOKEN_SPENT, scheduleLiveRefresh),
      subscribe(WALLET_EVENTS.CREDENTIAL_CHANGED, scheduleLiveRefresh),
      subscribe(WALLET_EVENTS.CREDENTIAL_ACCESSED, scheduleLiveRefresh),
    ];

    return () => {
      unsubs.forEach((unsub) => unsub());
      if (liveRefreshTimerRef.current) {
        clearTimeout(liveRefreshTimerRef.current);
        liveRefreshTimerRef.current = null;
      }
    };
  }, [scheduleLiveRefresh, subscribe]);

  useEffect(() => {
    setPage(0);
  }, [selectedTokenKey, decisionFilter, timeWindow, searchQuery]);

  const cutoff = useMemo(() => Date.now() - toWindowMs(timeWindow), [timeWindow]);
  const normalizedSearch = searchQuery.trim().toLowerCase();

  const tokenRows = useMemo(() => {
    return tokens.map((token, idx) => {
      const key = token.tokenHash || token.agentId || `unknown-${idx}`;
      return { key, token, status: classifyTokenStatus(token) };
    });
  }, [tokens]);

  const tokenRowsByKey = useMemo(() => new Map(tokenRows.map((row) => [row.key, row])), [tokenRows]);
  const selectedTokenRow = selectedTokenKey === 'all' ? null : tokenRowsByKey.get(selectedTokenKey) ?? null;

  const windowedEvents = useMemo(
    () => events.filter((row) => row.timestamp >= cutoff),
    [events, cutoff],
  );

  const summary = useMemo(() => {
    const activeCount = tokenRows.filter((row) => row.status === 'active').length;
    const denied = windowedEvents.filter((row) => row.decision === 'DENY').length;
    const rateLimited = windowedEvents.filter((row) => row.decision === 'RATE_LIMIT').length;
    const unknown = windowedEvents.filter((row) => row.decision === 'UNKNOWN' || row.reasonCode === 'UNKNOWN').length;
    return { activeCount, denied, rateLimited, unknown };
  }, [tokenRows, windowedEvents]);

  const filteredTokenRows = useMemo(() => {
    return tokenRows.filter((row) => {
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      if (!normalizedSearch) return true;
      const haystack = `${row.key} ${row.token.tokenHash} ${row.token.agentId}`.toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [tokenRows, statusFilter, normalizedSearch]);

  const tokenOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [{ value: 'all', label: 'ALL TOKENS' }];
    const seen = new Set<string>(['all']);
    filteredTokenRows.forEach((row) => {
      if (seen.has(row.key)) return;
      seen.add(row.key);
      options.push({ value: row.key, label: `${row.token.agentId ?? 'unknown'} · ${shortHash(row.token.tokenHash ?? row.key)}` });
    });

    if (selectedTokenKey !== 'all' && !seen.has(selectedTokenKey)) {
      const row = tokenRowsByKey.get(selectedTokenKey);
      if (row) options.push({ value: row.key, label: `${row.token.agentId ?? 'unknown'} · ${shortHash(row.token.tokenHash ?? row.key)}` });
    }

    return options;
  }, [filteredTokenRows, selectedTokenKey, tokenRowsByKey]);

  const lastUsedByKey = useMemo(() => {
    const map = new Map<string, number>();
    windowedEvents.forEach((row) => {
      const candidates = [
        row.tokenHash,
        row.tokenKey,
        row.agentId ? `agent:${row.agentId}` : undefined,
        row.agentId,
      ].filter((v): v is string => Boolean(v));

      candidates.forEach((key) => {
        map.set(key, Math.max(map.get(key) ?? 0, row.timestamp));
      });
    });
    return map;
  }, [windowedEvents]);

  const getLastUsed = useCallback(
    (row: { key: string; token: DashboardToken }): number | null => {
      const tokenHash = row.token.tokenHash;
      if (tokenHash && lastUsedByKey.has(tokenHash)) return lastUsedByKey.get(tokenHash) ?? null;
      if (lastUsedByKey.has(row.key)) return lastUsedByKey.get(row.key) ?? null;
      if (row.token.agentId && lastUsedByKey.has(`agent:${row.token.agentId}`)) {
        return lastUsedByKey.get(`agent:${row.token.agentId}`) ?? null;
      }
      if (row.token.agentId && lastUsedByKey.has(row.token.agentId)) return lastUsedByKey.get(row.token.agentId) ?? null;
      return null;
    },
    [lastUsedByKey],
  );

  const filtered = useMemo(() => {
    return windowedEvents.filter((row) => {
      if (selectedTokenKey !== 'all') {
        const selectedAgentId = selectedTokenRow?.token.agentId;
        const tokenMatch = row.tokenKey === selectedTokenKey || row.tokenHash === selectedTokenKey;
        const agentMatch = selectedAgentId ? row.agentId === selectedAgentId : false;
        if (!tokenMatch && !agentMatch) return false;
      }
      if (decisionFilter !== 'all' && row.decision !== decisionFilter) return false;
      if (normalizedSearch) {
        const haystack = `${row.tokenHash ?? ''} ${row.tokenKey} ${row.agentId ?? ''}`.toLowerCase();
        if (!haystack.includes(normalizedSearch)) return false;
      }
      return true;
    });
  }, [decisionFilter, windowedEvents, selectedTokenKey, selectedTokenRow, normalizedSearch]);

  const pagedRows = useMemo(() => {
    const start = page * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  const handleOpenActivity = useCallback((tokenKey: string) => {
    setSelectedTokenKey(tokenKey);
    setPage(0);
    if (activitySectionRef.current && typeof activitySectionRef.current.scrollIntoView === 'function') {
      activitySectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const handleCopyShortHash = useCallback(async (tokenKey: string, tokenHash: string | undefined) => {
    if (!tokenHash || !navigator.clipboard) {
      setNotice('Clipboard unavailable for this key.');
      return;
    }
    try {
      const value = shortHash(tokenHash);
      await navigator.clipboard.writeText(value);
      setCopiedTokenKey(tokenKey);
      setNotice(`Copied ${value}`);
      setTimeout(() => setCopiedTokenKey((prev) => (prev === tokenKey ? null : prev)), 1500);
    } catch {
      setNotice('Clipboard write failed.');
    }
  }, []);

  const handleRevokeClick = useCallback((tokenKey: string, tokenHash: string | undefined) => {
    if (!tokenHash) {
      setNotice('Token hash unavailable; cannot revoke.');
      return;
    }
    setRevokeTarget({ tokenKey, tokenHash });
  }, []);

  const handleRevokeConfirm = useCallback(async () => {
    if (!revokeTarget) return;
    const { tokenKey, tokenHash } = revokeTarget;
    setRevokeTarget(null);
    setRevokingTokenKey(tokenKey);
    setNotice(null);
    try {
      const result = await api.post<{ success: boolean; error?: string }>(Api.Wallet, '/actions/tokens/revoke', { tokenHash });
      if (!result.success) {
        setNotice(result.error || 'Failed to revoke token.');
        return;
      }
      setNotice(`Revoked ${shortHash(tokenHash)}`);
      await fetchAll();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to revoke token.');
    } finally {
      setRevokingTokenKey(null);
    }
  }, [revokeTarget, fetchAll]);

  if (loading) {
    return <div className="p-4 font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">LOADING_AUDIT_CONSOLE…</div>;
  }

  if (error) {
    return (
      <div className="p-4 border border-[var(--color-warning,#ff4d00)] bg-[color-mix(in_srgb,var(--color-warning,#ff4d00)_10%,transparent)]">
        <div className="flex items-center gap-2 font-mono text-[10px] text-[var(--color-warning,#ff4d00)]">
          <AlertTriangle size={12} /> {error}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-3 gap-3 overflow-hidden">
      <div className="flex items-center justify-between border border-[var(--color-border,#d4d4d8)] p-2 bg-[var(--color-surface,#fff)]">
        <div>
          <div className="font-mono text-[11px] font-bold">AUDIT</div>
          <div className="font-mono text-[9px] text-[var(--color-text-muted,#6b7280)]">
            {WINDOW_OPTIONS.find((opt) => opt.value === timeWindow)?.label.toLowerCase()} · {Math.min(events.length, HARD_CAP)} rows
            {events.length >= HARD_CAP ? ' (capped)' : ''}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void fetchAll()} icon={<RefreshCw size={10} />}>
          REFRESH
        </Button>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
        <div className="border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] p-2">
          <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">ACTIVE KEYS</div>
          <div className="font-mono text-[12px] font-bold">{summary.activeCount}</div>
        </div>
        <div className="border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] p-2">
          <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">DENIES ({timeWindow})</div>
          <div className="font-mono text-[12px] font-bold">{summary.denied}</div>
        </div>
        <div className="border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] p-2">
          <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">RATE LIMITED ({timeWindow})</div>
          <div className="font-mono text-[12px] font-bold">{summary.rateLimited}</div>
        </div>
        <div className="border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] p-2">
          <div className="font-mono text-[8px] text-[var(--color-text-muted,#6b7280)]">UNKNOWN MAPS ({timeWindow})</div>
          <div className="font-mono text-[12px] font-bold">{summary.unknown}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-2">
        <FilterDropdown
          label="Status"
          options={STATUS_OPTIONS}
          value={statusFilter}
          onChange={(value) => setStatusFilter(value as TokenStatusFilter)}
          compact
        />

        <FilterDropdown
          label="Window"
          options={WINDOW_OPTIONS}
          value={timeWindow}
          onChange={(value) => setTimeWindow(value as TimeWindow)}
          compact
        />

        <FilterDropdown
          label="Token"
          options={tokenOptions}
          value={selectedTokenKey}
          onChange={setSelectedTokenKey}
          compact
        />

        <FilterDropdown
          label="Decision"
          options={DECISION_OPTIONS}
          value={decisionFilter}
          onChange={(value) => setDecisionFilter(value as UiDecision | 'all')}
          compact
        />

        <label className="font-mono text-[9px] flex flex-col gap-1">
          SEARCH KEY / AGENT
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="hash or agent id"
            className="border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] px-2 py-1.5 text-[10px]"
          />
        </label>
      </div>

      {notice && (
        <div className="font-mono text-[9px] border border-[var(--color-info,#0047ff)] p-2 text-[var(--color-info,#0047ff)] bg-[color-mix(in_srgb,var(--color-info,#0047ff)_8%,transparent)]">
          {notice}
        </div>
      )}

      <div className="border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)] overflow-hidden">
        <div className="px-2 py-1.5 border-b border-[var(--color-border,#d4d4d8)] font-mono text-[9px]">
          KEY INVENTORY · {filteredTokenRows.length} ROWS
        </div>
        <div className="max-h-[220px] overflow-auto">
          {filteredTokenRows.length === 0 ? (
            <div className="p-4 font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">NO TOKENS MATCH FILTERS</div>
          ) : (
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-[var(--color-surface-alt,#fafafa)] border-b">
                <tr className="font-mono text-[9px]">
                  <th className="p-2">KEY</th>
                  <th className="p-2">AGENT</th>
                  <th className="p-2">PERMISSIONS</th>
                  <th className="p-2">ISSUED</th>
                  <th className="p-2">EXPIRES</th>
                  <th className="p-2">LAST USED</th>
                  <th className="p-2">ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {filteredTokenRows.map((row) => {
                  const lastUsed = getLastUsed(row);
                  const isRevoking = revokingTokenKey === row.key;
                  const canRevoke = row.status === 'active' && Boolean(row.token.tokenHash);
                  return (
                    <tr key={row.key} className="border-b font-mono text-[9px]">
                      <td className="p-2">
                        <div>{shortHash(row.token.tokenHash ?? row.key)}</div>
                        <div className={`text-[8px] uppercase ${statusTone(row.status)}`}>{row.status}</div>
                      </td>
                      <td className="p-2">{row.token.agentId ?? 'unknown'}</td>
                      <td className="p-2">{permissionsSummary(row.token.permissions ?? [])}</td>
                      <td className="p-2">{formatDate(row.token.createdAt)}</td>
                      <td className="p-2">
                        {formatDate(row.token.expiresAt)}
                        <div className="text-[8px] text-[var(--color-text-faint,#9ca3af)]">{formatRelative(row.token.expiresAt)}</div>
                      </td>
                      <td className="p-2">{lastUsed ? new Date(lastUsed).toLocaleString() : '—'}</td>
                      <td className="p-2">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => void handleCopyShortHash(row.key, row.token.tokenHash)}
                            className="border px-1.5 py-0.5 text-[8px] disabled:opacity-40"
                            title="Copy short hash"
                            disabled={!row.token.tokenHash}
                          >
                            <span className="inline-flex items-center gap-1">
                              <Copy size={8} />
                              {copiedTokenKey === row.key ? 'COPIED' : 'COPY'}
                            </span>
                          </button>
                          <button
                            onClick={() => handleOpenActivity(row.key)}
                            className="border px-1.5 py-0.5 text-[8px]"
                            title="Open activity"
                          >
                            VIEW
                          </button>
                          <button
                            onClick={() => handleRevokeClick(row.key, row.token.tokenHash)}
                            disabled={!canRevoke || isRevoking}
                            className="border px-1.5 py-0.5 text-[8px] disabled:opacity-40 text-[var(--color-warning,#ff4d00)]"
                            title={canRevoke ? 'Revoke token' : 'Token cannot be revoked'}
                          >
                            {isRevoking ? 'REVOKING' : 'REVOKE'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div ref={activitySectionRef} className="flex-1 overflow-auto border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#fff)]">
        <div className="sticky top-0 z-10 px-2 py-1.5 border-b bg-[var(--color-surface-alt,#fafafa)] font-mono text-[9px] flex items-center justify-between">
          <span>TOKEN ACTIVITY · {filtered.length} ROWS</span>
          <span className="text-[var(--color-text-muted,#6b7280)]">
            PAGE {page + 1} / {Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))}
          </span>
        </div>

        {events.length >= HARD_CAP && (
          <div className="font-mono text-[9px] border-b border-[var(--color-warning,#ff4d00)] p-2 text-[var(--color-warning,#ff4d00)]">
            RESULTS TRUNCATED AT 500 ROWS — NARROW FILTERS TO REDUCE VOLUME.
          </div>
        )}

        {pagedRows.length === 0 ? (
          <div className="p-4 font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">NO AUDIT EVENTS IN WINDOW</div>
        ) : (
          <table className="w-full text-left">
            <thead className="sticky top-[31px] bg-[var(--color-surface-alt,#fafafa)] border-b">
              <tr className="font-mono text-[9px]">
                <th className="p-2">TIME</th>
                <th className="p-2">TOKEN / AGENT</th>
                <th className="p-2">DECISION</th>
                <th className="p-2">REASON</th>
                <th className="p-2">CONFIDENCE</th>
                <th className="p-2">ENDPOINT</th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((row) => (
                <tr key={row.id} className="border-b font-mono text-[9px]">
                  <td className="p-2">{new Date(row.timestamp).toLocaleString()}</td>
                  <td className="p-2">{row.agentId ?? 'unknown'} · {row.tokenKey.slice(0, 10)}</td>
                  <td className="p-2">{row.decision}</td>
                  <td className="p-2">{row.reasonCode}{row.rawReasonCode && row.reasonCode === 'UNKNOWN' ? ` (${row.rawReasonCode})` : ''}</td>
                  <td className="p-2" title={row.confidence === 'HIGH' ? 'Direct token hash match' : row.confidence === 'MEDIUM' ? 'Agent correlation' : 'Partial/ambiguous join'}>{row.confidence}</td>
                  <td className="p-2">{row.endpoint ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
          className="font-mono text-[9px] border px-2 py-1 disabled:opacity-40"
        >
          PREV
        </button>
        <button
          onClick={() => setPage((p) => (p + 1) * PAGE_SIZE < filtered.length ? p + 1 : p)}
          disabled={(page + 1) * PAGE_SIZE >= filtered.length}
          className="font-mono text-[9px] border px-2 py-1 disabled:opacity-40"
        >
          NEXT
        </button>
      </div>

      <ConfirmationModal
        isOpen={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => void handleRevokeConfirm()}
        title="Revoke Token"
        message={revokeTarget ? `Revoke token ${shortHash(revokeTarget.tokenHash)}? The agent will lose access immediately.` : ''}
        confirmText="REVOKE"
        variant="danger"
      />
    </div>
  );
}
