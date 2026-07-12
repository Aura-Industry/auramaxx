/**
 * Tick Runner
 * ===========
 * Orchestrates a single tick for a strategy:
 * 1. Fetch sources
 * 2. Call tick hook → intents + state
 * 3. Approve (if config.approve)
 * 4. For each intent → call execute hook → action
 * 5. Execute action → outcome
 * 6. Call result hook → state updates + follow-ups
 * 7. Follow-up intents re-enter step 3 (depth limit: 3)
 */

import { createHash } from 'crypto';
import { StrategyManifest, StrategyConfig, HookResult, Intent, Action, ActionOutcome } from './types';
import { fetchAllSources } from './sources';
import { callHook } from './hooks';
import { executeAction } from './executor';
import { getState, updateState, getConfigOverrides, restoreState, persistState } from './state';
import { requestHumanApproval, requestActionToken } from './engine';
import { emitWalletEvent } from '../events';
import { getTokenHash } from '../auth';
import { getSessionBudget } from '../sessions';
import { processEmits } from './emits';
import { getDefaultSync } from '../defaults';
import {
  startTickSession,
  logTickEvent,
  logError as sessionLogError,
  endTickSession,
} from './session-logger';
import { getErrorMessage } from '../error';

/**
 * Emit a strategy event via the existing event system.
 */
function emitStrategyEvent(type: string, strategyId: string, data: Record<string, unknown>): void {
  emitWalletEvent(type, { strategyId, ...data });
}

function getMaxFollowupDepth(): number {
  return getDefaultSync<number>('ai.max_followup_depth', 3);
}

/** Last context hash per strategy — used to skip duplicate LLM calls */
const lastContextHash = new Map<string, string>();

/** Hash a string with SHA-256 (fast, collision-resistant) */
function hashContext(contextStr: string): string {
  return createHash('sha256').update(contextStr).digest('hex').slice(0, 16);
}

/** Clear context hash for a strategy (e.g. on disable/reset) */
export function clearContextHash(id: string): void {
  lastContextHash.delete(id);
}

/** Clear all context hashes (e.g. on engine shutdown) */
export function clearAllContextHashes(): void {
  lastContextHash.clear();
}

/**
 * Run a single tick for a strategy.
 */
export async function runTick(
  manifest: StrategyManifest,
  token?: string,
): Promise<void> {
  const startTime = Date.now();
  const tag = `[strategy:${manifest.id}]`;
  const sessionId = startTickSession(manifest.id);

  // Re-read state from DB to pick up changes from app UI (e.g. human moves)
  await restoreState(manifest.id);
  const state = getState(manifest.id);
  const configOverrides = await getConfigOverrides(manifest.id);
  const config: StrategyConfig = { ...manifest.config, ...configOverrides };

  console.log(`${tag} ── tick start (sources=${manifest.sources.length})`);

  // 1. Fetch sources
  let sourceData: Record<string, unknown[]>;
  try {
    const srcStart = Date.now();
    sourceData = await fetchAllSources(manifest, config, null, token);
    const srcKeys = Object.keys(sourceData);
    const srcCounts = srcKeys.map(k => `${k}:${sourceData[k].length}`).join(', ');
    console.log(`${tag}   sources fetched in ${Date.now() - srcStart}ms → {${srcCounts}}`);
    logTickEvent(sessionId, 'Sources', `${srcCounts} (${Date.now() - srcStart}ms)`);
  } catch (err) {
    const errorAction = config.errors?.sourceFail || 'skip';
    const errMsg = getErrorMessage(err);
    console.error(`${tag}   source fetch FAILED: ${errMsg} (policy=${errorAction})`);
    emitStrategyEvent('strategy:error', manifest.id, { error: errMsg, phase: 'sources' });
    sessionLogError(sessionId, err);

    if (errorAction === 'pause') {
      endTickSession(sessionId, 'error', Date.now() - startTime);
      throw err; // Let engine handle pause
    }
    // skip or retry — for skip, just return; retry handled by engine
    if (errorAction === 'skip') {
      endTickSession(sessionId, 'error', Date.now() - startTime);
      return;
    }
    endTickSession(sessionId, 'error', Date.now() - startTime);
    throw err;
  }

  // 2. Build context and check if it changed since last tick
  const context = {
    sources: sourceData,
    positions: state.positions || [],
    state,
    config,
    permissions: manifest.permissions,
    budget: token ? getSessionBudget(getTokenHash(token)) : { limits: {}, spent: {}, remaining: {} },
  };
  const contextStr = JSON.stringify(context);
  const contextHash = hashContext(contextStr);
  const prevHash = lastContextHash.get(manifest.id);

  if (prevHash === contextHash) {
    const dur = Date.now() - startTime;
    console.log(`${tag} ── tick skipped in ${dur}ms (context unchanged, hash=${contextHash})`);
    logTickEvent(sessionId, 'Context', `unchanged (hash=${contextHash}), skipped AI call`);
    endTickSession(sessionId, 'completed', dur);
    return;
  }

  // 3. Call tick hook
  console.log(`${tag}   calling tick hook...`);
  const hookStart = Date.now();
  const tickResult = await callHook(manifest, 'tick', context, token);
  lastContextHash.set(manifest.id, contextHash);
  const hookDur = Date.now() - hookStart;
  console.log(`${tag}   tick hook returned in ${hookDur}ms → intents=${tickResult.intents.length}, stateKeys=${Object.keys(tickResult.state).join(',') || '(none)'}`);
  logTickEvent(sessionId, 'Hook', `${hookDur}ms, intents=${tickResult.intents.length}`);

  // Update state from tick hook
  if (tickResult.state && Object.keys(tickResult.state).length > 0) {
    updateState(manifest.id, tickResult.state);
    await persistState(manifest.id);
    console.log(`${tag}   state updated + persisted: ${JSON.stringify(tickResult.state).slice(0, 200)}`);
  }

  // Broadcast any emit events from the tick hook
  processEmits(manifest.id, tickResult);

  if (tickResult.log) {
    console.log(`${tag}   hook log: ${tickResult.log}`);
  }

  if (!tickResult.intents || tickResult.intents.length === 0) {
    const dur = Date.now() - startTime;
    console.log(`${tag} ── tick done in ${dur}ms (no intents)`);
    logTickEvent(sessionId, 'Intents', 'none');
    endTickSession(sessionId, 'completed', dur);
    emitStrategyEvent('strategy:tick', manifest.id, {
      intents: 0,
      duration: dur,
      state: getState(manifest.id),
    });
    return; // Nothing to do
  }

  console.log(`${tag}   processing ${tickResult.intents.length} intent(s): ${tickResult.intents.map(i => i.type || 'unknown').join(', ')}`);

  // Process intents (with follow-up support)
  await processIntents(manifest, tickResult.intents, config, token, 0);

  const dur = Date.now() - startTime;
  console.log(`${tag} ── tick done in ${dur}ms (${tickResult.intents.length} intents processed)`);
  logTickEvent(sessionId, 'Intents', `${tickResult.intents.length} processed`);
  endTickSession(sessionId, 'completed', dur);
  emitStrategyEvent('strategy:tick', manifest.id, {
    intents: tickResult.intents.length,
    duration: dur,
    state: getState(manifest.id),
  });
}

