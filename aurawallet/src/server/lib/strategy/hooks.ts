/**
 * Strategy Hook Caller
 * ====================
 * Sends hook instructions + context to an AI model.
 * Supports four providers: Claude CLI, Claude API, Codex CLI, OpenAI API.
 * AI client logic (auth, model resolution) lives in ../ai.ts.
 */

import { execFile } from 'child_process';
import { writeFileSync, appendFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import {
  getAnthropicClient,
  getOpenAiClient,
  resolveModelId,
  selectModelTier,
  MODEL_TIERS,
  __resetCachedClient,
  AiProviderMode,
  type ModelTier,
} from '../ai';
import { validateToken } from '../auth';
import { StrategyManifest, HookResult, HookMeta } from './types';
import { getHookSystemContext } from './hook-context';
import { toAnthropicTools, toOpenAITools, executeTool } from '../../mcp/tools';
import { getDefaultSync } from '../defaults';
import { log } from '../pino';
import { getErrorMessage } from '../error';
import { redactJsonString, redactSensitiveData, redactUrlQuery } from '../redaction';

// Re-export for backward compatibility (tests, other consumers)
export { getAnthropicClient, __resetCachedClient };

/* ── Audit logging ────────────────────────────────────────────────────
 * Writes JSONL to ~/.auramaxx/logs/hooks-YYYY-MM-DD.jsonl
 * Each line is a complete hook invocation: prompt in, tool calls, response out.
 * Disabled during tests (WALLET_DATA_DIR override or NODE_ENV=test).
 */

interface AuditToolCall {
  tool: string;
  input: Record<string, unknown>;
  result: string;
}

interface AuditEntry {
  ts: string;
  strategyId: string;
  hook: string;
  model: string;
  via: AiProviderMode;
  prompt: {
    system: string;
    instructions: string;
    context: unknown;
  };
  toolCalls: AuditToolCall[];
  response: {
    raw: string;
    parsed: HookResult;
  };
  durationMs: number;
}

function getAuditLogDir(): string {
  const dataDir = process.env.WALLET_DATA_DIR || join(homedir(), '.auramaxx');
  return join(dataDir, 'logs');
}

function toRedactedPreview(value: string, maxChars = 300): string {
  const safe = redactJsonString(value);
  return safe.length > maxChars ? `${safe.slice(0, maxChars)}...` : safe;
}

function getRedactedToolSummary(input: Record<string, unknown>): string {
  const method = String(input.method || '?');
  const endpointRaw = typeof input.endpoint === 'string' ? input.endpoint : String(input.endpoint || '?');
  return `${method} ${redactUrlQuery(endpointRaw)}`;
}

function sanitizeAuditEntry(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    prompt: {
      system: redactJsonString(entry.prompt.system),
      instructions: redactJsonString(entry.prompt.instructions),
      context: redactSensitiveData(entry.prompt.context),
    },
    toolCalls: entry.toolCalls.map((toolCall) => ({
      tool: toolCall.tool,
      input: redactSensitiveData(toolCall.input) as Record<string, unknown>,
      result: redactJsonString(toolCall.result),
    })),
    response: {
      raw: redactJsonString(entry.response.raw),
      parsed: redactSensitiveData(entry.response.parsed) as HookResult,
    },
  };
}

function writeAuditEntry(entry: AuditEntry): void {
  // Skip in tests
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;

  try {
    const logDir = getAuditLogDir();
    mkdirSync(logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const logPath = join(logDir, `hooks-${date}.jsonl`);
    appendFileSync(logPath, JSON.stringify(sanitizeAuditEntry(entry)) + '\n');
  } catch (err) {
    log.warn({ err }, 'audit log write failed');
  }
}

/** CLI session IDs per strategy — enables conversation memory across ticks */
const cliSessions = new Map<string, string>();

/** Persistent MCP config files per strategy — written once, reused across hooks */
const mcpConfigPaths = new Map<string, string>();

/** Pre-resolved model tier per strategy — set at enable time, avoids per-hook token decode */
const resolvedTiers = new Map<string, 'fast' | 'standard' | 'powerful'>();

/**
 * Resolve token permissions for model-tier selection.
 *
 * In cron-owned mode, tokens are minted by the wallet server process and signed
 * with a different in-memory key, so local signature verification can fail.
 * For tiering only (non-auth), fall back to decoding the JWT-like payload.
 */
function getTokenPermissionsForTier(token?: string): string[] {
  if (!token) return [];

  const validated = validateToken(token);
  if (validated?.permissions?.length) return validated.permissions;

  try {
    const [payloadPart] = token.split('.');
    if (!payloadPart) return [];
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf-8')) as {
      permissions?: unknown;
    };
    if (!Array.isArray(payload.permissions)) return [];
    return payload.permissions.filter((perm): perm is string => typeof perm === 'string');
  } catch {
    return [];
  }
}

