export const ESCALATION_ERROR_CODES = [
  'operation_binding_mismatch',
  'missing_or_expired_claim',
  'approval_request_failed',
  'client_policy_not_allowed_for_derived_source',
  'policy_unsatisfied_for_retry',
  'invalid_requested_policy',
  'claim_rejected',
  'claim_denied',
  'claim_decrypt_failed',
  'claim_poll_failed',
  'claim_network_error',
  'claim_invalid_payload',
  'unsupported_contract_version',
  'route_not_allowlisted',
  'unknown_classifier_outcome',
  'missing_deny_context',
  'insufficient_permissions',
  'admin_required',
  'agent_pubkey_missing',
] as const;

export type EscalationErrorCode = (typeof ESCALATION_ERROR_CODES)[number];

export const DETERMINISTIC_ESCALATION_ERROR_CODES = new Set<string>(ESCALATION_ERROR_CODES);

