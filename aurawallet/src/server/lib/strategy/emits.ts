/**
 * Hook Emit Processor
 * ===================
 * Broadcasts hook emit events as app:emit WS events so the dashboard
 * can forward them to the correct app iframe via postMessage.
 */

import { HookResult, HookEmit } from './types';
import { emitWalletEvent } from '../events';

/**
 * Broadcast hook emit(s) as app:emit events.
 * Called after tick, result, and message hooks.
 */
export function processEmits(strategyId: string, hookResult: HookResult): void {
  if (!hookResult.emit) return;
  const emits: HookEmit[] = Array.isArray(hookResult.emit) ? hookResult.emit : [hookResult.emit];
  for (const e of emits) {
    emitWalletEvent('app:emit', { strategyId, channel: e.channel, data: e.data });
  }
}
