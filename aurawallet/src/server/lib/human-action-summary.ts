import type { HumanAction } from '@prisma/client';

export interface HumanActionReadableSummary {
  actionLabel: string;
  oneLiner: string;
  can: string[];
  cannot: string[];
  scope: string[];
  expiresIn: string;
  riskHint: string;
  profileLabel?: string;
}

function parseMetadata(metadata?: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function formatTtl(ttl: unknown): string {
  const n = Number(ttl);
  if (!Number.isFinite(n) || n <= 0) return 'default';
  if (n < 60) return `${n}s`;
  if (n % 60 === 0) return `${Math.round(n / 60)}m`;
  return `${n}s`;
}

export function buildHumanActionSummary(action: Pick<HumanAction, 'type' | 'metadata'> & { summary?: string }): HumanActionReadableSummary {
  const meta = parseMetadata(action.metadata);
  const verified = (meta.verifiedSummary && typeof meta.verifiedSummary === 'object')
    ? meta.verifiedSummary as Record<string, unknown>
    : null;

  const permissions = Array.isArray(meta.permissions)
    ? meta.permissions.filter((v): v is string => typeof v === 'string')
    : [];
  const walletAccess = Array.isArray(meta.walletAccess)
    ? meta.walletAccess.filter((v): v is string => typeof v === 'string')
    : [];

  const oneLiner = typeof verified?.oneLiner === 'string'
    ? verified.oneLiner
    : (typeof action.summary === 'string' && action.summary.trim()) || 'Approval requested';

  const can = Array.isArray(verified?.permissionLabels)
    ? (verified.permissionLabels as unknown[]).filter((v): v is string => typeof v === 'string')
    : permissions;

  const scope = Array.isArray(verified?.walletAccessLabels)
    ? (verified.walletAccessLabels as unknown[]).filter((v): v is string => typeof v === 'string')
    : walletAccess;

  const riskHint = scope.length > 1
    ? 'Affects multiple wallets'
    : can.some((p) => p.includes('swap') || p.includes('send') || p.includes('fund'))
      ? 'Can move funds'
      : 'Limited scope';

  const profile = meta.profile && typeof meta.profile === 'object'
    ? meta.profile as Record<string, unknown>
    : null;
  const profileLabel = typeof profile?.displayName === 'string'
    ? profile.displayName
    : undefined;

  return {
    actionLabel: action.type.replace(/[:_]/g, ' ').toUpperCase(),
    oneLiner,
    can,
    cannot: ['Cannot exceed granted permission scope', 'Cannot bypass expiry'],
    scope,
    expiresIn: typeof verified?.ttlLabel === 'string' ? verified.ttlLabel : formatTtl(meta.ttl),
    riskHint,
    profileLabel,
  };
}