/**
 * Pre-resolve and cache the model tier for a strategy based on its token permissions.
 * Called once at enable time — the tier stays constant until disable since permissions don't change.
 */
export function cacheModelTier(strategyId: string, token?: string): void {
  const permissions = getTokenPermissionsForTier(token);
  // Use 'tick' as a neutral non-lifecycle hook name to get the operational tier
  resolvedTiers.set(strategyId, selectModelTier('tick', permissions));
}

/** Clear the cached model tier for a strategy */
export function clearModelTier(strategyId: string): void {
  resolvedTiers.delete(strategyId);
}

/** Resolve the tsx binary path — direct bin path avoids npx package resolution overhead */
function getTsxBinPath(): string {
  const direct = join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
  if (existsSync(direct)) return direct;
  return 'npx'; // fallback
}

/** Get or create the MCP config file for a strategy */
function getOrCreateMcpConfig(strategyId: string): string {
  const existing = mcpConfigPaths.get(strategyId);
  if (existing && existsSync(existing)) return existing;

  const mcpDir = join(tmpdir(), 'auramaxx-mcp');
  mkdirSync(mcpDir, { recursive: true });
  const configPath = join(mcpDir, `${strategyId}.json`);

  const tsxBin = getTsxBinPath();
  const mcpServerPath = join(__dirname, '..', '..', 'mcp', 'server.ts');
  const mcpConfig = {
    mcpServers: {
      auramaxx: {
        command: tsxBin,
        args: tsxBin === 'npx' ? ['tsx', mcpServerPath] : [mcpServerPath],
        env: {
          ...(process.env.WALLET_SERVER_URL ? { WALLET_SERVER_URL: process.env.WALLET_SERVER_URL } : {}),
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(mcpConfig));
  mcpConfigPaths.set(strategyId, configPath);
  return configPath;
}

/** Remove the cached MCP config file for a strategy */
function removeMcpConfig(strategyId: string): void {
  const configPath = mcpConfigPaths.get(strategyId);
  if (configPath) {
    try { unlinkSync(configPath); } catch {}
    mcpConfigPaths.delete(strategyId);
  }
}

/** Clear CLI session for a strategy (e.g. on disable/reset) */
export function clearCliSession(strategyId: string): void {
  cliSessions.delete(strategyId);
  cliSessions.delete(`${strategyId}:message`);
  removeMcpConfig(strategyId);
  clearModelTier(strategyId);
}

/** Clear all CLI sessions (e.g. on engine shutdown) */
export function clearAllCliSessions(): void {
  cliSessions.clear();
  for (const [id] of mcpConfigPaths) removeMcpConfig(id);
  mcpConfigPaths.clear();
  resolvedTiers.clear();
}

/**
 * Parse a hook response from Claude into structured intents + state.
 * Handles raw JSON, JSON wrapped in markdown code blocks, or JSON
 * buried in reasoning text (extracts the last code block or first { ... }).
 */
export function parseHookResponse(text: string): HookResult {
  let cleaned = text.trim();

  // 1. Try: entire response is a code block
  const fullFence = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fullFence) {
    cleaned = fullFence[1].trim();
  }

  // 2. Try: parse as-is (raw JSON or extracted from step 1)
  const result = tryParseJson(cleaned);
  if (result) return result;

  // 3. Try: find a JSON code block anywhere in the text (model added reasoning around it)
  const embeddedFence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (embeddedFence) {
    const inner = embeddedFence[1].trim();
    const fenceResult = tryParseJson(inner);
    if (fenceResult) return fenceResult;
  }

  // 4. Try: find first { ... } blob that looks like our response format
  //    Only accept it if the parsed JSON has expected keys (intents, state, reply, log)
  //    to avoid misinterpreting error messages or conversational text containing JSON.
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    const blob = text.slice(braceStart, braceEnd + 1);
    const blobResult = tryParseJson(blob);
    if (blobResult && hasHookKeys(blob)) return blobResult;
  }

  // 5. Give up — return the raw text as a reply
  if (cleaned.length > 0) {
    return { intents: [], state: {}, reply: cleaned };
  }
  return { intents: [], state: {} };
}

/** Check if raw JSON text contains at least one expected hook response key */
function hasHookKeys(text: string): boolean {
  return /\b(intents|state|reply|log|emit)\b/.test(text);
}

/** Try to parse JSON text into a HookResult, return null on failure */
function tryParseJson(text: string): HookResult | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;

    // Normalize emit to undefined or array
    let emit: HookResult['emit'];
    if (parsed.emit) {
      if (Array.isArray(parsed.emit)) {
        emit = parsed.emit.filter((e: any) => e && typeof e.channel === 'string');
        if ((emit as any[]).length === 0) emit = undefined;
      } else if (typeof parsed.emit === 'object' && typeof parsed.emit.channel === 'string') {
        emit = parsed.emit;
      }
    }

    return {
      intents: Array.isArray(parsed.intents) ? parsed.intents : [],
      state: parsed.state && typeof parsed.state === 'object' ? parsed.state : {},
      log: typeof parsed.log === 'string' ? parsed.log : undefined,
      reply: typeof parsed.reply === 'string' ? parsed.reply : undefined,
      emit,
    };
  } catch {
    return null;
  }
}

