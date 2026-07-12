/**
 * Strategy Engine — Public API
 * ============================
 * Re-exports the main engine functions for use by routes and server startup.
 */

export {
  startEngine,
  stopEngine,
  enableStrategy,
  disableStrategy,
  reloadStrategies,
  getStrategies,
  getRuntime,
  resolveApproval,
  getPendingApprovals,
  isEngineStarted,
  emitStrategyEvent,
  runExternalTickCycle,
  reconcileWorkspaceStrategies,
  persistEngineStateSnapshot,
  enqueueAppMessage,
  waitForQueuedAppMessage,
  processPendingAppMessages,
  STRATEGY_ENABLED_STORAGE_KEY,
} from './engine';
export { getState, updateState, getConfigOverrides, setConfigOverrides } from './state';
export type { StrategyManifest, StrategyRuntime, StrategyStatus, TickTier, Intent, Action, ActionOutcome, HookResult } from './types';
