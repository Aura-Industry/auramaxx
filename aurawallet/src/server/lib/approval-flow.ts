/**
 * Shared approval-flow payload builders used by CLI + MCP surfaces.
 */
import { ESCALATION_CONTRACT_VERSION } from './escalation-contract';

export type ApprovalFlowMode =
  | 'one_time_scoped_read'
  | 'manual_auth_claim'
  | 'session_or_profile_token';

export interface ApprovalClaim {
  method: 'GET';
  endpoint: string;
  command?: string;
}

export interface ApprovalFlowPayload {
  contractVersion: typeof ESCALATION_CONTRACT_VERSION;
  requiresHumanApproval: true;
  reqId?: string;
  approvalScope?: 'one_shot_read' | 'session_token';
  approveUrl: string;
  pollUrl?: string;
  claim?: ApprovalClaim;
  instructions?: string[];
  approvalFlow: {
    mode: ApprovalFlowMode;
    summary: string;
    steps: string[];
    retryBehavior?: string;
  };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function buildClaimEndpoint(requestId: string, secret?: string): string {
  void secret;
  return `/auth/${encodeURIComponent(requestId)}`;
}

export function buildPollUrl(walletBase: string, requestId: string, secret?: string): string {
  void secret;
  return `${stripTrailingSlash(walletBase)}${buildClaimEndpoint(requestId)}`;
}

export function buildClaimHeaders(secret?: string): Record<string, string> {
  return {
    'x-aura-claim-secret': typeof secret === 'string' && secret ? secret : '<secret>',
  };
}

/**
 * Build a structured "approve -> claim -> retry" response contract.
 * If `secret` is omitted, a `<secret>` placeholder is used in pollUrl/claim endpoint.
 */
export function buildApprovalClaimFlow(input: {
  requestId: string;
  secret?: string;
  approveUrl?: string;
  dashboardBase: string;
  walletBase: string;
  mode: ApprovalFlowMode;
  summary: string;
  finalStep: string;
  retryBehavior: string;
  step1Label?: string;
  step2Label?: string;
}): ApprovalFlowPayload {
  const approveUrl = input.approveUrl || `${stripTrailingSlash(input.dashboardBase)}/approve/${encodeURIComponent(input.requestId)}`;
  const claimEndpoint = buildClaimEndpoint(input.requestId);
  const pollUrl = buildPollUrl(input.walletBase, input.requestId);
  const claimHeaders = buildClaimHeaders(input.secret);
  const step1Label = input.step1Label || 'Approve in dashboard';
  const step2Label = input.step2Label || 'Claim approval token';

  const approvalScope = input.mode === 'one_time_scoped_read' ? 'one_shot_read' : 'session_token';
  const steps = [
    `1) ${step1Label}: ${approveUrl}`,
    `2) ${step2Label}: GET ${pollUrl} with header x-aura-claim-secret`,
    `3) ${input.finalStep}`,
  ];

  return {
    contractVersion: ESCALATION_CONTRACT_VERSION,
    requiresHumanApproval: true,
    reqId: input.requestId,
    approvalScope,
    approveUrl,
    pollUrl,
    claim: {
      method: 'GET',
      endpoint: claimEndpoint,
      ...(typeof input.secret === 'string' && input.secret
        ? { command: `curl -s -H "x-aura-claim-secret: ${input.secret}" "${pollUrl}"` }
        : {}),
    },
    instructions: steps,
    approvalFlow: {
      mode: input.mode,
      summary: input.summary,
      steps,
      retryBehavior: input.retryBehavior,
    },
  };
}

/**
 * Build a structured "approve -> request token -> retry" response contract
 * for profile-level permission denials that do not have a one-shot claim URL.
 */
export function buildProfileApprovalFlow(input: {
  approveUrl: string;
  suggestedProfile: string;
  required?: string[];
  have?: string[];
}): ApprovalFlowPayload & { nextStep: string; required?: string[]; have?: string[] } {
  const steps = [
    `1) Approve in dashboard: ${input.approveUrl}`,
    `2) Request token: npx auramaxx auth request --profile ${input.suggestedProfile}`,
    '3) Retry original command with the new token/session.',
  ];
  return {
    contractVersion: ESCALATION_CONTRACT_VERSION,
    requiresHumanApproval: true,
    approvalScope: 'session_token',
    approveUrl: input.approveUrl,
    instructions: steps,
    approvalFlow: {
      mode: 'session_or_profile_token',
      summary: 'This denial requires a broader token/profile approval (not a one-shot claim).',
      steps,
    },
    nextStep: `npx auramaxx auth request --profile ${input.suggestedProfile}`,
    ...(Array.isArray(input.required) ? { required: input.required } : {}),
    ...(Array.isArray(input.have) ? { have: input.have } : {}),
  };
}
