'use client';

import React, { useState } from 'react';
import {
  Key,
  Loader2,
  Check,
  X,
  Shield,
  AlertTriangle,
  Copy,
  ChevronDown,
  ChevronUp,
  Zap,
  Box,
} from 'lucide-react';
import { Button } from '@/components/design-system';
import { useAgentActions, type AgentToken } from '@/hooks/useAgentActions';

// Self-contained app - only needs optional config
interface AgentKeysAppProps {
  config?: Record<string, unknown>;
}

function formatExpiry(expiresAt: number): string {
  const now = Date.now();
  const diffMs = expiresAt - now;

  if (diffMs <= 0) return 'expired';

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 60) return `${diffMins}m left`;
  if (diffHours < 24) return `${diffHours}h left`;
  return `${diffDays}d left`;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

const AgentKeysApp: React.FC<AgentKeysAppProps> = () => {
  // Self-contained: fetch data and handle actions internally
  const {
    activeTokens,
    inactiveTokens,
    loading,
    actionLoading,
    revokeToken,
    lastApprovalResult,
    clearApprovalResult,
  } = useAgentActions();

  const [copied, setCopied] = useState(false);

  const copyToken = () => {
    if (lastApprovalResult?.token) {
      navigator.clipboard.writeText(lastApprovalResult.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (loading) {
    return (
      <div className="py-8 text-center">
        <Loader2
          size={24}
          className="mx-auto mb-3 animate-spin"
          style={{ color: 'var(--color-text-muted)' }}
        />
        <div
          className="font-mono text-[10px] tracking-wider"
          style={{ color: 'var(--color-text-muted)' }}
        >
          LOADING...
        </div>
      </div>
    );
  }

  // Show generated token if available
  if (lastApprovalResult?.token) {
    return (
      <div className="space-y-4 p-1">
        {/* Success Banner */}
        <div
          className="p-4 rounded-sm"
          style={{
            background: 'var(--color-success, #00c853)',
            color: '#fff',
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <Check size={16} />
            <span className="font-mono text-[11px] font-bold tracking-wider">
              TOKEN GENERATED
            </span>
          </div>
          <div className="font-mono text-[10px] opacity-90 space-y-0.5">
            <div>
              Agent: <span className="font-bold">{lastApprovalResult.agentId}</span>
            </div>
            <div>
              Limit: <span className="font-bold">{lastApprovalResult.limit} ETH</span>
            </div>
            <div>
              Expires:{' '}
              <span className="font-bold">{lastApprovalResult.expiresIn}s</span>
            </div>
          </div>
        </div>

        {/* Token Display */}
        <div className="relative">
          <div
            className="p-3 rounded-sm max-h-24 overflow-y-auto"
            style={{
              background: 'var(--color-background, #f5f5f5)',
              border: '1px solid var(--color-border, #e5e5e5)',
            }}
          >
            <code
              className="font-mono text-[10px] break-all select-all"
              style={{ color: 'var(--color-text, #0a0a0a)' }}
            >
              {lastApprovalResult.token}
            </code>
          </div>
          <button
            onClick={copyToken}
            className="absolute top-2 right-2 p-1.5 rounded-sm transition-colors hover:opacity-80"
            style={{
              background: 'var(--color-surface, #fff)',
              border: '1px solid var(--color-border, #e5e5e5)',
            }}
          >
            <Copy
              size={12}
              style={{
                color: copied
                  ? 'var(--color-success, #00c853)'
                  : 'var(--color-text-muted, #888)',
              }}
            />
          </button>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button variant="primary" onClick={copyToken} icon={<Copy size={12} />} className="flex-1">
            {copied ? 'COPIED!' : 'COPY TOKEN'}
          </Button>
          <Button variant="secondary" onClick={clearApprovalResult}>
            DONE
          </Button>
        </div>

        {/* Warning */}
        <div
          className="p-3 rounded-sm flex items-start gap-2"
          style={{
            background: 'color-mix(in srgb, var(--color-warning, #ff4d00) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-warning, #ff4d00) 30%, transparent)',
          }}
        >
          <AlertTriangle
            size={14}
            className="shrink-0 mt-0.5"
            style={{ color: 'var(--color-warning, #ff4d00)' }}
          />
          <span
            className="font-mono text-[9px]"
            style={{ color: 'var(--color-warning, #ff4d00)' }}
          >
            Save this token now. It will not be shown again.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <KeysTab
        activeTokens={activeTokens}
        inactiveTokens={inactiveTokens}
        actionLoading={actionLoading}
        onRevoke={revokeToken}
      />
    </div>
  );
};

function KeysTab({
  activeTokens,
  inactiveTokens,
  actionLoading,
  onRevoke,
}: {
  activeTokens: AgentToken[];
  inactiveTokens: AgentToken[];
  actionLoading: string | null;
  onRevoke: (tokenHash: string) => Promise<boolean>;
}) {
  const [showInactive, setShowInactive] = useState(false);

  if (activeTokens.length === 0 && inactiveTokens.length === 0) {
    return (
      <div className="py-8 text-center">
        <div
          className="w-12 h-12 mx-auto mb-3 rounded-full flex items-center justify-center"
          style={{
            background: 'var(--color-background-alt, #f5f5f5)',
          }}
        >
          <Key size={24} style={{ color: 'var(--color-text-muted, #888)' }} />
        </div>
        <div
          className="font-mono text-[10px] tracking-wider"
          style={{ color: 'var(--color-text-muted, #888)' }}
        >
          NO AGENT TOKENS
        </div>
        <div
          className="font-mono text-[9px] mt-1"
          style={{ color: 'var(--color-text-faint, #aaa)' }}
        >
          Approved tokens will appear here
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Active Tokens */}
      {activeTokens.length > 0 && (
        <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
          {activeTokens.map((token) => {
            const isRevoking = actionLoading === `revoke-${token.tokenHash}`;
            const usedPercent = token.limit > 0 ? (token.spent / token.limit) * 100 : 0;
            const isAdminToken = token.isAdmin === true;
            const isAppToken = token.agentId.startsWith('strategy:') || token.agentId.startsWith('app:');
            const displayName = isAppToken ? token.agentId.replace(/^(strategy|app):/, '') : token.agentId;

            return (
              <div
                key={`${token.agentId}-${token.tokenHash}`}
                className="rounded-sm overflow-hidden"
                style={{
                  background: 'var(--color-surface, #fff)',
                  border: '1px solid var(--color-border, #e5e5e5)',
                }}
              >
                {/* Top accent band - gold for admin, green for app, blue for agents */}
                <div
                  className="h-1"
                  style={{ background: isAdminToken ? 'var(--color-accent, #ccff00)' : isAppToken ? 'var(--color-success, #00c853)' : 'var(--color-info, #0047ff)' }}
                />

                <div className="p-3">
                  {/* Header */}
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-7 h-7 rounded-sm flex items-center justify-center"
                        style={{
                          background: isAdminToken
                            ? 'color-mix(in srgb, var(--color-accent, #ccff00) 25%, transparent)'
                            : isAppToken
                            ? 'color-mix(in srgb, var(--color-success, #00c853) 15%, transparent)'
                            : 'color-mix(in srgb, var(--color-info, #0047ff) 15%, transparent)',
                        }}
                      >
                        {isAdminToken ? (
                          <Shield size={14} style={{ color: 'var(--color-text, #0a0a0a)' }} />
                        ) : isAppToken ? (
                          <Box size={14} style={{ color: 'var(--color-success, #00c853)' }} />
                        ) : (
                          <Zap size={14} style={{ color: 'var(--color-info, #0047ff)' }} />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span
                            className="font-mono text-[10px] font-bold"
                            style={{ color: 'var(--color-text, #0a0a0a)' }}
                          >
                            {displayName}
                          </span>
                          {isAdminToken && (
                            <span
                              className="px-1 py-0.5 rounded-sm font-mono text-[7px] font-bold"
                              style={{
                                background: 'var(--color-accent, #ccff00)',
                                color: 'var(--color-text, #0a0a0a)',
                              }}
                            >
                              ADMIN
                            </span>
                          )}
                          {isAppToken && (
                            <span
                              className="px-1 py-0.5 rounded-sm font-mono text-[7px] font-bold"
                              style={{
                                background: 'color-mix(in srgb, var(--color-success, #00c853) 20%, transparent)',
                                color: 'var(--color-success, #00c853)',
                              }}
                            >
                              APP
                            </span>
                          )}
                        </div>
                        <div
                          className="font-mono text-[8px]"
                          style={{ color: 'var(--color-text-muted, #888)' }}
                        >
                          {shortHash(token.tokenHash)}
                        </div>
                      </div>
                    </div>
                    {/* Don't show revoke button for admin tokens in UI */}
                    {!isAdminToken && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => onRevoke(token.tokenHash)}
                        disabled={!!actionLoading}
                        loading={isRevoking}
                        icon={<X size={8} />}
                      >
                        REVOKE
                      </Button>
                    )}
                  </div>

                  {/* Spending Progress - hide for admin tokens */}
                  {!isAdminToken && (
                    <div className="mb-2">
                      <div
                        className="h-1.5 rounded-full overflow-hidden"
                        style={{ background: 'var(--color-background-alt, #f5f5f5)' }}
                      >
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(usedPercent, 100)}%`,
                            background:
                              usedPercent > 80
                                ? 'var(--color-warning, #ff4d00)'
                                : 'var(--color-info, #0047ff)',
                          }}
                        />
                      </div>
                      <div className="flex justify-between mt-1">
                        <span
                          className="font-mono text-[8px]"
                          style={{ color: 'var(--color-text-muted, #888)' }}
                        >
                          {token.spent.toFixed(4)} / {token.limit} ETH
                        </span>
                        <span
                          className="font-mono text-[8px] font-medium"
                          style={{ color: 'var(--color-info, #0047ff)' }}
                        >
                          {token.remaining.toFixed(4)} left
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Footer */}
                  <div className="flex items-center justify-between">
                    <div className="flex gap-1 flex-wrap">
                      {token.permissions.slice(0, 2).map((perm) => (
                        <span
                          key={perm}
                          className="px-1.5 py-0.5 rounded-sm font-mono text-[7px]"
                          style={{
                            background: 'var(--color-background-alt, #f5f5f5)',
                            color: 'var(--color-text-muted, #888)',
                          }}
                        >
                          {perm}
                        </span>
                      ))}
                      {token.permissions.length > 2 && (
                        <span
                          className="px-1.5 py-0.5 rounded-sm font-mono text-[7px]"
                          style={{
                            background: 'var(--color-background-alt, #f5f5f5)',
                            color: 'var(--color-text-muted, #888)',
                          }}
                        >
                          +{token.permissions.length - 2}
                        </span>
                      )}
                    </div>
                    <span
                      className="font-mono text-[8px]"
                      style={{ color: 'var(--color-text-faint, #aaa)' }}
                    >
                      {formatExpiry(token.expiresAt)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Inactive Tokens Toggle */}
      {inactiveTokens.length > 0 && (
        <div
          className="rounded-sm overflow-hidden"
          style={{
            background: 'var(--color-surface, #fff)',
            border: '1px solid var(--color-border, #e5e5e5)',
          }}
        >
          <button
            onClick={() => setShowInactive(!showInactive)}
            className="w-full flex items-center justify-between p-2 font-mono text-[9px] transition-colors"
            style={{ color: 'var(--color-text-muted, #888)' }}
          >
            <span className="flex items-center gap-1.5">
              <AlertTriangle size={10} />
              INACTIVE ({inactiveTokens.length})
            </span>
            {showInactive ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>

          {showInactive && (
            <div
              className="space-y-1 p-2 pt-0 max-h-32 overflow-y-auto"
              style={{ borderTop: '1px solid var(--color-border-muted, #eee)' }}
            >
              {inactiveTokens.map((token) => (
                <div
                  key={`${token.agentId}-${token.tokenHash}`}
                  className="p-2 rounded-sm flex items-center justify-between opacity-60"
                  style={{
                    background: 'var(--color-background-alt, #f5f5f5)',
                  }}
                >
                  <div>
                    <span
                      className="font-mono text-[9px]"
                      style={{ color: 'var(--color-text-muted, #888)' }}
                    >
                      {token.agentId}
                    </span>
                    <span
                      className="font-mono text-[8px] ml-2"
                      style={{ color: 'var(--color-text-faint, #aaa)' }}
                    >
                      {shortHash(token.tokenHash)}
                    </span>
                  </div>
                  <span
                    className="font-mono text-[8px] px-1.5 py-0.5 rounded-sm"
                    style={{
                      background: 'var(--color-border, #e5e5e5)',
                      color: 'var(--color-text-muted, #888)',
                    }}
                  >
                    {token.isRevoked
                      ? 'REVOKED'
                      : token.isExpired
                      ? 'EXPIRED'
                      : !token.isActive
                      ? 'INACTIVE'
                      : 'DEPLETED'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { AgentKeysApp };
export default AgentKeysApp;
