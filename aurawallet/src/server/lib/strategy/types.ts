/**
 * Strategy Engine Types
 * =====================
 * Core type definitions for the cron-based strategy engine.
 */

/** Tick tier determines how often a strategy runs */
export type TickTier = 'sniper' | 'active' | 'standard' | 'slow' | 'maintenance';

/** Interval in ms for each tick tier */
export const TICK_INTERVALS: Record<TickTier, number> = {
  sniper: 10_000,
  active: 30_000,
  standard: 60_000,
  slow: 300_000,
  maintenance: 3_600_000,
};

/** External data source definition from app.md manifest */
export interface SourceDef {
  id: string;
  url: string;
  method: 'GET' | 'POST';
  body?: Record<string, unknown>;
  auth?: 'none' | 'header' | 'query' | 'bearer';
  header?: string;
  query?: string;
  key?: string;
  depends?: string;
  job?: string;
  optional?: boolean;
  rateLimit?: string;
  select?: Record<string, string>;
}

/** API key definition from app.md manifest */
export interface KeyDef {
  id: string;
  name: string;
  required?: boolean;
  description?: string;
}

/** Job definition for multi-interval strategies */
export interface JobDef {
  id: string;
  ticker: TickTier;
  sources?: string[];
}

/** Hook instructions from app.md manifest */
export interface HooksDef {
  init?: string;
  tick?: string;
  execute?: string;
  result?: string;
  shutdown?: string;
  message?: string;
}

/** Error handling config */
export interface ErrorConfig {
  sourceFail?: 'skip' | 'retry' | 'pause';
  executeFail?: 'skip' | 'retry' | 'pause';
  maxRetries?: number;
  cooldown?: string;
}

/** Strategy config from app.md manifest */
export interface StrategyConfig {
  wallet?: string;
  approve?: boolean;
  errors?: ErrorConfig;
  [key: string]: unknown;
}

/** Parsed strategy manifest from app.md */
export interface StrategyManifest {
  id: string;
  name: string;
  icon?: string;
  category?: string;
  size?: string;
  autoStart?: boolean;
  ticker?: TickTier;
  jobs?: JobDef[];
  sources: SourceDef[];
  keys?: KeyDef[];
  hooks: HooksDef;
  config: StrategyConfig;
  permissions: string[];
  limits?: { fund?: number; send?: number };
  allowedHosts?: string[];
}

/** Runtime state for an active strategy */
export interface StrategyRuntime {
  manifest: StrategyManifest;
  enabled: boolean;
  running: boolean;
  token?: string;
  tokenHash?: string;
  lastTick?: number;
  lastError?: string;
  errorCount: number;
  pausedUntil?: number;
  authFailureCount?: number;
}

/** Intent — what the agent wants to do (high-level) */
export interface Intent {
  type: string;
  [key: string]: unknown;
}

/** Action — how to do it (API call the engine executes) */
export interface Action {
  endpoint: string;
  method: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** Result of executing an action */
export interface ActionOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
}

/** A single emission from a hook to push data to the app iframe */
export interface HookEmit {
  channel: string;
  data: unknown;
}

/** Metadata from the AI provider, attached by callHook() */
export interface HookMeta {
  model: string;
  provider: string;
  tokens: { input: number; output: number; cacheRead?: number };
  durationMs: number;
  costUsd?: number;
  toolCallCount: number;
}

/** Result from calling a hook (LLM response) */
export interface HookResult {
  intents: Intent[];
  state: Record<string, unknown>;
  log?: string;
  reply?: string;
  emit?: HookEmit | HookEmit[];
  /** AI provider metadata — model, tokens, timing. Attached by callHook(). */
  _meta?: HookMeta;
}

/** Context passed to the tick hook */
export interface TickContext {
  sources: Record<string, unknown[]>;
  positions?: unknown[];
  state: Record<string, unknown>;
  config: StrategyConfig;
  wallets?: unknown[];
  permissions: string[];
  budget: { limits: Record<string, number>; spent: Record<string, number>; remaining: Record<string, number> };
}

/** Context passed to the execute hook */
export interface ExecuteContext {
  intent: Intent;
  wallet?: unknown;
  config: StrategyConfig;
}

/** Context passed to the result hook */
export interface ResultContext {
  intent: Intent;
  action: Action;
  outcome: ActionOutcome;
  state: Record<string, unknown>;
}

/** Context passed to the init hook */
export interface InitContext {
  config: StrategyConfig;
  wallets?: unknown[];
  state: Record<string, unknown>;
  storage?: Record<string, unknown>;
}

/** Context passed to the shutdown hook */
export interface ShutdownContext {
  positions?: unknown[];
  state: Record<string, unknown>;
}

/** Context passed to the message hook */
export interface MessageContext {
  message: string;
  appId: string;
  state: Record<string, unknown>;
  config: StrategyConfig;
  permissions: string[];
  budget: { limits: Record<string, number>; spent: Record<string, number>; remaining: Record<string, number> };
}

/** Strategy status for REST API */
export interface StrategyStatus {
  id: string;
  name: string;
  icon?: string;
  ticker?: TickTier;
  enabled: boolean;
  running: boolean;
  lastTick?: number;
  lastError?: string;
  errorCount: number;
  pausedUntil?: number;
}

/** Pending approval for dashboard/REST */
export interface PendingApproval {
  id: string;
  strategyId: string;
  intents: Intent[];
  createdAt: number;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}
