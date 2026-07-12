#!/usr/bin/env node
/**
 * AuraMaxx MCP Server
 * =====================
 * Standalone MCP stdio server that gives any AI agent access to the wallet API.
 *
 * Auth bootstrap (in order):
 *   1. Unix socket auto-approve (ephemeral RSA keypair, encrypted token, zero config)
 *   2. AURA_TOKEN env var (CI/CD fallback)
 *
 * Usage:
 *   npx tsx server/mcp/server.ts
 *   AURA_TOKEN=<token> npx tsx server/mcp/server.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as net from 'net';
import { spawn } from 'child_process';
import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
} from 'crypto';
import { TOOLS, executeTool, jsonSchemaToZod } from './tools.js';
import {
  evaluateProjectScopeAccess,
  emitProjectScopeEvent,
  type ProjectScopeMode,
} from '../lib/project-scope';
import { resolveAuraSocketCandidates } from '../lib/socket-path';
import {
  appendDiaryEntry,
  DIARY_ENTRY_COUNT_KEY,
  formatDiaryEntry,
  getDiaryCredentialName,
  getLegacyDiaryCredentialName,
  resolveDiaryEntryCount,
  resolveDiaryDate,
} from '../lib/diary';
import {
  canonicalizeCredentialFieldKey,
  getCredentialFieldSpec,
  getCredentialFieldValue,
  getCredentialPrimaryFieldKey,
  NOTE_CONTENT_KEY,
} from '../../../shared/credential-field-schema';
import { defaultSecretEnvVarName, normalizeEnvVarName } from '../lib/secret-env';
import {
  buildApprovalClaimFlow,
  buildClaimHeaders,
  buildClaimEndpoint,
  buildPollUrl,
} from '../lib/approval-flow';
import {
  buildOperationBindingHashes,
  operationBindingMatches,
  parsePolicyOperationBinding,
  type PolicyOperationBinding,
} from '../lib/temp-policy';
import {
  ESCALATION_CONTRACT_VERSION,
} from '../lib/escalation-contract';
import { DETERMINISTIC_ESCALATION_ERROR_CODES } from '../lib/escalation-error-codes';

let token: string | undefined = process.env.AURA_TOKEN;
let authSource: 'socket' | 'env' | 'none' = token ? 'env' : 'none';
const MCP_ACTOR_ID = 'mcp-stdio';

/** Tracks the most recent auth request so get_token can report status. */
let pendingAuth: {
  requestId: string;
  agentId: string;
  status: 'polling' | 'approved' | 'rejected' | 'expired' | 'timeout';
  approveUrl: string;
  secret: string;
  policyHash?: string;
  compilerVersion?: string;
} | null = null;

type ClaimStatus = 'pending' | 'approved' | 'rejected' | 'expired';
type ApprovalScope = 'one_shot_read' | 'session_token';
const SESSION_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

type MpcToolAction = {
  transport: 'mcp';
  kind: 'tool';
  tool: string;
  args: Record<string, unknown>;
};

type McpToolResponse = { content: Array<{ type: 'text'; text: string }> };
function buildMcpToolAction(tool: string, args: Record<string, unknown> = {}): MpcToolAction {
  return {
    transport: 'mcp',
    kind: 'tool',
    tool,
    args,
  };
}

interface PendingScopedApproval {
  reqId: string;
  secret: string;
  approveUrl: string;
  credentialId?: string;
  credentialName?: string;
  binding?: PolicyOperationBinding;
  requestedPolicySource?: 'agent' | 'derived_403';
  requestedPolicy?: Record<string, unknown>;
  effectivePolicy?: Record<string, unknown>;
  policyHash?: string;
  compilerVersion?: string;
  createdAt: number;
}

interface OneShotTokenBinding {
  token: string;
  expiresAt: number;
  credentialId?: string;
  credentialName?: string;
  binding?: PolicyOperationBinding;
  policyHash?: string;
  compilerVersion?: string;
}

const pendingScopedApprovals = new Map<string, PendingScopedApproval>();
const oneShotTokensByReqId = new Map<string, OneShotTokenBinding>();

const WALLET_BASE = () => process.env.WALLET_SERVER_URL || 'http://127.0.0.1:4242';
const DASHBOARD_BASE = () => `http://localhost:${process.env.DASHBOARD_PORT || '4747'}`;
const WORKING_WITH_SECRETS_DOCS_URL = 'https://www.aurawallet.sh/docs/how-to-auramaxx/WORKING_WITH_SECRETS.md';

// ── Socket Bootstrap ───────────────────────────────────────────────────

interface HybridEnvelope {
  v: number;
  alg: string;
  key: string;
  iv: string;
  tag: string;
  data: string;
}

/**
 * Decrypt an encrypted blob (token or credential) using our private key.
 * Supports both direct RSA-OAEP and hybrid RSA-OAEP/AES-256-GCM envelopes.
 */
function decryptWithPrivateKey(encryptedBase64: string, privateKeyPem: string): string {
  const decoded = Buffer.from(encryptedBase64, 'base64');
  let envelope: HybridEnvelope;
  try {
    envelope = JSON.parse(decoded.toString('utf8')) as HybridEnvelope;
  } catch {
    // Direct RSA-OAEP ciphertext (small payloads)
    return privateDecrypt(
      { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      decoded,
    ).toString('utf8');
  }

  if (envelope.v !== 1 || envelope.alg !== 'RSA-OAEP/AES-256-GCM') {
    throw new Error(`Unexpected envelope: v=${envelope.v} alg=${envelope.alg}`);
  }

  const sessionKey = privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(envelope.key, 'base64'),
  );
  const decipher = createDecipheriv('aes-256-gcm', sessionKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// Ephemeral keypair for this session (used for bootstrap + credential reads)
const { publicKey: ephemeralPubPem, privateKey: ephemeralPrivPem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** Token TTL from bootstrap (seconds). Used for refresh scheduling. */
let tokenTtl = SESSION_TOKEN_TTL_SECONDS;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Bootstrap auth via Unix socket auto-approve.
 * Returns true if successful.
 */
function bootstrapViaSocket(): Promise<boolean> {
  const uid = process.getuid?.() ?? 'unknown';
  const socketPaths = resolveAuraSocketCandidates({
    uid,
    serverUrl: WALLET_BASE(),
    serverPort: process.env.WALLET_SERVER_PORT,
  });

  const trySocket = (socketPath: string): Promise<{ ok: boolean; connectionFailure: boolean }> =>
    new Promise((resolve) => {
      const socket = net.createConnection(socketPath);
      let buffer = '';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve({ ok: false, connectionFailure: true });
        }
      }, 5000);

      socket.on('connect', () => {
        socket.write(JSON.stringify({
          type: 'auth',
          agentId: 'mcp-stdio',
          autoApprove: true,
          pubkey: ephemeralPubPem,
        }) + '\n');
      });

      socket.on('data', (data) => {
        buffer += data.toString();
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.substring(0, newlineIndex);
          buffer = buffer.substring(newlineIndex + 1);

          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line.trim()) as {
              type: string;
              encryptedToken?: string;
              ttl?: number;
              message?: string;
            };

            if (msg.type === 'auth_approved' && msg.encryptedToken) {
              token = decryptWithPrivateKey(msg.encryptedToken, ephemeralPrivPem);
              tokenTtl = msg.ttl || SESSION_TOKEN_TTL_SECONDS;
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                socket.destroy();
                console.error(`[mcp] Bootstrapped via Unix socket (auto-approve path: ${socketPath})`);
                resolve({ ok: true, connectionFailure: false });
              }
            } else if (msg.type === 'error') {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                socket.destroy();
                console.error(`[mcp] Socket bootstrap error: ${msg.message}`);
                resolve({ ok: false, connectionFailure: false });
              }
            }
          } catch { /* ignore parse errors */ }
        }
      });

      socket.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          console.error(`[mcp] Socket bootstrap connection error: ${err.message} (code=${(err as NodeJS.ErrnoException).code})`);
          resolve({ ok: false, connectionFailure: true });
        }
      });
    });

  return (async () => {
    for (const socketPath of socketPaths) {
      const result = await trySocket(socketPath);
      if (result.ok) return true;
      if (!result.connectionFailure) return false;
    }
    return false;
  })();
}

/**
 * Schedule a token refresh before expiry.
 */
function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  // Refresh 60s before expiry, minimum 10s
  const refreshMs = Math.max((tokenTtl - 60) * 1000, 10_000);
  refreshTimer = setTimeout(() => attemptRefresh(0), refreshMs);
}

/** Retry token refresh with exponential backoff (30s, 60s, 120s, 240s, cap 300s). */
async function attemptRefresh(attempt: number): Promise<void> {
  console.error(`[mcp] Refreshing token (attempt ${attempt + 1})...`);
  const ok = await bootstrapViaSocket();
  if (ok) {
    scheduleRefresh();
  } else {
    const backoffMs = Math.min(30_000 * Math.pow(2, attempt), 300_000); // cap at 5 min
    console.error(`[mcp] Token refresh failed — retrying in ${backoffMs / 1000}s`);
    refreshTimer = setTimeout(() => attemptRefresh(attempt + 1), backoffMs);
  }
}

// ── MCP Server Setup ───────────────────────────────────────────────────

const server = new McpServer({
  name: 'auramaxx',
  version: '1.0.0',
});

// ── Resources ──────────────────────────────────────────────────────────

function loadApiDocs(): string {
  try { return readFileSync(join(__dirname, '..', '..', '..', 'docs', 'API.md'), 'utf-8'); }
  catch { return 'API documentation not found.'; }
}

function loadAuthDocs(): string {
  try { return readFileSync(join(__dirname, '..', '..', '..', 'docs', 'AUTH.md'), 'utf-8'); }
  catch { return 'Auth documentation not found.'; }
}

function loadAgentGuide(): string {
  try { return readFileSync(join(__dirname, '..', '..', '..', 'skills', 'auramaxx', 'SKILL.md'), 'utf-8'); }
  catch { return 'Agent guide not found.'; }
}

server.resource(
  'api-reference', 'docs://api',
  { description: 'Full AuraMaxx HTTP API reference — all endpoints, parameters, and examples' },
  async () => ({ contents: [{ uri: 'docs://api', text: loadApiDocs(), mimeType: 'text/markdown' }] }),
);

server.resource(
  'auth-reference', 'docs://auth',
  { description: 'Authentication, permissions, and spending limits reference' },
  async () => ({ contents: [{ uri: 'docs://auth', text: loadAuthDocs(), mimeType: 'text/markdown' }] }),
);

server.resource(
  'agent-guide', 'docs://guide',
  { description: 'Agent skill reference — setup, operations, hook modes, permissions, error recovery' },
  async () => ({ contents: [{ uri: 'docs://guide', text: loadAgentGuide(), mimeType: 'text/markdown' }] }),
);

// ── Credential helpers ─────────────────────────────────────────────────

/**
 * Decrypt a credential payload encrypted to our ephemeral RSA key.
 */
