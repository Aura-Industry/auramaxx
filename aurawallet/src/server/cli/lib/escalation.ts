/**
 * Shared 403 escalation handler for CLI commands.
 *
 * Canonical-only mode:
 * - Accepts escalation payloads only when `contractVersion === "v1"`.
 * - Fails closed for legacy/missing-version escalation envelopes.
 */

import { ESCALATION_CONTRACT_VERSION } from '../../lib/escalation-contract';
import { DETERMINISTIC_ESCALATION_ERROR_CODES } from '../../lib/escalation-error-codes';
import { buildCliClaimAction, buildCliRetryAction } from './approval-actions';

interface ApprovalRequiredBody {
  contractVersion?: string;
  error?: string;
  requiresHumanApproval?: boolean;
  reqId?: string;
  approvalScope?: 'one_shot_read' | 'session_token';
  approveUrl?: string;
  claimStatus?: 'pending' | 'approved' | 'rejected' | 'expired';
  retryReady?: boolean;
  claimAction?: Record<string, unknown>;
  retryAction?: Record<string, unknown>;
  instructions?: string[];
}

interface DeterministicErrorBody {
  contractVersion?: string;
  error?: string;
  errorCode?: string;
  reqId?: string;
  approvalScope?: 'one_shot_read' | 'session_token';
  claimStatus?: 'pending' | 'approved' | 'rejected' | 'expired';
  retryReady?: boolean;
  claimAction?: Record<string, unknown>;
  retryAction?: Record<string, unknown>;
  instructions?: string[];
}

interface PermissionDeniedContext {
  retryCommandTemplate?: string;
}

function isEscalationPayload(body: unknown): body is Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const obj = body as Record<string, unknown>;
  return (
    obj.requiresHumanApproval === true
    || typeof obj.errorCode === 'string'
    || typeof obj.reqId === 'string'
    || typeof obj.approvalScope === 'string'
    || obj.escalation !== undefined // legacy shape marker
  );
}

function isApprovalRequiredBody(body: Record<string, unknown>): boolean {
  const reqId = typeof body.reqId === 'string' ? body.reqId : '';
  return body.requiresHumanApproval === true && reqId.length > 0;
}

