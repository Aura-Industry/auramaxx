/**
 * Local IPC Socket Server
 *
 * Provides secure local IPC for agent connections with:
 * - Unix socket path on macOS/Linux or named pipe on Windows
 * - 0600 permissions on Unix socket paths
 * - Auto-approve for same-UID processes (socket permission = peer credential)
 * - Encrypted token delivery (server-issued RSA-OAEP/AES-256-GCM envelope)
 *
 * Protocol (JSON over newline-delimited messages):
 *
 * Agent -> CLI:
 *   { "type": "auth", "agentId": "my-agent", "pubkey": "...", "autoApprove": true }
 *   { "type": "auth", "agentId": "my-agent", "pubkey": "...", "limit": 0.1, "permissions": [...] }
 *   { "type": "ping" }
 *
 * CLI -> Agent:
 *   { "type": "auth_pending", "requestId": "..." }
 *   { "type": "auth_approved", "encryptedToken": "...", "agentId": "...", ... }
 *   { "type": "auth_rejected", "requestId": "..." }
 *   { "type": "pong" }
 *   { "type": "error", "message": "..." }
 */

import * as net from 'net';
import * as fs from 'fs';
import { getDefaultSync } from '../lib/defaults';
import { getErrorMessage } from '../lib/error';
import { isValidAgentPubkey, normalizeAgentPubkey, encryptToAgentPubkey } from '../lib/credential-transport';
import { createToken } from '../lib/auth';
import { isUnlocked } from '../lib/cold';
import { AgentProfileError, resolveProfileToEffectivePolicy } from '../lib/agent-profiles';
import { resolveAuraSocketPath } from '../lib/socket-path';
import { buildApproveUrl } from '../lib/approval-link';
import { buildClaimHeaders, buildPollUrl } from '../lib/approval-flow';

interface SocketServerOptions {
  serverUrl: string;
  getToken?: () => string | null;
}

interface AgentAuthRequest {
  type: 'auth';
  agentId: string;
  autoApprove?: boolean;
  limit?: number;
  permissions?: string[];
  ttl?: number;
  limits?: { fund?: number; send?: number; swap?: number };
  walletAccess?: string[];
  credentialAccess?: { read?: string[]; write?: string[]; excludeFields?: string[]; ttl?: number; maxReads?: number };
  profile?: string;
  profileVersion?: string;
  profileOverrides?: {
    ttlSeconds?: number;
    maxReads?: number;
    readScopes?: string[];
    writeScopes?: string[];
    excludeFields?: string[];
  };
  pubkey?: string;
}

interface PendingAgentAuth {
  socket: net.Socket;
  requestId: string;
  secret: string;
  agentId: string;
  pubkey?: string;
}

// Rate limiting for auto-approve: track tokens per socket
const autoApproveRates = new WeakMap<net.Socket, { count: number; resetAt: number }>();
const AUTO_APPROVE_MAX = 10;
const AUTO_APPROVE_WINDOW_MS = 60_000;

function checkAutoApproveRate(socket: net.Socket): boolean {
  const now = Date.now();
  let entry = autoApproveRates.get(socket);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + AUTO_APPROVE_WINDOW_MS };
    autoApproveRates.set(socket, entry);
  }
  if (entry.count >= AUTO_APPROVE_MAX) return false;
  entry.count++;
  return true;
}