async function fetchAgentNameMap(): Promise<Map<string, string>> {
  const res = await fetch(`${WALLET_BASE()}/setup/agents`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return new Map();
  const data = await res.json() as { agents?: Array<{ id: string; name: string }> };
  return new Map((data.agents || []).map((v) => [v.id, v.name]));
}

const PROJECT_SCOPE_MODE_CACHE_MS = 10_000;
let cachedProjectScopeMode: ProjectScopeMode = 'off';
let cachedProjectScopeModeAt = 0;

function normalizeProjectScopeMode(raw: unknown): ProjectScopeMode {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'strict') return 'strict';
  if (value === 'auto') return 'auto';
  if (value === 'off') return 'off';
  return 'off';
}

async function fetchProjectScopeMode(): Promise<ProjectScopeMode> {
  const now = Date.now();
  if (now - cachedProjectScopeModeAt < PROJECT_SCOPE_MODE_CACHE_MS) {
    return cachedProjectScopeMode;
  }
  try {
    const res = await fetch(`${WALLET_BASE()}/setup`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return cachedProjectScopeMode;
    const data = await res.json() as { projectScopeMode?: unknown };
    cachedProjectScopeMode = normalizeProjectScopeMode(data.projectScopeMode);
    cachedProjectScopeModeAt = now;
    return cachedProjectScopeMode;
  } catch {
    return cachedProjectScopeMode;
  }
}

function decryptCredentialPayload(encryptedBase64: string): {
  id: string;
  agentId: string;
  type: string;
  fields: Array<{ key: string; value: string; type?: string; sensitive?: boolean }>;
} {
  const plaintext = decryptWithPrivateKey(encryptedBase64, ephemeralPrivPem);
  return JSON.parse(plaintext);
}

function extractErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error;
  } catch { /* plain-text payload */ }
  return raw;
}

function withEscalationContractVersion(payload: Record<string, unknown>): Record<string, unknown> {
  const needsVersion = (
    payload.requiresHumanApproval === true
    || typeof payload.errorCode === 'string'
    || typeof payload.reqId === 'string'
    || typeof payload.approvalScope === 'string'
  );
  if (!needsVersion) return payload;
  if (payload.contractVersion === ESCALATION_CONTRACT_VERSION) return payload;
  return {
    contractVersion: ESCALATION_CONTRACT_VERSION,
    ...payload,
  };
}

function unsupportedContractVersionPayload(rawVersion: string): Record<string, unknown> {
  return withEscalationContractVersion({
    success: false,
    requiresHumanApproval: false,
    errorCode: 'unsupported_contract_version',
    error: `Unsupported escalation contractVersion: ${rawVersion}`,
    claimStatus: 'expired' as ClaimStatus,
    retryReady: false,
  });
}

function looksLikeEscalationPayload(input: Record<string, unknown>): boolean {
  return (
    input.requiresHumanApproval === true
    || typeof input.errorCode === 'string'
    || typeof input.reqId === 'string'
    || typeof input.approvalScope === 'string'
    || input.escalation !== undefined // legacy payload marker
  );
}

function isCanonicalEscalationV1(input: Record<string, unknown>): boolean {
  return input.contractVersion === ESCALATION_CONTRACT_VERSION && looksLikeEscalationPayload(input);
}

function extractUnsupportedContractVersion(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const asRecord = parsed as Record<string, unknown>;
    if (!looksLikeEscalationPayload(asRecord)) return null;
    if (isCanonicalEscalationV1(asRecord)) return null;
    return typeof asRecord.contractVersion === 'string' ? asRecord.contractVersion : 'missing';
  } catch {
    return null;
  }
}

function extractExistingApproval(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const asRecord = parsed as Record<string, unknown>;
    if (!isCanonicalEscalationV1(asRecord)) return null;
    if (asRecord.requiresHumanApproval !== true) return null;
    if (!readReqId(asRecord)) return null;
    return asRecord;
  } catch {
    return null;
  }
}

function extractDeterministicEscalationError(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const asRecord = parsed as Record<string, unknown>;
    if (!isCanonicalEscalationV1(asRecord)) return null;
    const errorCode = typeof asRecord.errorCode === 'string' ? asRecord.errorCode : '';
    if (!errorCode || !DETERMINISTIC_ESCALATION_ERROR_CODES.has(errorCode)) return null;
    return asRecord;
  } catch {
    return null;
  }
}

function readReqId(input: Record<string, unknown>): string | null {
  if (typeof input.reqId === 'string' && input.reqId.trim()) return input.reqId.trim();
  return null;
}

function readPolicyBinding(input: Record<string, unknown>): PolicyOperationBinding | undefined {
  return parsePolicyOperationBinding(input.binding);
}

function readApprovalScope(input: Record<string, unknown>): ApprovalScope {
  return input.approvalScope === 'session_token' ? 'session_token' : 'one_shot_read';
}

function maybeRegisterApprovalContext(input: Record<string, unknown>, reqId: string): void {
  const secret = typeof input.secret === 'string' ? input.secret : '';
  if (!secret) return;
  const approveUrl = typeof input.approveUrl === 'string' ? input.approveUrl : `${DASHBOARD_BASE()}/approve/${encodeURIComponent(reqId)}`;
  const approvalScope = readApprovalScope(input);
  if (approvalScope === 'session_token') {
    pendingAuth = {
      requestId: reqId,
      agentId: pendingAuth?.agentId || 'mcp-stdio',
      status: 'polling',
      approveUrl,
      secret,
      ...(typeof input.policyHash === 'string' ? { policyHash: input.policyHash } : {}),
      ...(typeof input.compilerVersion === 'string' ? { compilerVersion: input.compilerVersion } : {}),
    };
    return;
  }
  const credential = input.credential && typeof input.credential === 'object' && !Array.isArray(input.credential)
    ? input.credential as Record<string, unknown>
    : undefined;
  const credentialId = credential && typeof credential.id === 'string' ? credential.id : undefined;
  const credentialName = credential && typeof credential.name === 'string' ? credential.name : undefined;
  pendingScopedApprovals.set(reqId, {
    reqId,
    secret,
    approveUrl,
    credentialId,
    credentialName,
    binding: readPolicyBinding(input),
    requestedPolicySource: input.requestedPolicySource === 'agent' ? 'agent' : input.requestedPolicySource === 'derived_403' ? 'derived_403' : undefined,
    requestedPolicy: input.requestedPolicy && typeof input.requestedPolicy === 'object' && !Array.isArray(input.requestedPolicy)
      ? input.requestedPolicy as Record<string, unknown>
      : undefined,
    effectivePolicy: input.effectivePolicy && typeof input.effectivePolicy === 'object' && !Array.isArray(input.effectivePolicy)
      ? input.effectivePolicy as Record<string, unknown>
      : undefined,
    policyHash: typeof input.policyHash === 'string' ? input.policyHash : undefined,
    compilerVersion: typeof input.compilerVersion === 'string' ? input.compilerVersion : undefined,
    createdAt: Date.now(),
  });
}

function bindOneShotToken(reqId: string, tokenValue: string, ttlSeconds?: number): void {
  const pending = pendingScopedApprovals.get(reqId);
  const ttlMs = Math.max(15_000, (typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) ? ttlSeconds : 120) * 1000);
  oneShotTokensByReqId.set(reqId, {
    token: tokenValue,
    expiresAt: Date.now() + ttlMs,
    credentialId: pending?.credentialId,
    credentialName: pending?.credentialName,
    binding: pending?.binding,
    policyHash: pending?.policyHash,
    compilerVersion: pending?.compilerVersion,
  });
}

function getOneShotToken(reqId: string): OneShotTokenBinding | null {
  const entry = oneShotTokensByReqId.get(reqId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    oneShotTokensByReqId.delete(reqId);
    return null;
  }
  return entry;
}

function consumeOneShotToken(reqId: string): void {
  oneShotTokensByReqId.delete(reqId);
}

function missingOrExpiredClaimPayload(
  reqId: string,
  approvalScope: ApprovalScope = 'one_shot_read',
  details?: { policyHash?: string; compilerVersion?: string },
): Record<string, unknown> {
  return withEscalationContractVersion({
    success: false,
    requiresHumanApproval: false,
    reqId,
    approvalScope,
    errorCode: 'missing_or_expired_claim',
    claimStatus: 'expired' as ClaimStatus,
    retryReady: false,
    error: `No active claimed token for reqId=${reqId}. Run claim step again.`,
    claimAction: buildMcpToolAction('get_token', { reqId }),
    retryAction: buildMcpToolAction('<retry_original_tool>', { reqId }),
    instructions: [
      `1) Ask human to approve request ${reqId}`,
      `2) Claim now: call MCP tool get_token with {"reqId":"${reqId}"}`,
      `3) Retry now: rerun the same MCP tool call and include {"reqId":"${reqId}"}`,
    ],
    ...(details?.policyHash ? { policyHash: details.policyHash } : {}),
    ...(details?.compilerVersion ? { compilerVersion: details.compilerVersion } : {}),
  });
}

function operationBindingMismatchPayload(input: {
  reqId: string;
  scope: ApprovalScope;
  expectedRouteId: string;
  expectedMethod: string;
  policyHash?: string;
  compilerVersion?: string;
}): Record<string, unknown> {
  return withEscalationContractVersion({
    success: false,
    requiresHumanApproval: false,
    reqId: input.reqId,
    approvalScope: input.scope,
    errorCode: 'operation_binding_mismatch',
    claimStatus: 'approved' as ClaimStatus,
    retryReady: false,
    error: `Claimed token for reqId=${input.reqId} is bound to ${input.expectedMethod} ${input.expectedRouteId}; this retry does not match the bound operation.`,
    claimAction: buildMcpToolAction('get_token', { reqId: input.reqId }),
    retryAction: buildMcpToolAction('<retry_original_tool>', { reqId: input.reqId }),
    ...(input.policyHash ? { policyHash: input.policyHash } : {}),
    ...(input.compilerVersion ? { compilerVersion: input.compilerVersion } : {}),
  });
}

