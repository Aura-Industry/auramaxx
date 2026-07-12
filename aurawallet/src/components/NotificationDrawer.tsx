'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, X, Clock } from 'lucide-react';
import { Drawer, Modal } from '@/components/design-system';
import type { HumanAction } from '@/hooks/useAgentActions';

interface NotificationDrawerProps {
  notifications: HumanAction[];
  onDismiss: (id: string) => void;
  /** Render only the bell trigger (compact mode for tablet sidebar) */
  compact?: boolean;
}

interface NotificationMeta {
  approvalScope?: 'one_shot_read' | 'session_token';
  summary?: string;
  agentId?: string;
  limit?: number;
  requestedLimitExplicit?: boolean;
  defaultFundLimit?: number;
  verifiedSummary?: { oneLiner?: string };
  escalationReason?: string;
  credentialAccess?: {
    maxReads?: number | null;
  };
}

type ApprovalScope = 'one_shot_read' | 'session_token';

function normalizeNotificationId(id: unknown): string {
  if (typeof id === 'string') return id.trim();
  if (typeof id === 'number') return String(id);
  return '';
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

function parseMeta(raw?: string): NotificationMeta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as NotificationMeta : {};
  } catch {
    return {};
  }
}

function normalizeApprovalScope(value: unknown): ApprovalScope | null {
  if (value === 'one_shot_read' || value === 'session_token') return value;
  return null;
}

