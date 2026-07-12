'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, Api } from '@/lib/api';

type HealthFlagSummary = {
  totalAnalyzed: number;
  safe: number;
  weak: number;
  reused: number;
  breached: number;
  unknown: number;
  lastScanAt: string;
};

type HealthRow = {
  id: string;
  name: string;
  type: string;
  agentId: string;
  health: {
    status: string;
    flags: { weak: boolean; reused: boolean; breached: boolean; unknown: boolean };
    evidence: {
      reuseCount: number;
      breachCount: number | null;
      weakReasons: string[];
    };
    engineVersion: string;
    lastScannedAt: string | null;
  };
};

type ScanStatus = 'idle' | 'queued' | 'running' | 'complete' | 'failed' | 'expired';

const STATUS_TONE: Record<string, string> = {
  safe: 'text-emerald-700',
  weak: 'text-amber-700',
  reused: 'text-orange-700',
  breached: 'text-red-700',
  unknown: 'text-slate-600',
  weak_reused: 'text-orange-700',
  weak_breached: 'text-red-700',
  reused_breached: 'text-red-700',
  weak_reused_breached: 'text-red-700',
};

function fmtTime(input?: string | null): string {
  if (!input) return '—';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export function CredentialHealthDashboard() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<HealthFlagSummary | null>(null);
  const [rows, setRows] = useState<HealthRow[]>([]);
  const [scanId, setScanId] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [scanError, setScanError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [summaryRes, rowsRes] = await Promise.all([
        api.get<{ success: boolean; summary: HealthFlagSummary }>(Api.Wallet, '/credentials/health/summary'),
        api.get<{ success: boolean; credentials: HealthRow[] }>(Api.Wallet, '/credentials/health'),
      ]);
      setSummary(summaryRes.summary);
      setRows(rowsRes.credentials || []);
    } catch (err) {
      setError((err as Error).message || 'Failed to load credential health');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!scanId || (scanStatus !== 'queued' && scanStatus !== 'running')) return;

    const timer = setInterval(async () => {
      try {
        const res = await api.get<{
          success: boolean;
          scan: { status: ScanStatus; error?: string };
        }>(Api.Wallet, `/credentials/health/rescan/${scanId}`);
        setScanStatus(res.scan.status);
        setScanError(res.scan.error || null);
        if (res.scan.status === 'complete') {
          await load();
        }
      } catch (err) {
        setScanStatus('failed');
        setScanError((err as Error).message || 'Failed to read scan status');
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [scanId, scanStatus, load]);

  const startRescan = useCallback(async () => {
    setScanError(null);
    setScanStatus('queued');
    try {
      const res = await api.post<{ accepted: boolean; scanId: string }>(Api.Wallet, '/credentials/health/rescan');
      setScanId(res.scanId);
    } catch (err) {
      setScanStatus('failed');
      setScanError((err as Error).message || 'Failed to start rescan');
    }
  }, []);

  const engineVersion = useMemo(() => rows.find((row) => row.health?.engineVersion)?.health.engineVersion, [rows]);

  if (loading) {
    return <div className="p-6 font-mono text-xs">LOADING_HEALTH...</div>;
  }

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <div className="font-mono text-xs text-red-700">{error}</div>
        <button className="border px-3 py-2 font-mono text-xs" onClick={() => void load()}>RETRY</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-background,#f4f4f5)] p-6">
      <div className="max-w-6xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="font-mono text-lg">Credential Health</h1>
            <p className="font-mono text-xs text-[var(--color-text-muted,#6b7280)]">
              Last scan: {fmtTime(summary?.lastScanAt)} {engineVersion ? `· Engine v${engineVersion}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/wallet" className="border px-3 py-2 font-mono text-xs">AGENT</Link>
            <button className="border px-3 py-2 font-mono text-xs" onClick={() => void startRescan()}>
              RESCAN
            </button>
          </div>
        </div>

        {(scanStatus !== 'idle' || scanError) && (
          <div className="border p-3 font-mono text-xs bg-white">
            RESCAN_STATUS: {scanStatus.toUpperCase()}
            {scanError ? ` · ${scanError}` : ''}
          </div>
        )}

        {summary && summary.unknown > 0 && (
          <div className="border border-amber-500/40 bg-amber-50 p-3 font-mono text-xs text-amber-800">
            Some breach checks are unknown (network/rate-limit/disabled). Retry later or enable HEALTH_BREACH_CHECK.
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {[
            ['WEAK', summary?.weak || 0],
            ['REUSED', summary?.reused || 0],
            ['BREACHED', summary?.breached || 0],
            ['UNKNOWN', summary?.unknown || 0],
            ['SAFE', summary?.safe || 0],
          ].map(([label, count]) => (
            <div key={label} className="border bg-white p-3">
              <div className="font-mono text-[10px] text-[var(--color-text-muted,#6b7280)]">{label}</div>
              <div className="font-mono text-xl">{count}</div>
            </div>
          ))}
        </div>

        <div className="border bg-white overflow-hidden">
          <table className="w-full text-left font-mono text-xs">
            <thead className="bg-[var(--color-background,#f4f4f5)]">
              <tr>
                <th className="p-2">Credential</th>
                <th className="p-2">Status</th>
                <th className="p-2">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td className="p-3" colSpan={3}>No scannable credentials found.</td></tr>
              ) : rows.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="p-2">
                    <div>{row.name}</div>
                    <div className="text-[10px] text-[var(--color-text-muted,#6b7280)]">{row.type} · {row.agentId}</div>
                  </td>
                  <td className={`p-2 uppercase ${STATUS_TONE[row.health.status] || 'text-slate-700'}`}>
                    {row.health.status.replaceAll('_', ' ')}
                  </td>
                  <td className="p-2 text-[10px] text-[var(--color-text-muted,#6b7280)]">
                    reuse={row.health.evidence.reuseCount}; breaches={row.health.evidence.breachCount ?? 'unknown'};
                    weak={row.health.evidence.weakReasons.length > 0 ? row.health.evidence.weakReasons.join(',') : 'none'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
