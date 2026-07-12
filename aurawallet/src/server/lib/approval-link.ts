export interface ApprovalLinkPayload {
  error: string;
  actionId: string;
  approveUrl: string;
  expiresAt?: string;
  reason?: string;
}

export function buildApproveUrl(baseUrl: string, actionId: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalizedBase}/approve/${encodeURIComponent(actionId)}`;
}

export function buildPermissionDeniedPayload(input: {
  actionId: string;
  baseUrl: string;
  reason?: string;
  expiresAt?: string;
}): ApprovalLinkPayload {
  return {
    error: 'PERMISSION_REQUIRED',
    actionId: input.actionId,
    approveUrl: buildApproveUrl(input.baseUrl, input.actionId),
    reason: input.reason,
    expiresAt: input.expiresAt,
  };
}
