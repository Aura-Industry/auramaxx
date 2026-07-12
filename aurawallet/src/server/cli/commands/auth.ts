/**
 * auramaxx auth — Request/claim agent auth approvals from CLI
 */

import {
  decryptWithPrivateKey,
  generateEphemeralKeypair,
  resolveAuthFallbackProfileConfig,
  type ProfileIssuanceSelection,
} from '../../lib/credential-transport';
import { buildApprovalClaimFlow, buildPollUrl } from '../../lib/approval-flow';
import { getErrorMessage } from '../../lib/error';
import { waitForAuthDecision, fetchAuthDecisionOnce, type AuthDecisionFetchResult } from '../lib/approval-poll';
import { buildCliClaimAction, buildCliRetryAction } from '../lib/approval-actions';
import { serverUrl, handlePermissionDeniedAndExit } from '../lib/http';
import { printHelp } from '../lib/theme';
import {
  putApprovalContext,
  getApprovalContext,
  putClaimedToken,
  deleteApprovalContext,
  putActiveSessionToken,
  type ApprovalScope,
} from '../lib/approval-context';

type JsonObject = Record<string, unknown>;

interface AuthCreateResponse {
  success?: boolean;
  requestId?: string;
  secret?: string;
  error?: string;
  [key: string]: unknown;
}

interface ParsedCommon {
  json: boolean;
  noWait: boolean;
  rawToken: boolean;
  unsafeShowSecret: boolean;
  timeoutMs: number;
  intervalMs: number;
}

interface ParsedRequestFlags extends ParsedCommon {
  agentId: string;
  profile?: string;
  profileVersion?: string;
  profileOverrides?: JsonObject;
  action?: { endpoint: string; method: string; body?: JsonObject };
}

type ClaimMappedStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'invalid_secret';

interface ClaimClassification {
  mappedStatus: ClaimMappedStatus;
  success: boolean;
  errorCode?: string;
  error?: string;
  retryable?: boolean;
}

const SESSION_TOKEN_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const ONE_SHOT_DEFAULT_TTL_SECONDS = 120;
const CLAIM_PENDING_RETRIES_DEFAULT = 3;
const CLAIM_PENDING_RETRY_INTERVAL_MS_DEFAULT = 250;

function parseTokenExpTtlSeconds(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
    const exp = typeof payload.exp === 'number' ? payload.exp : null;
    if (!exp || !Number.isFinite(exp)) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const remaining = Math.floor(exp - nowSec);
    return remaining > 0 ? remaining : 0;
  } catch {
    return null;
  }
}

function resolveClaimTtlSeconds(
  payload: Record<string, unknown>,
  token: string,
  approvalScope: ApprovalScope,
): number {
  const ttlRaw = payload.ttl;
  if (typeof ttlRaw === 'number' && Number.isFinite(ttlRaw) && ttlRaw > 0) {
    return Math.max(30, Math.floor(ttlRaw));
  }

  const tokenTtl = parseTokenExpTtlSeconds(token);
  if (typeof tokenTtl === 'number' && tokenTtl > 0) {
    return Math.max(30, tokenTtl);
  }

  return approvalScope === 'session_token'
    ? SESSION_TOKEN_DEFAULT_TTL_SECONDS
    : ONE_SHOT_DEFAULT_TTL_SECONDS;
}

function buildAuthApprovalFlow(input: {
  requestId: string;
  secret: string;
  approveUrl?: string;
}) {
  return buildApprovalClaimFlow({
    requestId: input.requestId,
    secret: input.secret,
    ...(typeof input.approveUrl === 'string' ? { approveUrl: input.approveUrl } : {}),
    dashboardBase: `http://localhost:${process.env.DASHBOARD_PORT || '4747'}`,
    walletBase: serverUrl(),
    mode: 'manual_auth_claim',
    summary: 'Auth token is only issued after explicit claim/poll. CLI does not auto-claim in background.',
    step2Label: 'Claim token',
    finalStep: 'Retry the original command after claim returns approved.',
    retryBehavior: 'Until claim succeeds, auth claim returns pending/rejected and no token is active.',
  });
}

