/**
 * Session Logger
 * ==============
 * Writes human-readable markdown files per agent session.
 * Chat sessions: one file per conversation (idle-timeout grouped).
 * Tick sessions: one file per app per day.
 * Crash recovery on startup, log rotation, daily summaries.
 *
 * All writes are async (appendFile) and never block the caller.
 * Errors in logging are caught and logged via pino — never thrown to callers.
 */

import { mkdir, appendFile, readFile, writeFile, readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { log } from '../pino';
import { getErrorMessage } from '../error';

// ─── Types ──────────────────────────────────────────────────────────

export type SessionStatus = 'in_progress' | 'completed' | 'error' | 'timeout' | 'crashed';
export type AdapterSource = 'dashboard' | 'telegram' | 'webhook' | 'cli' | 'system' | 'unknown';

interface SessionMeta {
  sessionId: string;
  filePath: string;
  appId: string;
  adapter: AdapterSource;
  startedAt: number;
  messageCount: number;
  toolCallCount: number;
  totalTokens: number;
  errorCount: number;
  lastModel?: string;
  lastProvider?: string;
}

interface TickSessionMeta {
  sessionId: string;
  filePath: string;
  appId: string;
  startedAt: number;
}

interface ToolCallEntry {
  name: string;
  input: Record<string, unknown>;
  result: string;
  durationMs: number;
}

// ─── Config ─────────────────────────────────────────────────────────

/** Idle timeout: new file after this gap (ms) */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Default log retention in days */
const DEFAULT_RETENTION_DAYS = 30;

// ─── State ──────────────────────────────────────────────────────────

/** Active chat sessions by sessionId */
const activeSessions = new Map<string, SessionMeta>();

/** Last activity per app → for idle-timeout grouping */
const lastActivity = new Map<string, { sessionId: string; timestamp: number }>();

/** Active tick sessions by sessionId */
const activeTickSessions = new Map<string, TickSessionMeta>();

// ─── Helpers ────────────────────────────────────────────────────────

function shouldSkip(): boolean {
  return (process.env.NODE_ENV === 'test' || !!process.env.VITEST);
}

function getDataDir(): string {
  return process.env.WALLET_DATA_DIR || join(homedir(), '.auramaxx');
}

function getSessionsDir(): string {
  return join(getDataDir(), 'logs', 'sessions');
}

function dateDir(date?: Date): string {
  const d = date || new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function timeStamp(date?: Date): string {
  const d = date || new Date();
  return d.toISOString().slice(11, 19).replace(/:/g, '-'); // HH-MM-SS
}

function timeDisplay(date?: Date): string {
  const d = date || new Date();
  return d.toISOString().slice(11, 19); // HH:MM:SS
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

function generateId(): string {
  return 's_' + randomBytes(6).toString('hex');
}

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function safeAppend(filePath: string, content: string): Promise<void> {
  try {
    await ensureDir(join(filePath, '..'));
    await appendFile(filePath, content, 'utf-8');
  } catch (err) {
    log.warn({ err, filePath }, 'session log write failed');
  }
}

async function safeWrite(filePath: string, content: string): Promise<void> {
  try {
    await ensureDir(join(filePath, '..'));
    await writeFile(filePath, content, 'utf-8');
  } catch (err) {
    log.warn({ err, filePath }, 'session log write failed');
  }
}

// ─── Chat Sessions ──────────────────────────────────────────────────

/**
 * Start or resume a chat session for a app.
 * Returns a sessionId to pass to subsequent log calls.
 */
export function startChatSession(
  appId: string,
  adapter: AdapterSource | string,
  message: string,
): string {
  if (shouldSkip()) return 'skip';

  const now = Date.now();
  const adapterSource = (adapter || 'unknown') as AdapterSource;

  // Check if there's a recent session for this app (within idle timeout)
  const last = lastActivity.get(appId);
  if (last) {
    const existing = activeSessions.get(last.sessionId);
    if (existing) {
      if ((now - last.timestamp) < IDLE_TIMEOUT_MS) {
        // Resume existing session — append new message
        existing.messageCount++;
        last.timestamp = now;
        const msgNum = existing.messageCount;

        const content = `\n---\n\n## Message ${msgNum} — ${timeDisplay()}\n**User:** ${message.slice(0, 500)}${message.length > 500 ? '...' : ''}\n`;
        safeAppend(existing.filePath, content);

        return existing.sessionId;
      }
      // Idle timeout expired — close the old session before creating a new one
      endChatSession(last.sessionId, 'completed');
    }
  }

  // Create new session
  const sessionId = generateId();
  const dd = dateDir();
  const ts = timeStamp();
  const safeApp = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${ts}_${adapterSource}_${safeApp}.md`;
  const filePath = join(getSessionsDir(), dd, fileName);

  const meta: SessionMeta = {
    sessionId,
    filePath,
    appId,
    adapter: adapterSource,
    startedAt: now,
    messageCount: 1,
    toolCallCount: 0,
    totalTokens: 0,
    errorCount: 0,
  };

  activeSessions.set(sessionId, meta);
  lastActivity.set(appId, { sessionId, timestamp: now });

  // Write file header + first message
  const header = buildFrontmatter(meta, 'in_progress');
  const title = `# ${adapterSource} > ${appId}\n`;
  const firstMsg = `\n## Message 1 — ${timeDisplay()}\n**User:** ${message.slice(0, 500)}${message.length > 500 ? '...' : ''}\n`;

  safeWrite(filePath, header + '\n' + title + firstMsg);

  return sessionId;
}

/** Metadata passed to logReply from the AI provider */
interface ReplyMeta {
  model?: string;
  tokens?: number;
  durationMs?: number;
  provider?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** Tool call count from providers that don't report individual calls (e.g. CLI) */
  toolCallCount?: number;
}

/**
 * Log the AI reply for a chat session message.
 */
export function logReply(
  sessionId: string,
  reply: string | null,
  meta?: ReplyMeta,
): void {
  if (shouldSkip() || sessionId === 'skip') return;

  const session = activeSessions.get(sessionId);
  if (!session) return;

  const model = meta?.model || 'unknown';
  const tokens = meta?.tokens || 0;
  const durationMs = meta?.durationMs || 0;
  const provider = meta?.provider || 'unknown';

  session.totalTokens += tokens;
  session.lastModel = model;
  session.lastProvider = provider;

  // For providers that don't report individual tool calls (e.g. CLI),
  // update the count from the aggregate reported by _meta.toolCallCount
  if (meta?.toolCallCount && meta.toolCallCount > session.toolCallCount) {
    session.toolCallCount = meta.toolCallCount;
  }

  // Update last activity
  const last = lastActivity.get(session.appId);
  if (last && last.sessionId === sessionId) {
    last.timestamp = Date.now();
  }

  // Build rich timing line with all available metadata
  const parts: string[] = [
    `**Response time:** ${durationMs.toLocaleString()}ms`,
    `**Model:** ${model}`,
    `**Provider:** ${provider}`,
  ];
  if (meta?.inputTokens || meta?.outputTokens) {
    parts.push(`**Tokens:** ${(meta.inputTokens || 0).toLocaleString()} in / ${(meta.outputTokens || 0).toLocaleString()} out`);
    if (meta.cacheReadTokens) parts.push(`**Cache:** ${meta.cacheReadTokens.toLocaleString()}`);
  } else if (tokens) {
    parts.push(`**Tokens:** ${tokens.toLocaleString()}`);
  }
  if (meta?.costUsd) parts.push(`**Cost:** $${meta.costUsd.toFixed(4)}`);
  const timing = parts.join(' | ');

  const replyBlock = reply
    ? `\n### Reply\n${reply.slice(0, 2000)}${reply.length > 2000 ? '\n...(truncated)' : ''}\n`
    : '\n### Reply\n_(no reply)_\n';

  safeAppend(session.filePath, timing + '\n' + replyBlock);
}

/**
 * Log a tool call within a chat session.
 */
export function logToolCall(
  sessionId: string,
  entry: ToolCallEntry,
): void {
  if (shouldSkip() || sessionId === 'skip') return;

  const session = activeSessions.get(sessionId);
  if (!session) return;

  session.toolCallCount++;
  const num = session.toolCallCount;

  // If this is the first tool call for the current message, write header
  if (num === 1 || (session as any)._lastToolMsg !== session.messageCount) {
    safeAppend(session.filePath, '\n### Tool Calls\n| # | Tool | Input | Duration |\n|---|------|-------|----------|\n');
    (session as any)._lastToolMsg = session.messageCount;
  }

  const inputStr = typeof entry.input === 'object'
    ? `${entry.input.method || '?'} ${entry.input.endpoint || JSON.stringify(entry.input).slice(0, 60)}`
    : String(entry.input).slice(0, 60);

  safeAppend(session.filePath, `| ${num} | ${entry.name} | ${inputStr} | ${entry.durationMs}ms |\n`);
}

/**
 * Log an error in a chat session.
 */
export function logError(
  sessionId: string,
  error: unknown,
): void {
  if (shouldSkip() || sessionId === 'skip') return;

  const session = activeSessions.get(sessionId);
  if (!session) return;

  session.errorCount++;
  const errMsg = getErrorMessage(error);
  const stack = error instanceof Error ? error.stack : undefined;

  const content = `\n### Error\n\`\`\`\n${errMsg}${stack ? '\n' + stack : ''}\n\`\`\`\n`;
  safeAppend(session.filePath, content);
}

/**
 * End a chat session with a final status.
 */
export async function endChatSession(
  sessionId: string,
  status: SessionStatus = 'completed',
): Promise<void> {
  if (shouldSkip() || sessionId === 'skip') return;

  const session = activeSessions.get(sessionId);
  if (!session) return;

  // Rewrite frontmatter with final status
  await rewriteSessionStatus(session.filePath, session, status);

  // Cleanup
  activeSessions.delete(sessionId);
  const last = lastActivity.get(session.appId);
  if (last && last.sessionId === sessionId) {
    lastActivity.delete(session.appId);
  }
}

// ─── Tick Sessions ──────────────────────────────────────────────────

/**
 * Start a tick session for a app. Appends to the daily tick file.
 */
export function startTickSession(appId: string): string {
  if (shouldSkip()) return 'skip';

  const sessionId = generateId();
  const dd = dateDir();
  const safeApp = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `ticks_${safeApp}.md`;
  const filePath = join(getSessionsDir(), dd, fileName);

  const meta: TickSessionMeta = {
    sessionId,
    filePath,
    appId,
    startedAt: Date.now(),
  };

  activeTickSessions.set(sessionId, meta);

  // Check if file needs a header (first tick of the day)
  const header = `\n## Tick — ${timeDisplay()} [${sessionId}]\n**Status:** in_progress\n`;
  safeAppend(filePath, header);

  return sessionId;
}

/**
 * Log an event within a tick session.
 */
export function logTickEvent(
  sessionId: string,
  phase: string,
  details: string,
): void {
  if (shouldSkip() || sessionId === 'skip') return;

  const tick = activeTickSessions.get(sessionId);
  if (!tick) return;

  safeAppend(tick.filePath, `**${phase}:** ${details}\n`);
}

/**
 * End a tick session with status and duration.
 */
export function endTickSession(
  sessionId: string,
  status: SessionStatus,
  durationMs: number,
): void {
  if (shouldSkip() || sessionId === 'skip') return;

  const tick = activeTickSessions.get(sessionId);
  if (!tick) return;

  const statusIcon = status === 'completed' ? '' : status === 'error' ? ' ERROR' : ` ${status.toUpperCase()}`;
  safeAppend(tick.filePath, `**Duration:** ${formatDuration(durationMs)} | **Status:** ${status}${statusIcon}\n\n---\n`);

  activeTickSessions.delete(sessionId);
}

// ─── Frontmatter ────────────────────────────────────────────────────

function buildFrontmatter(session: SessionMeta, status: SessionStatus): string {
  return `---
session_id: ${session.sessionId}
adapter: ${session.adapter}
app: ${session.appId}
started: ${new Date(session.startedAt).toISOString()}
status: ${status}
messages: ${session.messageCount}
tool_calls: ${session.toolCallCount}
tokens: ${session.totalTokens}
model: ${session.lastModel || 'unknown'}
provider: ${session.lastProvider || 'unknown'}
errors: ${session.errorCount}
---
`;
}

async function rewriteSessionStatus(
  filePath: string,
  session: SessionMeta,
  status: SessionStatus,
): Promise<void> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const endOfFrontmatter = content.indexOf('---', 4); // Skip first ---
    if (endOfFrontmatter === -1) return;

    const endedAt = new Date();
    const durationMs = endedAt.getTime() - session.startedAt;

    const newFrontmatter = `---
session_id: ${session.sessionId}
adapter: ${session.adapter}
app: ${session.appId}
started: ${new Date(session.startedAt).toISOString()}
ended: ${endedAt.toISOString()}
duration: ${formatDuration(durationMs)}
status: ${status}
messages: ${session.messageCount}
tool_calls: ${session.toolCallCount}
tokens: ${session.totalTokens}
model: ${session.lastModel || 'unknown'}
provider: ${session.lastProvider || 'unknown'}
errors: ${session.errorCount}
---`;

    const rest = content.slice(endOfFrontmatter + 3);
    await writeFile(filePath, newFrontmatter + rest, 'utf-8');
  } catch (err) {
    log.warn({ err, filePath }, 'failed to rewrite session frontmatter');
  }
}

// ─── Crash Recovery ─────────────────────────────────────────────────

/**
 * Scan recent session files for `status: in_progress` and mark them as crashed.
 * Called on server startup.
 */
export async function recoverCrashedSessions(): Promise<void> {
  if (shouldSkip()) return;

  const sessionsDir = getSessionsDir();
  const now = new Date();
  const today = dateDir(now);
  const yesterday = dateDir(new Date(now.getTime() - 86_400_000));

  for (const dd of [today, yesterday]) {
    const dayDir = join(sessionsDir, dd);
    let files: string[];
    try {
      files = await readdir(dayDir);
    } catch {
      continue; // Directory doesn't exist
    }

    for (const file of files) {
      if (!file.endsWith('.md') || file.startsWith('_') || file.startsWith('ticks_')) continue;

      const filePath = join(dayDir, file);
      try {
        const content = await readFile(filePath, 'utf-8');
        if (!content.includes('status: in_progress')) continue;

        // Mark as crashed
        const updated = content.replace(
          'status: in_progress',
          'status: crashed',
        );
        const crashNote = `\n## CRASH DETECTED\nThis session was in_progress when the server stopped unexpectedly.\nServer restarted at: ${now.toISOString()}\n`;
        await writeFile(filePath, updated + crashNote, 'utf-8');
        log.info({ file }, 'recovered crashed session');
      } catch (err) {
        log.warn({ err, file }, 'failed to recover crashed session');
      }
    }
  }
}

/**
 * Mark all currently active sessions with the given status.
 * Called during graceful shutdown.
 */
export async function endAllActiveSessions(status: SessionStatus = 'completed'): Promise<void> {
  if (shouldSkip()) return;

  const promises: Promise<void>[] = [];
  for (const [sessionId] of activeSessions) {
    promises.push(endChatSession(sessionId, status));
  }
  for (const [sessionId] of activeTickSessions) {
    endTickSession(sessionId, status, Date.now() - (activeTickSessions.get(sessionId)?.startedAt || Date.now()));
  }
  await Promise.all(promises);
}

/**
 * Mark all active sessions as crashed.
 * Called from uncaughtException handler.
 */
export async function markAllSessionsCrashed(): Promise<void> {
  if (shouldSkip()) return;

  const promises: Promise<void>[] = [];
  for (const [sessionId] of activeSessions) {
    promises.push(endChatSession(sessionId, 'crashed'));
  }
  for (const [sessionId] of activeTickSessions) {
    endTickSession(sessionId, 'crashed', Date.now() - (activeTickSessions.get(sessionId)?.startedAt || Date.now()));
  }
  await Promise.all(promises);
}

// ─── Log Rotation ───────────────────────────────────────────────────

/**
 * Delete session log directories older than retentionDays.
 */
export async function cleanupOldLogs(retentionDays: number = DEFAULT_RETENTION_DAYS): Promise<void> {
  if (shouldSkip()) return;

  const sessionsDir = getSessionsDir();
  let dirs: string[];
  try {
    dirs = await readdir(sessionsDir);
  } catch {
    return; // No sessions dir yet
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = dateDir(cutoff);

  for (const dir of dirs) {
    // Only process YYYY-MM-DD directories
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dir)) continue;
    if (dir >= cutoffStr) continue;

    try {
      await rm(join(sessionsDir, dir), { recursive: true });
      log.info({ dir }, 'cleaned up old session logs');
    } catch (err) {
      log.warn({ err, dir }, 'failed to clean up old session logs');
    }
  }
}

