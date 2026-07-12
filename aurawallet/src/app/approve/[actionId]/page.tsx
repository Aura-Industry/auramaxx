'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { api, Api, unlockWallet } from '@/lib/api';
import { generateAgentKeypair } from '@/lib/agent-crypto';

interface ActionSummary {
  success: boolean;
  id: string;
  type: string;
  status: string;
  action: string;
  scope?: string[];
  impact?: string[];
  risk?: string;
  profile?: string;
}

type PageState = 'loading' | 'locked' | 'ready';

export default function ApproveActionPage() {
  const { actionId } = useParams<{ actionId: string }>();
  const { setToken } = useAuth();

  const [pageState, setPageState] = useState<PageState>('loading');
  const [action, setAction] = useState<ActionSummary | null>(null);

  // Unlock form state
  const [password, setPassword] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);
  const [unlockLoading, setUnlockLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAction = useCallback(async () => {
    try {
      const data = await api.get<ActionSummary>(Api.Wallet, `/actions/${encodeURIComponent(actionId)}/summary`);
      setAction(data);
    } catch {
      setAction(null);
    }
  }, [actionId]);

  // Check setup status on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const setup = await api.get<{ hasWallet: boolean; unlocked: boolean }>(Api.Wallet, '/setup');
        if (cancelled) return;
        if (!setup.hasWallet) {
          window.location.href = `/wallet?next=${encodeURIComponent(`/approve/${actionId}`)}`;
          return;
        }
        if (!setup.unlocked) {
          setPageState('locked');
          return;
        }
        // Unlocked — fetch action and show approval
        await fetchAction();
        if (!cancelled) setPageState('ready');
      } catch {
        if (!cancelled) setPageState('locked');
      }
    })();
    return () => { cancelled = true; };
  }, [fetchAction]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;

    setUnlockLoading(true);
    setError(null);
    try {
      const { publicKeyBase64 } = await generateAgentKeypair();
      const data = await unlockWallet(password, undefined, publicKeyBase64);
      if (data.token) {
        setToken(data.token, { persist: trustDevice ? 'local' : 'session' });
      }
      setPassword('');
      // Fetch action summary now that we're unlocked
      await fetchAction();
      setPageState('ready');
    } catch (err) {
      setError((err as Error).message || 'Unlock failed');
    } finally {
      setUnlockLoading(false);
    }
  };

  const handleResolve = async (approved: boolean) => {
    setResolving(true);
    setError(null);
    try {
      await api.post(Api.Wallet, `/actions/${encodeURIComponent(actionId)}/resolve`, { approved });
      // Re-fetch action to get the resolved status from the server
      await fetchAction();
    } catch (err) {
      setError((err as Error).message || 'Failed to resolve action');
    } finally {
      setResolving(false);
    }
  };

  // Derive display state from action status
  const state: string = action?.status === 'approved' ? 'approved' : action?.status === 'rejected' ? 'denied' : action?.status === 'expired' ? 'expired' : 'pending';

  const actionName = action?.action || 'Unspecified action';
  const scopeItems = action?.scope || [];
  const impactItems = action?.impact || [];
  const isLimitBasedRequest = impactItems.some((item) => /^(Fund|Send|Swap) limit:/i.test(item));
  const hasFundPermission = scopeItems.some((item) => item.trim().toLowerCase() === 'fund');
  const isAuthApproval = action?.type === 'auth';
  const hideApproveUi = !isAuthApproval && (action?.type === 'fund' || hasFundPermission || isLimitBasedRequest);
  const riskLevel = (action?.risk || 'unknown').toUpperCase();
  const profileName = action?.profile;
  const isAdminProfile = profileName?.trim().toLowerCase() === 'admin';
  const hasAdminPermission = scopeItems.includes('admin:*');
  const isAdminRequest = isAdminProfile || hasAdminPermission;
  const displayScopeItems = isAdminRequest ? ['admin'] : scopeItems;

  const hasScopeContext = displayScopeItems.length > 0 || impactItems.length > 0;

  const isResolved = state === 'approved' || state === 'denied' || state === 'expired';

  const statusLabel =
    state === 'approved' ? 'APPROVED'
      : state === 'denied' ? 'DENIED'
        : state === 'expired' ? 'EXPIRED'
          : 'PENDING';

  const copy =
    state === 'approved'
      ? { title: 'ACTION APPROVED', body: 'This request has been approved. Return to your CLI/agent and retry.' }
      : state === 'denied'
        ? { title: 'ACTION DENIED', body: 'This request was denied. You can close this page.' }
        : state === 'expired'
          ? { title: 'ACTION EXPIRED', body: 'This approval link has expired. Generate a new approval request.' }
          : {
            title: 'REVIEW PERMISSION REQUEST',
            body: 'Confirm what this action can do before choosing Approve or Deny.',
          };

  return (
    <div className="min-h-screen bg-[var(--color-background,#f4f4f5)] relative flex items-center justify-center p-4">
      {/* Background — sterile field */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute inset-0 bg-grid-adaptive bg-[size:4rem_4rem] opacity-30" />
        <div className="absolute inset-0 tyvek-texture opacity-40 mix-blend-multiply" />

        {/* Giant background typography */}
        <div className="absolute bottom-[5%] right-[5%] opacity-5 select-none">
          <div className="text-[15vw] font-bold leading-none text-[var(--color-text,#0a0a0a)] font-mono tracking-tighter text-right">
            AURAWALLET
          </div>
        </div>

        {/* Corner finder patterns */}
        <div className="absolute top-10 left-10 w-32 h-32 border-l-4 border-t-4 border-[var(--color-text,#0a0a0a)] opacity-10">
          <div className="absolute top-2 left-2 w-4 h-4 bg-[var(--color-text,#0a0a0a)]" />
        </div>
        <div className="absolute bottom-10 right-10 w-32 h-32 border-r-4 border-b-4 border-[var(--color-text,#0a0a0a)] opacity-10 flex items-end justify-end">
          <div className="absolute bottom-2 right-2 w-4 h-4 bg-[var(--color-text,#0a0a0a)]" />
        </div>
      </div>

      {/* Logo header */}
      <div className="fixed top-6 left-6 z-50 flex items-center gap-3">
        <div className="w-10 h-10">
          <img src="/logo.webp" alt="AuraWallet" className="w-full h-full object-contain" />
        </div>
      </div>

      {/* Nav */}
      <div className="fixed top-7 right-6 z-50 flex items-center gap-3 font-mono text-[10px] tracking-widest">
        <Link href="/wallet" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">HOME</Link>
        <Link href="/docs" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">DOCS</Link>
        <Link href="/api" className="text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] transition-colors">API</Link>
      </div>

      {/* Main card */}
      <div className="relative z-10 w-full max-w-[420px]">
        {/* Vertical specimen label */}
        <div className="absolute -left-8 top-1/2 -translate-y-1/2 text-vertical label-specimen-sm text-[var(--color-text-faint,#9ca3af)] select-none hidden sm:block">
          PERMISSION&nbsp;REVIEW
        </div>
        <div className="bg-[var(--color-surface,#f4f4f2)] clip-specimen border-mech shadow-mech overflow-hidden font-mono corner-marks">
          {/* Loading state */}
          {pageState === 'loading' && (
            <div className="p-6 flex items-center justify-center gap-2">
              <div className="w-3 h-3 border border-[var(--color-text,#0a0a0a)] border-t-transparent animate-spin" />
              <span className="text-[10px] text-[var(--color-text-muted,#6b7280)] tracking-widest">LOADING...</span>
            </div>
          )}

          {/* Locked — unlock form */}
          {pageState === 'locked' && (
            <>
              <div className="px-5 py-3 border-b border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] flex items-center justify-between">
                <span className="font-sans font-bold text-sm text-[var(--color-text,#0a0a0a)] uppercase tracking-tight">
                  UNLOCK AGENT
                </span>
                <span className="text-[9px] font-bold tracking-widest text-[var(--color-warning,#ff4d00)]">
                  LOCKED
                </span>
              </div>
              <div className="p-6">
                <div className="text-[10px] text-[var(--color-text-muted,#6b7280)] tracking-wider mb-4">
                  Unlock your agent to review this permission request.
                </div>
                <form onSubmit={handleUnlock} className="space-y-4">
                  <div>
                    <label className="block text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest mb-1.5 uppercase">
                      Password
                    </label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); setError(null); }}
                      placeholder="Enter agent password"
                      className="w-full px-3 py-2.5 border border-[var(--color-border,#d4d4d8)] font-mono text-sm text-[var(--color-text,#0a0a0a)] focus:outline-none focus:border-[var(--color-text,#0a0a0a)] bg-[var(--color-surface,#ffffff)] placeholder-[var(--color-text-faint,#9ca3af)] transition-colors"
                      autoFocus
                    />
                  </div>
                  <label className="flex items-center justify-between gap-3 text-[8px] tracking-widest uppercase text-[var(--color-text-muted,#6b7280)]">
                    <span className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={trustDevice}
                        onChange={(e) => setTrustDevice(e.target.checked)}
                        className="h-3.5 w-3.5 border border-[var(--color-border,#d4d4d8)] accent-[var(--color-text,#0a0a0a)]"
                      />
                      Trusted device
                    </span>
                    <span>{trustDevice ? 'PERSISTENT' : 'TAB ONLY'}</span>
                  </label>

                  {error && (
                    <div
                      data-testid="unlock-error-banner"
                      className="text-[9px] text-[var(--color-danger,#ef4444)] px-3 py-2 border"
                      style={{
                        borderColor: 'color-mix(in srgb, var(--color-danger,#ef4444) 35%, transparent)',
                        background: 'color-mix(in srgb, var(--color-danger,#ef4444) 12%, transparent)',
                      }}
                    >
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={unlockLoading || !password}
                    className="w-full py-2.5 bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] font-mono text-xs tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {unlockLoading ? (
                      <>
                        <div className="w-3 h-3 border border-[var(--color-surface,#ffffff)] border-t-transparent animate-spin" />
                        UNLOCKING...
                      </>
                    ) : (
                      'UNLOCK'
                    )}
                  </button>
                </form>
              </div>
            </>
          )}

          {/* Ready — approval content */}
          {pageState === 'ready' && !hideApproveUi && (
            <>
              {/* Card header bar */}
              <div className="px-5 py-3 border-b border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] flex items-center justify-between">
                <span className="font-sans font-bold text-sm text-[var(--color-text,#0a0a0a)] uppercase tracking-tight">
                  {copy.title}
                </span>
                <span className={`text-[9px] font-bold tracking-widest ${state === 'approved' ? 'text-[var(--color-info,#0047ff)]'
                    : state === 'denied' ? 'text-[var(--color-danger,#ef4444)]'
                      : state === 'expired' ? 'text-[var(--color-text-faint,#9ca3af)]'
                        : 'text-[var(--color-warning,#ff4d00)]'
                  }`}>
                  {statusLabel}
                </span>
              </div>

              <div className="p-6 space-y-4">
                {/* Status message */}
                <p className="text-[10px] text-[var(--color-text-muted,#6b7280)] tracking-wider">
                  {copy.body}
                </p>

                {/* Action details */}
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="label-specimen-sm text-[var(--color-text-faint,#9ca3af)]">ACTION</span>
                    <span className="text-[11px] text-[var(--color-text,#0a0a0a)] font-bold tracking-wider text-right">{actionName}</span>
                  </div>
                  {profileName && (
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="label-specimen-sm text-[var(--color-text-faint,#9ca3af)]">PROFILE</span>
                      <span className="text-[11px] text-[var(--color-text,#0a0a0a)] tracking-wider text-right">{profileName}</span>
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="label-specimen-sm text-[var(--color-text-faint,#9ca3af)]">RISK</span>
                    <span className={`text-[11px] font-bold tracking-wider ${riskLevel === 'HIGH' ? 'text-[var(--color-danger,#ef4444)]'
                        : riskLevel === 'MEDIUM' ? 'text-[var(--color-warning,#ff4d00)]'
                          : 'text-[var(--color-text,#0a0a0a)]'
                      }`}>{riskLevel}</span>
                  </div>
                  <div className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest break-all">
                    ID: {actionId}
                  </div>
                </div>

                {/* Scope + Impact */}
                {hasScopeContext && (
                  <div className="border-t border-[var(--color-border,#d4d4d8)] pt-3 space-y-3">
                    {displayScopeItems.length > 0 && (
                      <div>
                        <div className="label-specimen-sm text-[var(--color-text-faint,#9ca3af)] mb-1.5">PERMISSIONS</div>
                        <div className="space-y-1">
                          {displayScopeItems.map((item) => {
                            const isAdminPermission = isAdminRequest && item.trim().toLowerCase() === 'admin';
                            return (
                              <div
                                key={item}
                                className={`text-[10px] tracking-wider pl-2 border-l-2 ${
                                  isAdminPermission
                                    ? 'text-[var(--color-danger,#ef4444)] border-[var(--color-danger,#ef4444)]'
                                    : 'text-[var(--color-text,#0a0a0a)] border-[var(--color-border,#d4d4d8)]'
                                }`}
                              >
                                {item}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {impactItems.length > 0 && (
                      <div>
                        <div className="label-specimen-sm text-[var(--color-text-faint,#9ca3af)] mb-1.5">IMPACT</div>
                        <div className="space-y-1">
                          {impactItems.map((item) => (
                            <div key={item} className="text-[10px] text-[var(--color-text,#0a0a0a)] tracking-wider pl-2 border-l-2 border-[var(--color-border,#d4d4d8)]">
                              {item}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Missing scope warning */}
                {!hasScopeContext && !action && (
                  <div className="text-[9px] text-[var(--color-warning,#ff4d00)] bg-[var(--color-warning,#ff4d00)]/10 px-3 py-2 border border-[var(--color-warning,#ff4d00)]/20">
                    Could not load action details. Use extra caution and deny if this request is unexpected.
                  </div>
                )}

                {/* Resolve error */}
                {error && (
                  <div
                    className="text-[9px] text-[var(--color-danger,#ef4444)] px-3 py-2 border"
                    style={{
                      borderColor: 'color-mix(in srgb, var(--color-danger,#ef4444) 35%, transparent)',
                      background: 'color-mix(in srgb, var(--color-danger,#ef4444) 12%, transparent)',
                    }}
                  >
                    {error}
                  </div>
                )}

                {/* Approve / Deny buttons */}
                {!isResolved && (
                  <div className="flex gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => handleResolve(true)}
                      disabled={resolving}
                      className="flex-1 py-2.5 bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] font-mono text-[10px] tracking-widest font-bold text-center hover:opacity-90 transition-opacity clip-specimen-sm disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {resolving ? (
                        <>
                          <div className="w-3 h-3 border border-[var(--color-surface,#ffffff)] border-t-transparent animate-spin" />
                          RESOLVING...
                        </>
                      ) : (
                        'APPROVE'
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleResolve(false)}
                      disabled={resolving}
                      className="flex-1 py-2.5 border border-[var(--color-border,#d4d4d8)] text-[var(--color-text-muted,#6b7280)] font-mono text-[10px] tracking-widest font-bold text-center hover:border-[var(--color-text,#0a0a0a)] hover:text-[var(--color-text,#0a0a0a)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      DENY
                    </button>
                  </div>
                )}

                {/* Resolved — link back */}
                {isResolved && (
                  <div className="pt-2">
                    <Link
                      href="/wallet"
                      className="block w-full py-2.5 border border-[var(--color-border,#d4d4d8)] text-[var(--color-text-muted,#6b7280)] font-mono text-[10px] tracking-widest font-bold text-center hover:border-[var(--color-text,#0a0a0a)] hover:text-[var(--color-text,#0a0a0a)] transition-colors"
                    >
                      RETURN TO DASHBOARD
                    </Link>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