function showHelp(): void {
  printHelp('AUTH', 'npx auramaxx auth <subcommand> [options]', [
    { name: 'request', desc: 'Request auth token via /auth (approve -> claim -> retry)' },
    { name: 'claim <reqId>', desc: 'Claim a stored approval context by reqId (no secret flag needed)' },
    { name: 'pending', desc: 'List pending auth requests' },
    { name: 'validate', desc: 'Validate a bearer token' },
  ], [
    'Request options:',
    '  --agent-id <id>              Agent id (default: cli-auth)',
    '  --profile <id>               Profile id (default: trust.localProfile; seed: admin)',
    '  --profile-version <v>        Profile version (default: trust.localProfileVersion; seed: v1)',
    '  --profile-overrides <json>   Tighten-only profile override JSON',
    '  --action <json>              Pre-computed action to auto-execute on approval',
    '                               JSON: {"endpoint":"/send","method":"POST","body":{...}}',
    '  --no-wait                    Return approval payload immediately (default behavior)',
    '  --wait                       Legacy behavior: poll until approved/rejected',
    '  --timeout-ms <ms>            Poll timeout (default: 120000)',
    '  --interval-ms <ms>           Poll interval (default: 3000)',
    '  --raw-token                  Print full token when approved',
    '  --unsafe-show-secret         Print full claim secret in output (unsafe)',
    '  --json                       JSON output',
    '',
    'Claim options:',
    `  --pending-retries <n>        Auto-retry claim polling while status=pending (default: ${CLAIM_PENDING_RETRIES_DEFAULT})`,
    `  --pending-retry-interval-ms <ms>  Delay between pending claim retries (default: ${CLAIM_PENDING_RETRY_INTERVAL_MS_DEFAULT})`,
    '',
    'Validate options:',
    '  --token <token>              Token to validate (default: AURA_TOKEN env)',
    '',
    'Examples:',
    '  npx auramaxx auth request --agent-id codex --profile dev',
    '  npx auramaxx auth request --agent-id codex --profile dev --wait',
    '  npx auramaxx auth request --profile dev --profile-overrides \'{"ttlSeconds":900}\' --json',
    '  npx auramaxx auth request --profile dev --action \'{"endpoint":"/send","method":"POST","body":{"to":"0x...","amount":"0.01"}}\'',
    '  npx auramaxx auth claim <reqId> --json',
    '  npx auramaxx auth claim <reqId> --pending-retries 8 --pending-retry-interval-ms 200 --json',
    '  npx auramaxx auth validate --token $AURA_TOKEN',
  ]);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function parseIntegerFlag(args: string[], flag: string, fallback: number): number {
  const raw = getFlagValue(args, flag);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return Math.floor(parsed);
}

function parseNonNegativeIntegerFlag(args: string[], flag: string, fallback: number): number {
  const raw = getFlagValue(args, flag);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number`);
  }
  return Math.floor(parsed);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonObjectFlag(args: string[], flag: string): JsonObject | undefined {
  const raw = getFlagValue(args, flag);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object`);
  }
  return parsed as JsonObject;
}

function parseCommon(args: string[]): ParsedCommon {
  const explicitNoWait = args.includes('--no-wait');
  const explicitWait = args.includes('--wait');
  if (explicitNoWait && explicitWait) {
    throw new Error('Use only one of --wait or --no-wait');
  }
  return {
    json: args.includes('--json'),
    // Default to explicit approve -> claim -> retry contract (no background polling).
    noWait: explicitNoWait || !explicitWait,
    rawToken: args.includes('--raw-token'),
    unsafeShowSecret: args.includes('--unsafe-show-secret'),
    timeoutMs: parseIntegerFlag(args, '--timeout-ms', 120_000),
    intervalMs: parseIntegerFlag(args, '--interval-ms', 3_000),
  };
}

function parseActionFlag(args: string[]): ParsedRequestFlags['action'] {
  const raw = getFlagValue(args, '--action');
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--action must be a JSON object with endpoint and method');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.endpoint !== 'string' || typeof obj.method !== 'string') {
    throw new Error('--action requires "endpoint" (string) and "method" (string)');
  }
  const action: { endpoint: string; method: string; body?: JsonObject } = {
    endpoint: obj.endpoint,
    method: obj.method.toUpperCase(),
  };
  if (obj.body && typeof obj.body === 'object' && !Array.isArray(obj.body)) {
    action.body = obj.body as JsonObject;
  }
  return action;
}