async function claimScopedApproval(reqId: string): Promise<Record<string, unknown>> {
  const claimAction = buildMcpToolAction('get_token', { reqId });
  const retryAction = buildMcpToolAction('<retry_original_tool>', { reqId });
  const instructions = [
    `1) Ask human to approve request ${reqId}`,
    `2) Claim now: call MCP tool get_token with {"reqId":"${reqId}"}`,
    `3) Retry now: rerun the same MCP tool call and include {"reqId":"${reqId}"}`,
  ];
  const existingToken = getOneShotToken(reqId);
  if (existingToken) {
    return {
      success: true,
      requiresHumanApproval: false,
      reqId,
      approvalScope: 'one_shot_read' as ApprovalScope,
      claimStatus: 'approved' as ClaimStatus,
      retryReady: true,
      note: 'Claim already completed for this reqId; retry now.',
      claimAction,
      retryAction,
      instructions,
      ...(existingToken.policyHash ? { policyHash: existingToken.policyHash } : {}),
      ...(existingToken.compilerVersion ? { compilerVersion: existingToken.compilerVersion } : {}),
    };
  }

  const pending = pendingScopedApprovals.get(reqId);
  if (!pending) {
    return missingOrExpiredClaimPayload(reqId);
  }
  const approveUrl = pending.approveUrl || `${DASHBOARD_BASE()}/approve/${encodeURIComponent(reqId)}`;

  const pollUrl = buildPollUrl(WALLET_BASE(), reqId, pending.secret);
  try {
    const pollRes = await fetch(pollUrl, {
      signal: AbortSignal.timeout(5000),
      headers: buildClaimHeaders(pending.secret),
    });
    if (pollRes.status === 410) {
      pendingScopedApprovals.delete(reqId);
      return {
        ...missingOrExpiredClaimPayload(reqId),
        note: 'Approval claim expired or already consumed.',
        ...(pending?.policyHash ? { policyHash: pending.policyHash } : {}),
        ...(pending?.compilerVersion ? { compilerVersion: pending.compilerVersion } : {}),
      };
    }
    if (pollRes.status === 403) {
      pendingScopedApprovals.delete(reqId);
      return {
        success: false,
        requiresHumanApproval: true,
        reqId,
        approvalScope: 'one_shot_read' as ApprovalScope,
        approveUrl,
        claimStatus: 'rejected' as ClaimStatus,
        retryReady: false,
        errorCode: 'claim_denied',
        error: 'Approval claim denied.',
        claimAction,
        retryAction,
        instructions,
        ...(pending.policyHash ? { policyHash: pending.policyHash } : {}),
        ...(pending.compilerVersion ? { compilerVersion: pending.compilerVersion } : {}),
      };
    }
    if (!pollRes.ok) {
      return {
        success: false,
        requiresHumanApproval: true,
        reqId,
        approvalScope: 'one_shot_read' as ApprovalScope,
        approveUrl,
        claimStatus: 'pending' as ClaimStatus,
        retryReady: false,
        errorCode: 'claim_poll_failed',
        error: `Claim poll failed (${pollRes.status})`,
        claimAction,
        retryAction,
        instructions,
        ...(pending.policyHash ? { policyHash: pending.policyHash } : {}),
        ...(pending.compilerVersion ? { compilerVersion: pending.compilerVersion } : {}),
      };
    }

    const pollData = await pollRes.json() as {
      status?: 'pending' | 'approved' | 'rejected';
      encryptedToken?: string;
      ttl?: number;
    };
    if (pollData.status === 'pending') {
      return {
        success: true,
        requiresHumanApproval: true,
        reqId,
        approvalScope: 'one_shot_read' as ApprovalScope,
        approveUrl,
        claimStatus: 'pending' as ClaimStatus,
        retryReady: false,
        note: 'Approval still pending. Ask human to approve, then claim again.',
        claimAction,
        retryAction,
        instructions,
        ...(pending.policyHash ? { policyHash: pending.policyHash } : {}),
        ...(pending.compilerVersion ? { compilerVersion: pending.compilerVersion } : {}),
      };
    }
    if (pollData.status === 'rejected') {
      pendingScopedApprovals.delete(reqId);
      return {
        success: false,
        requiresHumanApproval: true,
        reqId,
        approvalScope: 'one_shot_read' as ApprovalScope,
        approveUrl,
        claimStatus: 'rejected' as ClaimStatus,
        retryReady: false,
        errorCode: 'claim_rejected',
        error: 'Approval was rejected.',
        claimAction,
        retryAction,
        instructions,
        ...(pending.policyHash ? { policyHash: pending.policyHash } : {}),
        ...(pending.compilerVersion ? { compilerVersion: pending.compilerVersion } : {}),
      };
    }
    if (pollData.status === 'approved' && pollData.encryptedToken) {
      try {
        const scopedToken = decryptWithPrivateKey(pollData.encryptedToken, ephemeralPrivPem);
        bindOneShotToken(reqId, scopedToken, pollData.ttl);
        pendingScopedApprovals.delete(reqId);
        return {
          success: true,
          requiresHumanApproval: false,
          reqId,
          approvalScope: 'one_shot_read' as ApprovalScope,
          claimStatus: 'approved' as ClaimStatus,
          retryReady: true,
          note: 'Claim complete. Retry the original MCP tool call with reqId.',
          claimAction,
          retryAction,
          instructions,
          ...(pending.policyHash ? { policyHash: pending.policyHash } : {}),
          ...(pending.compilerVersion ? { compilerVersion: pending.compilerVersion } : {}),
        };
      } catch {
        pendingScopedApprovals.delete(reqId);
        return {
          success: false,
          requiresHumanApproval: false,
          reqId,
          approvalScope: 'one_shot_read' as ApprovalScope,
          claimStatus: 'expired' as ClaimStatus,
          retryReady: false,
          errorCode: 'claim_decrypt_failed',
          error: 'Claimed token could not be decrypted by MCP session key.',
          claimAction,
          retryAction,
          instructions,
          ...(pending.policyHash ? { policyHash: pending.policyHash } : {}),
          ...(pending.compilerVersion ? { compilerVersion: pending.compilerVersion } : {}),
        };
      }
    }

    return {
      success: false,
      requiresHumanApproval: false,
      reqId,
      approvalScope: 'one_shot_read' as ApprovalScope,
      claimStatus: 'expired' as ClaimStatus,
      retryReady: false,
      errorCode: 'claim_invalid_payload',
      error: 'Claim response did not include an approved token.',
      claimAction,
      retryAction,
      instructions,
      ...(pending.policyHash ? { policyHash: pending.policyHash } : {}),
      ...(pending.compilerVersion ? { compilerVersion: pending.compilerVersion } : {}),
    };
  } catch (error) {
    return {
      success: false,
      requiresHumanApproval: true,
      reqId,
      approvalScope: 'one_shot_read' as ApprovalScope,
      approveUrl,
      claimStatus: 'pending' as ClaimStatus,
      retryReady: false,
      errorCode: 'claim_network_error',
      error: `Claim polling failed: ${error}`,
      claimAction,
      retryAction,
      instructions,
      ...(pending.policyHash ? { policyHash: pending.policyHash } : {}),
      ...(pending.compilerVersion ? { compilerVersion: pending.compilerVersion } : {}),
    };
  }
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
    dashboardBase: DASHBOARD_BASE(),
    walletBase: WALLET_BASE(),
    mode: 'manual_auth_claim',
    summary: 'Auth token is only issued after explicit claim/poll. MCP does not auto-poll in background.',
    step2Label: 'Claim token',
    finalStep: 'Retry the original operation after claim returns approved.',
    retryBehavior: 'Until claim succeeds, get_token returns pending/rejected status and no active token.',
  });
}

async function buildPermissionEscalationResponse(input: {
  operation: string;
  status: number;
  rawBody: string;
  permissions: string[];
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
}): Promise<McpToolResponse> {
  const unsupportedVersion = extractUnsupportedContractVersion(input.rawBody);
  if (unsupportedVersion) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(unsupportedContractVersionPayload(unsupportedVersion)),
      }],
    };
  }

  const deterministic = extractDeterministicEscalationError(input.rawBody);
  if (deterministic) {
    const reqId = readReqId(deterministic);
    const payload: Record<string, unknown> = {
      status: input.status,
      ...deterministic,
      ...(reqId ? { reqId } : {}),
    };
    if (reqId) {
      payload.claimAction = buildMcpToolAction('get_token', { reqId });
      payload.retryAction = buildMcpToolAction('<retry_original_tool>', { reqId });
      if (!Array.isArray(payload.instructions) || payload.instructions.length === 0) {
        payload.instructions = [
          `1) Claim now: call MCP tool get_token with {"reqId":"${reqId}"}`,
          `2) Retry now: rerun the original MCP tool call and include {"reqId":"${reqId}"}`,
        ];
      }
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(withEscalationContractVersion(payload)),
      }],
    };
  }

  const existingApproval = extractExistingApproval(input.rawBody);
  if (existingApproval) {
    const reqId = readReqId(existingApproval);
    if (!reqId) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...unsupportedContractVersionPayload('missing'),
            status: input.status,
            reason: 'Approval payload missing reqId.',
          }),
        }],
      };
    }
    maybeRegisterApprovalContext(existingApproval, reqId);
    const approvalScope = readApprovalScope(existingApproval);
    const approveUrl = typeof existingApproval.approveUrl === 'string' && existingApproval.approveUrl.trim()
      ? existingApproval.approveUrl
      : `${DASHBOARD_BASE()}/approve/${encodeURIComponent(reqId)}`;
    const claimAction = buildMcpToolAction('get_token', { reqId });
    const retryAction = buildMcpToolAction('<retry_original_tool>', { reqId });
    const claimStatus = existingApproval.claimStatus === 'approved'
      ? 'approved'
      : existingApproval.claimStatus === 'rejected'
        ? 'rejected'
        : existingApproval.claimStatus === 'expired'
          ? 'expired'
          : 'pending';
    const retryReady = typeof existingApproval.retryReady === 'boolean' ? existingApproval.retryReady : false;
    const instructions = Array.isArray(existingApproval.instructions) && existingApproval.instructions.length > 0
      ? existingApproval.instructions
      : [
        `1) Ask human to approve: ${approveUrl}`,
        `2) Claim now: call MCP tool get_token with {"reqId":"${reqId}"}`,
        `3) Retry now: rerun the original MCP tool call and include {"reqId":"${reqId}"}`,
      ];
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(withEscalationContractVersion({
          status: input.status,
          ...existingApproval,
          reqId,
          approvalScope,
          claimStatus,
          retryReady,
          claimAction,
          retryAction,
          instructions,
        })),
      }],
    };
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ...unsupportedContractVersionPayload('missing'),
        status: input.status,
        reason: extractErrorMessage(input.rawBody),
        note: 'Permission-denied payload is not canonical escalation contract v1.',
      }),
    }],
  };
}

async function resolveDefaultAgentId(explicitAgent?: string): Promise<string> {
  if (explicitAgent) return explicitAgent;
  try {
    const { listAgents } = await import('../lib/cold');
    const agents = listAgents();
    const primaryAgent = agents.find(v => v.isPrimary || v.id === 'primary');
    if (primaryAgent) return primaryAgent.id;
    return 'primary';
  } catch {
    return 'primary';
  }
}

/**
 * Resolve the agent for diary entries — uses primary agent by default.
 */
async function resolveDiaryAgentId(explicitAgent?: string): Promise<string> {
  if (explicitAgent) return explicitAgent;
  try {
    const { listAgents } = await import('../lib/cold');
    const agents = listAgents();
    const primaryAgent = agents.find(v => v.isPrimary || v.id === 'primary');
    if (primaryAgent) return primaryAgent.id;
    return 'primary';
  } catch {
    return 'primary';
  }
}

// ── get_secret rate limiter ─────────────────────────────────────────────
const GET_SECRET_WINDOW_MS = 60_000; // 1 minute
const GET_SECRET_MAX = 10; // max 10 requests per window
const getSecretRequests: number[] = [];

function isGetSecretRateLimited(): boolean {
  const now = Date.now();
  // Prune old entries
  while (getSecretRequests.length > 0 && getSecretRequests[0] <= now - GET_SECRET_WINDOW_MS) {
    getSecretRequests.shift();
  }
  if (getSecretRequests.length >= GET_SECRET_MAX) return true;
  getSecretRequests.push(now);
  return false;
}

// ── Shared credential resolver ──────────────────────────────────────────

/**
 * Search for a credential by name or tag and return its ID + name.
 * Shared by get_secret, del_secret, inject_secret, share_secret.
 */
async function resolveCredentialByName(
  name: string,
  authTokenOverride?: string,
): Promise<
  | { credentialId: string; credentialName: string; credentialType?: string }
  | { error: string; escalation?: McpToolResponse }
