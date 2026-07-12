export type UiDecision = 'ALLOW' | 'DENY' | 'RATE_LIMIT' | 'ERROR' | 'UNKNOWN';
export type UiReasonCode =
  | 'SCOPE_DENY'
  | 'TOKEN_REVOKED'
  | 'TOKEN_EXPIRED'
  | 'RATE_LIMITED'
  | 'MISSING_KEY'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  | 'UNKNOWN';

export type AttributionConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface UiAuditEvent {
  id: string;
  timestamp: number;
  tokenKey: string;
  tokenHash?: string;
  agentId?: string;
  endpoint?: string;
  credentialKey?: string;
  sourceVersion: 'legacy-logs-v1' | 'task40-audit-v1';
  decision: UiDecision;
  reasonCode: UiReasonCode;
  rawDecision?: string;
  rawReasonCode?: string;
  confidence: AttributionConfidence;
}

const REASON_MAP: Record<string, UiReasonCode> = {
  CREDENTIAL_SCOPE_DENIED: 'SCOPE_DENY',
  TOKEN_PERMISSION_DENIED: 'SCOPE_DENY',
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  RATE_LIMIT: 'RATE_LIMITED',
  RATE_LIMITED: 'RATE_LIMITED',
  CREDENTIAL_NOT_FOUND: 'NOT_FOUND',
  CREDENTIAL_TOTP_NOT_CONFIGURED: 'NOT_FOUND',
  TOKEN_AGENT_PUBKEY_MISSING: 'MISSING_KEY',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  ALLOW: 'UNKNOWN',
};

function normalizeDecision(raw?: unknown, allowed?: boolean, httpStatus?: number): UiDecision {
  const v = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (v === 'ALLOW') return 'ALLOW';
  if (v === 'DENY') return 'DENY';
  if (v === 'RATE_LIMIT') return 'RATE_LIMIT';
  if (v === 'ERROR') return 'ERROR';
  if (allowed === true) return 'ALLOW';
  if (allowed === false && (httpStatus ?? 0) === 429) return 'RATE_LIMIT';
  if (allowed === false) return 'DENY';
  if ((httpStatus ?? 0) >= 500) return 'ERROR';
  return 'UNKNOWN';
}

function normalizeReasonCode(raw?: unknown): UiReasonCode {
  const v = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return REASON_MAP[v] ?? 'UNKNOWN';
}

function confidenceFromRow(input: { tokenHash?: string | null; agentId?: string | null }): AttributionConfidence {
  if (input.tokenHash) return 'HIGH';
  if (input.agentId) return 'MEDIUM';
  return 'LOW';
}

export function fromTask40Row(row: Record<string, unknown>): UiAuditEvent {
  const rawDecision = typeof row.decision === 'string' ? row.decision : undefined;
  const rawReasonCode = typeof row.reasonCode === 'string' ? row.reasonCode : undefined;
  const tokenHash = typeof row.tokenHash === 'string' ? row.tokenHash : undefined;
  const agentId = typeof row.agentId === 'string' ? row.agentId : undefined;
  const timestampValue = row.timestamp;
  const timestamp = new Date(typeof timestampValue === 'string' || typeof timestampValue === 'number' ? timestampValue : Date.now()).getTime();

  return {
    id: String(row.id ?? `${timestamp}-${tokenHash ?? agentId ?? 'unknown'}`),
    timestamp,
    tokenKey: tokenHash ?? agentId ?? 'unknown',
    tokenHash,
    agentId,
    endpoint: typeof row.action === 'string' ? row.action : undefined,
    credentialKey: typeof row.credentialId === 'string' ? row.credentialId : undefined,
    sourceVersion: 'task40-audit-v1',
    decision: normalizeDecision(rawDecision, row.allowed as boolean | undefined, row.httpStatus as number | undefined),
    reasonCode: normalizeReasonCode(rawReasonCode),
    rawDecision,
    rawReasonCode,
    confidence: confidenceFromRow({ tokenHash, agentId }),
  };
}

export function fromLegacyLog(row: Record<string, unknown>): UiAuditEvent {
  const data = (typeof row.data === 'object' && row.data !== null ? row.data : {}) as Record<string, unknown>;
  const metadata = (typeof data.metadata === 'object' && data.metadata !== null ? data.metadata : {}) as Record<string, unknown>;
  const rawDecision = typeof data.result === 'string' ? data.result : (typeof data.decision === 'string' ? data.decision : undefined);
  const rawReasonCode = typeof data.reasonCode === 'string' ? data.reasonCode : (typeof data.reason === 'string' ? data.reason : undefined);
  const tokenHash = typeof data.tokenHash === 'string' ? data.tokenHash : undefined;
  const agentId = typeof data.agentId === 'string' ? data.agentId : undefined;
  const timestampValue = row.timestamp;
  const timestamp = new Date(typeof timestampValue === 'string' || typeof timestampValue === 'number' ? timestampValue : Date.now()).getTime();

  return {
    id: String(row.id ?? `${timestamp}-${tokenHash ?? agentId ?? 'unknown'}`),
    timestamp,
    tokenKey: tokenHash ?? agentId ?? 'unknown',
    tokenHash,
    agentId,
    endpoint: typeof metadata.route === 'string' ? metadata.route : (typeof data.action === 'string' ? data.action : undefined),
    credentialKey: typeof data.credentialId === 'string' ? data.credentialId : undefined,
    sourceVersion: 'legacy-logs-v1',
    decision: normalizeDecision(rawDecision, data.allowed as boolean | undefined, data.httpStatus as number | undefined),
    reasonCode: normalizeReasonCode(rawReasonCode),
    rawDecision,
    rawReasonCode,
    confidence: confidenceFromRow({ tokenHash, agentId }),
  };
}

function dedupeKey(row: UiAuditEvent): string {
  return `${row.timestamp}|${row.endpoint ?? ''}|${row.tokenKey}|${row.credentialKey ?? ''}|${row.decision}|${row.reasonCode}`;
}

function confidenceRank(confidence: AttributionConfidence): number {
  if (confidence === 'HIGH') return 3;
  if (confidence === 'MEDIUM') return 2;
  return 1;
}

export function dedupeAuditEvents(rows: UiAuditEvent[]): UiAuditEvent[] {
  const byKey = new Map<string, UiAuditEvent>();
  for (const row of rows) {
    const key = row.id || dedupeKey(row);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }

    if (confidenceRank(row.confidence) > confidenceRank(existing.confidence)) {
      byKey.set(key, row);
      continue;
    }

    if (row.sourceVersion === 'task40-audit-v1' && existing.sourceVersion === 'legacy-logs-v1') {
      byKey.set(key, row);
    }
  }

  return Array.from(byKey.values()).sort((a, b) => b.timestamp - a.timestamp);
}
