'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Check, X, ChevronUp, ChevronDown, Zap, ArrowUpRight, KeyRound, Clock, Shield, Info, AlertTriangle, Lock } from 'lucide-react';
import { Button } from '@/components/design-system';
import type { HumanAction } from '@/hooks/useAgentActions';

interface HumanActionBarProps {
  requests: HumanAction[];
  resolveAction: (id: string, approved: boolean) => Promise<unknown>;
  actionLoading: string | null;
}

// ---------------------------------------------------------------------------
// Verified summary types (mirrors server/lib/verified-summary.ts)
// ---------------------------------------------------------------------------

interface VerifiedFact {
  label: string;
  value: string;
  raw?: string;
}

interface SummaryDiscrepancy {
  field: string;
  agentClaim: string;
  actual: string;
  severity: 'info' | 'warning' | 'critical';
}

interface VerifiedSummary {
  action: string;
  oneLiner: string;
  facts: VerifiedFact[];
  permissionLabels: string[];
  limitLabels: string[];
  walletAccessLabels: string[];
  ttlLabel: string;
  agentId: string;
  discrepancies: SummaryDiscrepancy[];
  verified: boolean;
  generatedAt: string;
}

interface ActionMeta {
  approvalScope?: 'one_shot_read' | 'session_token';
  agentId?: string;
  summary?: string;
  limit?: number;
  requestedLimitExplicit?: boolean;
  defaultFundLimit?: number;
  permissions?: string[];
  limits?: Record<string, number>;
  walletAccess?: string[];
  ttl?: number;
  action?: { endpoint?: string; method?: string; body?: Record<string, unknown> };
  verifiedSummary?: VerifiedSummary;
  escalationReason?: string;
  credentialAccess?: {
    maxReads?: number | null;
  };
  profile?: { id: string; version: string; displayName: string; rationale?: string };
}

type ApprovalScope = 'one_shot_read' | 'session_token';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseActionMeta(request: HumanAction): ActionMeta {
  if (!request.metadata) return {};
  try {
    return JSON.parse(request.metadata);
  } catch {
    return {};
  }
}

function formatSummary(request: HumanAction): string {
  if (request.humanSummary?.oneLiner) return request.humanSummary.oneLiner;
  const meta = parseActionMeta(request);
  if (meta.summary) return meta.summary;
  if (meta.verifiedSummary?.oneLiner) return meta.verifiedSummary.oneLiner;
  const agent = meta.agentId || 'agent';
  const type = request.type.replace(/_/g, ' ');
  if (request.amount) return `${agent} requesting ${request.amount} ETH`;
  return `${agent} — ${type}`;
}

function hasDiscrepancies(request: HumanAction): boolean {
  const meta = parseActionMeta(request);
  return (meta.verifiedSummary?.discrepancies?.length ?? 0) > 0;
}

function hasDetailContent(meta: ActionMeta, readable?: HumanAction['humanSummary']): boolean {
  const permissionCount = meta.verifiedSummary?.permissionLabels?.length ?? meta.permissions?.length ?? 0;
  const warningCount = meta.verifiedSummary?.discrepancies?.length ?? 0;
  const readableCount = (readable?.can.length ?? 0) + (readable?.scope.length ?? 0) + (readable?.cannot.length ?? 0);
  return Boolean(meta.summary || permissionCount > 0 || warningCount > 0 || readableCount > 0);
}

function getTypeIcon(type: string) {
  switch (type) {
    case 'agent_access': return <KeyRound size={10} />;
    case 'fund': return <ArrowUpRight size={10} />;
    case 'send': return <Zap size={10} />;
    case 'action': return <Shield size={10} />;
    default: return <Zap size={10} />;
  }
}

function formatTypeLabel(type: string): string {
  switch (type) {
    case 'agent_access': return 'ACCESS';
    case 'fund': return 'FUND';
    case 'send': return 'SEND';
    case 'action': return 'ACTION';
    default: return type.toUpperCase().replace(/_/g, ' ');
  }
}

function normalizeApprovalScope(value: unknown): ApprovalScope | null {
  if (value === 'one_shot_read' || value === 'session_token') return value;
  return null;
}