function parseRequestFlags(args: string[]): ParsedRequestFlags {
  const common = parseCommon(args);
  return {
    ...common,
    agentId: getFlagValue(args, '--agent-id') || 'cli-auth',
    profile: getFlagValue(args, '--profile'),
    profileVersion: getFlagValue(args, '--profile-version'),
    profileOverrides: parseJsonObjectFlag(args, '--profile-overrides'),
    action: parseActionFlag(args),
  };
}

function classifyClaimFetchResult(result: AuthDecisionFetchResult): ClaimClassification {
  if (result.httpStatus === 403) {
    return {
      mappedStatus: 'invalid_secret',
      success: false,
    };
  }

  if (result.httpStatus === 404 || result.httpStatus === 410) {
    return {
      mappedStatus: 'expired',
      success: false,
    };
  }

  if (result.httpStatus === 200) {
    if (result.payload.success !== true) {
      return {
        mappedStatus: 'pending',
        success: false,
        errorCode: 'claim_unexpected_response',
        error: result.payload.error || 'Claim response returned success=false (HTTP 200).',
        retryable: false,
      };
    }

    if (
      result.payload.status === 'approved'
      || result.payload.status === 'rejected'
      || result.payload.status === 'pending'
    ) {
      return {
        mappedStatus: result.payload.status,
        success: result.payload.status === 'pending',
      };
    }

    const rawStatus = typeof result.payload.status === 'string'
      ? result.payload.status
      : String(result.payload.status ?? 'missing');
    return {
      mappedStatus: 'pending',
      success: false,
      errorCode: 'claim_unexpected_response',
      error: `Claim response returned unexpected status "${rawStatus}" (HTTP 200).`,
      retryable: false,
    };
  }

  if (result.httpStatus >= 500) {
    return {
      mappedStatus: 'pending',
      success: false,
      errorCode: 'claim_server_error',
      error: result.payload.error || `Claim failed due to server error (HTTP ${result.httpStatus}).`,
      retryable: true,
    };
  }

  if (result.httpStatus >= 400) {
    return {
      mappedStatus: 'pending',
      success: false,
      errorCode: 'claim_http_error',
      error: result.payload.error || `Claim failed with HTTP ${result.httpStatus}.`,
      retryable: false,
    };
  }

  return {
    mappedStatus: 'pending',
    success: false,
    errorCode: 'claim_http_error',
    error: `Claim returned unexpected HTTP ${result.httpStatus}.`,
    retryable: false,
  };
}

async function createAuthRequest(payload: JsonObject): Promise<AuthCreateResponse> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl()}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(`Cannot reach AuraMaxx server at ${serverUrl()}. Run 'npx auramaxx' first. (${getErrorMessage(error)})`);
  }
  const data = await res.json().catch(() => ({})) as AuthCreateResponse;
  if (!res.ok || !data.success || !data.requestId || !data.secret) {
    throw new Error(data.error || `Failed to create auth request (HTTP ${res.status})`);
  }
  return data;
}