/** Max tool calls per hook invocation to prevent runaway loops */
function getMaxToolCalls(): number {
  return getDefaultSync<number>('ai.max_tool_calls', 10);
}

/** Pull the user message out of message-hook context payloads. */
function getContextMessage(context: unknown): string {
  if (!context || typeof context !== 'object') return '';
  const maybeMessage = (context as { message?: unknown }).message;
  return typeof maybeMessage === 'string' ? maybeMessage : '';
}

/**
 * Promote message-hook model tier for token research and deeper analysis prompts.
 * This avoids cheap-model drift on queries that need tool use and disambiguation.
 */
function promoteMessageTier(
  hookLabel: string,
  context: unknown,
  currentTier: ModelTier,
): ModelTier {
  if (hookLabel !== 'message') return currentTier;

  const text = getContextMessage(context).toLowerCase();
  if (!text) return currentTier;

  const hasTicker = /\$[a-z0-9]{2,}/i.test(text);
  const isTokenResearch = hasTicker || /\b(market cap|mcap|price|liquidity|volume|fdv|contract|token|ticker)\b/.test(text);
  const isChainScoped = /\b(on|in)\s+(base|ethereum|solana|arbitrum|optimism|polygon|bsc)\b/.test(text);
  const isDeepAnalysis = /\b(who(?:'s| is)|dump(?:ing)?|whale|holders?|transactions?|analy[sz]e|audit|risk|due diligence|compare)\b/.test(text);

  if (currentTier !== 'powerful' && isDeepAnalysis) {
    return 'powerful';
  }
  if (currentTier === 'fast' && (isTokenResearch || isChainScoped)) {
    return 'standard';
  }

  return currentTier;
}

/** Build the stdin prompt content for CLI-based providers */
function buildCliPrompt(
  hookMode: 'intent' | 'tool-call',
  systemContext: string,
  instructions: string,
  contextStr: string,
): string {
  const formatSuffix = hookMode === 'tool-call'
    ? `\n\nUse the wallet_api and request_human_action tools to perform actions. For token ticker/name queries without a contract address, you MUST call wallet_api GET /token/search?q=<token>&chain=<chain> before asking for an address or sending the user to external websites. After all tool calls are complete, respond with a JSON object containing reply and state.`
    : `\n\nRespond with ONLY a raw JSON object. No markdown, no code fences, no explanation. Start with { and end with }:`;
  return `${systemContext}\n\n---\n\nApp instructions:\n${instructions}\n\nContext:\n${contextStr}${formatSuffix}`;
}

// ─── Claude CLI ────────────────────────────────────────────────────

/**
 * Call a strategy hook via the `claude` CLI in print mode.
 * Uses persistent sessions per strategy — the CLI stores conversation history
 * automatically, so the model has memory across ticks.
 */
async function callHookViaCli(
  manifest: StrategyManifest,
  hookName: string,
  instructions: string,
  contextStr: string,
  model: string,
  token?: string,
): Promise<HookResult> {
  const sessionKey = hookName === 'message' ? `${manifest.id}:message` : manifest.id;
  const sessionId = cliSessions.get(sessionKey);
  const startTime = Date.now();

  const hookMode = hookName === 'message' ? 'tool-call' : 'intent' as const;
  const systemContext = getHookSystemContext(hookMode, 'cli');
  const stdinContent = buildCliPrompt(hookMode, systemContext, instructions, contextStr);

  // Reuse persistent MCP config file (created once per strategy, cleaned up on disable/shutdown).
  // Always provide tools — some endpoints are public (token search, etc.)
  // and the AI needs tools to look up data even without a wallet token.
  let mcpConfigPath: string | undefined;
  try {
    mcpConfigPath = getOrCreateMcpConfig(manifest.id);
  } catch (err) {
    log.warn({ err, strategyId: manifest.id }, 'mcp config write failed');
    mcpConfigPath = undefined;
  }

  const tag = `[strategy:${manifest.id}]`;
  console.log(`${tag} hook:${hookName} ▸ stdin (${stdinContent.length} chars):`);
  console.log(`${tag} hook:${hookName} ▸ system context: ${systemContext.length} chars (mode=${hookMode})`);
  console.log(`${tag} hook:${hookName} ▸ instructions: ${toRedactedPreview(instructions, 200)}`);
  console.log(`${tag} hook:${hookName} ▸ context: ${toRedactedPreview(contextStr, 300)}`);
  console.log(`${tag} hook:${hookName} ▸ MCP config: ${mcpConfigPath ? 'yes' : 'no'}, token: ${token ? 'yes' : 'no'}`);

  return new Promise((resolve) => {
    const args = [
      '-p',
      '--model', model,
      '--output-format', 'json',
    ];

    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath);
      args.push('--allowedTools', 'mcp__auramaxx__wallet_api,mcp__auramaxx__request_human_action');
    } else {
      args.push('--tools', '');
    }

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    console.log(`${tag} hook:${hookName} ▸ CLI args: claude ${args.join(' ')}`);

    const child = execFile('claude', args, {
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...(token ? { AURA_TOKEN: token } : {}) },
    }, (err, stdout, stderr) => {
      if (err) {
        console.error(`${tag} hook:${hookName} CLI error: ${err.message}`);
        if (stderr) console.error(`${tag} hook:${hookName} stderr: ${toRedactedPreview(stderr, 500)}`);
        if (sessionId) {
          console.log(`${tag} clearing stale session ${sessionId}`);
          cliSessions.delete(sessionKey);
        }
        resolve({ intents: [], state: {} });
        return;
      }

      try {
        const result = JSON.parse(stdout);
        const text = result.result || '';
        const cost = result.total_cost_usd;
        const usage = result.usage;
        const numTurns = result.num_turns;

        if (result.session_id && !cliSessions.has(sessionKey)) {
          cliSessions.set(sessionKey, result.session_id);
          console.log(`${tag} hook:${hookName} session created: ${result.session_id}`);
        }

        if (usage) {
          console.log(`${tag} hook:${hookName} ← tokens in=${usage.input_tokens} out=${usage.output_tokens}${usage.cache_read_input_tokens ? ` cached=${usage.cache_read_input_tokens}` : ''} cost=$${cost?.toFixed(4) || '?'} turns=${numTurns || '?'}`);
        }

        if (numTurns && numTurns > 1) {
          console.log(`${tag} hook:${hookName} ← ${numTurns} turns (tool calls detected)`);
        } else if (hookMode === 'tool-call') {
          console.warn(`${tag} hook:${hookName} ⚠ tool-call mode but only ${numTurns || 1} turn — AI may not have called tools`);
        }

        console.log(`${tag} hook:${hookName} ← response: ${toRedactedPreview(text, 300)}`);

        const durationMs = Date.now() - startTime;
        const parsed = parseHookResponse(text);
        parsed._meta = {
          model: result.model || model,
          provider: 'claude-cli',
          tokens: {
            input: usage?.input_tokens || 0,
            output: usage?.output_tokens || 0,
            cacheRead: usage?.cache_read_input_tokens || undefined,
          },
          durationMs,
          costUsd: cost || undefined,
          toolCallCount: numTurns ? Math.max(0, numTurns - 1) : 0,
        };
        writeAuditEntry({
          ts: new Date().toISOString(),
          strategyId: manifest.id,
          hook: hookName,
          model,
          via: 'claude-cli',
          prompt: { system: systemContext, instructions, context: safeJsonParse(contextStr) },
          toolCalls: [],
          response: { raw: text, parsed },
          durationMs,
        });
        resolve(parsed);
      } catch {
        const durationMs = Date.now() - startTime;
        console.log(`${tag} hook:${hookName} ← raw: ${toRedactedPreview(stdout, 500)}`);
        const parsed = parseHookResponse(stdout);
        parsed._meta = {
          model,
          provider: 'claude-cli',
          tokens: { input: 0, output: 0 },
          durationMs,
          toolCallCount: 0,
        };
        writeAuditEntry({
          ts: new Date().toISOString(),
          strategyId: manifest.id,
          hook: hookName,
          model,
          via: 'claude-cli',
          prompt: { system: systemContext, instructions, context: safeJsonParse(contextStr) },
          toolCalls: [],
          response: { raw: stdout, parsed },
          durationMs,
        });
        resolve(parsed);
      }
    });

    if (child.stdin) {
      child.stdin.write(stdinContent);
      child.stdin.end();
    }
  });
}