> {
  const base = WALLET_BASE();
  const authToken = authTokenOverride || token;
  if (!authToken) {
    return { error: 'No auth token available for credential lookup' };
  }
  try {
    const agentNames = await fetchAgentNameMap();
    const projectScopeMode = await fetchProjectScopeMode();
    for (const queryParam of [`q=${encodeURIComponent(name)}`, `tag=${encodeURIComponent(name)}`]) {
      const res = await fetch(`${base}/credentials?${queryParam}`, {
        headers: { 'Authorization': `Bearer ${authToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 403) {
        const text = await res.text();
        return {
          error: `Permission denied searching for "${name}"`,
          escalation: await buildPermissionEscalationResponse({
            operation: `Read secret "${name}"`,
            status: res.status,
            rawBody: text,
            permissions: ['secret:read'],
            endpoint: `/credentials?${queryParam}`,
            method: 'GET',
          }),
        };
      }
      if (!res.ok) continue;

      const data = await res.json() as { credentials: Array<{ id: string; name: string; type?: string; agentId: string }> };
      if (!data.credentials || data.credentials.length === 0) continue;

      const decision = evaluateProjectScopeAccess({
        surface: 'mcp_get_secret',
        requested: { agentName: null, credentialName: name },
        candidates: data.credentials.map((c) => ({
          id: c.id,
          name: c.name,
          agentName: agentNames.get(c.agentId) || null,
        })),
        actor: 'mcp-stdio',
        projectScopeMode,
      });

      emitProjectScopeEvent({
        actor: 'mcp-stdio',
        surface: 'mcp_get_secret',
        requestedCredential: { agentName: null, credentialName: name },
        decision,
      });

      if (!decision.allowed) {
        return { error: `${decision.code}: ${decision.remediation}` };
      }

      const allowedIds = new Set(decision.allowedCandidates.map((c) => c.id).filter(Boolean));
      const scopedCandidates = data.credentials.filter((c) => allowedIds.has(c.id));
      if (scopedCandidates.length === 0) continue;

      return {
        credentialId: scopedCandidates[0].id,
        credentialName: scopedCandidates[0].name,
        credentialType: scopedCandidates[0].type,
      };
    }
  } catch (err) {
    return { error: `Search failed: ${err}` };
  }
  return { error: `No credential found matching "${name}"` };
}

function resolveReadAuthContext(
  reqId?: string,
):
  | { ok: true; bearer: string; mode: 'one_shot' | 'session'; reqId?: string; binding?: OneShotTokenBinding }
  | { ok: false; payload: Record<string, unknown> } {
  if (typeof reqId === 'string' && reqId.trim()) {
    const normalizedReqId = reqId.trim();
    const oneShot = getOneShotToken(normalizedReqId);
    if (oneShot) {
      return {
        ok: true,
        bearer: oneShot.token,
        mode: 'one_shot',
        reqId: normalizedReqId,
        binding: oneShot,
      };
    }

    if (pendingAuth && pendingAuth.requestId === normalizedReqId && token && pendingAuth.status === 'approved') {
      return {
        ok: true,
        bearer: token,
        mode: 'session',
        reqId: normalizedReqId,
      };
    }

    const scope = pendingAuth && pendingAuth.requestId === normalizedReqId
      ? 'session_token' as ApprovalScope
      : 'one_shot_read' as ApprovalScope;
    const pendingScoped = pendingScopedApprovals.get(normalizedReqId);
    return {
      ok: false,
      payload: missingOrExpiredClaimPayload(normalizedReqId, scope, {
        ...(pendingScoped?.policyHash ? { policyHash: pendingScoped.policyHash } : {}),
        ...(pendingScoped?.compilerVersion ? { compilerVersion: pendingScoped.compilerVersion } : {}),
      }),
    };
  }

  if (!token) {
    return {
      ok: false,
      payload: { error: 'No auth token — start AuraMaxx server for auto-bootstrap, or set AURA_TOKEN env var' },
    };
  }

  return { ok: true, bearer: token, mode: 'session' };
}

function validateOneShotCredentialReadBinding(input: {
  reqId: string;
  binding: OneShotTokenBinding;
  credentialId: string;
}): Record<string, unknown> | null {
  const compiledBinding = input.binding.binding;
  if (!compiledBinding) return null;
  const expected = buildOperationBindingHashes({
    actorId: MCP_ACTOR_ID,
    method: 'POST',
    routeId: 'credentials.read',
    resource: { credentialId: input.credentialId },
    body: {},
    policyHash: input.binding.policyHash || 'unknown',
  });
  const matches = operationBindingMatches({
    binding: compiledBinding,
    actorId: MCP_ACTOR_ID,
    method: 'POST',
    routeId: 'credentials.read',
    resource: { credentialId: input.credentialId },
    body: {},
  });
  if (matches) return null;
  return {
    ...operationBindingMismatchPayload({
      reqId: input.reqId,
      scope: 'one_shot_read',
      expectedRouteId: compiledBinding.routeId,
      expectedMethod: compiledBinding.method,
      policyHash: input.binding.policyHash,
      compilerVersion: input.binding.compilerVersion,
    }),
    expectedBinding: {
      routeId: expected.routeId,
      method: expected.method,
      resourceHash: expected.resourceHash,
      bodyHash: expected.bodyHash,
      bindingHash: expected.bindingHash,
    },
  };
}

function extractPrimarySecretValue(
  fields: Array<{ key: string; value: string; type?: string; sensitive?: boolean }>,
): string {
  const noteField = getCredentialFieldValue('note', fields, NOTE_CONTENT_KEY);
  const sensitiveField = fields.find((f) => f.sensitive)?.value;
  return noteField || sensitiveField || fields[0]?.value || '';
}

function findCredentialFieldValue(
  credentialType: string | undefined,
  fields: Array<{ key: string; value: string; type?: string; sensitive?: boolean }>,
  requestedField: string,
): string | undefined {
  const trimmed = String(requestedField || '').trim();
  if (!trimmed) return undefined;
  const directMatch = fields.find((field) => field.key.toLowerCase() === trimmed.toLowerCase());
  if (directMatch) return directMatch.value;
  const canonicalKey = canonicalizeCredentialFieldKey(String(credentialType || 'custom'), trimmed).toLowerCase();
  const canonicalMatch = fields.find((field) => field.key.toLowerCase() === canonicalKey);
  return canonicalMatch?.value;
}

function renderSecretValue(secretValue: string, dangerPlaintext: boolean): string {
  return dangerPlaintext ? secretValue : '*******';
}

function buildWhatDoLines(envVar: string): string[] {
  return [
    `Saved to env variable ${envVar}.`,
    "Scope: current MCP server process only. Use '-- <command>' to inject into a child command.",
  ];
}

function buildStoredSecretResponse(input: {
  name: string;
  credentialId: string;
  envVar: string;
  secretValue: string;
  dangerPlaintext: boolean;
  totpCode?: string;
  totpRemaining?: number;
}): McpToolResponse {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        success: true,
        banner: 'SECRET DECRYPTED',
        name: input.name,
        credentialId: input.credentialId,
        envVar: input.envVar,
        docs: WORKING_WITH_SECRETS_DOCS_URL,
        secret: renderSecretValue(input.secretValue, input.dangerPlaintext),
        whatDo: buildWhatDoLines(input.envVar),
        scope: 'mcp-server-process',
        ...(input.totpCode && { totpCode: renderSecretValue(input.totpCode, input.dangerPlaintext), totpRemaining: input.totpRemaining }),
      }),
    }],
  };
}

async function runSecretCommand(input: {
  command: string[];
  envVar: string;
  secretValue: string;
  name: string;
  credentialId: string;
  dangerPlaintext: boolean;
}): Promise<McpToolResponse> {
  return await new Promise((resolve) => {
    const child = spawn(input.command[0], input.command.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, [input.envVar]: input.secretValue },
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });

    child.on('error', (error) => {
      resolve({
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: `Failed to execute command: ${error.message}`,
            envVar: input.envVar,
            name: input.name,
            credentialId: input.credentialId,
            secret: renderSecretValue(input.secretValue, input.dangerPlaintext),
          }),
        }],
      });
    });

    child.on('exit', (code) => {
      const truncated = (s: string) => s.length > 2000 ? s.slice(0, 2000) + '...[truncated]' : s;
      resolve({
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: code === 0,
            exitCode: code,
            envVar: input.envVar,
            name: input.name,
            credentialId: input.credentialId,
            command: input.command.join(' '),
            secret: renderSecretValue(input.secretValue, input.dangerPlaintext),
            stdout: truncated(stdout),
            ...(stderr ? { stderr: truncated(stderr) } : {}),
          }),
        }],
      });
    });
  });
}

async function claimSessionApproval(reqId: string): Promise<Record<string, unknown>> {
  if (!pendingAuth || pendingAuth.requestId !== reqId) {
    return missingOrExpiredClaimPayload(reqId, 'session_token');
  }

  const flow = buildAuthApprovalFlow({
    requestId: pendingAuth.requestId,
    secret: pendingAuth.secret,
    approveUrl: pendingAuth.approveUrl,
  });
  const pollUrl = flow.pollUrl || buildPollUrl(WALLET_BASE(), pendingAuth.requestId, pendingAuth.secret);
  const claim = flow.claim || {
    method: 'GET' as const,
    endpoint: buildClaimEndpoint(pendingAuth.requestId, pendingAuth.secret),
    command: `curl -s -H "x-aura-claim-secret: ${pendingAuth.secret}" "${pollUrl}"`,
  };
  const claimAction = buildMcpToolAction('get_token', { reqId: pendingAuth.requestId });
  const retryAction = buildMcpToolAction('<retry_original_tool>', { reqId: pendingAuth.requestId });
  const instructions = [
    `1) Ask human to approve: ${flow.approveUrl}`,
    `2) Claim now: call MCP tool get_token with {"reqId":"${pendingAuth.requestId}"}`,
    `3) Retry now: rerun the original MCP tool call and include {"reqId":"${pendingAuth.requestId}"}`,
  ];

  if (pendingAuth.status === 'polling') {
    try {
      const pollRes = await fetch(pollUrl, {
        signal: AbortSignal.timeout(5000),
        headers: buildClaimHeaders(pendingAuth.secret),
      });
      if (pollRes.status === 410) {
        pendingAuth.status = 'expired';
      } else if (pollRes.status === 403) {
        pendingAuth.status = 'rejected';
      } else if (pollRes.ok) {
        const pollData = await pollRes.json() as {
          status?: string;
          encryptedToken?: string;
          ttl?: number;
        };
        if (!applyClaimResponseToPendingAuth(pollData, pendingAuth.requestId) && pollData.status === 'rejected') {
          pendingAuth.status = 'rejected';
        }
      } else {
        return withEscalationContractVersion({
          success: false,
          hasToken: false,
          status: pendingAuth.status,
          reqId: pendingAuth.requestId,
          agentId: pendingAuth.agentId,
          requiresHumanApproval: true,
          approvalScope: 'session_token' as ApprovalScope,
          claimStatus: 'pending' as ClaimStatus,
          retryReady: false,
          approveUrl: flow.approveUrl,
          pollUrl,
          claim,
          approvalFlow: flow.approvalFlow,
          errorCode: 'claim_poll_failed',
          error: `Claim poll failed (${pollRes.status})`,
          claimAction,
          retryAction,
          instructions,
          ...(pendingAuth.policyHash ? { policyHash: pendingAuth.policyHash } : {}),
          ...(pendingAuth.compilerVersion ? { compilerVersion: pendingAuth.compilerVersion } : {}),
          note: 'Claim polling returned a non-success response. Retry claim; if this persists, create a new auth request.',
        });
      }
    } catch (error) {
      return withEscalationContractVersion({
        success: false,
        hasToken: false,
        status: pendingAuth.status,
        reqId: pendingAuth.requestId,
        agentId: pendingAuth.agentId,
        requiresHumanApproval: true,
        approvalScope: 'session_token' as ApprovalScope,
        claimStatus: 'pending' as ClaimStatus,
        retryReady: false,
        approveUrl: flow.approveUrl,
        pollUrl,
        claim,
        approvalFlow: flow.approvalFlow,
        errorCode: 'claim_network_error',
        error: `Claim polling failed: ${error}`,
        claimAction,
        retryAction,
        instructions,
        ...(pendingAuth.policyHash ? { policyHash: pendingAuth.policyHash } : {}),
        ...(pendingAuth.compilerVersion ? { compilerVersion: pendingAuth.compilerVersion } : {}),
        note: 'Claim polling failed due to a transport error. Retry claim; if this persists, create a new auth request.',
      });
    }
  }

  const claimStatus: ClaimStatus = pendingAuth.status === 'polling'
    ? 'pending'
    : pendingAuth.status === 'approved'
      ? 'approved'
      : pendingAuth.status === 'expired'
        ? 'expired'
      : pendingAuth.status === 'rejected'
        ? 'rejected'
        : 'expired';

  return withEscalationContractVersion({
    hasToken: pendingAuth.status === 'approved' && !!token,
    status: pendingAuth.status,
    reqId: pendingAuth.requestId,
    agentId: pendingAuth.agentId,
    requiresHumanApproval: pendingAuth.status !== 'approved',
    approvalScope: 'session_token' as ApprovalScope,
    claimStatus,
    retryReady: claimStatus === 'approved',
    approveUrl: flow.approveUrl,
    pollUrl,
    claim,
    approvalFlow: flow.approvalFlow,
    claimAction,
    retryAction,
    instructions,
    ...(pendingAuth.policyHash ? { policyHash: pendingAuth.policyHash } : {}),
    ...(pendingAuth.compilerVersion ? { compilerVersion: pendingAuth.compilerVersion } : {}),
    ...(pendingAuth.status === 'polling' && { note: 'Pending approval. Approve in dashboard, then call get_token again to claim.' }),
    ...(pendingAuth.status === 'rejected' && { note: 'Auth request was rejected. Call `auth` to create a new request.' }),
    ...(pendingAuth.status === 'expired' && { note: 'Auth request claim expired or was already consumed. Call `auth` to create a new request.' }),
    ...(pendingAuth.status === 'timeout' && { note: 'Auth request timed out. Call `auth` to create a new request.' }),
    ...(token && pendingAuth.status === 'approved' && { note: 'Token is active for this MCP session.' }),
  });
}

function applyClaimResponseToPendingAuth(
  response: { status?: string; encryptedToken?: string; ttl?: number },
  reqId?: string,
): boolean {
  if (!reqId || !pendingAuth || pendingAuth.requestId !== reqId) {
    return false;
  }

  if (response.status === 'rejected') {
    pendingAuth.status = 'rejected';
    return false;
  }

  if (response.status !== 'approved' || !response.encryptedToken) {
    return false;
  }

  try {
    token = decryptWithPrivateKey(response.encryptedToken, ephemeralPrivPem);
    tokenTtl = response.ttl || SESSION_TOKEN_TTL_SECONDS;
    scheduleRefresh();
    pendingAuth.status = 'approved';
    console.error(`[mcp] Auth approved — token activated for ${pendingAuth.agentId}`);
    return true;
  } catch {
    pendingAuth.status = 'rejected';
    return false;
  }
}

// ── get_secret ─────────────────────────────────────────────────────────
server.tool(
  'get_secret',
  'Look up a stored credential/secret by name or tag, inject its primary value (or explicit field) into a default env var, and return redacted metadata unless dangerPlaintext is explicitly enabled.',
  {
    name: z.string().describe('Name or tag to search for (e.g. "GitHub", "openai", "deploy")'),
    field: z.string().optional().describe('Optional explicit field key to read (e.g. "password", "cvv"). When omitted, reads the credential primary field.'),
    command: z.array(z.string()).optional().describe('Optional command + args to spawn with injected env var (e.g. ["node", "script.js"]). If omitted, sets env var in MCP server process and returns WHATDO guidance.'),
    dangerPlaintext: z.boolean().optional().describe('If true, include plaintext secret in output (unsafe). Defaults to false (masked).'),
    reqId: z.string().optional().describe('Optional approval request id for one-shot claim retry binding'),
  },
  async (input) => {
    const {
      name,
      field,
      command,
      dangerPlaintext,
      reqId,
    } = input as { name: string; field?: string; command?: string[]; dangerPlaintext?: boolean; reqId?: string };
    const revealPlaintext = dangerPlaintext === true;
    const requestedField = String(field || '').trim();

    if (isGetSecretRateLimited()) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Rate limited — too many get_secret requests. Try again in 1 minute.' }) }] };
    }
    const authContext = resolveReadAuthContext(reqId);
    if (!authContext.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify(authContext.payload) }] };
    }

    const authToken = authContext.bearer;
    const credentialIdFromBinding = authContext.mode === 'one_shot' ? authContext.binding?.credentialId : undefined;
    const credentialNameFromBinding = authContext.mode === 'one_shot' ? authContext.binding?.credentialName : undefined;

    const resolved = credentialIdFromBinding
      ? { credentialId: credentialIdFromBinding, credentialName: credentialNameFromBinding || name, credentialType: undefined }
      : await resolveCredentialByName(name, authToken);
    if ('error' in resolved) {
      if ('escalation' in resolved && resolved.escalation) return resolved.escalation;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: resolved.error }) }] };
    }

    const { credentialId, credentialName } = resolved;
    const requestedFields = requestedField
      ? [requestedField]
      : resolved.credentialType
        ? [getCredentialPrimaryFieldKey(resolved.credentialType)]
        : [];
    const readPayload = requestedFields.length > 0
      ? { requestedFields }
      : {};
    const readBody = requestedFields.length > 0
      ? JSON.stringify(readPayload)
      : undefined;
    if (authContext.mode === 'one_shot' && authContext.reqId && authContext.binding) {
      const bindingError = validateOneShotCredentialReadBinding({
        reqId: authContext.reqId,
        binding: authContext.binding,
        credentialId,
      });
      if (bindingError) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(bindingError) }] };
      }
    }
    const base = WALLET_BASE();

    // Step 3: Read credential (encrypted to our ephemeral key)
    try {
      const res = await fetch(`${base}/credentials/${credentialId}/read`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          ...(readBody ? { 'Content-Type': 'application/json' } : {}),
          'X-Secret-Surface': 'get_secret',
          'X-Credential-Name': credentialName || name,
          'X-Aura-Original-Command': `mcp get_secret ${JSON.stringify(name)}`,
        },
        ...(readBody ? { body: readBody } : {}),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status === 403) {
          return await buildPermissionEscalationResponse({
            operation: `Read secret "${credentialName || name}"`,
            status: res.status,
            rawBody: text,
            permissions: ['secret:read'],
            endpoint: `/credentials/${credentialId}/read`,
            method: 'POST',
            body: readPayload,
          });
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Read failed (${res.status}): ${text}` }) }] };
      }

      const data = await res.json() as { encrypted: string };
      const decrypted = decryptCredentialPayload(data.encrypted);

      // If credential has a TOTP field, generate current code
      const totpField = decrypted.fields?.find((f: { key: string }) => f.key === 'totp' || f.key === 'otp');
      let totpCode: string | undefined;
      let totpRemaining: number | undefined;
      if (totpField) {
        try {
          const totpRes = await fetch(`${base}/credentials/${credentialId}/totp`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${authToken}`,
              'X-Aura-Original-Command': `mcp get_secret ${JSON.stringify(name)}`,
            },
            signal: AbortSignal.timeout(5000),
          });
          if (totpRes.ok) {
            const totpData = await totpRes.json() as { code: string; remaining: number };
            totpCode = totpData.code;
            totpRemaining = totpData.remaining;
          }
        } catch {
          // TOTP generation failed — skip, still return credential
        }
      }

      let secretValue = '';
      if (requestedField) {
        const requestedValue = findCredentialFieldValue(decrypted.type || resolved.credentialType, decrypted.fields, requestedField);
        if (requestedValue === undefined) {
          const availableFields = decrypted.fields.map((entry) => entry.key).join(', ');
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Field "${requestedField}" not found on credential "${credentialName || name}"`, availableFields }) }] };
        }
        secretValue = requestedValue;
      } else {
        secretValue = extractPrimarySecretValue(decrypted.fields);
        if (!secretValue) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Credential "${credentialName || name}" has no extractable secret value` }) }] };
        }
      }

      const resolvedEnvVar = defaultSecretEnvVarName(credentialName || name);
      process.env[resolvedEnvVar] = secretValue;

      if (command && command.length > 0) {
        return await runSecretCommand({
          command,
          envVar: resolvedEnvVar,
          secretValue,
          name: credentialName || name,
          credentialId: decrypted.id,
          dangerPlaintext: revealPlaintext,
        });
      }

      return buildStoredSecretResponse({
        name: credentialName || name,
        credentialId: decrypted.id,
        envVar: resolvedEnvVar,
        secretValue,
        dangerPlaintext: revealPlaintext,
        ...(totpCode && { totpCode, totpRemaining }),
      });
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Decryption failed: ${err}` }) }] };
    } finally {
      if (authContext.ok && authContext.mode === 'one_shot' && authContext.reqId) {
        consumeOneShotToken(authContext.reqId);
      }
    }
  },
);