function maskToken(token: string): string {
  if (token.length <= 24) return token;
  return `${token.slice(0, 20)}...${token.slice(-4)}`;
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`;
}

function buildAuthRequestRetryCommand(input: {
  agentId: string;
  profile: string;
  profileVersion?: string;
  profileOverrides?: JsonObject;
  action?: { endpoint: string; method: string; body?: JsonObject };
}): string {
  const args: string[] = ['npx', 'auramaxx', 'auth', 'request', '--profile', input.profile];
  if (input.agentId && input.agentId !== 'cli-auth') {
    args.push('--agent-id', input.agentId);
  }
  if (input.profileVersion && input.profileVersion !== 'v1') {
    args.push('--profile-version', input.profileVersion);
  }
  if (input.profileOverrides) {
    args.push('--profile-overrides', JSON.stringify(input.profileOverrides));
  }
  if (input.action) {
    args.push('--action', JSON.stringify(input.action));
  }
  args.push('--json');
  return args.map(shellQuote).join(' ');
}

function resolveRetryCommandTemplate(template: string | undefined, reqId: string): string {
  const candidate = String(template || '').trim().replaceAll('<reqId>', reqId);
  if (candidate && !candidate.includes('<retry_original_command>')) {
    return candidate;
  }
  // For plain `auth request` flows there may be no original operation command;
  // return a concrete fallback command instead of a placeholder token.
  return `npx auramaxx auth claim ${reqId} --json`;
}

async function handleApprovalFlow(
  createResult: AuthCreateResponse,
  privateKeyPem: string,
  options: ParsedCommon,
  requestRetryCommand: string,
): Promise<number> {
  const requestId = createResult.requestId!;
  const secret = createResult.secret!;
  const reqId = requestId;

  const approveUrl = typeof createResult.approveUrl === 'string' ? createResult.approveUrl : undefined;
  const flow = buildAuthApprovalFlow({ requestId, secret, approveUrl });
  const pollUrl = flow.pollUrl || buildPollUrl(serverUrl(), requestId, secret);
  const claimAction = buildCliClaimAction(reqId);
  const retryAction = buildCliRetryAction(requestRetryCommand);

  putApprovalContext({
    reqId,
    secret,
    privateKeyPem,
    approvalScope: 'session_token',
    ttlSeconds: SESSION_TOKEN_DEFAULT_TTL_SECONDS,
    retryCommandTemplate: requestRetryCommand,
  });

  if (options.noWait) {
    if (options.json) {
      console.log(JSON.stringify({
        success: true,
        requiresHumanApproval: true,
        approvalScope: 'session_token',
        status: 'pending',
        claimStatus: 'pending',
        retryReady: false,
        reqId,
        secret: options.unsafeShowSecret ? secret : undefined,
        secretPreview: options.unsafeShowSecret ? undefined : '[REDACTED]',
        approveUrl: flow.approveUrl,
        pollUrl,
        claim: flow.claim,
        claimAction,
        retryAction,
        instructions: [
          `1) Ask a human to approve: ${flow.approveUrl}`,
          `2) Claim now: ${claimAction.command}`,
          `3) If request is rejected/expired, re-request: ${requestRetryCommand}`,
        ],
        approvalFlow: flow.approvalFlow,
        message: 'Auth request created. Approve and claim token before retrying.',
      }, null, 2));
    } else {
      console.log(`Request created.`);
      console.log(`  approveUrl: ${flow.approveUrl}`);
      console.log(`  reqId: ${reqId}`);
      if (options.unsafeShowSecret) {
        console.log(`  secret: ${secret}`);
      } else {
        console.log('  secret: [REDACTED] (stored in local approval context)');
      }
      console.log(`  pollUrl: ${pollUrl}`);
      console.log(`  claim: ${claimAction.command}`);
      console.log(`If rejected/expired, re-request with: ${requestRetryCommand}`);
    }
    return 0;
  }

  if (flow.approveUrl) {
    console.log(`Request created (${requestId}). Approve at:\n  ${flow.approveUrl}\nWaiting for approval...`);
  } else {
    console.log(`Request created (${requestId}). Waiting for approval...`);
  }

  const { response, attempts, elapsedMs } = await waitForAuthDecision(
    serverUrl(),
    requestId,
    secret,
    {
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      onPending: ({ attempt }) => {
        if (attempt === 1 || attempt % 5 === 0) {
          console.log('  pending...');
        }
      },
    },
  );

  if (response.status === 'rejected') {
    deleteApprovalContext(reqId);
    if (options.json) {
      console.log(JSON.stringify({
        success: true,
        requiresHumanApproval: true,
        approvalScope: 'session_token',
        status: 'rejected',
        claimStatus: 'rejected',
        retryReady: false,
        reqId,
        attempts,
        elapsedMs,
        approveUrl: flow.approveUrl,
        pollUrl,
        claim: flow.claim,
        claimAction,
        retryAction,
        instructions: [
          `1) Ask a human to approve: ${flow.approveUrl}`,
          `2) Claim now: ${claimAction.command}`,
          `3) Re-request token: ${requestRetryCommand}`,
        ],
        approvalFlow: flow.approvalFlow,
        note: 'Auth request was rejected. Create a new request and repeat the approval flow.',
      }, null, 2));
    } else {
      console.log('Request was rejected.');
      console.log(`  approveUrl: ${flow.approveUrl}`);
      console.log(`  pollUrl: ${pollUrl}`);
    }
    return 1;
  }

  if (!response.encryptedToken) {
    deleteApprovalContext(reqId);
    throw new Error('Approved response did not include encryptedToken');
  }

  const token = decryptWithPrivateKey(response.encryptedToken, privateKeyPem);
  const ttlSeconds = resolveClaimTtlSeconds(
    response as unknown as Record<string, unknown>,
    token,
    'session_token',
  );
  putActiveSessionToken({
    token,
    ttlSeconds,
    reqId,
  });
  deleteApprovalContext(reqId);

  if (options.json) {
    console.log(JSON.stringify({
      success: true,
      approvalScope: 'session_token',
      status: 'approved',
      claimStatus: 'approved',
      retryReady: true,
      reqId,
      attempts,
      elapsedMs,
      approveUrl: flow.approveUrl,
      pollUrl,
      token: options.rawToken ? token : undefined,
      tokenPreview: maskToken(token),
    }, null, 2));
  } else {
    console.log('Approved.');
    if (options.rawToken) {
      console.log(`  token: ${token}`);
    } else {
      console.log(`  token: ${maskToken(token)}`);
      console.log('  (use --raw-token to print the full token)');
    }
    console.log(`  approveUrl: ${flow.approveUrl}`);
    console.log(`  pollUrl: ${pollUrl}`);
    console.log('  Session token is active in local CLI context.');
  }

  return 0;
}

async function cmdRequest(args: string[]): Promise<number> {
  const flags = parseRequestFlags(args);
  const keypair = generateEphemeralKeypair();
  const resolvedDefaults = await resolveAuthFallbackProfileConfig({
    profile: flags.profile,
    profileVersion: flags.profileVersion,
  });
  const profileSelection: {
    profile: string;
    profileVersion: string;
    profileOverrides?: JsonObject;
  } = {
    profile: resolvedDefaults.profile,
    profileVersion: resolvedDefaults.profileVersion,
    ...(flags.profileOverrides ? { profileOverrides: flags.profileOverrides } : {}),
  };

  const createResult = await createAuthRequest({
    agentId: flags.agentId,
    profile: profileSelection.profile,
    ...(profileSelection.profileVersion ? { profileVersion: profileSelection.profileVersion } : {}),
    ...(profileSelection.profileOverrides ? { profileOverrides: profileSelection.profileOverrides } : {}),
    ...(flags.action ? { action: flags.action } : {}),
    pubkey: keypair.publicKeyPem,
  });

  const requestRetryCommand = buildAuthRequestRetryCommand({
    agentId: flags.agentId,
    profile: profileSelection.profile,
    ...(profileSelection.profileVersion ? { profileVersion: profileSelection.profileVersion } : {}),
    ...(profileSelection.profileOverrides ? { profileOverrides: profileSelection.profileOverrides } : {}),
    ...(flags.action ? { action: flags.action } : {}),
  });

  return handleApprovalFlow(createResult, keypair.privateKeyPem, flags, requestRetryCommand);
}

async function cmdClaim(args: string[]): Promise<number> {
  const reqId = args[0];
  if (!reqId) {
    throw new Error('Usage: npx auramaxx auth claim <reqId> [--json] [--raw-token] [--pending-retries <n>] [--pending-retry-interval-ms <ms>]');
  }
  const json = args.includes('--json');
  const rawToken = args.includes('--raw-token');
  const pendingRetries = parseNonNegativeIntegerFlag(args, '--pending-retries', CLAIM_PENDING_RETRIES_DEFAULT);
  const pendingRetryIntervalMs = parseIntegerFlag(
    args,
    '--pending-retry-interval-ms',
    CLAIM_PENDING_RETRY_INTERVAL_MS_DEFAULT,
  );
  const ctx = getApprovalContext(reqId);
  const retryCommand = (template?: string): string | undefined => {
    const candidate = String(template || '').trim();
    if (!candidate) return undefined;
    return candidate.replaceAll('<reqId>', reqId);
  };
  const retryCommandFromClaim = (payload: Record<string, unknown>): string | undefined => {
    const candidate = typeof payload.retryCommand === 'string' ? payload.retryCommand.trim() : '';
    if (!candidate) return undefined;
    return candidate.replaceAll('<reqId>', reqId);
  };
  if (!ctx) {
    const claimAction = buildCliClaimAction(reqId);
    const payload = {
      success: false,
      reqId,
      requiresHumanApproval: false,
      errorCode: 'missing_or_expired_claim',
      claimStatus: 'expired',
      retryReady: false,
      error: `No stored approval context for reqId=${reqId}.`,
      claimAction,
    };
    console.log(JSON.stringify(payload, null, 2));
    return 1;
  }

  const pollUrl = buildPollUrl(serverUrl(), reqId, ctx.secret);
  const claimAction = buildCliClaimAction(reqId);
  const retryAction = buildCliRetryAction(resolveRetryCommandTemplate(ctx.retryCommandTemplate, reqId));
  let result = await fetchAuthDecisionOnce(serverUrl(), reqId, ctx.secret);
  let classification = classifyClaimFetchResult(result);
  let mappedStatus = classification.mappedStatus;
  let pendingRetriesUsed = 0;

  while (mappedStatus === 'pending' && classification.success && pendingRetriesUsed < pendingRetries) {
    pendingRetriesUsed += 1;
    await sleep(pendingRetryIntervalMs);
    result = await fetchAuthDecisionOnce(serverUrl(), reqId, ctx.secret);
    classification = classifyClaimFetchResult(result);
    mappedStatus = classification.mappedStatus;
  }

  const payload: Record<string, unknown> = {
    reqId,
    requiresHumanApproval: mappedStatus !== 'approved',
    approvalScope: ctx.approvalScope,
    httpStatus: result.httpStatus,
    claimStatus: mappedStatus === 'invalid_secret' ? 'expired' : mappedStatus,
    retryReady: mappedStatus === 'approved',
    pollUrl,
    claimAction,
    retryAction,
    claimPollAttempts: pendingRetriesUsed + 1,
    pendingRetriesUsed,
    pendingRetriesConfigured: pendingRetries,
    pendingRetryIntervalMs,
  };

  if (mappedStatus === 'approved') {
    if (!result.payload.encryptedToken) {
      payload.success = false;
      payload.errorCode = 'claim_invalid_payload';
      payload.error = 'Approved response missing encryptedToken';
      payload.retryReady = false;
      payload.claimStatus = 'expired';
      deleteApprovalContext(reqId);
      console.log(JSON.stringify(payload, null, 2));
      return 1;
    }

    try {
      const token = decryptWithPrivateKey(result.payload.encryptedToken, ctx.privateKeyPem);
      const ttlSeconds = resolveClaimTtlSeconds(
        result.payload as Record<string, unknown>,
        token,
        ctx.approvalScope,
      );
      putClaimedToken({
        reqId,
        token,
        privateKeyPem: ctx.privateKeyPem,
        approvalScope: ctx.approvalScope,
        ttlSeconds,
        credentialId: ctx.credentialId,
        credentialName: ctx.credentialName,
      });
      if (ctx.approvalScope === 'session_token') {
        putActiveSessionToken({
          token,
          privateKeyPem: ctx.privateKeyPem,
          ttlSeconds,
          reqId,
        });
      }
      deleteApprovalContext(reqId);
      const retryNow = retryCommandFromClaim(result.payload)
        || retryCommand(ctx.retryCommandTemplate)
        || retryAction.command;
      payload.success = true;
      payload.retryCommand = retryNow;
      payload.instructions = [
        `1) Claim complete for reqId=${reqId}`,
        ctx.approvalScope === 'session_token'
          ? '2) Session token is active for subsequent CLI calls until expiry/revoke.'
          : `2) Retry original command with --reqId ${reqId}`,
        `3) Retry now: ${retryNow}`,
      ];
      payload.note = `Claimed token stored for reqId=${reqId}. Retry now: ${retryNow}`;
      if (json) {
        if (rawToken) {
          payload.token = token;
        } else {
          payload.tokenPreview = maskToken(token);
        }
      }
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    } catch (error) {
      payload.success = false;
      payload.errorCode = 'claim_decrypt_failed';
      payload.error = getErrorMessage(error);
      payload.retryReady = false;
      payload.claimStatus = 'expired';
      deleteApprovalContext(reqId);
      console.log(JSON.stringify(payload, null, 2));
      return 1;
    }
  }

  payload.success = classification.success;
  if (mappedStatus === 'pending') {
    if (classification.success) {
      payload.note = pendingRetriesUsed > 0
        ? `Approval is still pending after ${pendingRetriesUsed + 1} claim poll attempts. Ask human to approve, then claim again.`
        : 'Approval is still pending. Ask human to approve, then claim again.';
      payload.instructions = [
        `1) Ask a human to approve: http://localhost:${process.env.DASHBOARD_PORT || '4747'}/approve/${reqId}`,
        `2) Claim again: ${claimAction.command}`,
        `3) Retry original command after claimStatus=approved.`,
      ];
    } else {
      payload.errorCode = classification.errorCode || 'claim_unexpected_response';
      payload.error = classification.error || 'Claim did not return a usable status.';
      payload.retryReady = false;
      payload.note = classification.retryable
        ? 'Claim hit a transient error. Retry claim with the same reqId.'
        : 'Claim failed with a non-retryable response. Create a new auth request if this persists.';
      payload.instructions = [
        `1) Retry claim: ${claimAction.command}`,
        '2) If retries keep failing, create a new auth request and repeat approve -> claim -> retry.',
      ];
    }
  } else if (mappedStatus === 'invalid_secret') {
    payload.errorCode = 'claim_invalid_secret';
    payload.error = 'Claim rejected due to invalid or mismatched claim secret.';
    payload.note = 'Stored approval context was kept. Retry claim if the request is still active.';
  } else if (mappedStatus === 'rejected') {
    payload.errorCode = 'claim_rejected';
    payload.error = 'Approval was rejected.';
    deleteApprovalContext(reqId);
  } else if (mappedStatus === 'expired') {
    payload.errorCode = 'missing_or_expired_claim';
    payload.error = 'Approval claim expired or was already consumed.';
    deleteApprovalContext(reqId);
  }

  console.log(JSON.stringify(payload, null, 2));
  return classification.success ? 0 : 1;
}

