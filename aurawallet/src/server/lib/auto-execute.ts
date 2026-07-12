/**
 * Shared auto-execute helper for pre-computed actions.
 *
 * When a human approves a request that includes a pre-computed action
 * (endpoint + method + body), this helper executes it with the newly-minted
 * token and feeds results back to the app AI via WebSocket.
 *
 * Used by both resolveAction() (for /actions) and auth resolution (for /auth).
 */

import { emitWalletEvent } from './events';
import { handleAppMessage } from './strategy/engine';
import { getDefaultSync, parseRateLimit } from './defaults';
import { logger } from './logger';
import { getErrorMessage } from './error';

export interface AutoExecuteAction {
  endpoint: string;
  method: string;
  body?: Record<string, unknown>;
}

export interface AutoExecuteContext {
  requestId: string;
  agentId: string;
  summary?: string;
  token: string;
}

export interface AutoExecuteResult {
  executed: boolean;
  success?: boolean;
  statusCode?: number;
  result?: unknown;
  error?: string;
}

/** Track auto-execute callback depth per app to prevent infinite loops */
const callbackCounts = new Map<string, number[]>();

export function canFireCallback(appId: string): boolean {
  const { max: MAX_CALLBACKS, windowMs: CALLBACK_WINDOW_MS } = parseRateLimit(getDefaultSync('rate.app_callback', '3,120000'));
  const now = Date.now();
  const timestamps = callbackCounts.get(appId) || [];
  const recent = timestamps.filter(t => now - t < CALLBACK_WINDOW_MS);
  if (recent.length >= MAX_CALLBACKS) return false;
  recent.push(now);
  callbackCounts.set(appId, recent);
  return true;
}

/**
 * Execute a pre-computed action with the given token and feed results back.
 */
export async function autoExecuteAction(
  action: AutoExecuteAction,
  ctx: AutoExecuteContext,
): Promise<AutoExecuteResult> {
  if (!action.endpoint || !action.method) {
    return { executed: false };
  }

  const appId = (ctx.agentId || '').replace(/^app:/, '');

  try {
    const actionUrl = `http://127.0.0.1:4242${action.endpoint}`;
    const actionRes = await fetch(actionUrl, {
      method: action.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ctx.token}`,
      },
      body: action.method === 'POST' && action.body
        ? JSON.stringify(action.body)
        : undefined,
    });
    const actionResult = await actionRes.text();
    let parsedResult: unknown;
    try { parsedResult = JSON.parse(actionResult); } catch { parsedResult = actionResult; }

    emitWalletEvent('app:emit', {
      strategyId: appId,
      channel: 'action:executed',
      data: {
        requestId: ctx.requestId,
        approved: true,
        action: { endpoint: action.endpoint, method: action.method },
        status: actionRes.ok ? 'success' : 'error',
        statusCode: actionRes.status,
        result: parsedResult,
      },
    });

    logger.actionResolved(ctx.requestId, 'action:auto-execute', actionRes.ok, 'system');

    // Feed result back to app AI for a contextual follow-up message
    if (appId) {
      const summary = ctx.summary || 'action';
      const systemMsg = actionRes.ok
        ? `[SYSTEM] Action "${summary}" approved and executed successfully.\nResult: ${JSON.stringify(parsedResult).slice(0, 500)}\n\nIf there are more steps needed to complete the user's original request, use your tools NOW (wallet_api or request_human_action) to continue. Do not just describe what you will do — do it.`
        : `[SYSTEM] Action "${summary}" approved but failed (${actionRes.status}).\nError: ${JSON.stringify(parsedResult).slice(0, 500)}\n\nInvestigate the error using wallet_api and retry with request_human_action if you can fix the issue. Do NOT just explain the error — try to fix it.`;

      if (canFireCallback(appId)) {
        handleAppMessage(appId, systemMsg).then(({ reply }) => {
          if (reply) {
            emitWalletEvent('app:emit', {
              strategyId: appId,
              channel: 'agent:message',
              data: { message: reply },
            });
          }
        }).catch((err) => { logger.actionResolved(ctx.requestId, 'action:callback-error', false, getErrorMessage(err)); });
      } else {
        logger.actionResolved(ctx.requestId, 'action:callback-limit', true, `app:${appId}`);
      }
    }

    return {
      executed: true,
      success: actionRes.ok,
      statusCode: actionRes.status,
      result: parsedResult,
    };
  } catch (err) {
    const errMsg = getErrorMessage(err);
    emitWalletEvent('app:emit', {
      strategyId: appId,
      channel: 'action:executed',
      data: {
        requestId: ctx.requestId,
        approved: true,
        action: { endpoint: action.endpoint, method: action.method },
        status: 'error',
        error: errMsg,
      },
    });

    // Feed error back to app AI
    if (appId) {
      const summary = ctx.summary || 'action';
      const systemMsg = `[SYSTEM] Action "${summary}" approved but execution failed.\nError: ${errMsg}\n\nInvestigate the error using wallet_api and retry with request_human_action if you can fix the issue. Do NOT just explain the error — try to fix it.`;

      if (canFireCallback(appId)) {
        handleAppMessage(appId, systemMsg).then(({ reply }) => {
          if (reply) {
            emitWalletEvent('app:emit', {
              strategyId: appId,
              channel: 'agent:message',
              data: { message: reply },
            });
          }
        }).catch((err) => { logger.actionResolved(ctx.requestId, 'action:callback-error', false, getErrorMessage(err)); });
      } else {
        logger.actionResolved(ctx.requestId, 'action:callback-limit', false, `app:${appId}`);
      }
    }

    return { executed: true, success: false, error: errMsg };
  }
}