// ── put_secret ─────────────────────────────────────────────────────────
server.tool(
  'put_secret',
  'Store a new credential/secret with the given name and value. Creates a "note" type credential in the default agent with a single sensitive field.',
  {
    name: z.string().describe('Name for the credential (e.g. "OpenAI API Key", "GitHub Token")'),
    value: z.string().describe('The secret value to store'),
    agent: z.string().optional().describe('Agent ID to store in (defaults to "primary")'),
    tags: z.array(z.string()).optional().describe('Optional tags for organization'),
  },
  async (input) => {
    const { name, value, agent, tags } = input as { name: string; value: string; agent?: string; tags?: string[] };

    if (!token) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No auth token — start AuraMaxx server for auto-bootstrap, or set AURA_TOKEN env var' }) }] };
    }

    const base = WALLET_BASE();
    const agentId = await resolveDefaultAgentId(agent);

    try {
      const noteFieldSpec = getCredentialFieldSpec('note', NOTE_CONTENT_KEY);
      // Check if a credential with this name already exists (upsert)
      const existing = await resolveCredentialByName(name);
      if ('credentialId' in existing) {
        // Update existing credential via PUT
        const updateBody: Record<string, unknown> = {
          sensitiveFields: [{ key: NOTE_CONTENT_KEY, value, sensitive: noteFieldSpec?.sensitive ?? false }],
        };
        if (tags) {
          updateBody.meta = { tags };
        }
        const res = await fetch(`${base}/credentials/${encodeURIComponent(existing.credentialId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(updateBody),
          signal: AbortSignal.timeout(5000),
        });

        const text = await res.text();
        if (!res.ok) {
          if (res.status === 403) {
            return await buildPermissionEscalationResponse({
              operation: `Update secret "${name}"`,
              status: res.status,
              rawBody: text,
              permissions: ['secret:write'],
              endpoint: `/credentials/${existing.credentialId}`,
              method: 'PUT',
              body: updateBody,
            });
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Update failed (${res.status}): ${text}` }) }] };
        }

        const data = JSON.parse(text) as { credential: { id: string; name: string } };
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              action: 'updated',
              credentialId: data.credential.id,
              name: data.credential.name,
              message: `Secret "${name}" updated successfully`,
            }),
          }],
        };
      }

      // No existing credential found — create new one via POST
      const createBody = {
        agentId,
        type: 'note',
        name,
        meta: tags ? { tags } : {},
        fields: [{ key: NOTE_CONTENT_KEY, value, type: noteFieldSpec?.type ?? 'text', sensitive: noteFieldSpec?.sensitive ?? false }],
      };

      const res = await fetch(`${base}/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(createBody),
        signal: AbortSignal.timeout(5000),
      });

      const text = await res.text();
      if (!res.ok) {
        if (res.status === 403) {
          return await buildPermissionEscalationResponse({
            operation: `Store secret "${name}"`,
            status: res.status,
            rawBody: text,
            permissions: ['secret:write'],
            endpoint: '/credentials',
            method: 'POST',
            body: createBody,
          });
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Store failed (${res.status}): ${text}` }) }] };
      }

      const data = JSON.parse(text) as { credential: { id: string; name: string } };
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            action: 'created',
            credentialId: data.credential.id,
            name: data.credential.name,
            message: `Secret "${name}" stored successfully`,
          }),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Store failed: ${err}` }) }] };
    }
  },
);

// ── write_diary ────────────────────────────────────────────────────────
server.tool(
  'write_diary',
  'Append an entry to a daily diary note (YYYY-MM-DD_LOGS). Uses the primary agent by default.',
  {
    entry: z.string().min(1).describe('Diary text to append'),
    date: z.string().optional().describe('Optional date in YYYY-MM-DD (defaults to today UTC)'),
  },
  async (input) => {
    const { entry, date } = input as { entry: string; date?: string };

    if (!token) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No auth token — start AuraMaxx server for auto-bootstrap, or set AURA_TOKEN env var' }) }] };
    }
    if (!entry.trim()) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'entry must not be empty' }) }] };
    }

    const resolvedDate = resolveDiaryDate(date);
    if (!resolvedDate) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'date must be YYYY-MM-DD' }) }] };
    }

    const base = WALLET_BASE();
    const agentId = await resolveDiaryAgentId();
    const diaryName = getDiaryCredentialName(resolvedDate);
    const legacyDiaryName = getLegacyDiaryCredentialName(resolvedDate);
    const entryBlock = formatDiaryEntry(entry);

    try {
      const listRes = await fetch(
        `${base}/credentials?agent=${encodeURIComponent(agentId)}&q=${encodeURIComponent(resolvedDate)}`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        },
      );

      if (!listRes.ok) {
        const text = await listRes.text();
        if (listRes.status === 403) {
          return await buildPermissionEscalationResponse({
            operation: `Read diary "${diaryName}"`,
            status: listRes.status,
            rawBody: text,
            permissions: ['secret:read'],
            endpoint: `/credentials?agent=${encodeURIComponent(agentId)}&q=${encodeURIComponent(resolvedDate)}`,
            method: 'GET',
          });
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Diary lookup failed (${listRes.status}): ${text}` }) }] };
      }

      const listed = await listRes.json() as {
        credentials?: Array<{ id: string; name: string; agentId: string; meta?: Record<string, unknown> }>;
      };
      const existing = (listed.credentials || []).find((c) => c.name === diaryName)
        || (listed.credentials || []).find((c) => c.name === legacyDiaryName);

      if (!existing) {
        const plainNoteSpec = getCredentialFieldSpec('plain_note', NOTE_CONTENT_KEY);
        const createBody = {
          agentId,
          type: 'plain_note',
          name: diaryName,
          meta: {
            tags: ['diary', 'heartbeat'],
            [DIARY_ENTRY_COUNT_KEY]: 1,
            [NOTE_CONTENT_KEY]: entryBlock,
          },
          fields: [{ key: NOTE_CONTENT_KEY, value: entryBlock, type: plainNoteSpec?.type ?? 'text', sensitive: plainNoteSpec?.sensitive ?? false }],
        };

        const createRes = await fetch(`${base}/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(createBody),
          signal: AbortSignal.timeout(5000),
        });

        const createText = await createRes.text();
        if (!createRes.ok) {
          if (createRes.status === 403) {
            return await buildPermissionEscalationResponse({
              operation: `Create diary "${diaryName}"`,
              status: createRes.status,
              rawBody: createText,
              permissions: ['secret:write'],
              endpoint: '/credentials',
              method: 'POST',
              body: createBody,
            });
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Diary create failed (${createRes.status}): ${createText}` }) }] };
        }

        const created = JSON.parse(createText) as { credential: { id: string } };
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              date: resolvedDate,
              entryCount: 1,
              credentialId: created.credential.id,
              agentId,
            }),
          }],
        };
      }

      const readRes = await fetch(`${base}/credentials/${existing.id}/read`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!readRes.ok) {
        const text = await readRes.text();
        if (readRes.status === 403) {
          return await buildPermissionEscalationResponse({
            operation: `Read diary "${existing.name}"`,
            status: readRes.status,
            rawBody: text,
            permissions: ['secret:read', 'secret:write'],
            endpoint: `/credentials/${existing.id}/read`,
            method: 'POST',
            body: {},
          });
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Diary read failed (${readRes.status}): ${text}` }) }] };
      }

      const readData = await readRes.json() as {
        encrypted?: string;
        fields?: Array<{ key: string; value: string; type?: string; sensitive?: boolean }>;
      };
      const decrypted = readData.encrypted
        ? decryptCredentialPayload(readData.encrypted)
        : {
            id: existing.id,
            agentId: existing.agentId,
            type: 'plain_note',
            fields: readData.fields || [],
          };
      const previousText = getCredentialFieldValue('plain_note', decrypted.fields, NOTE_CONTENT_KEY)
        || decrypted.fields[0]?.value
        || '';
      const nextText = appendDiaryEntry(previousText, entryBlock);
      const existingMeta = existing.meta && typeof existing.meta === 'object' && !Array.isArray(existing.meta)
        ? existing.meta
        : {};
      const previousEntryCount = resolveDiaryEntryCount(existingMeta, previousText);
      const nextEntryCount = previousEntryCount + 1;
      const existingTags = Array.isArray(existingMeta.tags)
        ? existingMeta.tags.filter((tag): tag is string => typeof tag === 'string')
        : [];
      const nextTags = [...new Set([...existingTags, 'diary', 'heartbeat'])];
      const updateBody = {
        name: diaryName,
        meta: {
          ...existingMeta,
          [NOTE_CONTENT_KEY]: nextText,
          [DIARY_ENTRY_COUNT_KEY]: nextEntryCount,
          tags: nextTags,
        },
        sensitiveFields: [],
      };

      const updateRes = await fetch(`${base}/credentials/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(updateBody),
        signal: AbortSignal.timeout(5000),
      });

      const updateText = await updateRes.text();
      if (!updateRes.ok) {
        if (updateRes.status === 403) {
          return await buildPermissionEscalationResponse({
            operation: `Update diary "${diaryName}"`,
            status: updateRes.status,
            rawBody: updateText,
            permissions: ['secret:read', 'secret:write'],
            endpoint: `/credentials/${existing.id}`,
            method: 'PUT',
            body: updateBody,
          });
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Diary update failed (${updateRes.status}): ${updateText}` }) }] };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            date: resolvedDate,
            name: diaryName,
            entryCount: nextEntryCount,
            credentialId: existing.id,
            agentId: existing.agentId || agentId,
          }),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `write_diary failed: ${err}` }) }] };
    }
  },
);

// ── del_secret ─────────────────────────────────────────────────────────
server.tool(
  'del_secret',
  'Delete a stored credential/secret by name. Searches for the credential then deletes it from the active agent.',
  {
    name: z.string().describe('Name or tag of the credential to delete'),
    location: z.enum(['active', 'archive', 'recently_deleted']).optional().describe('Credential location (default: active)'),
  },
  async (input) => {
    const { name, location } = input as { name: string; location?: string };

    if (!token) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No auth token — start AuraMaxx server for auto-bootstrap, or set AURA_TOKEN env var' }) }] };
    }

    const resolved = await resolveCredentialByName(name);
    if ('error' in resolved) {
      if ('escalation' in resolved && resolved.escalation) return resolved.escalation;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: resolved.error }) }] };
    }

    const base = WALLET_BASE();
    const loc = location || 'active';
    const qs = new URLSearchParams({ location: loc }).toString();

    try {
      const res = await fetch(`${base}/credentials/${encodeURIComponent(resolved.credentialId)}?${qs}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });

      const text = await res.text();
      if (!res.ok) {
        if (res.status === 403) {
          return await buildPermissionEscalationResponse({
            operation: `Delete secret "${resolved.credentialName}"`,
            status: res.status,
            rawBody: text,
            permissions: ['secret:write'],
            endpoint: `/credentials/${resolved.credentialId}`,
            method: 'DELETE',
          });
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Delete failed (${res.status}): ${text}` }) }] };
      }

      let data: Record<string, unknown> = {};
      try { data = JSON.parse(text); } catch { /* plain text */ }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            name: resolved.credentialName,
            credentialId: resolved.credentialId,
            action: data.action || 'deleted',
          }),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `del_secret failed: ${err}` }) }] };
    }
  },
);

// ── inject_secret ──────────────────────────────────────────────────────
server.tool(
  'inject_secret',
  'Look up a credential by name, extract its primary secret field (or explicit field), and inject it into env for MCP process or a child command. Output is redacted unless dangerPlaintext is enabled.',
  {
    name: z.string().describe('Name or tag of the credential to inject'),
    field: z.string().optional().describe('Optional explicit field key to inject instead of the credential primary field.'),
    envVar: z.string().optional().describe('Optional environment variable name (defaults to AURA_{SECRETNAME}, e.g. "AURA_OPENAI_API_KEY")'),
    command: z.array(z.string()).optional().describe('Optional command + args to spawn with injected env var (e.g. ["node", "script.js"]). If omitted, sets env var in MCP server process and returns WHATDO guidance.'),
    dangerPlaintext: z.boolean().optional().describe('If true, include plaintext secret in output (unsafe). Defaults to false (masked).'),
    reqId: z.string().optional().describe('Optional approval request id for one-shot claim retry binding'),
  },
  async (input) => {
    const {
      name,
      field,
      envVar,
      command,
      dangerPlaintext,
      reqId,
    } = input as { name: string; field?: string; envVar?: string; command?: string[]; dangerPlaintext?: boolean; reqId?: string };
    const revealPlaintext = dangerPlaintext === true;
    const requestedField = String(field || '').trim();
    const resolvedEnvVar = normalizeEnvVarName(envVar || defaultSecretEnvVarName(name));
    if (!resolvedEnvVar) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Invalid envVar. Expected shell env var format like AURA_SECRET or GITHUB_PAT.' }) }] };
    }

    if (isGetSecretRateLimited()) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Rate limited — too many secret requests. Try again in 1 minute.' }) }] };
    }

    const authContext = resolveReadAuthContext(reqId);
    if (!authContext.ok) {
      return { content: [{ type: 'text' as const, text: JSON.stringify(authContext.payload) }] };
    }
    const authToken = authContext.bearer;
    const credentialIdFromBinding = authContext.mode === 'one_shot' ? authContext.binding?.credentialId : undefined;
    const credentialNameFromBinding = authContext.mode === 'one_shot' ? authContext.binding?.credentialName : undefined;

    const resolved = credentialIdFromBinding
      ? { credentialId: credentialIdFromBinding, credentialName: credentialNameFromBinding || name, credentialType: undefined }
      : await resolveCredentialByName(name, authToken);
    if ('error' in resolved) {
      if ('escalation' in resolved && resolved.escalation) return resolved.escalation;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: resolved.error }) }] };
    }

    const base = WALLET_BASE();
    const requestedFields = requestedField
      ? [requestedField]
      : resolved.credentialType
        ? [getCredentialPrimaryFieldKey(resolved.credentialType)]
        : [];
    const readPayload = requestedFields.length > 0
      ? { requestedFields }
      : {};
    const readBody = requestedFields.length > 0
      ? JSON.stringify(readPayload)
      : undefined;
    if (authContext.mode === 'one_shot' && authContext.reqId && authContext.binding) {
      const bindingError = validateOneShotCredentialReadBinding({
        reqId: authContext.reqId,
        binding: authContext.binding,
        credentialId: resolved.credentialId,
      });
      if (bindingError) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(bindingError) }] };
      }
    }

    // Read + decrypt credential
    let secretValue: string;
    try {
      const res = await fetch(`${base}/credentials/${resolved.credentialId}/read`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          ...(readBody ? { 'Content-Type': 'application/json' } : {}),
          'X-Secret-Surface': 'inject_secret',
          'X-Secret-EnvVar': resolvedEnvVar,
          'X-Credential-Name': resolved.credentialName || name,
          'X-Aura-Original-Command': `mcp inject_secret ${JSON.stringify(name)}`,
        },
        ...(readBody ? { body: readBody } : {}),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status === 403) {
          return await buildPermissionEscalationResponse({
            operation: `Read secret "${resolved.credentialName}" for injection`,
            status: res.status,
            rawBody: text,
            permissions: ['secret:read'],
            endpoint: `/credentials/${resolved.credentialId}/read`,
            method: 'POST',
            body: readPayload,
          });
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Read failed (${res.status}): ${text}` }) }] };
      }

      const data = await res.json() as { encrypted: string };
      const decrypted = decryptCredentialPayload(data.encrypted);

      if (requestedField) {
        const requestedValue = findCredentialFieldValue(decrypted.type || resolved.credentialType, decrypted.fields, requestedField);
        if (requestedValue === undefined) {
          const availableFields = decrypted.fields.map((entry) => entry.key).join(', ');
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Field "${requestedField}" not found on credential "${resolved.credentialName || name}"`, availableFields }) }] };
        }
        secretValue = requestedValue;
      } else {
        secretValue = extractPrimarySecretValue(decrypted.fields);
        if (!secretValue) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Credential "${name}" has no extractable secret value` }) }] };
        }
      }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `inject_secret read failed: ${err}` }) }] };
    } finally {
      if (authContext.ok && authContext.mode === 'one_shot' && authContext.reqId) {
        consumeOneShotToken(authContext.reqId);
      }
    }

    // Set env var or spawn child
    if (!command || command.length === 0) {
      process.env[resolvedEnvVar] = secretValue;
      return buildStoredSecretResponse({
        name: resolved.credentialName || name,
        credentialId: resolved.credentialId,
        envVar: resolvedEnvVar,
        secretValue,
        dangerPlaintext: revealPlaintext,
      });
    }

    return await runSecretCommand({
      command,
      envVar: resolvedEnvVar,
      secretValue,
      name: resolved.credentialName || name,
      credentialId: resolved.credentialId,
      dangerPlaintext: revealPlaintext,
    });
  },
);