// ─── Claude API (Anthropic SDK) ────────────────────────────────────

/**
 * Call a strategy hook via the Anthropic SDK (requires real API key).
 * Includes tool-use loop: if the model calls wallet_api, execute it and continue.
 */
async function callHookViaSdk(
  manifest: StrategyManifest,
  hookName: string,
  instructions: string,
  contextStr: string,
  model: string,
  token?: string,
  onProgress?: (status: string) => void,
  onToolCall?: (entry: { name: string; input: Record<string, unknown>; result: string; durationMs: number }) => void,
): Promise<HookResult> {
  const client = await getAnthropicClient();
  const tag = `[strategy:${manifest.id}]`;
  const startTime = Date.now();
  const auditToolCalls: AuditToolCall[] = [];

  const hookMode = hookName === 'message' ? 'tool-call' : 'intent' as const;
  const systemContext = getHookSystemContext(hookMode, 'sdk');
  const system: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: systemContext,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: instructions,
    },
  ];

  const tools = toAnthropicTools();

  console.log(`${tag} hook:${hookName} ▸ SDK request:`);
  console.log(`${tag} hook:${hookName} ▸ system: ${systemContext.length} chars (mode=${hookMode})`);
  console.log(`${tag} hook:${hookName} ▸ instructions: ${toRedactedPreview(instructions, 200)}`);
  console.log(`${tag} hook:${hookName} ▸ context: ${toRedactedPreview(contextStr, 300)}`);
  console.log(`${tag} hook:${hookName} ▸ tools: [${tools.map(t => t.name).join(', ')}] (${tools.length} tools), token: ${token ? 'yes' : 'no'}`);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: contextStr },
  ];

  let toolCallCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;

  const finalize = (rawText: string): HookResult => {
    const durationMs = Date.now() - startTime;
    const parsed = parseHookResponse(rawText);
    writeAuditEntry({
      ts: new Date().toISOString(),
      strategyId: manifest.id,
      hook: hookName,
      model,
      via: 'claude-api',
      prompt: { system: systemContext, instructions, context: safeJsonParse(contextStr) },
      toolCalls: auditToolCalls,
      response: { raw: rawText, parsed },
      durationMs,
    });
    parsed._meta = {
      model,
      provider: 'claude-api',
      tokens: { input: totalInputTokens, output: totalOutputTokens, cacheRead: totalCacheRead || undefined },
      durationMs,
      toolCallCount,
    };
    return parsed;
  };

  while (true) {
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system,
      tools: tools.length > 0 ? tools : undefined,
      messages,
    });

    const usage = (response as any).usage;
    if (usage) {
      totalInputTokens += usage.input_tokens || 0;
      totalOutputTokens += usage.output_tokens || 0;
      totalCacheRead += usage.cache_read_input_tokens || 0;
      console.log(`${tag} hook:${hookName} ← tokens in=${usage.input_tokens} out=${usage.output_tokens}${usage.cache_read_input_tokens ? ` cached=${usage.cache_read_input_tokens}` : ''}`);
    }

    if (response.stop_reason === 'tool_use') {
      const toolBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      const maxToolCalls = getMaxToolCalls();
      if (toolBlocks.length === 0 || toolCallCount >= maxToolCalls) {
        if (toolCallCount >= maxToolCalls) {
          console.warn(`${tag} hook:${hookName} hit max tool calls (${maxToolCalls}), stopping`);
        }
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');
        console.log(`${tag} hook:${hookName} ← response: ${toRedactedPreview(text, 300)}`);
        return finalize(text);
      }

      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolBlock of toolBlocks) {
        toolCallCount++;
        const input = toolBlock.input as Record<string, unknown>;
        console.log(`${tag} hook:${hookName} tool: ${getRedactedToolSummary(input)}`);

        if (onProgress) {
          const status = toolCallToStatus(toolBlock.name, input);
          onProgress(status || '');
        }

        const toolStart = Date.now();
        const result = await executeTool(toolBlock.name, input, token);
        if (onToolCall) onToolCall({ name: toolBlock.name, input, result, durationMs: Date.now() - toolStart });
        auditToolCalls.push({ tool: toolBlock.name, input, result });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: result,
        });
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    console.log(`${tag} hook:${hookName} ← response: ${toRedactedPreview(text, 300)}`);
    return finalize(text);
  }
}