async function cmdPending(json: boolean): Promise<number> {
  const res = await fetch(`${serverUrl()}/auth/pending`, {
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    await handlePermissionDeniedAndExit(res.status, data);
    throw new Error(String(data.error || `HTTP ${res.status}`));
  }

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }

  const requests = Array.isArray((data as { requests?: unknown[] }).requests)
    ? (data as { requests: Array<{ id: string; status: string; createdAt: string; metadata?: { agentId?: string } }> }).requests
    : [];

  if (requests.length === 0) {
    console.log('No pending auth requests.');
    return 0;
  }

  for (const req of requests) {
    const agentId = typeof req.metadata?.agentId === 'string' ? req.metadata.agentId : 'unknown';
    console.log(`${req.id}  agent=${agentId}  status=${req.status}  createdAt=${req.createdAt}`);
  }
  return 0;
}

async function cmdValidate(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const token = getFlagValue(args, '--token') || args[0] || process.env.AURA_TOKEN;
  if (!token || token.startsWith('--')) {
    throw new Error('validate requires --token <token> (or AURA_TOKEN)');
  }

  const res = await fetch(`${serverUrl()}/auth/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;

  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`valid=${String(data.valid ?? false)}`);
    if (typeof data.error === 'string' && data.error) {
      console.log(`error=${data.error}`);
    }
    if (typeof data.tokenHash === 'string') {
      console.log(`tokenHash=${data.tokenHash}`);
    }
  }

  return data.valid === true ? 0 : 1;
}

export async function runAuthCli(args: string[]): Promise<number> {
  const subcommand = args[0];
  const helpRequested = args.includes('--help') || args.includes('-h');

  if (!subcommand || subcommand === '--help' || subcommand === '-h' || helpRequested) {
    showHelp();
    return 0;
  }

  switch (subcommand) {
    case 'request':
      return await cmdRequest(args.slice(1));
    case 'claim':
      return await cmdClaim(args.slice(1));
    case 'pending':
      return await cmdPending(args.includes('--json'));
    case 'validate':
      return await cmdValidate(args.slice(1));
    default:
      throw new Error(`Unknown auth subcommand: ${subcommand}`);
  }
}

async function main(): Promise<void> {
  try {
    const code = await runAuthCli(process.argv.slice(2));
    process.exit(code);
  } catch (error) {
    console.error(`Auth command failed: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Auth command failed: ${getErrorMessage(error)}`);
    process.exit(1);
  });
}

// Exposed for testing only
export const _testOnly = { parseActionFlag, parseRequestFlags, buildPollUrl };