// ── share_secret ───────────────────────────────────────────────────────
server.tool(
  'share_secret',
  'Create a shareable link for a credential. Resolves by name, then creates a time-limited share URL with optional password protection.',
  {
    name: z.string().describe('Name or tag of the credential to share'),
    expiresAfter: z.string().optional().describe('Expiry duration (e.g. "1h", "7d", "30m"). Default: server default.'),
    accessMode: z.enum(['anyone', 'password']).optional().describe('Access mode: "anyone" (link only) or "password" (requires password)'),
    password: z.string().optional().describe('Password for password-protected shares'),
    oneTimeOnly: z.boolean().optional().describe('If true, share link can only be viewed once'),
  },
  async (input) => {
    const { name, expiresAfter, accessMode, password, oneTimeOnly } = input as {
      name: string;
      expiresAfter?: string;
      accessMode?: 'anyone' | 'password';
      password?: string;
      oneTimeOnly?: boolean;
    };

    if (!token) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No auth token — start AuraMaxx server for auto-bootstrap, or set AURA_TOKEN env var' }) }] };
    }

    const resolved = await resolveCredentialByName(name);
    if ('error' in resolved) {
      if ('escalation' in resolved && resolved.escalation) return resolved.escalation;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: resolved.error }) }] };
    }

    const base = WALLET_BASE();
    const shareBody: Record<string, unknown> = { credentialId: resolved.credentialId };
    if (expiresAfter) shareBody.expiresAfter = expiresAfter;
    if (accessMode) shareBody.accessMode = accessMode;
    if (password) shareBody.password = password;
    if (oneTimeOnly !== undefined) shareBody.oneTimeOnly = oneTimeOnly;

    try {
      const res = await fetch(`${base}/credential-shares`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(shareBody),
        signal: AbortSignal.timeout(8000),
      });

      const text = await res.text();
      if (!res.ok) {
        if (res.status === 403) {
          return await buildPermissionEscalationResponse({
            operation: `Share secret "${resolved.credentialName}"`,
            status: res.status,
            rawBody: text,
            permissions: ['secret:read', 'secret:share'],
            endpoint: '/credential-shares',
            method: 'POST',
            body: shareBody,
          });
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Share failed (${res.status}): ${text}` }) }] };
      }

      const data = JSON.parse(text) as { success?: boolean; share?: Record<string, unknown>; error?: string };
      if (!data.success || !data.share) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: data.error || 'Share creation returned unexpected response' }) }] };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            name: resolved.credentialName,
            credentialId: resolved.credentialId,
            share: data.share,
          }),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `share_secret failed: ${err}` }) }] };
    }
  },
);

// ── auth ────────────────────────────────────────────────────────────────
server.tool(
  'auth',
  'Request an authenticated session token. Sends an auth request and returns explicit approve/poll URLs. No background polling — caller must claim approval explicitly.',
  {
    agentId: z.string().optional().describe('Agent identifier (default: "mcp-stdio")'),
    profile: z.string().optional().describe('Permission profile name to request'),
    profileVersion: z.string().optional().describe('Profile version'),
    profileOverrides: z.record(z.unknown()).optional().describe('Profile permission overrides'),
    action: z.object({
      endpoint: z.string().describe('API endpoint to call (e.g. "/send")'),
      method: z.string().describe('HTTP method (e.g. "POST")'),
      body: z.record(z.unknown()).optional().describe('Request body for the action'),
    }).optional().describe('Pre-computed action to auto-execute on approval'),
  },
  async (input) => {
    const { agentId, profile, profileVersion, profileOverrides, action } = input as {
      agentId?: string;
      profile?: string;
      profileVersion?: string;
      profileOverrides?: Record<string, unknown>;
      action?: { endpoint: string; method: string; body?: Record<string, unknown> };
    };

    const base = WALLET_BASE();
    const resolvedAgentId = agentId || 'mcp-stdio';
    const resolvedProfile = typeof profile === 'string' && profile.trim() ? profile.trim() : 'dev';

    // Step 1: Create auth request with our ephemeral pubkey
    let requestId: string;
    let secret: string;
    let approveUrl: string | undefined;
    try {
      const authBody: Record<string, unknown> = {
        agentId: resolvedAgentId,
        pubkey: ephemeralPubPem,
        profile: resolvedProfile,
      };
      if (profileVersion) authBody.profileVersion = profileVersion;
      if (profileOverrides) authBody.profileOverrides = profileOverrides;
      if (action) authBody.action = action;

      const res = await fetch(`${base}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authBody),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const text = await res.text();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Auth request failed (${res.status}): ${text}` }) }] };
      }

      const data = await res.json() as { requestId: string; secret: string; approveUrl?: string };
      requestId = data.requestId;
      secret = data.secret;
      if (data.approveUrl) approveUrl = data.approveUrl;
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Auth request failed: ${err}` }) }] };
    }

    const flow = buildAuthApprovalFlow({ requestId, secret, approveUrl });
    pendingAuth = {
      requestId,
      agentId: resolvedAgentId,
      status: 'polling',
      approveUrl: flow.approveUrl,
      secret,
    };

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(withEscalationContractVersion({
          success: true,
          requiresHumanApproval: true,
          approvalScope: 'session_token' as ApprovalScope,
          message: 'Auth request created. Approve, claim token, then retry.',
          reqId: requestId,
          agentId: resolvedAgentId,
          approveUrl: flow.approveUrl,
          pollUrl: flow.pollUrl,
          claim: flow.claim,
          approvalFlow: flow.approvalFlow,
          claimStatus: 'pending',
          retryReady: false,
          claimAction: buildMcpToolAction('get_token', { reqId: requestId }),
          retryAction: buildMcpToolAction('<retry_original_tool>', { reqId: requestId }),
          instructions: [
            `1) Ask human to approve: ${flow.approveUrl}`,
            `2) Claim now: call MCP tool get_token with {"reqId":"${requestId}"}`,
            `3) Retry now: rerun the original MCP tool call and include {"reqId":"${requestId}"}`,
          ],
          note: 'No background auto-poll is performed. Call get_token to explicitly claim status/token.',
        })),
      }],
    };
  },
);