function isDeterministicErrorBody(body: Record<string, unknown>): boolean {
  const errorCode = typeof body.errorCode === 'string' ? body.errorCode : '';
  return errorCode.length > 0 && DETERMINISTIC_ESCALATION_ERROR_CODES.has(errorCode);
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`;
}

function deriveRetryCommandTemplateFromArgv(): string | undefined {
  const scriptPath = process.argv[1] || '';
  const match = scriptPath.match(/\/([^/]+)\.ts$/);
  if (!match) return undefined;
  const commandName = match[1];
  const args = process.argv.slice(2).map(shellQuote).join(' ').trim();
  return args.length > 0
    ? `npx auramaxx ${commandName} ${args}`
    : `npx auramaxx ${commandName}`;
}

function materializeRetryCommand(baseCommand: string | undefined, reqId: string): string | undefined {
  const base = String(baseCommand || '').trim();
  if (!base) return undefined;
  let command = base.replace(/<reqId>/g, reqId);
  command = command
    .replace(/--req-id\s+\S+/g, `--reqId ${reqId}`)
    .replace(/--request-id\s+\S+/g, `--reqId ${reqId}`)
    .replace(/--requestId\s+\S+/g, `--reqId ${reqId}`)
    .replace(/--reqId\s+\S+/g, `--reqId ${reqId}`);
  if (!/\s--(?:reqId|req-id|requestId|request-id)(?:\s|=|$)/.test(command)) {
    command = `${command} --reqId ${reqId}`;
  }
  return command;
}

function isPlaceholderRetryCommand(command: string | undefined): boolean {
  const value = String(command || '').trim();
  if (!value) return true;
  return value.includes('<retry_original_command>') || value.includes('<retry_original_tool>');
}

function resolveRetryCommand(params: {
  reqId: string;
  body: Record<string, unknown>;
  context?: PermissionDeniedContext;
}): string {
  const retryAction = (
    params.body.retryAction
    && typeof params.body.retryAction === 'object'
    && !Array.isArray(params.body.retryAction)
  ) ? params.body.retryAction as Record<string, unknown> : null;

  const actionCommand = retryAction && typeof retryAction.command === 'string'
    ? retryAction.command
    : undefined;
  const retryCommand = typeof params.body.retryCommand === 'string'
    ? params.body.retryCommand
    : undefined;
  const template = String(params.context?.retryCommandTemplate || '').trim();
  const derivedTemplate = deriveRetryCommandTemplateFromArgv();

  const candidate = [
    template,
    retryCommand,
    isPlaceholderRetryCommand(actionCommand) ? '' : (actionCommand || ''),
    derivedTemplate || '',
  ]
    .map((entry) => String(entry || '').trim())
    .find((entry) => entry.length > 0);

  return materializeRetryCommand(candidate || '<retry_original_command>', params.reqId)
    || `<retry_original_command> --reqId ${params.reqId}`;
}

function hasPlaceholderInstructions(instructions: unknown): boolean {
  if (!Array.isArray(instructions)) return false;
  return instructions.some((entry) =>
    typeof entry === 'string'
    && (entry.includes('<retry_original_command>') || entry.includes('<retry_original_tool>')));
}

function emitUnsupportedContractVersion(status: number, rawVersion: string): void {
  const payload = {
    contractVersion: ESCALATION_CONTRACT_VERSION,
    status,
    requiresHumanApproval: false,
    errorCode: 'unsupported_contract_version',
    error: `Unsupported escalation contractVersion: ${rawVersion}`,
    claimStatus: 'expired',
    retryReady: false,
  };
  console.error(JSON.stringify(payload, null, 2));
}

/**
 * Detect a permission-denied response and print structured JSON guidance.
 *
 * Returns `true` if the error was handled (caller should exit),
 * `false` if this isn't an escalation-shaped permission response.
 */
export async function handlePermissionDenied(
  status: number,
  body: unknown,
  context?: PermissionDeniedContext,
): Promise<boolean> {
  if (status !== 400 && status !== 403) return false;
  if (!isEscalationPayload(body)) return false;

  const contractVersion = typeof body.contractVersion === 'string' ? body.contractVersion : 'missing';
  if (contractVersion !== ESCALATION_CONTRACT_VERSION) {
    emitUnsupportedContractVersion(status, contractVersion);
    return true;
  }

  if (isDeterministicErrorBody(body)) {
    const deterministic = body as DeterministicErrorBody & Record<string, unknown>;
    const reqId = typeof body.reqId === 'string' ? body.reqId.trim() : '';
    const claimCommand = reqId ? `npx auramaxx auth claim ${reqId} --json` : undefined;
    const retryCommand = reqId
      ? resolveRetryCommand({ reqId, body: deterministic, context })
      : '<retry_original_command>';
    const existingInstructions = Array.isArray(deterministic.instructions) ? deterministic.instructions : [];
    const instructions = reqId && (existingInstructions.length === 0 || hasPlaceholderInstructions(existingInstructions))
      ? [
          ...(claimCommand ? [`1) Re-claim token: ${claimCommand}`] : []),
          `2) Run this exact command now: ${retryCommand}`,
        ]
      : deterministic.instructions;
    const guidance = {
      status,
      ...deterministic,
      ...(reqId ? { reqId } : {}),
      ...(reqId ? {
        claimAction: buildCliClaimAction(reqId),
      } : {}),
      ...(reqId ? {
        retryAction: buildCliRetryAction(retryCommand),
      } : {}),
      ...(instructions ? { instructions } : {}),
    };
    console.error(JSON.stringify(guidance, null, 2));
    return true;
  }

  if (isApprovalRequiredBody(body)) {
    const approval = body as ApprovalRequiredBody & Record<string, unknown>;
    const reqId = approval.reqId!.trim();
    const approveUrl = typeof approval.approveUrl === 'string' && approval.approveUrl.trim()
      ? approval.approveUrl
      : '<approve_url>';
    const claimCommand = `npx auramaxx auth claim ${reqId} --json`;
    const retryCommand = resolveRetryCommand({ reqId, body: approval, context });
    const existingInstructions = Array.isArray(approval.instructions) ? approval.instructions : [];
    const instructions = existingInstructions.length === 0 || hasPlaceholderInstructions(existingInstructions)
      ? [
          `1) Ask a human to approve: ${approveUrl}`,
          `2) Claim now: ${claimCommand}`,
          `3) Run this exact command now: ${retryCommand}`,
        ]
      : approval.instructions;
    const guidance = {
      status,
      ...approval,
      reqId,
      claimStatus: typeof approval.claimStatus === 'string' ? approval.claimStatus : 'pending',
      retryReady: typeof approval.retryReady === 'boolean' ? approval.retryReady : false,
      claimAction: buildCliClaimAction(reqId),
      retryAction: buildCliRetryAction(retryCommand),
      ...(instructions ? { instructions } : {}),
    };
    console.error(JSON.stringify(guidance, null, 2));
    return true;
  }

  console.error(JSON.stringify({ status, ...body }, null, 2));
  return true;
}
