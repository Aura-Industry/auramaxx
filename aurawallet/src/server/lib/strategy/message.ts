/**
 * Message Handler
 * ===============
 * Processes human-to-app messages through the AI message hook.
 * Serial per-app (prevents state race conditions), parallel across apps.
 * Rate limited: 10 messages per 60s per app.
 */

import { StrategyManifest, MessageContext } from './types';
import { callHook } from './hooks';
import { getState, updateState, getConfigOverrides, persistState, restoreState } from './state';
import { getTokenHash } from '../auth';
import { getSessionBudget } from '../sessions';
import { processEmits } from './emits';
import { getDefaultSync, parseRateLimit } from '../defaults';
import { log } from '../pino';
import { getErrorMessage } from '../error';
import {
  startChatSession,
  logReply as sessionLogReply,
  logToolCall as sessionLogToolCall,
  logError as sessionLogError,
  endChatSession,
  type AdapterSource,
} from './session-logger';

function bypassRateLimit(): boolean {
  return process.env.BYPASS_RATE_LIMIT === 'true';
}

/** Per-app serial queue */
const queues = new Map<string, Promise<unknown>>();

/** Per-app rate limit tracking */
const rateLimits = new Map<string, number[]>();

interface MessageRequest {
  appId: string;
  message: string;
  onProgress?: (status: string) => void;
  adapter?: string;
}

interface MessageRuntime {
  manifest: StrategyManifest;
  token?: string;
}

/** Detect ticker/name lookups that should always use /token/search first. */
function isTickerLookup(message: string): boolean {
  const lower = message.toLowerCase();
  const hasTickerSymbol = /\$[a-z0-9]{2,}/i.test(message);
  const hasTokenIntent = /\b(token|ticker|market cap|mcap|price|liquidity|volume|fdv)\b/.test(lower);
  const hasContractAddress = /0x[a-fA-F0-9]{6,}/.test(message);
  return !hasContractAddress && (hasTickerSymbol || hasTokenIntent);
}

/**
 * Guardrail: if the model deflects a ticker lookup to external sites without
 * using tools, force one retry with explicit /token/search instruction.
 */
function shouldRetryTickerLookup(
  message: string,
  reply: string | null,
  toolCallCount?: number,
): boolean {
  if (!isTickerLookup(message) || !reply) return false;
  if ((toolCallCount || 0) > 0) return false;

  const lower = reply.toLowerCase();
  const externalRedirect = /\b(coingecko|coinmarketcap|dextools|dexscreener|basescan)\b/.test(lower);
  const claimsUnavailable = /\b(don't have|do not have|can't|cannot|unable)\b/.test(lower)
    && /\b(search|market cap|data)\b/.test(lower);
  const asksForAddressFirst = /\b(need|provide|share)\b.{0,60}\b(contract address|0x)\b/.test(lower);
  const mentionsSearchUnavailable = /\b(no|not)\b.{0,40}\b(token search|search endpoint)\b/.test(lower);

  return externalRedirect || claimsUnavailable || asksForAddressFirst || mentionsSearchUnavailable;
}

/**
 * Queue a message for processing. Serial per-app, parallel across apps.
 * Returns the reply (or null) once processing completes.
 */
export function processMessage(
  req: MessageRequest,
  runtime: MessageRuntime,
): Promise<{ reply: string | null; error?: string }> {
  const prev = queues.get(req.appId) || Promise.resolve();
  const next = prev.then(() => handleMessage(req, runtime)).catch((err) => {
    const msg = getErrorMessage(err);
    return { reply: null, error: msg };
  });
  queues.set(req.appId, next);
  return next;
}

/**
 * Process a single message: rate limit check, build context, call hook, update state.
 */