// ── get_token ──────────────────────────────────────────────────────────
server.tool(
  'get_token',
  'Check if the MCP session has an active auth token. After `auth`, this explicitly polls/claims approval status (no background polling).',
  {
    reqId: z.string().optional().describe('Optional approval request id to claim a specific approval flow (one-shot or session)'),
  },
  async (input) => {
    const { reqId } = input as { reqId?: string };
    const normalizedReqId = typeof reqId === 'string' && reqId.trim() ? reqId.trim() : undefined;
    if (normalizedReqId) {
      if (pendingAuth && pendingAuth.requestId === normalizedReqId) {
        const sessionPayload = await claimSessionApproval(normalizedReqId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(withEscalationContractVersion(sessionPayload)),
          }],
        };
      }

      if (pendingScopedApprovals.has(normalizedReqId) || !!getOneShotToken(normalizedReqId)) {
        const scoped = await claimScopedApproval(normalizedReqId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(withEscalationContractVersion(scoped)),
          }],
        };
      }

      const scoped = token
        ? missingOrExpiredClaimPayload(normalizedReqId, 'session_token')
        : await claimScopedApproval(normalizedReqId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(withEscalationContractVersion(scoped)),
        }],
      };
    }

    if (!pendingAuth) {
      if (token) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(withEscalationContractVersion({
              hasToken: true,
              agentId: 'mcp-stdio',
              approvalScope: 'session_token' as ApprovalScope,
              claimStatus: 'approved',
              retryReady: true,
            })),
          }],
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(withEscalationContractVersion({
            hasToken: false,
            approvalScope: 'session_token' as ApprovalScope,
            claimStatus: 'expired',
            retryReady: false,
            note: 'No auth request in progress. Call `auth` to request a token.',
          })),
        }],
      };
    }

    const payload = await claimSessionApproval(pendingAuth.requestId);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(withEscalationContractVersion(payload)),
      }],
    };
  },
);