export class SocketServer {
  private server: net.Server | null = null;
  private socketPath: string;
  private options: SocketServerOptions;
  private pendingAuths: Map<string, PendingAgentAuth> = new Map();
  private pollIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(options: SocketServerOptions) {
    this.options = options;
    const uid = process.getuid?.() ?? 'unknown';
    this.socketPath = resolveAuraSocketPath({
      uid,
      serverUrl: options.serverUrl,
      serverPort: process.env.WALLET_SERVER_PORT,
    });
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  async start(): Promise<void> {
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        console.error('Socket server error:', err.message);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        if (process.platform !== 'win32') {
          fs.chmodSync(this.socketPath, 0o600);
        }
        console.log(`IPC socket listening at ${this.socketPath}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.pollIntervals.forEach((interval) => {
      clearInterval(interval);
    });
    this.pollIntervals.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
            try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleConnection(socket: net.Socket): void {
    const MAX_BUFFER_SIZE = 64 * 1024; // 64KB
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      if (buffer.length > MAX_BUFFER_SIZE) {
        console.error('[socket] Buffer overflow — disconnecting client');
        this.send(socket, { type: 'error', message: 'Message too large' });
        socket.destroy();
        return;
      }

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.substring(0, newlineIndex);
        buffer = buffer.substring(newlineIndex + 1);

        if (line.trim()) {
          this.handleMessage(socket, line.trim());
        }
      }
    });

    socket.on('error', (err) => {
      console.error(`[socket] Connection error: ${err.message} (code=${(err as NodeJS.ErrnoException).code})`);
    });

    socket.on('close', () => {
      const toDelete: string[] = [];
      this.pendingAuths.forEach((pending, requestId) => {
        if (pending.socket === socket) {
          const interval = this.pollIntervals.get(requestId);
          if (interval) {
            clearInterval(interval);
            this.pollIntervals.delete(requestId);
          }
          toDelete.push(requestId);
        }
      });
      toDelete.forEach(id => this.pendingAuths.delete(id));
    });
  }

  private handleMessage(socket: net.Socket, message: string): void {
    try {
      const msg = JSON.parse(message);

      switch (msg.type) {
        case 'ping':
          this.send(socket, { type: 'pong' });
          break;

        case 'auth':
          this.handleAuthRequest(socket, msg as AgentAuthRequest);
          break;

        default:
          this.send(socket, { type: 'error', message: `Unknown message type: ${msg.type}` });
      }
    } catch {
      this.send(socket, { type: 'error', message: 'Invalid JSON message' });
    }
  }

  /**
   * Handle auth request — auto-approve path or standard approval flow
   */
  private async handleAuthRequest(socket: net.Socket, request: AgentAuthRequest): Promise<void> {
    try {
      if (typeof request.pubkey !== 'string' || !request.pubkey.trim()) {
        this.send(socket, { type: 'error', message: 'pubkey is required for auth requests' });
        return;
      }

      if (!isValidAgentPubkey(request.pubkey)) {
        this.send(socket, { type: 'error', message: 'Invalid RSA public key' });
        return;
      }

      const normalizedPubkey = normalizeAgentPubkey(request.pubkey);

      // ── Auto-approve path ──
      if (request.autoApprove) {
        const autoApproveEnabled = getDefaultSync<boolean>('trust.localAutoApprove', true);
        if (!autoApproveEnabled) {
          this.send(socket, { type: 'error', message: 'Auto-approve is disabled. Use standard approval flow.' });
          return;
        }

        // Rate limit
        if (!checkAutoApproveRate(socket)) {
          this.send(socket, { type: 'error', message: 'Rate limit exceeded for auto-approve (max 10/minute)' });
          return;
        }

        // Resolve local auto-approve policy defaults
        const limits = getDefaultSync<Record<string, number>>('trust.localLimits', { fund: 0, send: 0, swap: 0 });
        const localProfile = String(getDefaultSync<string>('trust.localProfile', 'admin') || '').trim();
        const localProfileVersion = String(getDefaultSync<string>('trust.localProfileVersion', 'v1') || '').trim();
        const localProfileOverrides = getDefaultSync<AgentAuthRequest['profileOverrides'] | null>('trust.localProfileOverrides', null);
        const agentId = request.agentId || 'local-agent';
        if (!localProfile) {
          this.send(socket, { type: 'error', message: 'Local profile is not configured for socket issuance.' });
          return;
        }
        if (localProfile === 'strict') {
          this.send(socket, { type: 'error', message: 'Strict profile requires manual approval (auto-approve disabled).' });
          return;
        }

        const hasTokenProvider = typeof this.options.getToken === 'function';
        const adminToken = hasTokenProvider ? this.options.getToken!() : null;

        // CLI daemon mode: require unlocked admin token callback.
        if (hasTokenProvider && !adminToken) {
          this.send(socket, { type: 'error', message: 'CLI daemon is locked. Unlock before socket auto-approve.' });
          return;
        }

        // When an admin token callback exists, issue via HTTP route.
        if (adminToken) {
          const issueBody: Record<string, unknown> = {
            agentId,
            limits,
            pubkey: normalizedPubkey,
            profile: localProfile,
            profileVersion: localProfileVersion || 'v1',
          };
          if (localProfileOverrides) {
            issueBody.profileOverrides = localProfileOverrides;
          }

          const issueResponse = await fetch(`${this.options.serverUrl}/actions/token`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${adminToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(issueBody),
          });

          let issueData: {
            success?: boolean;
            error?: string;
            code?: string;
            encryptedToken?: string;
            permissions?: string[];
            limits?: { fund?: number; send?: number; swap?: number };
            profile?: { id: string; version: string; displayName?: string; rationale?: string };
            effectivePolicyHash?: string;
            overrideDelta?: string[];
            warnings?: string[];
            expiresIn?: number;
          } = {};
          try {
            issueData = await issueResponse.json();
          } catch {
            issueData = {};
          }
          if (!issueResponse.ok || !issueData.success || !issueData.encryptedToken) {
            const message = issueData.error
              ? (issueData.code ? `${issueData.error} (${issueData.code})` : issueData.error)
              : `Auto-approve token issue failed (${issueResponse.status})`;
            this.send(socket, { type: 'error', message });
            return;
          }

          this.send(socket, {
            type: 'auth_approved',
            encryptedToken: issueData.encryptedToken,
            agentId,
            permissions: issueData.permissions || [],
            limits: issueData.limits || limits,
            ttl: issueData.expiresIn,
            profile: issueData.profile,
            effectivePolicyHash: issueData.effectivePolicyHash,
            overrideDelta: issueData.overrideDelta,
            warnings: issueData.warnings,
          });

          console.log(`[socket][audit] auto-approve issued token agentId=${agentId} ttl=${issueData.expiresIn ?? 0}s profile=${issueData.profile?.id}@${issueData.profile?.version}`);
          return;
        }

        // Server-runtime mode: issue token in-process so settings changes apply immediately.
        if (!isUnlocked()) {
          this.send(socket, { type: 'error', message: 'Wallet is locked. Unlock first.' });
          return;
        }

        const fundLimit = typeof limits.fund === 'number' ? limits.fund : 0;
        const defaultSendLimit = getDefaultSync<number>('limits.send', 0.1);
        const defaultSwapLimit = getDefaultSync<number>('limits.swap', 0.1);

        const resolvedProfile = resolveProfileToEffectivePolicy({
          profileId: localProfile,
          profileVersion: localProfileVersion || 'v1',
          overrides: localProfileOverrides ?? undefined,
        });

        const effectivePermissions = [...resolvedProfile.permissions];
        const ttlSeconds = resolvedProfile.ttlSeconds;
        const tokenLimits = {
          fund: fundLimit,
          send: defaultSendLimit,
          swap: defaultSwapLimit,
          ...limits,
        };

        const token = await createToken(agentId, fundLimit, effectivePermissions, ttlSeconds, {
          limits: tokenLimits,
          credentialAccess: resolvedProfile.credentialAccess,
          agentPubkey: normalizedPubkey,
        });
        const encryptedToken = encryptToAgentPubkey(token, normalizedPubkey);

        this.send(socket, {
          type: 'auth_approved',
          encryptedToken,
          agentId,
          permissions: effectivePermissions,
          limits: tokenLimits,
          ttl: ttlSeconds,
          profile: resolvedProfile.profile,
          effectivePolicyHash: resolvedProfile.effectivePolicyHash,
          overrideDelta: resolvedProfile.overrideDelta,
          warnings: resolvedProfile.warnings,
        });

        console.log(`[socket][audit] auto-approve issued token agentId=${agentId} ttl=${ttlSeconds}s profile=${localProfile}@${localProfileVersion} path=in-process`);
        return;
      }

      // ── Standard approval flow (proxy to HTTP) ──
      if (request.permissions !== undefined || request.ttl !== undefined || request.credentialAccess !== undefined) {
        this.send(socket, {
          type: 'error',
          message: 'Raw permission issuance is disabled. Use profile + optional profileOverrides.',
        });
        return;
      }
      const requestProfile = (
        typeof request.profile === 'string' && request.profile.trim().length > 0
          ? request.profile.trim()
          : String(getDefaultSync<string>('trust.localProfile', 'admin') || '').trim()
      );
      const requestProfileVersion = (
        typeof request.profileVersion === 'string' && request.profileVersion.trim().length > 0
          ? request.profileVersion.trim()
          : String(getDefaultSync<string>('trust.localProfileVersion', 'v1') || '').trim()
      );
      if (!requestProfile) {
        this.send(socket, { type: 'error', message: 'profile is required for auth requests' });
        return;
      }

      const response = await fetch(`${this.options.serverUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: request.agentId,
          limit: request.limit ?? getDefaultSync<number>('limits.fund', 0),
          limits: request.limits,
          walletAccess: request.walletAccess,
          profile: requestProfile,
          profileVersion: requestProfileVersion || 'v1',
          profileOverrides: request.profileOverrides,
          pubkey: request.pubkey,
        })
      });

