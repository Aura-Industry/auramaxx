/**
 * AI Client Module
 * ================
 * Multi-provider AI abstraction supporting:
 *   - Claude CLI (subscription/OAuth via `claude` binary)
 *   - Claude API (direct Anthropic SDK with API key)
 *   - Codex CLI (OpenAI's `codex` binary)
 *   - OpenAI API (direct OpenAI SDK with API key)
 *
 * Provider selection read from system defaults (ai.provider); model auto-derived per provider.
 * Extracted from strategy/hooks.ts so it's reusable beyond strategies.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { execFile } from 'child_process';
import {
  ensureApiKeysMigrated,
  hasActiveApiKeyCredential,
  readApiKeyValueByService,
} from './apikey-migration';
import { getDefault, onDefaultChanged } from './defaults';

// ─── Types ─────────────────────────────────────────────────────────

export type AiProviderMode = 'claude-cli' | 'claude-api' | 'codex-cli' | 'openai-api';

export type ModelTier = 'fast' | 'standard' | 'powerful';

export interface ProviderStatus {
  mode: AiProviderMode;
  label: string;
  available: boolean;
  reason: string;
  models: string[];
}

// ─── Model Maps ────────────────────────────────────────────────────

/** Claude model short names → full SDK model IDs */
const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-5-20250929',
  opus: 'claude-opus-4-6',
};

/** Codex/OpenAI model short names → full SDK model IDs */
const CODEX_MODEL_MAP: Record<string, string> = {
  'codex-mini': 'gpt-5.1-codex-mini',
  'codex': 'gpt-5.3-codex',
  'codex-max': 'gpt-5.1-codex-max',
};

/** Available models per provider */
export const PROVIDER_MODELS: Record<AiProviderMode, string[]> = {
  'claude-cli': ['haiku', 'sonnet', 'opus'],
  'claude-api': ['haiku', 'sonnet', 'opus'],
  'codex-cli': ['codex-mini', 'codex', 'codex-max'],
  'openai-api': ['codex-mini', 'codex', 'codex-max'],
};

/** Model tiers per provider — fast/standard/powerful mapped to model short names */
export const MODEL_TIERS: Record<AiProviderMode, Record<ModelTier, string>> = {
  'claude-cli':  { fast: 'haiku', standard: 'sonnet', powerful: 'opus' },
  'claude-api':  { fast: 'haiku', standard: 'sonnet', powerful: 'opus' },
  'codex-cli':   { fast: 'codex-mini', standard: 'codex', powerful: 'codex-max' },
  'openai-api':  { fast: 'codex-mini', standard: 'codex', powerful: 'codex-max' },
};

/** Permissions that trigger the 'powerful' tier (financial operations) */
const POWERFUL_PERMISSIONS = new Set(['swap', 'send:hot', 'send:temp', 'fund', 'launch', 'admin:*']);

/** Permissions that trigger the 'standard' tier (write operations) */
const STANDARD_PERMISSIONS = new Set(['wallet:create:hot', 'wallet:create:temp']);

/**
 * Select a model tier based on hook name and token permissions.
 * - init/shutdown → fast (lightweight lifecycle hooks)
 * - Financial or admin permissions → powerful
 * - Write permissions → standard
 * - No token or read-only → fast
 */
export function selectModelTier(hookName: string, permissions: string[]): ModelTier {
  // Lifecycle hooks always use fast tier
  if (hookName === 'init' || hookName === 'shutdown') return 'fast';

  // Check for powerful-tier permissions
  for (const perm of permissions) {
    if (POWERFUL_PERMISSIONS.has(perm)) return 'powerful';
  }

  // Check for standard-tier permissions
  for (const perm of permissions) {
    if (STANDARD_PERMISSIONS.has(perm)) return 'standard';
  }

  // No token or read-only permissions
  return 'fast';
}

// ─── Cached Clients ────────────────────────────────────────────────

let cachedAnthropicClient: Anthropic | null = null;
let cachedOpenAiClient: OpenAI | null = null;

/** @internal Reset cached clients (for testing only) */
export function __resetCachedClient() {
  cachedAnthropicClient = null;
  cachedOpenAiClient = null;
}

// Reset cached clients when provider changes
onDefaultChanged('ai.provider', () => {
  cachedAnthropicClient = null;
  cachedOpenAiClient = null;
});

// ─── Provider & Model Selection ────────────────────────────────────

/**
 * Get the active AI provider mode from system defaults.
 */
export async function getProviderMode(): Promise<AiProviderMode> {
  return getDefault<AiProviderMode>('ai.provider', 'claude-cli');
}

/**
 * Get the system-wide default model (standard tier), derived from the active provider.
 */
export async function getDefaultModel(): Promise<string> {
  const provider = await getProviderMode();
  return MODEL_TIERS[provider].standard;
}

/**
 * Resolve a model short name to the full SDK model ID based on provider.
 * CLI modes return the short name directly (CLIs handle them natively).
 * API modes map to full model IDs.
 */