// ── approve ────────────────────────────────────────────────────────────
server.tool(
  'approve',
  'Admin-only shortcut to approve a pending human action by id.',
  {
    actionId: z.string().describe('Pending human action id to approve (e.g. "act_123")'),
    walletAccess: z.array(z.string()).optional().describe('Optional wallet access override'),
    limits: z.record(z.unknown()).optional().describe('Optional limits override object'),
  },
  async (input) => {
    const { actionId, walletAccess, limits } = input as {
      actionId: string;
      walletAccess?: string[];
      limits?: Record<string, unknown>;
    };

    if (!token) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No auth token — run auth first or set AURA_TOKEN' }) }] };
    }

    const base = WALLET_BASE();
    const body = {
      ...(Array.isArray(walletAccess) && walletAccess.length > 0 ? { walletAccess } : {}),
      ...(limits && typeof limits === 'object' && !Array.isArray(limits) ? { limits } : {}),
    };

    try {
      const res = await fetch(`${base}/actions/${encodeURIComponent(actionId)}/approve`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });

      const text = await res.text();
      if (!res.ok) {
        if (res.status === 403) {
          return await buildPermissionEscalationResponse({
            operation: `Approve action "${actionId}"`,
            status: res.status,
            rawBody: text,
            permissions: ['admin:*'],
            endpoint: `/actions/${encodeURIComponent(actionId)}/approve`,
            method: 'POST',
            body,
          });
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Approve failed (${res.status}): ${extractErrorMessage(text)}` }) }] };
      }

      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(parsed) }] };
      } catch {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              actionId,
              message: text || `Approved ${actionId}.`,
            }),
          }],
        };
      }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Approve failed: ${err}` }) }] };
    }
  },
);

// ── start ──────────────────────────────────────────────────────────────

/** If the agent hasn't been set up, launch the dashboard so the human can onboard via browser. */
async function ensureDashboardIfNeeded(base: string): Promise<{ needsSetup: boolean; dashboardUrl: string } | null> {
  try {
    const res = await fetch(`${base}/setup`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const setup = await res.json() as { hasWallet?: boolean };
    if (setup.hasWallet) return null;

    const dashboardUrl = DASHBOARD_BASE();
    try {
      const { startDashboardProcess } = await import('../cli/lib/process');
      startDashboardProcess({ detached: true });
    } catch { /* dashboard start failed — non-fatal */ }
    try {
      const { exec } = await import('child_process');
      exec(`open "${dashboardUrl}"`);
    } catch { /* browser open failed — non-fatal */ }
    return { needsSetup: true, dashboardUrl };
  } catch {
    return null;
  }
}

server.tool(
  'start',
  'Start the AuraMaxx server if not already running. Checks health first, then starts in terminal mode if needed. If the agent is not yet set up, launches the dashboard for human onboarding. Attempts socket bootstrap after start.',
  {},
  async () => {
    const base = WALLET_BASE();

    const { acquireStartLock } = await import('../cli/lib/process');
    const releaseStartLock = await acquireStartLock({ waitMs: 30_000 });
    if (!releaseStartLock) {
      try {
        const res = await fetch(`${base}/setup`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          if (!token) {
            const ok = await bootstrapViaSocket();
            if (ok) scheduleRefresh();
          }
          const setup = await ensureDashboardIfNeeded(base);
          if (setup) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  message: `Agent not set up yet. Dashboard opened at ${setup.dashboardUrl} — ask the human to complete setup there.`,
                  needsSetup: true,
                  hasToken: false,
                  url: base,
                  dashboardUrl: setup.dashboardUrl,
                }),
              }],
            };
          }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: 'Server is already running',
                hasToken: !!token,
                url: base,
              }),
            }],
          };
        }
      } catch {
        // Server not reachable; another startup likely still in progress.
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Another server start is already in progress. Retry in a few seconds.',
          }),
        }],
      };
    }

    try {
      // Step 1: Check if server is already running
      try {
        const res = await fetch(`${base}/setup`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          // Already running — try socket bootstrap if no token
          if (!token) {
            const ok = await bootstrapViaSocket();
            if (ok) scheduleRefresh();
          }
          const setup = await ensureDashboardIfNeeded(base);
          if (setup) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  message: `Agent not set up yet. Dashboard opened at ${setup.dashboardUrl} — ask the human to complete setup there.`,
                  needsSetup: true,
                  hasToken: false,
                  url: base,
                  dashboardUrl: setup.dashboardUrl,
                }),
              }],
            };
          }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: 'Server is already running',
                hasToken: !!token,
                url: base,
              }),
            }],
          };
        }
      } catch {
        // Server not reachable — proceed to start
      }

      // Step 2: Import and call startServer
      try {
        const { startServer } = await import('../cli/lib/process');
        startServer({ headless: false });
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to start server: ${err}` }) }] };
      }

      // Step 3: Wait for server to become reachable (up to 15s)
      const startedAt = Date.now();
      const maxWaitMs = 15_000;
      let serverReady = false;

      while (Date.now() - startedAt < maxWaitMs) {
        try {
          const res = await fetch(`${base}/setup`, {
            signal: AbortSignal.timeout(2000),
          });
          if (res.ok) {
            serverReady = true;
            break;
          }
        } catch {
          // Not ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (!serverReady) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Server started but did not become reachable within 15 seconds' }) }] };
      }

      // Step 4: Attempt socket bootstrap
      if (!token) {
        const ok = await bootstrapViaSocket();
        if (ok) scheduleRefresh();
      }

      // Step 5: If agent is not set up yet, launch dashboard for human onboarding
      const setup = await ensureDashboardIfNeeded(base);
      if (setup) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Agent not set up yet. Dashboard opened at ${setup.dashboardUrl} — ask the human to complete setup there.`,
              needsSetup: true,
              hasToken: false,
              url: base,
              dashboardUrl: setup.dashboardUrl,
            }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: 'Server started in terminal mode (API only)',
            hasToken: !!token,
            url: base,
          }),
        }],
      };
    } finally {
      releaseStartLock();
    }
  },
);

// ── unlock ─────────────────────────────────────────────────────────────
server.tool(
  'unlock',
  'Unlock the agent with the provided password. Encrypts the password client-side using the server\'s RSA public key, then sends the encrypted payload. On success, activates an admin token for this MCP session. Optionally specify a agentId to unlock a specific agent.',
  {
    password: z.string().describe('The agent password (plaintext — encrypted before transmission)'),
    agentId: z.string().optional().describe('Optional agent ID to unlock a specific agent (default: primary)'),
  },
  async (input) => {
    const { password, agentId } = input as { password: string; agentId?: string };

    if (!password.trim()) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'password is required' }) }] };
    }

    const base = WALLET_BASE();

    // Step 1: Fetch server's RSA public key
    let serverPubKey: string;
    try {
      const res = await fetch(`${base}/auth/connect`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to fetch server public key (${res.status})` }) }] };
      }
      const data = await res.json() as { publicKey: string };
      serverPubKey = data.publicKey;
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Server not reachable: ${err}` }) }] };
    }

    // Step 2: Encrypt password with server's RSA public key
    let encrypted: string;
    try {
      const { publicEncrypt, constants: cryptoConstants } = await import('crypto');
      encrypted = publicEncrypt(
        { key: serverPubKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(password),
      ).toString('base64');
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Encryption failed: ${err}` }) }] };
    }

    // Step 3: POST /unlock with encrypted password + our ephemeral pubkey
    const endpoint = agentId ? `/unlock/${encodeURIComponent(agentId)}` : '/unlock';
    try {
      const res = await fetch(`${base}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted, pubkey: ephemeralPubPem }),
        signal: AbortSignal.timeout(10_000),
      });

      const text = await res.text();
      if (!res.ok) {
        let errorMsg: string;
        try { errorMsg = (JSON.parse(text) as { error?: string }).error || text; } catch { errorMsg = text; }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unlock failed (${res.status}): ${errorMsg}` }) }] };
      }

      const data = JSON.parse(text) as { success: boolean; token?: string; address?: string; message?: string };

      // Activate the returned admin token for this MCP session
      if (data.token) {
        token = data.token;
        scheduleRefresh();
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: data.message || 'Agent unlocked',
            address: data.address,
            hasToken: !!token,
            ...(agentId ? { agentId } : {}),
          }),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unlock request failed: ${err}` }) }] };
    }
  },
);

// ── doctor ─────────────────────────────────────────────────────────────
server.tool(
  'doctor',
  'Run onboarding and runtime diagnostics (CLI equivalent: `auramaxx doctor --json`). Returns structured check results with pass/warn/fail status, findings, evidence, and remediation steps.',
  {
    strict: z.boolean().optional().describe('If true, treats warnings as failures (default: false)'),
    fix: z.boolean().optional().describe('If true, attempts auto-fixes like shell fallback installation (default: false)'),
  },
  async (input) => {
    const { strict, fix } = input as { strict?: boolean; fix?: boolean };

    try {
      const { runDoctor } = await import('../cli/commands/doctor');
      const result = await runDoctor({ json: true, strict: !!strict, fix: !!fix });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Doctor failed: ${err}` }) }] };
    }
  },
);

// ── Register shared tools ──────────────────────────────────────────────

for (const tool of TOOLS) {
  const shape = jsonSchemaToZod(tool.parameters.properties, tool.parameters.required || []);

  server.tool(
    tool.name,
    tool.description,
    shape,
    async (input) => {
      const result = await executeTool(tool.name, input as Record<string, unknown>, token);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  // Bootstrap auth: try socket first, then env var
  if (!token) {
    const ok = await bootstrapViaSocket();
    if (ok) {
      authSource = 'socket';
      scheduleRefresh();
      console.error('[mcp] Auth: socket bootstrap');
    } else if (process.env.AURA_TOKEN) {
      token = process.env.AURA_TOKEN;
      authSource = 'env';
      console.error('[mcp] Auth: AURA_TOKEN env var');
    } else {
      authSource = 'none';
      console.error('[mcp] Auth: none (tools will return auth errors until server is running)');
    }
  } else {
    authSource = 'env';
    // Have AURA_TOKEN from env — still try socket for encrypted upgrade
    console.error('[mcp] Auth: AURA_TOKEN env var (pre-configured)');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});
