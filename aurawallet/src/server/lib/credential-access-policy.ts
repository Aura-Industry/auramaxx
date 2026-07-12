import { AgentTokenPayload } from '../types';
import { checkCredentialAccess } from './sessions';

export type CredentialAccessAction = 'credentials.read' | 'credentials.totp';

export type CredentialAccessReasonCode =
  | 'ALLOW'
  | 'TOKEN_TTL_EXPIRED'
  | 'TOKEN_MAX_READS_EXCEEDED'
  | 'CREDENTIAL_RATE_LIMIT_EXCEEDED'
  | 'TOKEN_BINDING_MISMATCH'
  | 'DENY_EXCLUDED_FIELD'
  | 'CREDENTIAL_SCOPE_DENIED'
  | 'TOKEN_PERMISSION_DENIED'
  | 'TOKEN_AGENT_PUBKEY_MISSING'
  | 'CREDENTIAL_TOTP_NOT_CONFIGURED';

export interface CredentialAccessDecision {
  allowed: boolean;
  reasonCode: CredentialAccessReasonCode;
  httpStatus: 200 | 403 | 429;
  limiterWindowMs?: number;
  limiterLimit?: number;
  limiterCount?: number;
}

interface CredentialLimiterState {
  timestamps: number[];
}

const credentialAccessLimiter = new Map<string, CredentialLimiterState>();

const READ_LIMIT_PER_MIN = parsePositiveInt(process.env.AURA_CRED_READ_LIMIT_PER_MIN, 60);
const TOTP_LIMIT_PER_MIN = parsePositiveInt(process.env.AURA_CRED_TOTP_LIMIT_PER_MIN, 10);
const LIMIT_WINDOW_MS = 60_000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function toSessionReasonCode(reason: string): 'TOKEN_TTL_EXPIRED' | 'TOKEN_MAX_READS_EXCEEDED' {
  if (reason.includes('TTL')) return 'TOKEN_TTL_EXPIRED';
  return 'TOKEN_MAX_READS_EXCEEDED';
}

function getActionLimit(action: CredentialAccessAction): number {
  return action === 'credentials.totp' ? TOTP_LIMIT_PER_MIN : READ_LIMIT_PER_MIN;
}

function checkPerCredentialRateLimit(
  credentialId: string,
  action: CredentialAccessAction,
  nowMs: number,
): { allowed: true; count: number; limit: number } | { allowed: false; count: number; limit: number } {
  const limit = getActionLimit(action);
  const key = `${credentialId}:${action}`;
  const state = credentialAccessLimiter.get(key) ?? { timestamps: [] };
  state.timestamps = state.timestamps.filter((timestamp) => nowMs - timestamp < LIMIT_WINDOW_MS);

  if (state.timestamps.length >= limit) {
    credentialAccessLimiter.set(key, state);
    return { allowed: false, count: state.timestamps.length, limit };
  }

  state.timestamps.push(nowMs);
  credentialAccessLimiter.set(key, state);
  return { allowed: true, count: state.timestamps.length, limit };
}

export function evaluateCredentialAccess(params: {
  tokenHash: string;
  token: AgentTokenPayload;
  credentialId: string;
  action: CredentialAccessAction;
  nowMs?: number;
}): CredentialAccessDecision {
  const sessionCheck = checkCredentialAccess(params.tokenHash, params.token);
  if (!sessionCheck.ok) {
    return {
      allowed: false,
      reasonCode: toSessionReasonCode(sessionCheck.reason),
      httpStatus: 403,
    };
  }

  const limiter = checkPerCredentialRateLimit(params.credentialId, params.action, params.nowMs ?? Date.now());
  if (!limiter.allowed) {
    return {
      allowed: false,
      reasonCode: 'CREDENTIAL_RATE_LIMIT_EXCEEDED',
      httpStatus: 429,
      limiterWindowMs: LIMIT_WINDOW_MS,
      limiterLimit: limiter.limit,
      limiterCount: limiter.count,
    };
  }

  return {
    allowed: true,
    reasonCode: 'ALLOW',
    httpStatus: 200,
    limiterWindowMs: LIMIT_WINDOW_MS,
    limiterLimit: limiter.limit,
    limiterCount: limiter.count,
  };
}

export function resetCredentialAccessLimiterForTests(): void {
  credentialAccessLimiter.clear();
}
