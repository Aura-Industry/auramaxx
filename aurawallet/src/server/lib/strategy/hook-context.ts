/**
 * Hook System Context
 * ===================
 * Loads and caches system context for strategy hook AI calls.
 *
 * Two framing modes:
 * - 'tool-call': For message hooks (chat apps). AI uses wallet_api + request_human_action tools directly.
 * - 'intent': For tick hooks (strategies). AI returns intent JSON for the engine to process.
 *
 * Two provider paths:
 * - 'cli': Claude CLI / Codex CLI — model reads MCP resources (docs://guide, docs://api).
 *          Returns minimal response-format reminder only.
 * - 'sdk': Anthropic SDK / OpenAI SDK — no MCP resources available.
 *          Loads full context from skills/auramaxx/SKILL.md + docs/ai-agents-workflow/API.md.
 *
 * Source of truth: skills/auramaxx/SKILL.md (served as docs://guide MCP resource too).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getErrorMessage } from '../error';

/** Cache key: `${provider}-${mode}` */
const cache = new Map<string, string>();

/** Minimal response-format reminder for CLI providers (model reads MCP resources for the rest) */
const CLI_TOOL_CALL_REMINDER = `## Response format
Return a JSON object with: reply, state, emit (all optional).
{ "reply": "...", "state": {...}, "emit": {...} }

Tool rule: if user gives a token ticker/name without a contract address,
call wallet_api GET /token/search?q=<ticker>&chain=<chain> before asking for an address.
Do not tell the user to search external sites first.

Read the docs://guide resource for operating instructions.
Read the docs://api resource for the full endpoint reference.`;

const CLI_INTENT_REMINDER = `## Response format
Return a JSON object with: reply, state, intents, emit (all optional).

Read the docs://guide resource for operating instructions.
Read the docs://api resource for the full endpoint reference.`;

/** Hardcoded fallback if doc files are missing — never crash */
const FALLBACK_TOOL_CALL = `## Response format
Return a JSON object with: reply, state, emit (all optional).
{ "reply": "...", "state": {...}, "emit": {...} }

Tool rule: for token tickers/names without contract addresses, call
wallet_api GET /token/search first before asking the user for an address.`;

const FALLBACK_INTENT = `## Response format
Return a JSON object with: reply, state, intents, emit (all optional).`;

/**
 * Load the agent guide from skills/auramaxx/SKILL.md and extract a section.
 * Returns the section content or empty string if not found.
 */
function loadAgentGuideSection(mode: 'tool-call' | 'intent'): string {
  const guidePath = join(__dirname, '..', '..', '..', '..', 'skills', 'auramaxx', 'SKILL.md');
  try {
    const full = readFileSync(guidePath, 'utf-8');
    if (mode === 'tool-call') {
      const start = full.indexOf('## Tool-Call Mode');
      const end = full.indexOf('## Intent Mode');
      if (start !== -1 && end !== -1) {
        return full.slice(start, end).trim();
      }
    } else {
      const start = full.indexOf('## Intent Mode');
      const end = full.indexOf('## Reference Documentation');
      if (start !== -1 && end !== -1) {
        return full.slice(start, end).trim();
      }
      if (start !== -1) {
        return full.slice(start).trim();
      }
    }
    // Section markers not found — return full content
    return full.trim();
  } catch (err) {
    console.debug('[hook-context] SKILL.md not found:', getErrorMessage(err));
    return '';
  }
}

function loadApiReference(): string {
  const apiMdPath = join(__dirname, '..', '..', '..', '..', 'docs', 'API.md');
  try {
    const full = readFileSync(apiMdPath, 'utf-8');
    const agentStart = full.indexOf('## Agent Endpoints');
    const endMarker = full.indexOf('## Request Types');
    if (agentStart !== -1 && endMarker !== -1) {
      return full.slice(agentStart, endMarker).trim();
    }
    // Newer API.md layouts may not include legacy section markers.
    // In that case, keep behavior deterministic by returning the full entrypoint doc.
    return full.trim();
  } catch (err) {
    console.debug('[hook-context] API.md not found:', getErrorMessage(err));
  }

  // Fallback to SKILL.md
  const skillPath = join(__dirname, '..', '..', '..', '..', 'skills', 'auramaxx', 'SKILL.md');
  try {
    return readFileSync(skillPath, 'utf-8').trim();
  } catch (err) {
    console.warn('[hook-context] no api reference docs found:', getErrorMessage(err));
  }

  return '';
}

/**
 * Returns the cached system context string for hook AI calls.
 * Loaded lazily on first call, then cached for the process lifetime.
 *
 * @param mode - 'tool-call' for message hooks (chat apps), 'intent' for tick hooks (strategies)
 * @param provider - 'cli' for CLI providers (reads MCP resources), 'sdk' for SDK providers (needs full injection)
 */
export function getHookSystemContext(
  mode: 'tool-call' | 'intent' = 'intent',
  provider: 'cli' | 'sdk' = 'sdk',
): string {
  const key = `${provider}-${mode}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let result: string;

  if (provider === 'cli') {
    // CLI providers: minimal reminder — model reads docs://guide and docs://api via MCP
    result = mode === 'tool-call' ? CLI_TOOL_CALL_REMINDER : CLI_INTENT_REMINDER;
  } else {
    // SDK providers: load full context from doc files (same source as MCP resources)
    const guideSection = loadAgentGuideSection(mode);
    const apiRef = loadApiReference();

    if (guideSection) {
      result = apiRef
        ? `${guideSection}\n\n## Available API endpoints\n\n${apiRef}`
        : guideSection;
    } else {
      // Fallback if doc file missing
      const fallback = mode === 'tool-call' ? FALLBACK_TOOL_CALL : FALLBACK_INTENT;
      result = apiRef
        ? `${fallback}\n\n## Available API endpoints\n\n${apiRef}`
        : fallback;
    }
  }

  cache.set(key, result);
  return result;
}

/** Reset cached context (for tests) */
export function __resetHookContext(): void {
  cache.clear();
}