      const data = await response.json() as {
        success?: boolean;
        requestId?: string;
        secret?: string;
        error?: string;
      };

      if (!response.ok || !data.success) {
        this.send(socket, {
          type: 'error',
          message: data.error || 'Failed to create auth request'
        });
        return;
      }

      // Store pending auth info (with pubkey for encrypted delivery)
      const pending: PendingAgentAuth = {
        socket,
        requestId: data.requestId!,
        secret: data.secret!,
        agentId: request.agentId,
        pubkey: normalizedPubkey,
      };
      this.pendingAuths.set(data.requestId!, pending);

      const dashboardBase = `http://localhost:${process.env.DASHBOARD_PORT || '4747'}`;
      this.send(socket, {
        type: 'auth_pending',
        requestId: data.requestId,
        approveUrl: buildApproveUrl(dashboardBase, data.requestId!),
        message: 'Action escalated — waiting for human approval'
      });

      this.startPolling(data.requestId!, data.secret!);

    } catch (error) {
      if (error instanceof AgentProfileError) {
        const suffix = error.code ? ` (${error.code})` : '';
        this.send(socket, { type: 'error', message: `${error.message}${suffix}` });
        return;
      }
      const message = getErrorMessage(error);
      this.send(socket, { type: 'error', message });
    }
  }

  /**
   * Start polling for request approval
   */
  private startPolling(requestId: string, secret: string): void {
    const MAX_POLL_DURATION_MS = 10 * 60 * 1000; // 10 minutes
    const pollStart = Date.now();
    const pollUrl = buildPollUrl(this.options.serverUrl, requestId, secret);

    const interval = setInterval(async () => {
      // Timeout: stop polling after 10 minutes
      if (Date.now() - pollStart > MAX_POLL_DURATION_MS) {
        const pending = this.pendingAuths.get(requestId);
        if (pending) {
          this.send(pending.socket, { type: 'error', message: 'Auth request timed out (10 minutes)' });
          this.pendingAuths.delete(requestId);
        }
        clearInterval(interval);
        this.pollIntervals.delete(requestId);
        console.error(`[socket] Poll timeout for request ${requestId}`);
        return;
      }
      try {
        const response = await fetch(pollUrl, {
          headers: buildClaimHeaders(secret),
        });

        const data = await response.json() as {
          success?: boolean;
          status?: string;
          token?: string;
          encryptedToken?: string;
          agentId?: string;
          limit?: number;
          limits?: { fund?: number; send?: number; swap?: number };
          permissions?: string[];
          walletAccess?: string[];
          profile?: { id: string; version: string; displayName?: string; rationale?: string };
          effectivePolicyHash?: string;
          overrideDelta?: string[];
          warnings?: string[];
          error?: string;
        };

        if (!response.ok || !data.success) {
          return; // Keep polling
        }

        const pending = this.pendingAuths.get(requestId);
        if (!pending) {
          clearInterval(interval);
          this.pollIntervals.delete(requestId);
          return;
        }

        if (data.status === 'approved') {
          if (!data.encryptedToken) {
            this.send(pending.socket, {
              type: 'error',
              message: 'Encrypted token unavailable for auth approval',
            });
            clearInterval(interval);
            this.pollIntervals.delete(requestId);
            this.pendingAuths.delete(requestId);
            return;
          }

          this.send(pending.socket, {
            type: 'auth_approved',
            encryptedToken: data.encryptedToken,
            agentId: data.agentId,
            limit: data.limit,
            limits: data.limits,
            permissions: data.permissions,
            walletAccess: data.walletAccess,
            profile: data.profile,
            effectivePolicyHash: data.effectivePolicyHash,
            overrideDelta: data.overrideDelta,
            warnings: data.warnings,
          });

          clearInterval(interval);
          this.pollIntervals.delete(requestId);
          this.pendingAuths.delete(requestId);
        } else if (data.status === 'rejected') {
          this.send(pending.socket, {
            type: 'auth_rejected',
            requestId,
            message: 'Request was rejected'
          });

          clearInterval(interval);
          this.pollIntervals.delete(requestId);
          this.pendingAuths.delete(requestId);
        }
      } catch (err) {
        console.error(`[socket] Poll error for ${requestId}: ${getErrorMessage(err)}`);
      }
    }, 2000);

    this.pollIntervals.set(requestId, interval);
  }

  private send(socket: net.Socket, message: object): void {
    try {
      socket.write(JSON.stringify(message) + '\n');
    } catch {
      // Socket may be closed
    }
  }
}