async function handleMessage(
  req: MessageRequest,
  runtime: MessageRuntime,
): Promise<{ reply: string | null; error?: string }> {
  const { appId, message } = req;
  const { manifest } = runtime;
  const tag = `[strategy:${appId}]`;

  // Rate limit check (bypassed in dev mode)
  if (!bypassRateLimit()) {
    const { max: RATE_LIMIT, windowMs: RATE_WINDOW_MS } = parseRateLimit(getDefaultSync('rate.app_message', '10,60000'));
    const now = Date.now();
    const timestamps = rateLimits.get(appId) || [];
    const recent = timestamps.filter(t => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      console.warn(`${tag} message rate limited (${recent.length}/${RATE_LIMIT} in ${RATE_WINDOW_MS / 1000}s)`);
      return { reply: null, error: 'Rate limited — too many messages' };
    }
    recent.push(now);
    rateLimits.set(appId, recent);
  }

  // Build context
  try {
    await restoreState(appId);
  } catch (err) {
    log.warn({ err, appId }, 'state restore failed before message');
  }
  const state = getState(appId);
  const configOverrides = await getConfigOverrides(appId);
  const config = { ...manifest.config, ...configOverrides };

  const context: MessageContext = {
    message,
    appId,
    state,
    config,
    permissions: manifest.permissions,
    budget: runtime.token ? getSessionBudget(getTokenHash(runtime.token)) : { limits: {}, spent: {}, remaining: {} },
  };

  console.log(`${tag} message → "${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"`);

  // Start session logging
  const sessionId = startChatSession(appId, (req.adapter || 'unknown') as AdapterSource, message);
  const hookStart = Date.now();

  // Tool call callback for session logging
  const onToolCall = (entry: { name: string; input: Record<string, unknown>; result: string; durationMs: number }) => {
    sessionLogToolCall(sessionId, entry);
  };

  try {
    // Call message hook
    let result = await callHook(manifest, 'message', context, runtime.token, req.onProgress, onToolCall);

    const initialReply = result.reply || result.log || null;
    if (shouldRetryTickerLookup(message, initialReply, result._meta?.toolCallCount)) {
      const retryContext: MessageContext & {
        retry?: { reason: string; requiredToolCall: string };
      } = {
        ...context,
        retry: {
          reason: 'Ticker/name lookup response skipped token search guardrail.',
          requiredToolCall: 'wallet_api GET /token/search?q=<token>&chain=<chain> before asking for a contract address or external website.',
        },
      };
      result = await callHook(manifest, 'message', retryContext, runtime.token, req.onProgress, onToolCall);
    }

    const durationMs = Date.now() - hookStart;

    // Update state if the hook returned state changes
    if (result.state && Object.keys(result.state).length > 0) {
      updateState(appId, result.state);
      await persistState(appId).catch((err) => {
        log.warn({ err, appId }, 'state persistence failed after message');
      });
      console.log(`${tag} message state updated: ${JSON.stringify(result.state).slice(0, 200)}`);
    }

    // Broadcast any emit events from the message hook
    processEmits(appId, result);

    // Process intents if any (dynamic import to avoid circular dependency with engine)
    if (result.intents && result.intents.length > 0) {
      console.log(`${tag} message produced ${result.intents.length} intent(s)`);
      try {
        const { processIntents } = await import('./tick');
        await processIntents(manifest, result.intents, config, runtime.token, 0);
        await persistState(appId).catch((err) => {
          log.warn({ err, appId }, 'state persistence failed after message intents');
        });
      } catch (err) {
        console.error(`${tag} message intent processing error:`, err);
      }
    }

    // Extract reply: prefer reply field, fall back to log
    const reply = result.reply || result.log || null;
    console.log(`${tag} message ← reply: ${reply ? reply.slice(0, 200) : '(none)'}`);

    // Log reply with metadata from the AI provider (model, tokens, timing)
    const meta = result._meta;
    sessionLogReply(sessionId, reply, {
      model: meta?.model,
      tokens: meta?.tokens ? meta.tokens.input + meta.tokens.output : undefined,
      durationMs,
      provider: meta?.provider,
      costUsd: meta?.costUsd,
      inputTokens: meta?.tokens?.input,
      outputTokens: meta?.tokens?.output,
      cacheReadTokens: meta?.tokens?.cacheRead,
      toolCallCount: meta?.toolCallCount,
    });
    // Don't end session here — it stays alive for idle-timeout grouping.
    // Sessions are closed when: (a) idle timeout expires on next startChatSession(),
    // (b) graceful shutdown via endAllActiveSessions(), or (c) crash recovery.

    return { reply };
  } catch (err) {
    sessionLogError(sessionId, err);
    endChatSession(sessionId, 'error');
    throw err;
  }
}

/** Clear the message queue for a app (e.g. on disable) */
export function clearMessageQueue(appId: string): void {
  queues.delete(appId);
  rateLimits.delete(appId);
}

/** Clear all message queues (e.g. on engine shutdown) */
export function clearAllMessageQueues(): void {
  queues.clear();
  rateLimits.clear();
}