// ─── Daily Summary ──────────────────────────────────────────────────

/**
 * Generate a daily summary markdown file from today's session files.
 */
export async function generateDailySummary(date?: string): Promise<void> {
  if (shouldSkip()) return;

  const dd = date || dateDir();
  const dayDir = join(getSessionsDir(), dd);
  let files: string[];
  try {
    files = await readdir(dayDir);
  } catch {
    return; // No sessions for this day
  }

  let chatSessions = 0;
  let tickInvocations = 0;
  let totalTokens = 0;
  let completedCount = 0;
  let errorCount = 0;
  let crashCount = 0;
  let timeoutCount = 0;
  const sessionRows: string[] = [];

  for (const file of files) {
    if (!file.endsWith('.md') || file.startsWith('_')) continue;

    const filePath = join(dayDir, file);
    try {
      const content = await readFile(filePath, 'utf-8');

      if (file.startsWith('ticks_')) {
        // Count tick entries
        const tickMatches = content.match(/^## Tick —/gm);
        tickInvocations += tickMatches ? tickMatches.length : 0;
        continue;
      }

      // Parse chat session frontmatter
      chatSessions++;
      const statusMatch = content.match(/^status:\s*(.+)$/m);
      const status = statusMatch ? statusMatch[1].trim() : 'unknown';
      const adapterMatch = content.match(/^adapter:\s*(.+)$/m);
      const adapter = adapterMatch ? adapterMatch[1].trim() : '?';
      const appMatch = content.match(/^app:\s*(.+)$/m);
      const app = appMatch ? appMatch[1].trim() : '?';
      const msgMatch = content.match(/^messages:\s*(\d+)$/m);
      const messages = msgMatch ? parseInt(msgMatch[1]) : 0;
      const tokenMatch = content.match(/^tokens:\s*(\d+)$/m);
      const tokens = tokenMatch ? parseInt(tokenMatch[1]) : 0;
      const startMatch = content.match(/^started:\s*(.+)$/m);
      const startTime = startMatch ? startMatch[1].trim().slice(11, 16) : '?';

      totalTokens += tokens;
      if (status === 'completed') completedCount++;
      else if (status === 'error') errorCount++;
      else if (status === 'crashed') crashCount++;
      else if (status === 'timeout') timeoutCount++;

      sessionRows.push(`| ${startTime} | ${adapter} | ${app} | ${messages} | ${status} | ${tokens} |`);
    } catch {
      continue;
    }
  }

  const total = chatSessions + tickInvocations;
  const successRate = total > 0 ? ((completedCount / (chatSessions || 1)) * 100).toFixed(1) : '0.0';

  const summary = `# Daily Summary — ${dd}

| Metric | Value |
|--------|-------|
| Total sessions | ${total} |
| Chat sessions | ${chatSessions} |
| Tick invocations | ${tickInvocations} |
| Success rate | ${successRate}% |
| Timeouts | ${timeoutCount} |
| Errors | ${errorCount} |
| Crashes | ${crashCount} |
| Total tokens | ${totalTokens.toLocaleString()} |

## Sessions
| Time | Adapter | App | Messages | Status | Tokens |
|------|---------|--------|----------|--------|--------|
${sessionRows.join('\n') || '_(none)_'}

## Errors & Crashes
${errorCount + crashCount > 0 ? `${errorCount} error(s), ${crashCount} crash(es) — see individual session files for details.` : '_None today._'}
`;

  await safeWrite(join(dayDir, '_daily-summary.md'), summary);
}

// ─── Test Helpers ───────────────────────────────────────────────────

/** Reset all in-memory state (for tests) */
export function __resetSessionLogger(): void {
  activeSessions.clear();
  lastActivity.clear();
  activeTickSessions.clear();
}

/** Get active session count (for tests) */
export function __getActiveSessionCount(): number {
  return activeSessions.size;
}

/** Get active tick session count (for tests) */
export function __getActiveTickSessionCount(): number {
  return activeTickSessions.size;
}
