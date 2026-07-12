# AI Agent System

How AuraMaxx's AI agents work — from app manifests to executed trades.

## Overview

Apps can embed AI agents via the strategy hook system. A app declares
hooks (tick, message, execute, result) in its `app.md` frontmatter, and
the engine orchestrates the AI ↔ API ↔ human-approval loop automatically.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│ App       │────▶│ Strategy     │────▶│ AI Model    │
│ (app.md)  │     │ Engine       │     │ (Claude/GPT)│
└─────────────┘     └──────┬───────┘     └──────┬──────┘
                           │                     │
                    ┌──────▼───────┐     ┌──────▼──────┐
                    │ Executor     │     │ Tool-Use    │
                    │ (API calls)  │     │ (wallet_api)│
                    └──────────────┘     └─────────────┘
```

## Engine Lifecycle

### Startup

1. `startEngine()` loads all `apps/*/app.md` manifests
2. Creates `StrategyRuntime` per app (disabled by default)
3. Groups strategies by tick tier (sniper/active/standard/slow/maintenance)
4. Creates tick intervals per tier
5. Auto-enables strategies with `autoStart: true` or `hooks.message`

### Enable Strategy

1. Gets app token from central registry
2. Requires `HumanAction` if permissions/limits declared
3. Restores state from DB
4. Calls `init` hook if defined
5. Marks ready for ticking

### Disable Strategy

1. Calls `shutdown` hook if defined
2. Persists state to DB
3. Clears token, CLI session, context hash, message queue

## Tick Flow

```
restoreState() ← DB
     │
fetchAllSources() ← external APIs
     │
hashContext() ── skip if unchanged
     │
callHook('tick', context, token)
     │
processIntents()
     ├── Batch approval (if config.approve)
     ├── Per-action token approval (if intent has permissions[])
     │
     └── For each approved intent:
          ├── Pre-computed action OR execute hook
          ├── executeAction() (paper or live)
          ├── result hook → state updates + follow-ups
          └── Follow-ups re-enter (depth limit: 3)
```

### Tick Context

```json
{
  "sources": { "source_id": ["...data"] },
  "positions": [],
  "state": {},
  "config": { "approve": true },
  "permissions": ["swap"],
  "budget": { "limits": {}, "spent": {}, "remaining": {} }
}
```

### Context Deduplication

SHA-256 hash of tick context. Skips LLM call if unchanged since last tick.

## Message Flow

```
Rate limit check (10/60s per app)
     │
Build MessageContext
     │
callHook('message', context, token)
     │
Update state + emit events
     │
Process intents (if any)
     │
Return reply
```

Serial per-app (prevents state races), parallel across apps.

### Entry Points

Messages reach the engine via multiple channels, all converging on `handleAppMessage()`:

| Channel | Path | Auth |
|---------|------|------|
| Dashboard UI | `POST /apps/:id/message` → `handleAppMessage()` | Session token |
| Adapter (Telegram) | Long-poll → `ctx.sendMessage()` → `handleAppMessage()` | chatId validation |
| Adapter (Webhook) | `POST /adapters/:type/message` → `router.sendMessage()` → `handleAppMessage()` | HMAC signature |

All channels share the same rate limit, tool-use loop, and state. See [ADAPTERS.md](../ADAPTERS.md) for adapter chat configuration.

### Message Context

```json
{
  "message": "user input",
  "appId": "swap-chat",
  "state": {},
  "config": {},
  "permissions": ["wallet:list"],
  "budget": { "limits": {}, "spent": {}, "remaining": {} }
}
```

## AI Provider Selection

`getProviderMode()` in `server/lib/ai.ts` reads the `ai.provider` system default. Four provider modes are supported:

| Mode | Backend | Auth | Tool Support |
|------|---------|------|-------------|
| `claude-cli` (default) | `claude` binary | Subscription/OAuth | MCP server via `--mcp-config` |
| `claude-api` | Anthropic SDK | `ANTHROPIC_API_KEY` or DB | Native tool-use |
| `codex-cli` | `codex` binary | Subscription | Prompt-embedded (no native MCP) |
| `openai-api` | OpenAI SDK | `OPENAI_API_KEY` or DB | Native tool-use (OpenAI format) |

### Tiered Model Selection

Models are auto-selected using a 3-tier system based on the hook name and the token's permissions at `callHook()` time. No user configuration needed — the right model is chosen automatically:

| Tier | Claude | Codex/OpenAI | When |
|------|--------|-------------|------|
| `fast` | haiku | codex-mini | `init`/`shutdown` hooks, no token, or read-only permissions |
| `standard` | sonnet | codex | Write permissions (`wallet:create:hot`, `wallet:create:temp`) |
| `powerful` | opus | codex-max | Financial permissions (`swap`, `send:hot`, `send:temp`, `fund`, `launch`) or `admin:*` |

**How it works:** At each `callHook()` invocation, the engine decodes the token (via `validateToken()` — a synchronous HMAC check, no DB call) to extract permissions, then calls `selectModelTier(hookName, permissions)` to pick the tier. The tier maps to a model short name via `MODEL_TIERS[provider][tier]`, which is then resolved to a full SDK model ID if needed.

**Key functions** (`server/lib/ai.ts`):
- `selectModelTier(hookName, permissions)` — returns `'fast'` | `'standard'` | `'powerful'`
- `MODEL_TIERS` — maps `AiProviderMode × ModelTier → model short name`
- `getDefaultModel()` — returns the `standard` tier model for the active provider (backward compat)

| Provider | Fast | Standard | Powerful |
|----------|------|----------|----------|
| `claude-cli` | `haiku` | `sonnet` | `opus` |
| `claude-api` | `haiku` → `claude-haiku-4-5-20251001` | `sonnet` → `claude-sonnet-4-5-20250929` | `opus` → `claude-opus-4-6` |
| `codex-cli` | `codex-mini` | `codex` | `codex-max` |
| `openai-api` | `codex-mini` → `gpt-5.1-codex-mini` | `codex` → `gpt-5.3-codex` | `codex-max` → `gpt-5.1-codex-max` |

All four paths use the same hook system, same tools, same context injection.

### Configuring Providers

Via SystemDefaultsApp (AI ENGINE section) or API:
```bash
# Change provider (model auto-selected: claude→sonnet, codex/openai→codex)
curl -X PATCH http://localhost:4242/defaults/ai.provider \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"value": "openai-api"}'

# Check provider availability
curl http://localhost:4242/ai/status \
  -H "Authorization: Bearer <admin-token>"
```

## Hook Dispatch

`callHook(manifest, hookName, context, token?)` in `hooks.ts` dispatches to the correct provider:

### Claude SDK Path (`callHookViaSdk`)

- `client.messages.create()` with system prompt + tools array
- System context: `cache_control: { type: 'ephemeral' }` (sent once, cached)
- Tool-use loop: if `stop_reason === 'tool_use'` → execute → append result → retry
- Max 10 tool calls per invocation

### Claude CLI Path (`callHookViaCli`)

- `execFile('claude', ['-p', '--model', model, ...])` with MCP config
- Per-strategy session memory (conversation persists across ticks)
- Separate sessions for tick vs message: `{id}` vs `{id}:message`
- MCP server provides `wallet_api` tool via `--mcp-config`

### OpenAI SDK Path (`callHookViaOpenAiSdk`)

- `client.chat.completions.create()` with messages + tools (OpenAI format)
- Uses existing `toOpenAITools()` from `server/mcp/tools.ts`
- Tool-use loop: if `finish_reason === 'tool_calls'` → execute via `executeTool()` → feed results back
- Same max tool calls limit

### Codex CLI Path (`callHookViaCodexCli`)

- `execFile('codex', ['exec', '--json', '--model', model, '--ephemeral', '-'])` with stdin prompt
- Ephemeral sessions (no persistence across ticks)
- No native MCP support — tool instructions embedded in prompt text
- JSONL output parsed for final assistant message

## Tool-Use (API Access)

Hook AIs call the wallet API mid-conversation using the `wallet_api` tool.
Instead of pre-injecting wallet data, the agent fetches what it needs.

### Flow

1. Agent receives API docs + permissions in system context (auto-injected)
2. Agent decides it needs data (e.g., wallet addresses for a swap)
3. Agent calls `wallet_api` with `{ method: "GET", endpoint: "/wallets" }`
4. Engine executes HTTP call using app's token
5. Agent receives response and continues (constructs swap intent)

### Tool Definition

| Param | Type | Description |
|-------|------|-------------|
| method | `"GET"` or `"POST"` | HTTP method |
| endpoint | string | API path (e.g., `/wallets`) |
| body | object | POST request body (optional) |

### request_human_action

Request human approval for a privileged wallet action. Available in message hooks (tool-call mode).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| summary | string | yes | Human-readable description (shown in approval card) |
| permissions | string[] | yes | Permission strings needed (e.g. `["swap"]`) |
| action | object | yes | Pre-computed API call `{ endpoint, method, body }` |
| limits | object | no | Spending caps per permission (e.g. `{ swap: 0.01 }`) |
| walletAccess | string[] | no | Wallet addresses the temp token needs access to (include all addresses involved in the action) |
| ttl | number | no | Seconds the temporary token lives (default 120) |

**Flow:**
1. AI tries `wallet_api` POST to execute action directly
2. Gets 403 (insufficient permissions)
3. AI calls `request_human_action` with the action details
4. Human sees approval card with summary + action details
5. On approval: action auto-executes with a scoped temporary token
6. Result emitted back to app via `action:executed` channel
7. Execution result is fed back to the app's AI, which generates a contextual follow-up reply sent to the app via `agent:message` channel (e.g. "Wallet created at 0x123, want to fund it?")

**App event channels for `request_human_action`:**

| Channel | When | Data |
|---------|------|------|
| `action:resolved` | Always on approve/reject | `{ requestId, approved }` |
| `action:executed` | After auto-execute attempt | `{ requestId, approved, status, result }` |
| `agent:message` | After AI processes result | `{ message: "contextual reply" }` |

On rejection, only `action:resolved` fires (with `approved: false`). On approval with auto-execute, all three fire in sequence.

**Permission → Endpoint mapping:**

Use exactly these permission strings when calling `request_human_action`:

| Permission | Endpoint |
|------------|----------|
| `swap` | `/swap` |
| `send:hot` | `/send` |
| `send:temp` | `/send` |
| `fund` | `/fund` |
| `launch` | `/launch` |
| `wallet:create:hot` | `/wallet/create` |
| `wallet:create:temp` | `/wallet/create` |

**Callback depth limit:** Auto-execute callbacks (where the result is fed back to the app AI) are capped at **3 per app per 2-minute window**. This prevents infinite loops where the AI creates approval requests in a cycle (e.g., approve → callback → new approval → approve → callback...). When the limit is hit, the `action:executed` event still fires to the app UI, but the AI callback is skipped. The counter resets after 2 minutes of inactivity.

**Security:** The tool validates that requested permissions match the action endpoint both forward (permission → endpoint) and reverse (endpoint → required permissions). Using an unknown or incorrect permission string for a known endpoint returns an immediate error.

### Safety Limits

- Max 10 tool calls per hook invocation
- 10s timeout per call
- Responses truncated to 4KB
- Uses app's own token — server enforces permissions

### Provider Comparison

| Feature | Claude CLI | Claude API | Codex CLI | OpenAI API |
|---------|-----------|-----------|----------|-----------|
| Tool-use | MCP server (`--mcp-config`) | Native (`tools` param) | Prompt-embedded | Native (`tools` param) |
| Sessions | Persistent per-strategy | None (stateless) | Ephemeral | None (stateless) |
| Tool format | `server/mcp/server.ts` | `toAnthropicTools()` | N/A | `toOpenAITools()` |

All providers use the same tool definitions from `server/mcp/tools.ts` and the same `executeTool()` handler.

## Auto-Injected System Context

The system context that guides hook AI calls lives in `skills/auramaxx/SKILL.md` — a single source of truth shared by both the MCP server (as `docs://guide` resource) and the SDK injection path.

### Provider-Aware Injection

`hook-context.ts` is a thin loader that adapts based on the AI provider:

| Provider | What Gets Injected | How Agent Gets Full Docs |
|----------|-------------------|--------------------------|
| `claude-cli` | Minimal response-format reminder | Reads `docs://guide` and `docs://api` MCP resources |
| `claude-api` | Full guide section + API reference from doc files | Injected in system prompt |
| `codex-cli` | Full guide section + API reference from doc files | Injected in stdin (no MCP support) |
| `openai-api` | Full guide section + API reference from doc files | Injected in system prompt |

**CLI providers** get a minimal system context (just response format + "read docs://guide/docs://api") because the MCP server provides the full documentation as resources. This avoids triple-injecting the same content.

**SDK providers** get the full content loaded from `skills/auramaxx/SKILL.md` + the agent endpoints section of `docs/ai-agents-workflow/API.md`, since they have no MCP resource access.

### Dual Framing Modes

The agent guide contains two sections, one per hook type:

| Mode | Used By | Behavior |
|------|---------|----------|
| `intent` | Tick hooks (`tick`, `execute`, `result`, `init`, `shutdown`) | AI returns structured intents with permissions arrays. Engine handles approval + execution. |
| `tool-call` | Message hooks (`message`) | AI uses `wallet_api` and `request_human_action` tools directly. Try action → 403 → request approval → auto-execute. No intents needed. |

**Tool-call mode** (chat apps like swap-chat, launch-chat):
- AI calls `wallet_api` for reads and writes
- Token mint requests (`POST /auth`, `POST /actions/token`, approval-derived token issuance) must include caller `pubkey`
- On 403, AI calls `request_human_action` to request human approval
- On approval, the action auto-executes with a scoped temporary token
- Response format: `{ reply, state, emit }` — no intents field needed

**Intent mode** (tick-based strategies):
- AI returns intents with optional `permissions` arrays
- Engine handles batch approval, per-action tokens, and execution
- Response format: `{ reply, state, intents, emit }`

Both modes share the same API reference and wallet tier documentation. See `skills/auramaxx/SKILL.md` for the full guide content.

## Intent & Approval System

### Intent Types

1. **Batch intents** (no `permissions` array) — approved together if `config.approve`
2. **Per-action intents** (has `permissions` array) — each gets own approval + scoped temp token

### Approval Flow

- Engine creates `HumanAction` → emits `action:created` event
- Dashboard/adapters show approval card with intent summary
- Human approves → engine creates scoped token → executes action
- Human rejects or timeout → intent skipped

### Pre-Computed Actions

Hooks can return intents with `action: { endpoint, method, body }` to skip
the execute hook entirely. The engine calls the API directly.

## State Management

- **In-memory**: `Map<string, Record<string, unknown>>` per app
- **Persistence**: REST calls to app storage (`PUT /apps/{id}/storage/_strategy_state`)
- **Restore**: Read from DB at tick start (picks up UI changes)
- **Auto-persist**: Every 5 minutes + on disable + on error

## Action Execution

`executeAction()` in `executor.ts`:

- HTTP request to `http://127.0.0.1:4242{endpoint}` with Bearer token
- 30-second timeout per action
- External endpoints are validated before fetch:
  - Only `http:` and `https:` protocols are allowed
  - Private/internal destinations are blocked after DNS resolution (SSRF protection)
  - External hosts must be explicitly allowed (`allowedHosts` + source-derived hosts)
  - Redirects are blocked (`redirect: 'error'`)

## Emit System

Hooks can return `emit: { channel, data }` or `emit: [...]`.
Engine broadcasts as `app:emit` WebSocket events.
Dashboard forwards to app iframe via `postMessage()`.

## Error Handling

Configurable per strategy via `config.errors`:

- `sourceFail`: `'skip'` | `'pause'` | `'retry'` — what to do when sources fail
- `executeFail`: `'skip'` | `'pause'` — what to do when actions fail
- Error counting with cooldown (strategy pauses after N consecutive errors)
- Skip-on-busy: if previous tick still running, next tick is skipped

## Integration Testing

The AI agent pipeline has its own integration test suite, separate from the main unit tests.

### Running

```bash
# AI integration tests only
npm run test:ai

# Main unit tests (does NOT include AI integration tests)
npm test
```

### Architecture

```
User prompt
  → processMessage()          [message.ts — REAL]
    → callHook()              [hooks.ts — REAL]
      → callHookViaSdk()      [hooks.ts — REAL, Anthropic SDK MOCKED]
        → client.messages.create()  ← SCRIPTED RESPONSES
        → executeTool()        [mcp/tools.ts — REAL]
          → fetch(127.0.0.1:4242)  ← INTERCEPTED → test Express app
            → Express routes   [REAL — auth, permissions, wallet ops]
```

**Mock boundary**: Only the AI model is mocked (scripted tool_use / text responses). Everything from `executeTool` through Express routes is real code — real auth, real permission checks, real wallet state, real test database.

**Fetch interception**: `executeTool` hardcodes `http://127.0.0.1:4242`. Tests start Express on port 0 (random), then intercept `globalThis.fetch` to rewrite the URL. This preserves all of executeTool's real validation, timeouts, and truncation logic.

### Key Files

| File | Purpose |
|------|---------|
| `server/tests/ai-integration/vitest.config.ts` | Separate vitest config (60s timeout, sequential) |
| `server/tests/ai-integration/harness.ts` | Server setup, fetch interception, `runPrompt()` helper |
| `server/tests/ai-integration/scenarios.test.ts` | Prompt scenarios (simple queries, multi-step, errors) |

### Adding Scenarios

Use `runPrompt()` to script an AI conversation:

```typescript
const result = await runPrompt(
  mockCreate,
  'What are my wallets?',
  [
    // Turn 1: AI calls wallet_api tool (real HTTP to test server)
    { toolCalls: [{ name: 'wallet_api', input: { method: 'GET', endpoint: '/wallets' } }] },
    // Turn 2: AI returns final text (parsed as HookResult)
    { text: '{"reply": "You have 1 wallet.", "state": {}}' },
  ],
  { token: agentToken },
);
expect(result.reply).toBe('You have 1 wallet.');
```

Each `ScriptedTurn` is either a tool_use turn (tool calls executed against real server) or a text turn (final AI response). Add new scenarios by defining the expected AI conversation turns.

### Live Model Testing

A separate test suite sends real prompts to real Claude and validates that the model makes sensible tool calls against the real wallet server. This tests **system prompt quality** — does `hook-context.ts` + tool descriptions guide the model correctly?

```bash
# Uses claude CLI (subscription) or ANTHROPIC_API_KEY — whichever is available
npm run test:ai:live
```

**Architecture (two provider paths):**

```
SDK path (API key in env or DB):
  User prompt → processMessage() → callHookViaSdk()
    → client.messages.create()     ← REAL CLAUDE (haiku)
    → executeTool()                [mcp/tools.ts — REAL]
      → fetch(WALLET_SERVER_URL)   → test Express app

CLI path (claude subscription):
  User prompt → processMessage() → callHookViaCli()
    → execFile('claude', ...)      ← REAL CLAUDE (haiku) via CLI
    → MCP server subprocess        [mcp/server.ts — REAL]
      → executeTool()              → fetch(WALLET_SERVER_URL) → test Express app
```

**Nothing is mocked.** Real Claude, real system prompt, real tools, real server. The test Express app runs on a random port, reached via `WALLET_SERVER_URL` env var (propagated to MCP subprocesses) and fetch interception (for in-process calls).

**Key differences from scripted tests:**

| | Scripted (`test:ai`) | Live (`test:ai:live`) |
|---|---|---|
| AI model | Mocked (scripted responses) | Real Claude (haiku) |
| What it tests | Plumbing (tool execution, auth, permissions) | System prompt quality (does Claude pick the right tools?) |
| Assertions | Exact replies, tool call sequences | Keywords in reply, DB side effects |
| Cost | Free | ~$0.01-0.05 per run |
| AI provider | Not needed (test placeholder) | Claude CLI or API key |
| Timeout | 60s | 120s |

**Skip behavior:** Auto-skips if neither `claude` CLI nor a real `ANTHROPIC_API_KEY` is available. Safe to run in CI without secrets or CLI configured.

**Key files:**

| File | Purpose |
|------|---------|
| `server/tests/ai-integration/vitest.live.config.ts` | Vitest config (120s timeout, sequential) |
| `server/tests/ai-integration/live-harness.ts` | Server setup, `runLivePrompt()` (no mocking) |
| `server/tests/ai-integration/live.test.ts` | Live model scenarios |

## MCP Server (Standalone)

See [MCP.md](../../ai-agents-workflow/MCP.md) for standalone MCP server usage.
