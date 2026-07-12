import { EscalationErrorCode } from './escalation-error-codes';
import {
  EscalationRouteId,
  NON_WALLET_ESCALATION_ALLOWLIST,
  isWalletDeferredRoute,
} from './escalation-route-registry';

export const ESCALATION_CONTRACT_VERSION = 'v1' as const;
export type EscalationContractVersion = typeof ESCALATION_CONTRACT_VERSION;

export type ApprovalScope = 'one_shot_read' | 'session_token';
export type ClaimStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type RequestedPolicySource = 'agent' | 'derived_403';
export type EscalationDecision = 'hard_deny' | 'escalate_session' | 'escalate_one_shot';

export interface EscalationAction {
  transport: 'http' | 'cli' | 'mcp';
  kind: 'request' | 'command' | 'tool';
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpoint?: string;
  command?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

export interface CanonicalEscalationEnvelope {
  contractVersion: EscalationContractVersion;
  requiresHumanApproval: boolean;
  error: string;
  errorCode?: EscalationErrorCode;
  reqId?: string;
  approvalScope?: ApprovalScope;
  approveUrl?: string;
  claimAction?: EscalationAction;
  retryAction?: EscalationAction;
  instructions?: string[];
  claimStatus: ClaimStatus;
  retryReady: boolean;
  policyHash?: string;
  compilerVersion?: string;
}

export function hasSupportedEscalationContractVersion(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return true;
  const value = (input as Record<string, unknown>).contractVersion;
  if (typeof value === 'undefined') return true;
  return value === ESCALATION_CONTRACT_VERSION;
}

export function buildCanonicalHardDeny(input: {
  error: string;
  errorCode: EscalationErrorCode;
  approvalScope?: ApprovalScope;
  reqId?: string;
  claimAction?: EscalationAction;
  retryAction?: EscalationAction;
  instructions?: string[];
  policyHash?: string;
  compilerVersion?: string;
}): CanonicalEscalationEnvelope {
  return {
    contractVersion: ESCALATION_CONTRACT_VERSION,
    requiresHumanApproval: false,
    error: input.error,
    errorCode: input.errorCode,
    ...(input.reqId ? { reqId: input.reqId } : {}),
    ...(input.approvalScope ? { approvalScope: input.approvalScope } : {}),
    ...(input.claimAction ? { claimAction: input.claimAction } : {}),
    ...(input.retryAction ? { retryAction: input.retryAction } : {}),
    ...(Array.isArray(input.instructions) ? { instructions: input.instructions } : {}),
    claimStatus: 'expired',
    retryReady: false,
    ...(input.policyHash ? { policyHash: input.policyHash } : {}),
    ...(input.compilerVersion ? { compilerVersion: input.compilerVersion } : {}),
  };
}

export function buildCanonicalApprovalRequired(input: {
  error: string;
  reqId: string;
  approvalScope: ApprovalScope;
  approveUrl: string;
  claimAction: EscalationAction;
  retryAction: EscalationAction;
  instructions: string[];
  claimStatus?: ClaimStatus;
  retryReady?: boolean;
  policyHash?: string;
  compilerVersion?: string;
}): CanonicalEscalationEnvelope {
  return {
    contractVersion: ESCALATION_CONTRACT_VERSION,
    requiresHumanApproval: true,
    error: input.error,
    reqId: input.reqId,
    approvalScope: input.approvalScope,
    approveUrl: input.approveUrl,
    claimAction: input.claimAction,
    retryAction: input.retryAction,
    instructions: input.instructions,
    claimStatus: input.claimStatus || 'pending',
    retryReady: input.retryReady || false,
    ...(input.policyHash ? { policyHash: input.policyHash } : {}),
    ...(input.compilerVersion ? { compilerVersion: input.compilerVersion } : {}),
  };
}

export interface EscalationClassifierResult {
  decision: EscalationDecision;
  reasonCode: string;
}

export function classifyEscalation(input: {
  routeId: EscalationRouteId;
  hasDenyContext: boolean;
  requestedPolicySource?: RequestedPolicySource;
}): EscalationClassifierResult {
  if (isWalletDeferredRoute(input.routeId)) {
    return { decision: 'hard_deny', reasonCode: 'wallet_deferred_legacy' };
  }

  if (!NON_WALLET_ESCALATION_ALLOWLIST.has(input.routeId)) {
    return { decision: 'hard_deny', reasonCode: 'route_not_allowlisted' };
  }

  if (input.requestedPolicySource === 'derived_403' && !input.hasDenyContext) {
    return { decision: 'hard_deny', reasonCode: 'missing_deny_context' };
  }

  if (input.requestedPolicySource === 'derived_403' && input.hasDenyContext) {
    return { decision: 'escalate_one_shot', reasonCode: 'derived_403_one_shot' };
  }

  if (input.requestedPolicySource === 'agent') {
    return { decision: 'escalate_session', reasonCode: 'agent_requested_session' };
  }

  return { decision: 'escalate_session', reasonCode: 'default_session' };
}