function resolveNotificationApprovalScope(notification: HumanAction): ApprovalScope | null {
  const meta = parseMeta(notification.metadata);
  const explicit = normalizeApprovalScope(meta.approvalScope);
  if (explicit) return explicit;
  if (meta.escalationReason === 'DENY_EXCLUDED_FIELD') return 'one_shot_read';
  if (typeof meta.credentialAccess?.maxReads === 'number' && meta.credentialAccess.maxReads === 1) {
    return 'one_shot_read';
  }
  if (notification.type === 'auth' || notification.type === 'agent_access' || notification.type === 'action') {
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

function getNotificationSummary(n: HumanAction): string {
  const meta = parseMeta(n.metadata);
  if (meta.verifiedSummary?.oneLiner) return meta.verifiedSummary.oneLiner;
  if (meta.summary) return meta.summary;

  if ((n.type === 'auth' || n.type === 'agent_access') && typeof meta.limit === 'number') {
    const agent = meta.agentId || 'agent';
    if (meta.requestedLimitExplicit === false) {
      return `${agent} requesting access`;
    }
    return `${agent} requesting ${meta.limit} ETH access`;
  }

  return n.type;
}

function notificationStatusLabel(n: HumanAction): string {
  if (n.status === 'pending') return 'PENDING';
  if (n.status === 'approved') return 'APPROVED';
  if (n.status === 'rejected') return 'REJECTED';
  if (n.type === 'notify') return 'ALERT';
  return 'INFO';
}

function notificationStatusColors(n: HumanAction): { bg: string; fg: string; border: string } {
  if (n.status === 'pending') {
    return {
      bg: 'color-mix(in srgb, var(--color-warning,#ff4d00) 15%, transparent)',
      fg: 'var(--color-warning,#ff4d00)',
      border: 'color-mix(in srgb, var(--color-warning,#ff4d00) 35%, transparent)',
    };
  }
  if (n.status === 'approved') {
    return {
      bg: 'color-mix(in srgb, var(--color-success,#10b981) 15%, transparent)',
      fg: 'var(--color-success,#10b981)',
      border: 'color-mix(in srgb, var(--color-success,#10b981) 35%, transparent)',
    };
  }
  if (n.status === 'rejected') {
    return {
      bg: 'color-mix(in srgb, var(--color-danger,#ef4444) 15%, transparent)',
      fg: 'var(--color-danger,#ef4444)',
      border: 'color-mix(in srgb, var(--color-danger,#ef4444) 35%, transparent)',
    };
  }
  return {
    bg: 'var(--color-background-alt,#f4f4f5)',
    fg: 'var(--color-text-muted,#6b7280)',
    border: 'var(--color-border,#d4d4d8)',
  };
}

export const NotificationDrawer: React.FC<NotificationDrawerProps> = ({
  notifications,
  onDismiss,
  compact = false,
}) => {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [locallyDismissedKeys, setLocallyDismissedKeys] = useState<Set<string>>(new Set());
  const [selectedNotification, setSelectedNotification] = useState<HumanAction | null>(null);

  const getNotificationKey = (notification: HumanAction): string => {
    const normalizedId = normalizeNotificationId(notification.id);
    if (normalizedId) return `id:${normalizedId}`;
    return `fallback:${notification.type}:${notification.createdAt}:${getNotificationSummary(notification)}`;
  };

  const visibleNotifications = useMemo(() => {
    return notifications
      .filter((n) => !locallyDismissedKeys.has(getNotificationKey(n)))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [notifications, locallyDismissedKeys]);

  const badgeCount = useMemo(() => {
    return visibleNotifications.filter(
      (n) => n.status === 'pending' && n.type !== 'notify',
    ).length;
  }, [visibleNotifications]);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  return (
    <>
      {/* Bell trigger */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className={`${compact ? 'p-0' : 'p-1.5'} text-[var(--color-text-muted,#6b7280)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-surface,#ffffff)]/50 transition-colors rounded`}
          title="Notifications"
          aria-label="Notifications"
        >
          <Bell size={compact ? 10 : 14} />
        </button>
        {badgeCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] bg-[var(--color-warning,#ff4d00)] text-white font-mono text-[7px] font-bold flex items-center justify-center px-0.5">
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        )}
      </div>

      {/* Drawer */}
      {mounted && createPortal(
        <>
          {open && (
            <button
              type="button"
              aria-label="Close notifications"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-30 bg-[var(--color-text,#0a0a0a)]/20"
            />
          )}
          <div className="fixed inset-y-0 right-0 z-40">
            <Drawer
              isOpen={open}
              onClose={() => setOpen(false)}
              title="NOTIFICATIONS"
              subtitle="Approvals"
              width="sm"
            >
              {visibleNotifications.length === 0 ? (
                <div className="py-8 text-center tyvek-label corner-marks mx-2">
                  <Bell size={24} className="mx-auto mb-2 text-[var(--color-text-faint,#9ca3af)]" />
                  <div className="label-specimen text-[var(--color-text-muted,#6b7280)]">NO ALERTS</div>
                </div>
              ) : (
                <div className="space-y-2">
                  {visibleNotifications.map((n) => {
                    const tokenScope = resolveNotificationApprovalScope(n);
                    return (
                      <div
                        key={normalizeNotificationId(n.id) || `${n.type}:${n.createdAt}`}
                        className="w-full text-left flex items-start gap-2 p-3 clip-specimen-sm border-mech bg-[var(--color-surface-alt,#fafafa)] group cursor-pointer corner-marks transition-all hover:shadow-mech-hover"
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedNotification(n)}
                          className="flex-1 min-w-0 text-left"
                          title="View details"
                        >
                          <div className="mb-1.5 flex items-center gap-1">
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 font-mono text-[7px] font-bold tracking-[0.15em] uppercase"
                              style={{
                                background: notificationStatusColors(n).bg,
                                color: notificationStatusColors(n).fg,
                                border: `1px solid ${notificationStatusColors(n).border}`,
                              }}
                            >
                              {notificationStatusLabel(n)}
                            </span>
                            {tokenScope === 'one_shot_read' && (
                              <span
                                className="inline-flex items-center px-1.5 py-0.5 font-mono text-[7px] font-bold tracking-[0.15em]"
                                style={approvalScopeStyle()}
                              >
                                {approvalScopeLabel(tokenScope)}
                              </span>
                            )}
                          </div>
                          <div className="font-mono text-[10px] text-[var(--color-text,#0a0a0a)]">
                            {getNotificationSummary(n)}
                          </div>
                          <div className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] flex items-center gap-1 mt-1">
                            <Clock size={7} />
                            {timeAgo(n.createdAt)}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const notificationKey = getNotificationKey(n);
                            setLocallyDismissedKeys((prev) => {
                              const next = new Set(prev);
                              next.add(notificationKey);
                              return next;
                            });
                            const normalizedId = normalizeNotificationId(n.id);
                            if (normalizedId) {
                              onDismiss(normalizedId);
                            }
                          }}
                          className="p-1 hover:bg-[var(--color-background-alt,#e5e5e5)] transition-colors shrink-0"
                          title="Dismiss"
                        >
                          <X size={10} className="text-[var(--color-text-muted,#6b7280)]" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </Drawer>
          </div>
        </>,
        document.body,
      )}

      {/* Detail Modal */}
      <NotificationDetailModal
        notification={selectedNotification}
        onClose={() => setSelectedNotification(null)}
      />
    </>
  );
};

function NotificationDetailModal({ notification, onClose }: { notification: HumanAction | null; onClose: () => void }) {
  // Keep a ref to the last notification so content stays visible during exit animation
  const [lastNotification, setLastNotification] = React.useState<HumanAction | null>(null);
  React.useEffect(() => {
    if (notification) setLastNotification(notification);
  }, [notification]);

  const display = notification || lastNotification;
  const meta = display ? parseMeta(display.metadata) : {};
  const summary = display?.humanSummary;
  const colors = display ? notificationStatusColors(display) : { bg: '', fg: '', border: '' };
  const tokenScope = display ? resolveNotificationApprovalScope(display) : null;
  const agentId = meta.agentId || 'unknown';

  return (
    <Modal
      isOpen={!!notification}
      onClose={onClose}
      title={summary?.actionLabel || display?.type.toUpperCase() || 'DETAILS'}
      size="sm"
    >
      <div className="space-y-4">
        {/* Status + Time */}
        {display && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <span
                className="inline-flex items-center px-1.5 py-0.5 font-mono text-[7px] font-bold tracking-[0.15em] uppercase"
                style={{
                  background: colors.bg,
                  color: colors.fg,
                  border: `1px solid ${colors.border}`,
                }}
              >
                {notificationStatusLabel(display)}
              </span>
              {tokenScope === 'one_shot_read' && (
                <span
                  className="inline-flex items-center px-1.5 py-0.5 font-mono text-[7px] font-bold tracking-[0.15em]"
                  style={approvalScopeStyle()}
                >
                  {approvalScopeLabel(tokenScope)}
                </span>
              )}
            </div>
            <span className="font-mono text-[8px] text-[var(--color-text-faint,#9ca3af)] flex items-center gap-1">
              <Clock size={7} />
              {timeAgo(display.createdAt)}
            </span>
          </div>
        )}

        {/* One-liner */}
        {summary?.oneLiner && (
          <div className="text-[10px] text-[var(--color-text-muted,#6b7280)] tracking-wider">
            {summary.oneLiner}
          </div>
        )}

        {/* Details */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest uppercase">Agent</span>
            <span className="text-[10px] text-[var(--color-text,#0a0a0a)] tracking-wider text-right">{agentId}</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest uppercase">Type</span>
            <span className="text-[10px] text-[var(--color-text,#0a0a0a)] font-bold tracking-wider text-right">{display?.type}</span>
          </div>
          {tokenScope === 'one_shot_read' && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest uppercase">Token</span>
              <span className="text-[10px] text-[var(--color-text,#0a0a0a)] font-bold tracking-wider text-right">
                {approvalScopeLabel(tokenScope)}
              </span>
            </div>
          )}
          {summary?.profileLabel && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest uppercase">Profile</span>
              <span className="text-[10px] text-[var(--color-text,#0a0a0a)] tracking-wider text-right">{summary.profileLabel}</span>
            </div>
          )}
          {summary?.riskHint && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest uppercase">Risk</span>
              <span className={`text-[10px] font-bold tracking-wider ${
                summary.riskHint.toLowerCase().includes('high') ? 'text-[var(--color-danger,#ef4444)]'
                  : summary.riskHint.toLowerCase().includes('medium') ? 'text-[var(--color-warning,#ff4d00)]'
                    : 'text-[var(--color-text,#0a0a0a)]'
              }`}>{summary.riskHint}</span>
            </div>
          )}
          {summary?.expiresIn && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest uppercase">Expires</span>
              <span className="text-[10px] text-[var(--color-text,#0a0a0a)] tracking-wider text-right">{summary.expiresIn}</span>
            </div>
          )}
          {typeof meta.limit === 'number' && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest uppercase">Limit</span>
              <span className="text-[10px] text-[var(--color-text,#0a0a0a)] font-bold tracking-wider text-right">{meta.limit} ETH</span>
            </div>
          )}
          <div className="text-[7px] text-[var(--color-text-faint,#9ca3af)] tracking-widest break-all">
            ID: {display?.id}
          </div>
        </div>

        {/* Permissions (can) */}
        {summary?.can && summary.can.length > 0 && (
          <div className="border-t border-[var(--color-border,#d4d4d8)] pt-3">
            <div className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest uppercase mb-1.5">Permissions</div>
            <div className="space-y-1">
              {summary.can.map((item) => (
                <div key={item} className="text-[10px] text-[var(--color-text,#0a0a0a)] tracking-wider pl-2 border-l-2 border-[var(--color-border,#d4d4d8)]">
                  {item}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Restrictions (cannot) */}
        {summary?.cannot && summary.cannot.length > 0 && (
          <div className="border-t border-[var(--color-border,#d4d4d8)] pt-3">
            <div className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest uppercase mb-1.5">Restrictions</div>
            <div className="space-y-1">
              {summary.cannot.map((item) => (
                <div key={item} className="text-[10px] text-[var(--color-danger,#ef4444)] tracking-wider pl-2 border-l-2 border-[var(--color-danger,#ef4444)]/30">
                  {item}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Scope */}
        {summary?.scope && summary.scope.length > 0 && (
          <div className="border-t border-[var(--color-border,#d4d4d8)] pt-3">
            <div className="text-[8px] text-[var(--color-text-faint,#9ca3af)] tracking-widest uppercase mb-1.5">Scope</div>
            <div className="space-y-1">
              {summary.scope.map((item) => (
                <div key={item} className="text-[10px] text-[var(--color-text,#0a0a0a)] tracking-wider pl-2 border-l-2 border-[var(--color-border,#d4d4d8)]">
                  {item}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