// ─── Codex CLI ─────────────────────────────────────────────────────

/**
 * Call a strategy hook via the `codex` CLI.
 * Uses `codex exec --json --model <model> --ephemeral -` with stdin prompt.
 * No session persistence — each invocation is ephemeral.
 * No native MCP support — tool instructions are embedded in the prompt text.
 */
async function callHookViaCodexCli(
  manifest: StrategyManifest,
  hookName: string,
  instructions: string,
  contextStr: string,
  model: string,
  _token?: string,
): Promise<HookResult> {
  const startTime = Date.now();
  const tag = `[strategy:${manifest.id}]`;

  const hookMode = hookName === 'message' ? 'tool-call' : 'intent' as const;
  const systemContext = getHookSystemContext(hookMode, 'sdk');
  const stdinContent = buildCliPrompt(hookMode, systemContext, instructions, contextStr);

  console.log(`${tag} hook:${hookName} ▸ codex exec stdin (${stdinContent.length} chars)`);
  console.log(`${tag} hook:${hookName} ▸ model: ${model}`);

  return new Promise((resolve) => {
    const args = [
      'exec',
      '--json',
      '--model', model,
      '--ephemeral',
      '-',  // read from stdin
    ];

    console.log(`${tag} hook:${hookName} ▸ CLI args: codex ${args.join(' ')}`);

    const child = execFile('codex', args, {
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      if (err) {
        console.error(`${tag} hook:${hookName} Codex CLI error: ${err.message}`);
        if (stderr) console.error(`${tag} hook:${hookName} stderr: ${toRedactedPreview(stderr, 500)}`);
        resolve({ intents: [], state: {} });
        return;
      }

      // Codex outputs JSONL — extract text from the last assistant message
      const text = extractCodexResponse(stdout);
      console.log(`${tag} hook:${hookName} ← response: ${toRedactedPreview(text, 300)}`);

      const durationMs = Date.now() - startTime;
      const parsed = parseHookResponse(text);
      parsed._meta = {
        model,
        provider: 'codex-cli',
        tokens: { input: 0, output: 0 },
        durationMs,
        toolCallCount: 0,
      };
      writeAuditEntry({
        ts: new Date().toISOString(),
        strategyId: manifest.id,
        hook: hookName,
        model,
        via: 'codex-cli',
        prompt: { system: systemContext, instructions, context: safeJsonParse(contextStr) },
        toolCalls: [],
        response: { raw: text, parsed },
        durationMs,
      });
      resolve(parsed);
    });

    if (child.stdin) {
      child.stdin.write(stdinContent);
      child.stdin.end();
    }
  });
}