export function resolveModelId(name: string, provider: AiProviderMode): string {
  switch (provider) {
    case 'claude-cli':
      return name; // Claude CLI handles short names natively
    case 'claude-api':
      return MODEL_MAP[name] || name;
    case 'codex-cli':
      return name; // Codex CLI handles short names natively
    case 'openai-api':
      return CODEX_MODEL_MAP[name] || name;
    default:
      return name;
  }
}

// ─── SDK Clients ───────────────────────────────────────────────────

/**
 * Get an Anthropic SDK client (for claude-api mode).
 * Priority: ANTHROPIC_API_KEY env → agent API key credential (service: 'anthropic').
 */
export async function getAnthropicClient(): Promise<Anthropic> {
  if (cachedAnthropicClient) return cachedAnthropicClient;

  if (process.env.ANTHROPIC_API_KEY) {
    cachedAnthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return cachedAnthropicClient;
  }

  await ensureApiKeysMigrated();
  const apiKey = readApiKeyValueByService('anthropic');
  if (apiKey) {
    cachedAnthropicClient = new Anthropic({ apiKey });
    return cachedAnthropicClient;
  }

  throw new Error(
    'No Anthropic credentials found. Add an API key via Settings, set ANTHROPIC_API_KEY, or use Claude CLI mode (subscription).'
  );
}

/**
 * Get an OpenAI SDK client (for openai-api mode).
 * Priority: OPENAI_API_KEY env → agent API key credential (service: 'openai').
 */
export async function getOpenAiClient(): Promise<OpenAI> {
  if (cachedOpenAiClient) return cachedOpenAiClient;

  if (process.env.OPENAI_API_KEY) {
    cachedOpenAiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return cachedOpenAiClient;
  }

  await ensureApiKeysMigrated();
  const apiKey = readApiKeyValueByService('openai');
  if (apiKey) {
    cachedOpenAiClient = new OpenAI({ apiKey });
    return cachedOpenAiClient;
  }

  throw new Error(
    'No OpenAI credentials found. Add an API key via Settings or set OPENAI_API_KEY.'
  );
}

// ─── Provider Status ───────────────────────────────────────────────

/** Check if a CLI binary is available in PATH */
function checkCliAvailable(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(lookupCmd, [binary], (err) => {
      resolve(!err);
    });
  });
}

/** Check if an API key exists for a service (env or agent credential) */
async function hasApiKey(service: string, envVar: string): Promise<boolean> {
  if (process.env[envVar]) return true;
  await ensureApiKeysMigrated();
  return hasActiveApiKeyCredential(service);
}

/**
 * Get availability status for each provider.
 * Used by the dashboard UI to show status indicators.
 */
export async function getProviderStatus(): Promise<ProviderStatus[]> {
  const [claudeCliOk, codexCliOk, anthropicKeyOk, openaiKeyOk] = await Promise.all([
    checkCliAvailable('claude'),
    checkCliAvailable('codex'),
    hasApiKey('anthropic', 'ANTHROPIC_API_KEY'),
    hasApiKey('openai', 'OPENAI_API_KEY'),
  ]);

  return [
    {
      mode: 'claude-cli',
      label: 'Claude Max (CLI)',
      available: claudeCliOk,
      reason: claudeCliOk ? 'claude CLI found in PATH' : 'claude CLI not found in PATH',
      models: PROVIDER_MODELS['claude-cli'],
    },
    {
      mode: 'claude-api',
      label: 'Claude API Key',
      available: anthropicKeyOk,
      reason: anthropicKeyOk ? 'Anthropic API key configured' : 'No Anthropic API key configured',
      models: PROVIDER_MODELS['claude-api'],
    },
    {
      mode: 'codex-cli',
      label: 'Codex Max (CLI)',
      available: codexCliOk,
      reason: codexCliOk ? 'codex CLI found in PATH' : 'codex CLI not found in PATH',
      models: PROVIDER_MODELS['codex-cli'],
    },
    {
      mode: 'openai-api',
      label: 'OpenAI API Key',
      available: openaiKeyOk,
      reason: openaiKeyOk ? 'OpenAI API key configured' : 'No OpenAI API key configured',
      models: PROVIDER_MODELS['openai-api'],
    },
  ];
}

// ─── Backward Compatibility ────────────────────────────────────────

/**
 * @deprecated Use getProviderMode() instead.
 * Kept temporarily for backward compatibility.
 */
export async function shouldUseCli(): Promise<boolean> {
  const mode = await getProviderMode();
  return mode === 'claude-cli' || mode === 'codex-cli';
}

/**
 * @deprecated Use getProviderMode() instead.
 * Returns 'sdk' if provider uses direct API, 'cli' otherwise.
 */
export async function getAiProvider(): Promise<'sdk' | 'cli'> {
  const mode = await getProviderMode();
  return (mode === 'claude-api' || mode === 'openai-api') ? 'sdk' : 'cli';
}