/**
 * Process intents through approval → execute → result pipeline.
 * Supports recursive follow-ups with depth limit.
 */
export async function processIntents(
  manifest: StrategyManifest,
  intents: Intent[],
  config: StrategyConfig,
  token?: string,
  depth: number = 0,
): Promise<void> {
  const tag = `[strategy:${manifest.id}]`;

  const maxDepth = getMaxFollowupDepth();
  if (depth >= maxDepth) {
    console.warn(`${tag}   follow-up depth limit reached (${maxDepth}), stopping`);
    return;
  }

  if (depth > 0) {
    console.log(`${tag}   processing ${intents.length} follow-up intent(s) at depth ${depth}`);
  }

  // 3. Batch approve (if config.approve and no per-intent permissions)
  // Intents with `permissions` array use per-action tokens instead of batch approval
  const batchIntents = intents.filter(i => !i.permissions || !Array.isArray(i.permissions));
  const actionIntents = intents.filter(i => i.permissions && Array.isArray(i.permissions));

  let batchApproved = true;
  if (config.approve && batchIntents.length > 0) {
    console.log(`${tag}   waiting for batch approval of ${batchIntents.length} intent(s)...`);
    emitStrategyEvent('strategy:approve', manifest.id, { intents: batchIntents });
    batchApproved = await requestHumanApproval(manifest.id, batchIntents);
    if (!batchApproved) {
      console.log(`${tag}   batch intents REJECTED or timed out`);
      // Still process action intents (they get their own approval)
      if (actionIntents.length === 0) return;
    } else {
      console.log(`${tag}   batch intents APPROVED`);
    }
  }

  // Build the ordered list: approved batch intents + per-action intents
  const toProcess: Array<{ intent: Intent; intentToken?: string }> = [];

  // Add batch-approved intents (use strategy token). If approval was required and rejected, skip.
  const approvedBatchIntents = batchApproved ? batchIntents : [];
  for (const intent of approvedBatchIntents) {
    toProcess.push({ intent, intentToken: token });
  }

  // Per-action intents: each gets its own approval + scoped token
  for (const intent of actionIntents) {
    console.log(`${tag}   [${intent.type}] requesting per-action token...`);
    const result = await requestActionToken(manifest.id, intent);
    if (!result.approved) {
      console.log(`${tag}   [${intent.type}] action REJECTED or timed out`);
      continue;
    }
    console.log(`${tag}   [${intent.type}] action APPROVED (temp token)`);
    toProcess.push({ intent, intentToken: result.token });
  }

  // 4-6. Execute each intent
  const followUps: Intent[] = [];
  let stateUpdated = false;

  for (let i = 0; i < toProcess.length; i++) {
    const { intent, intentToken } = toProcess[i];
    const intentLabel = intent.type || `#${i}`;

    try {
      // 4. Determine action: pre-computed or via execute hook
      let action: Action | null;
      const intentAction = intent.action as Record<string, unknown> | undefined;

      if (intentAction && typeof intentAction.endpoint === 'string' && typeof intentAction.method === 'string') {
        // Pre-computed action — skip execute hook
        action = {
          endpoint: intentAction.endpoint,
          method: intentAction.method,
          body: intentAction.body as Record<string, unknown> | undefined,
          headers: intentAction.headers as Record<string, string> | undefined,
        };
        console.log(`${tag}   [${intentLabel}] using pre-computed action`);
      } else if (manifest.hooks.execute) {
        // Call execute hook
        console.log(`${tag}   [${intentLabel}] calling execute hook...`);
        const execStart = Date.now();
        const execResult = await callHook(manifest, 'execute', {
          intent,
          config,
        });
        console.log(`${tag}   [${intentLabel}] execute hook returned in ${Date.now() - execStart}ms`);
        action = extractAction(execResult);
      } else {
        console.warn(`${tag}   [${intentLabel}] no action and no execute hook, skipping`);
        continue;
      }

      if (!action) {
        console.warn(`${tag}   [${intentLabel}] execute hook returned NO action, skipping`);
        continue;
      }

      console.log(`${tag}   [${intentLabel}] action: ${action.method} ${action.endpoint}${action.body ? ' (has body)' : ''}`);

      // 5. Execute action (use intentToken which may be a per-action temp token)
      let outcome: ActionOutcome;
      try {
        const actionStart = Date.now();
        outcome = await executeAction(action, manifest.id, intentToken, manifest.allowedHosts);
        const actionMs = Date.now() - actionStart;
        if (outcome.success) {
          console.log(`${tag}   [${intentLabel}] action OK in ${actionMs}ms`);
        } else {
          console.error(`${tag}   [${intentLabel}] action FAILED in ${actionMs}ms: ${outcome.error}`);
        }
      } catch (err) {
        const errMsg = getErrorMessage(err);
        outcome = { success: false, error: errMsg };
        const errorAction = config.errors?.executeFail || 'skip';

        console.error(`${tag}   [${intentLabel}] action threw: ${errMsg} (policy=${errorAction})`);
        emitStrategyEvent('strategy:error', manifest.id, {
          error: errMsg,
          phase: 'execute',
          intent,
        });

        if (errorAction === 'pause') {
          throw err;
        }
        if (errorAction === 'skip') continue;
        // retry handled by engine
      }

      // 6. Call result hook
      if (manifest.hooks.result) {
        console.log(`${tag}   [${intentLabel}] calling result hook...`);
        const resStart = Date.now();
        const resultResult = await callHook(manifest, 'result', {
          intent,
          action,
          outcome,
          state: getState(manifest.id),
        });
        console.log(`${tag}   [${intentLabel}] result hook returned in ${Date.now() - resStart}ms → followUps=${resultResult.intents.length}, stateKeys=${Object.keys(resultResult.state).join(',') || '(none)'}`);

        if (resultResult.state && Object.keys(resultResult.state).length > 0) {
          updateState(manifest.id, resultResult.state);
          stateUpdated = true;
        }

        // Collect follow-up intents
        if (resultResult.intents && resultResult.intents.length > 0) {
          followUps.push(...resultResult.intents);
        }

        // Broadcast any emit events from the result hook
        processEmits(manifest.id, resultResult);

        if (resultResult.log) {
          console.log(`${tag}   [${intentLabel}] result log: ${resultResult.log}`);
        }
      }
    } catch (err) {
      const errMsg = getErrorMessage(err);
      console.error(`${tag}   [${intentLabel}] processing error: ${errMsg}`);
      emitStrategyEvent('strategy:error', manifest.id, {
        error: errMsg,
        phase: 'intent',
        intent,
      });
    }
  }

  // Process follow-up intents (recursive with depth limit)
  if (followUps.length > 0) {
    console.log(`${tag}   ${followUps.length} follow-up intent(s) queued`);
    await processIntents(manifest, followUps, config, token, depth + 1);
  }

  if (stateUpdated) {
    await persistState(manifest.id).catch((err) => {
      console.warn(`${tag}   state persistence failed after intents:`, err);
    });
  }
}

/**
 * Extract an Action from the execute hook result.
 * The hook might return the action in intents[0] or directly in the response.
 */
function extractAction(hookResult: HookResult): Action | null {
  // Try intents[0] first (agent returned action as an intent)
  if (hookResult.intents && hookResult.intents.length > 0) {
    const intent = hookResult.intents[0];
    if (intent.endpoint && intent.method) {
      return {
        endpoint: intent.endpoint as string,
        method: intent.method as string,
        body: intent.body as Record<string, unknown> | undefined,
        headers: intent.headers as Record<string, string> | undefined,
      };
    }
  }

  // Try state as action (agent put action params in state)
  const state = hookResult.state;
  if (state && state.endpoint && state.method) {
    return {
      endpoint: state.endpoint as string,
      method: state.method as string,
      body: state.body as Record<string, unknown> | undefined,
      headers: state.headers as Record<string, string> | undefined,
    };
  }

  return null;
}