/**
 * Extract the final assistant message text from Codex CLI JSONL output.
 * Codex outputs one JSON object per line. We look for the last message with role=assistant.
 */
function extractCodexResponse(stdout: string): string {
  const lines = stdout.trim().split('\n');

  // Try parsing as single JSON first (codex exec --json may output a single object)
  try {
    const single = JSON.parse(stdout);
    if (single.result) return single.result;
    if (single.message?.content) return single.message.content;
    if (typeof single.content === 'string') return single.content;
  } catch {
    // Not single JSON — try JSONL
  }

  // Parse JSONL, find last assistant message
  let lastText = '';
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.role === 'assistant' && obj.content) {
        lastText = typeof obj.content === 'string'
          ? obj.content
          : Array.isArray(obj.content)
            ? obj.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
            : '';
      }
      // Also handle { type: 'message', message: { content: '...' } } format
      if (obj.type === 'message' && obj.message?.role === 'assistant') {
        const content = obj.message.content;
        if (typeof content === 'string') lastText = content;
        else if (Array.isArray(content)) {
          lastText = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return lastText || stdout;
}

// ─── OpenAI API (OpenAI SDK) ───────────────────────────────────────

/**
 * Call a strategy hook via the OpenAI SDK.
 * Includes tool-use loop: if the model calls tools, execute them and continue.
 * Uses existing toOpenAITools() and executeTool() from mcp/tools.ts.
 */
async function callHookViaOpenAiSdk(
  manifest: StrategyManifest,
  hookName: string,
  instructions: string,
  contextStr: string,
  model: string,
  token?: string,
  onProgress?: (status: string) => void,
  onToolCall?: (entry: { name: string; input: Record<string, unknown>; result: string; durationMs: number }) => void,
): Promise<HookResult> {
  const client = await getOpenAiClient();
  const tag = `[strategy:${manifest.id}]`;
  const startTime = Date.now();
  const auditToolCalls: AuditToolCall[] = [];

  const hookMode = hookName === 'message' ? 'tool-call' : 'intent' as const;
  const systemContext = getHookSystemContext(hookMode, 'sdk');

  const tools = toOpenAITools();

  console.log(`${tag} hook:${hookName} ▸ OpenAI SDK request:`);
  console.log(`${tag} hook:${hookName} ▸ system: ${systemContext.length} chars (mode=${hookMode})`);
  console.log(`${tag} hook:${hookName} ▸ instructions: ${toRedactedPreview(instructions, 200)}`);
  console.log(`${tag} hook:${hookName} ▸ context: ${toRedactedPreview(contextStr, 300)}`);
  console.log(`${tag} hook:${hookName} ▸ tools: [${tools.map(t => t.function.name).join(', ')}] (${tools.length} tools), token: ${token ? 'yes' : 'no'}`);

  const messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: any[];
    tool_call_id?: string;
  }> = [
    { role: 'system', content: `${systemContext}\n\n${instructions}` },
    { role: 'user', content: contextStr },
  ];

  let toolCallCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const finalize = (rawText: string): HookResult => {
    const durationMs = Date.now() - startTime;
    const parsed = parseHookResponse(rawText);
    writeAuditEntry({
      ts: new Date().toISOString(),
      strategyId: manifest.id,
      hook: hookName,
      model,
      via: 'openai-api',
      prompt: { system: systemContext, instructions, context: safeJsonParse(contextStr) },
      toolCalls: auditToolCalls,
      response: { raw: rawText, parsed },
      durationMs,
    });
    parsed._meta = {
      model,
      provider: 'openai-api',
      tokens: { input: totalInputTokens, output: totalOutputTokens },
      durationMs,
      toolCallCount,
    };
    return parsed;
  };

  while (true) {
    const response = await client.chat.completions.create({
      model,
      max_tokens: 2048,
      messages: messages as any,
      tools: tools.length > 0 ? tools : undefined,
    });

    const choice = response.choices[0];
    if (!choice) {
      console.warn(`${tag} hook:${hookName} ← no choices returned`);
      return finalize('');
    }

    const usage = response.usage;
    if (usage) {
      totalInputTokens += usage.prompt_tokens || 0;
      totalOutputTokens += usage.completion_tokens || 0;
      console.log(`${tag} hook:${hookName} ← tokens in=${usage.prompt_tokens} out=${usage.completion_tokens}`);
    }

    // Check if the model wants to use tools
    if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
      const maxToolCalls = getMaxToolCalls();
      if (toolCallCount >= maxToolCalls) {
        console.warn(`${tag} hook:${hookName} hit max tool calls (${maxToolCalls}), stopping`);
        const text = choice.message.content || '';
        console.log(`${tag} hook:${hookName} ← response: ${toRedactedPreview(text, 300)}`);
        return finalize(text);
      }

      // Append assistant message with tool_calls
      messages.push({
        role: 'assistant',
        content: choice.message.content,
        tool_calls: choice.message.tool_calls,
      });

      // Execute each tool call and feed results back
      for (const toolCall of choice.message.tool_calls) {
        toolCallCount++;
        if (toolCall.type !== 'function') continue;
        const fnName = toolCall.function.name;
        let fnArgs: Record<string, unknown> = {};
        try {
          fnArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          fnArgs = {};
        }

        console.log(`${tag} hook:${hookName} tool: ${getRedactedToolSummary(fnArgs)}`);

        if (onProgress) {
          const status = toolCallToStatus(fnName, fnArgs);
          onProgress(status || '');
        }

        const toolStart = Date.now();
        const result = await executeTool(fnName, fnArgs, token);
        if (onToolCall) onToolCall({ name: fnName, input: fnArgs, result, durationMs: Date.now() - toolStart });
        auditToolCalls.push({ tool: fnName, input: fnArgs, result });
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      continue;
    }

    // No tool use — extract text and return
    const text = choice.message.content || '';
    console.log(`${tag} hook:${hookName} ← response: ${toRedactedPreview(text, 300)}`);
    return finalize(text);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Safe parse — returns object if valid JSON, raw string otherwise */
function safeJsonParse(str: string): unknown {
  try { return JSON.parse(str); } catch { return str; }
}

// ─── Progress Helpers ──────────────────────────────────────────────

/**
 * Map a tool call name + input to a human-readable progress status.
 * Returns null when no specific status applies (caller uses flavor text).
 */
export function toolCallToStatus(name: string, input: Record<string, unknown>): string | null {
  if (name === 'request_human_action') return 'requesting approval...';
  const endpoint = String(input.endpoint || '');
  const method = String(input.method || 'GET');
  if (endpoint === '/wallets') return 'checking your wallets...';
  if (endpoint.startsWith('/wallet/') && endpoint.includes('/assets')) return 'looking up assets...';
  if (endpoint === '/swap') return method === 'POST' ? 'preparing the swap...' : 'checking swap routes...';
  if (endpoint === '/send') return 'preparing the transfer...';
  if (endpoint === '/fund') return 'funding the wallet...';
  if (endpoint === '/launch') return 'launching the token...';
  if (endpoint.startsWith('/token/')) return 'looking up token info...';
  return null;
}

// ─── Entry Point ───────────────────────────────────────────────────

/**
 * Call a strategy hook by sending instructions + context to an AI model.
 * Dispatches to the correct provider based on system defaults.
 * Returns parsed intents and state, or empty defaults on error/missing hook.
 * Optional onProgress callback fires on each tool call with a human-readable status.
 */
export async function callHook(
  manifest: StrategyManifest,
  hookName: keyof StrategyManifest['hooks'],
  context: unknown,
  token?: string,
  onProgress?: (status: string) => void,
  onToolCall?: (entry: { name: string; input: Record<string, unknown>; result: string; durationMs: number }) => void,
): Promise<HookResult> {
  const instructions = manifest.hooks[hookName];
  if (!instructions) {
    return { intents: [], state: {} };
  }

  const contextStr = JSON.stringify(context);
  const provider = getDefaultSync<AiProviderMode>('ai.provider', 'claude-cli');
  const hookLabel = String(hookName);

  // Fast path: use cached tier from resolvedTiers map when available.
  // Lifecycle hooks always override to 'fast' regardless of cached tier.
  const isLifecycle = hookLabel === 'init' || hookLabel === 'shutdown';
  const cachedTier = !isLifecycle ? resolvedTiers.get(manifest.id) : undefined;
  const baseTier = cachedTier ?? selectModelTier(hookLabel, getTokenPermissionsForTier(token));
  const tier = promoteMessageTier(hookLabel, context, baseTier);
  const model = resolveModelId(MODEL_TIERS[provider][tier], provider);

  console.log(`[strategy:${manifest.id}] hook:${hookLabel} → model=${model}, tier=${tier}, provider=${provider}, context=${contextStr.length} chars, token=${token ? 'yes' : 'NO'}`);

  try {
    switch (provider) {
      case 'claude-cli':
        return await callHookViaCli(manifest, hookLabel, instructions, contextStr, model, token);
      case 'claude-api':
        return await callHookViaSdk(manifest, hookLabel, instructions, contextStr, model, token, onProgress, onToolCall);
      case 'codex-cli':
        return await callHookViaCodexCli(manifest, hookLabel, instructions, contextStr, model, token);
      case 'openai-api':
        return await callHookViaOpenAiSdk(manifest, hookLabel, instructions, contextStr, model, token, onProgress, onToolCall);
    }
  } catch (err) {
    const errMsg = getErrorMessage(err);
    console.error(`[strategy:${manifest.id}] hook:${hookLabel} FAILED: ${errMsg}`);
    return { intents: [], state: {} };
  }
}