function resolveApprovalScope(request: HumanAction, meta: ActionMeta): ApprovalScope | null {
  const explicit = normalizeApprovalScope(meta.approvalScope);
  if (explicit) return explicit;

  if (meta.escalationReason === 'DENY_EXCLUDED_FIELD') return 'one_shot_read';
  if (typeof meta.credentialAccess?.maxReads === 'number' && meta.credentialAccess.maxReads === 1) {
    return 'one_shot_read';
  }

  if (request.type === 'auth' || request.type === 'agent_access' || request.type === 'action') {
    return 'session_token';
  }

  return null;
}

function approvalScopeLabel(scope: ApprovalScope): string {
  return scope === 'one_shot_read' ? 'temp' : '';
}

function approvalScopeStyle(): { background: string; color: string; border: string } {
  return {
    background: 'var(--color-surface, #ffffff)',
    color: 'var(--color-text, #0a0a0a)',
    border: '1px solid var(--color-border, #d4d4d8)',
  };
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function resolveFailureMessage(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const candidate = result as { success?: unknown; message?: unknown; error?: unknown };
  if (candidate.success !== false) return null;
  if (typeof candidate.message === 'string' && candidate.message.trim().length > 0) return candidate.message.trim();
  if (typeof candidate.error === 'string' && candidate.error.trim().length > 0) return candidate.error.trim();
  return 'request failed';
}

// ---------------------------------------------------------------------------
// Detail section sub-component
// ---------------------------------------------------------------------------

function DetailSection({ icon, label, children, muted }: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex gap-2 py-1.5" style={{ opacity: muted ? 0.7 : 1 }}>
      <div className="shrink-0 mt-0.5" style={{ color: 'var(--color-text-muted, #6b7280)' }}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="font-mono text-[8px] font-bold tracking-[0.15em] uppercase mb-1"
          style={{ color: 'var(--color-text-faint, #9ca3af)' }}
        >
          {label}
        </div>
        <div
          className="font-mono text-[10px]"
          style={{
            color: 'var(--color-text, #0a0a0a)',
            fontStyle: muted ? 'italic' : undefined,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function ActionDetailPanel({ meta, readable }: { meta: ActionMeta; readable?: HumanAction['humanSummary'] }) {
  const vs = meta.verifiedSummary;
  const hasWarnings = (vs?.discrepancies?.length ?? 0) > 0;
  const permissionLabels = vs?.permissionLabels?.length ? vs.permissionLabels : (meta.permissions || []);

  return (
    <div
      className="px-4 py-3"
      style={{
        background: 'var(--color-background-alt, #f4f4f5)',
        borderTop: '1px solid var(--color-border, #e5e5e5)',
      }}
    >
      {/* Discrepancy warning banner */}
      {hasWarnings && vs?.discrepancies && (
        <div
          className="flex items-start gap-2 px-3 py-2 mb-3"
          style={{
            background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 30%, transparent)',
          }}
        >
          <AlertTriangle size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--color-warning, #f59e0b)' }} />
          <div className="font-mono text-[9px]" style={{ color: 'var(--color-text, #0a0a0a)' }}>
            {vs.discrepancies.map((d, i) => (
              <div key={i} className="mb-1 last:mb-0">
                <span
                  className="font-bold uppercase text-[8px] mr-1"
                  style={{
                    color: d.severity === 'critical'
                      ? 'var(--color-danger, #ef4444)'
                      : d.severity === 'warning'
                        ? 'var(--color-warning, #f59e0b)'
                        : 'var(--color-text-muted, #6b7280)',
                  }}
                >
                  {d.severity}
                </span>
                {d.field}: agent says &ldquo;{d.agentClaim}&rdquo;, actual: {d.actual}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AGENT SAYS */}
      {meta.summary && (
        <DetailSection icon={<Info size={10} />} label="AGENT SAYS" muted>
          &ldquo;{meta.summary}&rdquo;
        </DetailSection>
      )}

      {/* PROFILE */}
      {(meta.profile || readable?.profileLabel) && (
        <DetailSection icon={<Shield size={10} />} label="PROFILE">
          <span className="font-bold">{meta.profile?.displayName || readable?.profileLabel}</span>
          {meta.profile?.rationale && (
            <span className="ml-1" style={{ color: 'var(--color-text-muted, #6b7280)' }}>
              — {meta.profile.rationale}
            </span>
          )}
        </DetailSection>
      )}

      {/* PERMISSIONS */}
      {permissionLabels.length > 0 && (
        <DetailSection icon={<Lock size={10} />} label="PERMISSIONS">
          <div className="flex flex-wrap gap-1">
            {permissionLabels.map((label, i) => (
              <span
                key={i}
                className="px-1.5 py-0.5 text-[8px] font-bold"
                style={{
                  background: 'var(--color-border, #e5e5e5)',
                  color: 'var(--color-text-muted, #6b7280)',
                }}
              >
                {label}
              </span>
            ))}
          </div>
        </DetailSection>
      )}

      {readable && (
        <>
          {readable.can.length > 0 && (
            <DetailSection icon={<Shield size={10} />} label="CAN">
              {readable.can.join(', ')}
            </DetailSection>
          )}
          {readable.cannot.length > 0 && (
            <DetailSection icon={<X size={10} />} label="CANNOT">
              {readable.cannot.join('; ')}
            </DetailSection>
          )}
          {readable.scope.length > 0 && (
            <DetailSection icon={<Info size={10} />} label="SCOPE">
              {readable.scope.join(', ')}
            </DetailSection>
          )}
          <DetailSection icon={<Clock size={10} />} label="EXPIRY / RISK">
            {readable.expiresIn} · {readable.riskHint}
          </DetailSection>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActionCard
// ---------------------------------------------------------------------------

function ActionCard({ request, resolveAction, actionLoading, showBorder, bulkLocked = false }: {
  request: HumanAction;
  resolveAction: (id: string, approved: boolean) => Promise<unknown>;
  actionLoading: string | null;
  showBorder: boolean;
  bulkLocked?: boolean;
}) {
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);
  const approving = actionLoading === `resolve-${request.id}` || actionLoading === `approve-${request.id}`;
  const rejecting = actionLoading === `reject-${request.id}`;
  const loading = approving || rejecting || bulkLocked;
  const meta = parseActionMeta(request);
  const approvalScope = resolveApprovalScope(request, meta);
  const hasMismatch = hasDiscrepancies(request);
  const borderColor = hasMismatch
    ? 'var(--color-warning, #f59e0b)'
    : 'var(--color-danger, #ef4444)';

  return (
    <div>
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{
          borderBottom: showBorder && !detailExpanded ? '1px solid var(--color-border, #e5e5e5)' : undefined,
          borderLeft: `3px solid ${borderColor}`,
          background: 'var(--color-surface, #ffffff)',
        }}
      >
        {/* Type badge */}
        <div
          className="flex items-center gap-1 px-1.5 py-0.5 shrink-0"
          style={{
            background: 'var(--color-background-alt, #f4f4f5)',
            border: '1px solid var(--color-border, #e5e5e5)',
            color: 'var(--color-text-muted, #6b7280)',
          }}
        >
          {getTypeIcon(request.type)}
          <span className="font-mono text-[8px] font-bold tracking-wider uppercase">
            {formatTypeLabel(request.type)}
          </span>
        </div>

        {approvalScope === 'one_shot_read' && (
          <span
            className="px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-[0.12em] shrink-0"
            style={approvalScopeStyle()}
          >
            {approvalScopeLabel(approvalScope)}
          </span>
        )}

        {/* Summary + timestamp */}
        <div className="flex-1 min-w-0">
          <div
            className="font-mono text-[10px] truncate flex items-center gap-1.5"
            style={{ color: 'var(--color-text, #0a0a0a)' }}
          >
            {formatSummary(request)}
            {hasMismatch && (
              <span
                className="shrink-0 px-1 py-0 text-[7px] font-bold tracking-wider uppercase"
                style={{
                  background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 15%, transparent)',
                  color: 'var(--color-warning, #f59e0b)',
                  border: '1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 30%, transparent)',
                }}
              >
                MISMATCH
              </span>
            )}
          </div>
          <div
            className="font-mono text-[8px] mt-0.5 flex items-center gap-1"
            style={{ color: 'var(--color-text-faint, #9ca3af)' }}
          >
            <Clock size={7} />
            {timeAgo(request.createdAt)}
          </div>
        </div>

        {/* Detail toggle */}
        {hasDetailContent(meta, request.humanSummary) && (
          <button
            onClick={() => setDetailExpanded(!detailExpanded)}
            className="flex items-center gap-1 shrink-0 hover:opacity-70"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-text-muted, #6b7280)',
              padding: '2px 4px',
            }}
          >
            <Info size={10} />
            {detailExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </button>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="primary"
            size="sm"
            onClick={() => resolveAction(request.id, true)}
            disabled={loading}
            loading={approving}
            icon={!approving ? <Check size={10} /> : undefined}
            className="h-7 px-2"
          >
            APPROVE
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => resolveAction(request.id, false)}
            disabled={loading}
            loading={rejecting}
            icon={!rejecting ? <X size={10} /> : undefined}
            className="h-7 px-2"
          >
            REJECT
          </Button>
        </div>
      </div>

      {/* Expanded detail panel */}
      <div
        style={{
          display: 'grid',
          gridTemplateRows: detailExpanded ? '1fr' : '0fr',
          transition: 'grid-template-rows 150ms ease',
          borderLeft: `3px solid ${borderColor}`,
          borderBottom: showBorder && detailExpanded ? '1px solid var(--color-border, #e5e5e5)' : undefined,
        }}
      >
        <div style={{ overflow: 'hidden' }}>
          {detailExpanded && (
            <>
              <ActionDetailPanel meta={meta} readable={request.humanSummary} />
              <div className="px-4 pb-3 bg-[var(--color-background-alt,#f4f4f5)]">
                <button
                  onClick={() => setRawExpanded((v) => !v)}
                  className="font-mono text-[9px] underline text-[var(--color-text-muted,#6b7280)]"
                >
                  {rawExpanded ? 'Hide raw details' : 'Show raw details'}
                </button>
                {rawExpanded && (
                  <pre className="mt-2 p-2 text-[9px] overflow-x-auto border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#ffffff)]">{request.rawPayload || request.metadata || '{}'}</pre>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main bar
// ---------------------------------------------------------------------------

export const HumanActionBar: React.FC<HumanActionBarProps> = ({
  requests,
  resolveAction,
  actionLoading,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);
  const [bulkApproving, setBulkApproving] = useState(false);
  const [bulkRejecting, setBulkRejecting] = useState(false);
  const [bulkFailureSummary, setBulkFailureSummary] = useState<string | null>(null);
  const pending = requests.filter(r => r.status === 'pending' && r.type !== 'notify');
  const panelRef = useRef<HTMLDivElement>(null);

  // Close expanded panel on outside click
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [expanded]);

  // Auto-collapse when queue drains
  useEffect(() => {
    if (pending.length <= 1) setExpanded(false);
  }, [pending.length]);

  useEffect(() => {
    if (pending.length === 0) {
      setBulkFailureSummary(null);
    }
  }, [pending.length]);

  // Hidden when nothing pending
  if (pending.length === 0) return null;

  const first = pending[0];
  const firstMeta = parseActionMeta(first);
  const firstApprovalScope = resolveApprovalScope(first, firstMeta);
  const firstApproving = actionLoading === `resolve-${first.id}` || actionLoading === `approve-${first.id}`;
  const firstRejecting = actionLoading === `reject-${first.id}`;
  const firstLoading = firstApproving || firstRejecting || bulkApproving || bulkRejecting;
  const firstHasMismatch = hasDiscrepancies(first);
  const firstBorderColor = firstHasMismatch
    ? 'var(--color-warning, #f59e0b)'
    : 'var(--color-danger, #ef4444)';

  const handleResolveAll = async (approved: boolean) => {
    if (bulkApproving || bulkRejecting) return;
    const targets = pending.map((request) => request.id);
    if (targets.length === 0) return;

    const actionLabel = approved ? 'APPROVE ALL' : 'REJECT ALL';
    setBulkFailureSummary(null);
    if (approved) {
      setBulkApproving(true);
    } else {
      setBulkRejecting(true);
    }
    setExpanded(false);

    const failures: Array<{ id: string; message: string }> = [];
    for (const id of targets) {
      try {
        const result = await resolveAction(id, approved);
        const failure = resolveFailureMessage(result);
        if (failure) {
          failures.push({ id, message: failure });
        }
      } catch (error) {
        failures.push({
          id,
          message: error instanceof Error ? error.message : 'request failed',
        });
      }
    }

    if (failures.length > 0) {
      const shown = failures
        .slice(0, 3)
        .map((failure) => `${failure.id} (${failure.message})`)
        .join(', ');
      const more = failures.length > 3 ? ` +${failures.length - 3} more` : '';
      setBulkFailureSummary(`${actionLabel} completed with ${failures.length} failed: ${shown}${more}`);
    }

    if (approved) {
      setBulkApproving(false);
    } else {
      setBulkRejecting(false);
    }
  };

  const handleApproveAll = async () => handleResolveAll(true);
  const handleRejectAll = async () => handleResolveAll(false);

  return (
    <div className="relative z-30" ref={panelRef}>
      {/* Expanded stack — grows upward */}
      {expanded && pending.length > 1 && (
        <div
          className="absolute bottom-full left-0 right-0"
          style={{
            maxHeight: '320px',
            overflowY: 'auto',
            border: '1px solid var(--color-border, #e5e5e5)',
            borderBottom: 'none',
          }}
        >
          {/* Queue header */}
          <div
            className="px-4 py-2 sticky top-0 z-10"
            style={{
              background: 'var(--color-background-alt, #f4f4f5)',
              borderBottom: '1px solid var(--color-border, #e5e5e5)',
            }}
          >
            <span
              className="font-mono text-[8px] font-bold tracking-[0.2em] uppercase"
              style={{ color: 'var(--color-text-faint, #9ca3af)' }}
            >
              QUEUED ACTIONS ({pending.length - 1})
            </span>
          </div>

          {/* Queued action cards */}
          {pending.slice(1).map((req, i) => (
            <ActionCard
              key={req.id}
              request={req}
              resolveAction={resolveAction}
              actionLoading={actionLoading}
              showBorder={i < pending.length - 2}
              bulkLocked={bulkApproving || bulkRejecting}
            />
          ))}
        </div>
      )}

      {/* Main bar */}
      <div
        style={{
          background: 'var(--color-surface, #ffffff)',
          borderTop: '1px solid var(--color-border, #e5e5e5)',
          borderBottom: '1px solid var(--color-border, #e5e5e5)',
        }}
      >
        <div
          className="flex items-center h-14 px-2 gap-2 sm:px-4 sm:gap-3 max-w-full overflow-hidden"
          style={{ borderLeft: `3px solid ${firstBorderColor}` }}
        >
          {/* Red count badge — flat rectangle, no radius */}
          <div
            className="flex items-center justify-center shrink-0"
            style={{
              minWidth: '24px',
              height: '22px',
              padding: '0 6px',
              background: 'var(--color-danger, #ef4444)',
              color: '#ffffff',
              fontFamily: 'monospace',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.05em',
            }}
          >
            {pending.length}
          </div>

          {/* Label */}
          <span
            className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase shrink-0 hidden sm:inline"
            style={{ color: 'var(--color-danger, #ef4444)' }}
          >
            PENDING
          </span>

          {/* Divider */}
          <div
            className="w-px h-6 shrink-0 hidden sm:block"
            style={{ background: 'var(--color-border, #e5e5e5)' }}
          />

          {/* Type badge */}
          <div
            className="hidden sm:flex items-center gap-1 px-1.5 py-0.5 shrink-0"
            style={{
              background: 'var(--color-background-alt, #f4f4f5)',
              border: '1px solid var(--color-border, #e5e5e5)',
              color: 'var(--color-text-muted, #6b7280)',
            }}
          >
            {getTypeIcon(first.type)}
            <span className="font-mono text-[8px] font-bold tracking-[0.15em] uppercase">
              {formatTypeLabel(first.type)}
            </span>
          </div>

          {firstApprovalScope === 'one_shot_read' && (
            <span
              className="hidden sm:inline px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-[0.12em] shrink-0"
              style={approvalScopeStyle()}
            >
              {approvalScopeLabel(firstApprovalScope)}
            </span>
          )}

          {/* Summary */}
          <div
            className="font-mono text-[11px] truncate min-w-0 flex-1 flex items-center gap-1.5"
            style={{ color: 'var(--color-text, #0a0a0a)' }}
          >
            {formatSummary(first)}
            {firstHasMismatch && (
              <span
                className="shrink-0 px-1 py-0 text-[7px] font-bold tracking-wider uppercase"
                style={{
                  background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 15%, transparent)',
                  color: 'var(--color-warning, #f59e0b)',
                  border: '1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 30%, transparent)',
                }}
              >
                MISMATCH
              </span>
            )}
          </div>

          {/* Detail toggle */}
          {hasDetailContent(firstMeta, first.humanSummary) && (
            <button
              onClick={() => setDetailExpanded(!detailExpanded)}
              className="flex items-center gap-1 shrink-0 hover:opacity-70"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-text-muted, #6b7280)',
                padding: '2px 4px',
              }}
            >
              <Info size={10} />
              {detailExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            </button>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-1.5 shrink-0">
            {pending.length > 1 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleApproveAll()}
                disabled={firstLoading}
                loading={bulkApproving}
                icon={!bulkApproving ? <Check size={10} /> : undefined}
                className="h-7 px-2"
              >
                APPROVE ALL
              </Button>
            )}
            {pending.length > 1 && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => void handleRejectAll()}
                disabled={firstLoading}
                loading={bulkRejecting}
                icon={!bulkRejecting ? <X size={10} /> : undefined}
                className="h-7 px-2"
              >
                REJECT ALL
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => resolveAction(first.id, true)}
              disabled={firstLoading}
              loading={firstApproving}
              icon={!firstApproving ? <Check size={10} /> : undefined}
              className="h-7 px-2"
            >
              APPROVE
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => resolveAction(first.id, false)}
              disabled={firstLoading}
              loading={firstRejecting}
              icon={!firstRejecting ? <X size={10} /> : undefined}
              className="h-7 px-2"
            >
              REJECT
            </Button>
          </div>

          {/* Expand toggle — only when multiple pending */}
          {pending.length > 1 && (
            <>
              <div
                className="w-px h-6 shrink-0"
                style={{ background: 'var(--color-border, #e5e5e5)' }}
              />
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1.5 shrink-0 hover:opacity-70"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--color-text-muted, #6b7280)',
                  padding: '4px 8px',
                }}
              >
                <span className="font-mono text-[8px] font-bold tracking-[0.15em] uppercase">
                  +{pending.length - 1} MORE
                </span>
                {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
              </button>
            </>
          )}
        </div>

        {bulkFailureSummary && (
          <div
            className="px-4 py-2 font-mono text-[9px]"
            style={{
              color: 'var(--color-danger, #ef4444)',
              background: 'color-mix(in srgb, var(--color-danger, #ef4444) 8%, transparent)',
              borderTop: '1px solid color-mix(in srgb, var(--color-danger, #ef4444) 30%, transparent)',
            }}
          >
            {bulkFailureSummary}
          </div>
        )}

        {/* First card's expanded detail panel */}
        <div
          style={{
            display: 'grid',
            gridTemplateRows: detailExpanded ? '1fr' : '0fr',
            transition: 'grid-template-rows 150ms ease',
            borderLeft: `3px solid ${firstBorderColor}`,
          }}
        >
          <div style={{ overflow: 'hidden' }}>
            {detailExpanded && (
              <>
                <ActionDetailPanel meta={firstMeta} readable={first.humanSummary} />
                <div className="px-4 pb-3 bg-[var(--color-background-alt,#f4f4f5)]">
                  <button
                    onClick={() => setRawExpanded((v) => !v)}
                    className="font-mono text-[9px] underline text-[var(--color-text-muted,#6b7280)]"
                  >
                    {rawExpanded ? 'Hide raw details' : 'Show raw details'}
                  </button>
                  {rawExpanded && (
                    <pre className="mt-2 p-2 text-[9px] overflow-x-auto border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface,#ffffff)]">{first.rawPayload || first.metadata || '{}'}</pre>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
