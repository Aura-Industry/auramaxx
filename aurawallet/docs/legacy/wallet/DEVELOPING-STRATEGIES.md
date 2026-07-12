# Developing Strategies

Reference for extending an app with AI-powered automation — strategy manifest fields, hooks, sources, intents, and examples.

A strategy is an app with additional manifest fields that activate the AI engine. Start with [DEVELOPING-APPS.md](../DEVELOPING-APPS.md) for the base app manifest, SDK, and security model.

For a high-level overview, see [STRATEGY.md](./STRATEGY.md). For AI engine internals (provider selection, tool-use loop, testing), see [AI.md](./AI.md).

## Table of Contents

1. [Strategy Manifest Fields](#strategy-manifest-fields)
2. [Tick Tiers and Jobs](#tick-tiers-and-jobs)
3. [Hooks Lifecycle](#hooks-lifecycle)
4. [Hook Response Format](#hook-response-format)
5. [Hook Contexts](#hook-contexts)
6. [Intent Format and Approval Modes](#intent-format-and-approval-modes)
7. [Pre-Computed Actions](#pre-computed-actions)
8. [Sources](#sources)
9. [Config](#config)
10. [Auto-Granted Permissions](#auto-granted-permissions)
11. [Budget-Aware Intent Decisions](#budget-aware-intent-decisions)
12. [State Management](#state-management)
13. [Error Handling Config](#error-handling-config)
14. [Validation Rules](#validation-rules)
15. [Tool-Use in Hooks](#tool-use-in-hooks)
16. [AI Provider Selection and Tiered Models](#ai-provider-selection-and-tiered-models)
17. [DB-Backed Template Strategies](#db-backed-template-strategies)
18. [Example: Tick-Mode Strategy](#example-tick-mode-strategy)
19. [Example: Message-Mode Chat App](#example-message-mode-chat-app)

---

## Strategy Manifest Fields

The manifest is a Markdown file (`app.md`) with YAML frontmatter — the same format used by all apps (see [DEVELOPING-APPS.md](../DEVELOPING-APPS.md#manifest-reference)). The body text after `---` is the description shown in the App Store. A strategy adds the fields below to the base app manifest.

### Base Fields (from app manifest)

These fields are shared with all apps. See [DEVELOPING-APPS.md](../DEVELOPING-APPS.md#manifest-reference) for full details.

| Field | Type | Required | Default | Description |
|-------|------|:---:|---------|-------------|
| `name` | string | yes | folder name | Display name |
| `icon` | string | no | `Box` | [Lucide](https://lucide.dev) icon name |
| `category` | string | no | `general` | App Store category filter |
| `size` | string | no | `1x1` | Default grid size `WxH` (1=320x280, 2=640x560, 3=960x840) |
| `permissions` | string[] | no | `[]` | Wallet permissions the app needs |

### Strategy Fields

These fields activate the AI engine and are specific to strategies.

| Field | Type | Required | Default | Description |
|-------|------|:---:|---------|-------------|
| `autoStart` | boolean | no | `false` | Auto-enable on engine startup |
| `ticker` | string | no | — | Tick tier. One of: `sniper`, `active`, `standard`, `slow`, `maintenance`. Mutually exclusive with `jobs`. |
| `jobs` | array | no | — | Multi-interval jobs. Mutually exclusive with `ticker`. |
| `sources` | array | no | `[]` | External data endpoints fetched each tick |
| `keys` | array | no | — | API key declarations |
| `hooks` | object | yes* | — | Hook instructions (at least one of `tick` or `message` required) |
| `config` | object | no | `{}` | Strategy config passed to hooks |
| `limits` | object | no | — | Spending caps: `{ fund?: number, send?: number }` |
| `allowedHosts` | string[] | no | `[]` | Hostnames allowed for external fetches (SSRF allowlist) |

### Permissions

Strategies use the same permission system as all apps. Strategies with permissions or limits require human approval before the engine creates auth tokens.

See [DEVELOPING-APPS.md](../DEVELOPING-APPS.md#permissions) for the full permissions table, or [AUTH.md](../../ai-agents-workflow/AUTH.md) for complete auth details.

Note: the `action:create` permission is required for strategies that use the `request_human_action` tool in message hooks.

### Limits

Spending caps embedded in the strategy's token:

```yaml
limits:
  fund: 1.0     # Max 1 ETH cold-to-hot transfer
  send: 0.5     # Max 0.5 ETH sends
```

### Allowed Hosts

Hostnames (no protocol, no path) the strategy engine may fetch. Hosts from `sources[].url` are auto-derived, so you only need to list additional hosts used by templated URLs or external action endpoints.

```yaml
allowedHosts:
  - api.coingecko.com
  - api.dexscreener.com
```

Private/reserved hosts (`localhost`, `127.0.0.1`, `10.x`, `192.168.x`, etc.) are always blocked.

---

## Tick Tiers and Jobs

### Tick Tiers

| Tier | Interval | Use Case |
|------|----------|----------|
| `sniper` | 10 seconds | Time-critical sniping, MEV |
| `active` | 30 seconds | Active trading, price triggers |
| `standard` | 1 minute | General monitoring |
| `slow` | 5 minutes | Portfolio tracking, reporting |
| `maintenance` | 1 hour | Daily buys, maintenance tasks |

### Jobs

For strategies that need multiple tick intervals, use `jobs` instead of `ticker`:

```yaml
jobs:
  - id: price_check
    ticker: active
    sources:
      - price       # Only fetch these sources for this job
  - id: rebalance
    ticker: maintenance
    sources:
      - portfolio
```

| Field | Type | Required | Description |
|-------|------|:---:|-------------|
| `id` | string | yes | Job identifier (passed to tick context) |
| `ticker` | string | yes | Tick tier for this job |
| `sources` | string[] | no | Source IDs to fetch (defaults to all) |

---

## Hooks Lifecycle

Six lifecycle hooks. Each is a natural-language string instructing the AI what to do. The engine passes structured JSON context and expects a JSON response.

| Hook | When Called | Mode |
|------|-----------|------|
| `init` | Strategy enabled | Tick |
| `tick` | Every scheduled interval | Tick |
| `execute` | Per approved intent (if no pre-computed action) | Tick |
| `result` | After action execution | Tick |
| `shutdown` | Strategy disabled | Tick |
| `message` | Human sends a message | Message |

### Tick Mode Flow

```
fetch sources -> tick hook -> intents -> (approve?) -> execute hook -> action -> result hook
```

1. Engine fetches all `sources`
2. Calls `tick` hook with source data, state, config, budget
3. AI returns intents (what to do)
4. If `config.approve: true` or intent has `permissions[]`, human approves
5. For each approved intent: `execute` hook (or pre-computed action) -> API call -> `result` hook
6. `result` hook can return follow-up intents (depth limit: 3)

### Message Mode Flow

```
user message -> message hook (with tools) -> reply + optional intents
```

1. User sends message via `AuraApp.send()` or adapter
2. Engine calls `message` hook with AI tools (`wallet_api`, `request_human_action`)
3. AI uses tools directly (try action -> 403 -> request approval)
4. Returns reply text and state updates

### Auto-Injected Context

You do **not** need to embed API docs or intent format instructions in your hooks. The engine auto-injects (via `hook-context.ts`):

- API endpoint reference (from `docs/ai-agents-workflow/API.md`)
- Response format specification
- Intent format with `permissions`, `limits`, `ttl`, `action`, `summary` fields
- Wallet tier documentation (COLD/HOT/TEMP)
- Budget-aware decision logic

Keep hook instructions focused on your app's specific behavior.

---

## Hook Response Format

All hooks return `HookResult`:

```json
{
  "reply": "Text response to the user (message hooks)",
  "state": { "key": "persisted state values" },
  "intents": [{ "type": "swap", "token": "0xABC" }],
  "log": "Optional log message",
  "emit": { "channel": "event-name", "data": { "price": 42 } }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `reply` | string | Text reply sent to the user (message hooks) |
| `state` | object | Key-value state updates to persist across ticks |
| `log` | string | Fallback reply if `reply` is absent; also logged |
| `intents` | array | High-level intents for the engine to execute (tick mode) |
| `emit` | object or array | Custom events pushed to the app's iframe. `{ channel, data }` or `[{ channel, data }, ...]` |

### Mode-Specific Response Patterns

**Tick mode** hooks should return:
```json
{ "state": { ... }, "intents": [{ "type": "buy", ... }] }
```

**Message mode** hooks should return:
```json
{ "reply": "Response text", "state": { ... } }
```

Message hooks use the tool-call flow (wallet_api + request_human_action) instead of intents. You can still return intents from message hooks, but it's not the recommended pattern.

---

## Hook Contexts

Each hook receives a structured JSON context. These are the TypeScript interfaces for reference.

### TickContext (tick hook)

```typescript
{
  sources: Record<string, unknown[]>;   // Fetched source data by source ID
  positions?: unknown[];                // Wallet positions
  state: Record<string, unknown>;       // Persisted strategy state
  config: StrategyConfig;               // Manifest config + overrides
  wallets?: unknown[];                  // Available wallets
  permissions: string[];                // App token's permissions
  budget: {
    limits: Record<string, number>;     // Spending caps (ETH)
    spent: Record<string, number>;      // Already spent this session
    remaining: Record<string, number>;  // Remaining budget
  };
}
```

### ExecuteContext (execute hook)

```typescript
{
  intent: Intent;            // The approved intent to convert to an action
  wallet?: unknown;          // Selected wallet
  config: StrategyConfig;    // Manifest config
}
```

### ResultContext (result hook)

```typescript
{
  intent: Intent;            // The original intent
  action: Action;            // The executed API call
  outcome: ActionOutcome;    // { success: boolean, data?, error? }
  state: Record<string, unknown>;
}
```

### InitContext (init hook)

```typescript
{
  config: StrategyConfig;
  wallets?: unknown[];
  state: Record<string, unknown>;
  storage?: Record<string, unknown>;
}
```

### ShutdownContext (shutdown hook)

```typescript
{
  positions?: unknown[];
  state: Record<string, unknown>;
}
```

### MessageContext (message hook)

```typescript
{
  message: string;           // User's message text
  appId: string;             // App identifier
  state: Record<string, unknown>;
  config: StrategyConfig;
  permissions: string[];     // App token's permissions
  budget: {
    limits: Record<string, number>;
    spent: Record<string, number>;
    remaining: Record<string, number>;
  };
}
```

---

## Intent Format and Approval Modes

Intents returned by `tick` or `message` hooks:

```json
{
  "type": "swap",
  "summary": "Buy 0.01 ETH of TOKEN",
  "permissions": ["swap"],
  "limits": { "swap": 0.01 },
  "ttl": 60,
  "action": {
    "endpoint": "/swap",
    "method": "POST",
    "body": { "tokenIn": "ETH", "tokenOut": "0xABC", "amountIn": "0.01" }
  }
}
```

| Field | Type | Required | Description |
|-------|------|:---:|-------------|
| `type` | string | yes | Intent type label |
| `summary` | string | no | Human-readable description for approval card |
| `permissions` | string[] | no | Triggers per-action token flow with human approval |
| `limits` | object | no | Spending caps for the temp token |
| `ttl` | number | no | Token lifetime in seconds (default: 600) |
| `action` | object | no | Pre-computed API call (skips `execute` hook) |
| `action.endpoint` | string | — | API path (`/swap`) or external URL |
| `action.method` | string | — | HTTP method |
| `action.body` | object | — | Request body |
| `action.headers` | object | — | Custom headers |

### Approval Modes

| Intent has `permissions`? | `config.approve`? | Result |
|:---:|:---:|---|
| Yes | Any | Per-action token, individual approval per intent |
| No | true | Batch boolean approval |
| No | false | No approval needed |

---

## Pre-Computed Actions

Hooks can return intents with an `action` field to skip the `execute` hook entirely:

```json
{
  "type": "swap",
  "summary": "Buy 0.01 ETH of TOKEN",
  "action": {
    "endpoint": "/swap",
    "method": "POST",
    "body": { "tokenIn": "ETH", "tokenOut": "0xABC", "amountIn": "0.01" }
  }
}
```

When `action` is present, the engine calls the API directly instead of invoking the `execute` hook. This is useful when the tick hook already has all the information needed to construct the API call.

---

## Sources

External data endpoints fetched before each tick. Results are passed to the `tick` hook as `sources.<id>`.

```yaml
sources:
  - id: price
    url: https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd
    method: GET
    select:
      items: $.ethereum
      price: $.usd

  - id: holders
    url: https://api.example.com/holders/${token}
    method: GET
    auth: header
    header: X-API-KEY
    key: example_key
    depends: price
    optional: true
    select:
      items: $.data
      address: $.holder
      balance: $.amount
```

### Source Fields

| Field | Type | Required | Default | Description |
|-------|------|:---:|---------|-------------|
| `id` | string | yes | — | Unique identifier (referenced in `jobs[].sources` and `depends`) |
| `url` | string | yes | — | URL template. `${var}` resolves from parent source `select` fields or `config` |
| `method` | string | yes | — | `GET` or `POST` |
| `body` | object | no | — | POST request body template |
| `auth` | string | no | `none` | Auth mode: `none`, `header`, `query`, `bearer` |
| `header` | string | no | — | Header name when `auth: header` |
| `query` | string | no | — | Query param name when `auth: query` |
| `key` | string | no | — | App storage key to read the API key from |
| `depends` | string | no | — | Source ID that must run first (enables URL template chaining) |
| `job` | string | no | — | Job ID this source belongs to |
| `optional` | boolean | no | `false` | Skip if API key not found in storage |
| `rateLimit` | string | no | — | Rate limit specification |
| `select` | object | no | — | JSONPath extraction: `items` = path to array, other keys = per-item field paths |

### URL Templates

Source URLs can contain `${var}` placeholders resolved from:
1. `select` fields of a parent source (via `depends`)
2. `config` values

Templated external URLs require explicit `allowedHosts`.

### API Key Auth

Sources that need auth reference a key stored in app storage:

```yaml
- id: analytics
  url: https://public-api.birdeye.so/defi/token_overview?address=${mint}
  auth: header
  header: X-API-KEY
  key: birdeye           # reads from AuraApp.storage.get('birdeye')
  optional: true         # skip if key not in storage
```

The app developer builds the UI for entering and saving the key via `AuraApp.storage.set('birdeye', 'sk-...')`.

### Keys

Declare API keys the strategy needs. Informational — helps users know which keys to configure.

```yaml
keys:
  - id: birdeye
    name: Birdeye API Key
    required: false
    description: Used for token analytics data
```

| Field | Type | Required | Description |
|-------|------|:---:|-------------|
| `id` | string | yes | Key identifier (matches `sources[].key`) |
| `name` | string | yes | Display name |
| `required` | boolean | no | Whether the key is required for the app to function |
| `description` | string | no | What the key is used for |

---

## Config

The `config` object is passed to every hook invocation. It supports both special engine-recognized fields and custom fields.

### Special Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `wallet` | string | Preferred wallet address or `"auto"` |
| `approve` | boolean | `true` = require batch human approval between tick and execute |
| `mode` | string | `"live"` (execute actions) or `"paper"` (log only, no execution) |

All other config keys are custom and passed through to hooks.

---

## Auto-Granted Permissions

The engine auto-grants these permissions — you don't need to list them in `permissions`:

- `app:storage` — State persistence (always granted)
- `app:accesskey` — Granted when sources use `key` fields

---

## Budget-Aware Intent Decisions

The tick context includes a `budget` object with `limits`, `spent`, and `remaining` fields. The engine auto-injects budget-aware decision logic into the system context, so hook AIs can make informed decisions about whether to proceed with an action based on remaining budget.

```json
{
  "budget": {
    "limits": { "swap": 0.1 },
    "spent": { "swap": 0.03 },
    "remaining": { "swap": 0.07 }
  }
}
```

---

## State Management

- **In-memory**: `Map<string, Record<string, unknown>>` per app
- **Persistence**: REST calls to app storage (`PUT /apps/{id}/storage/_strategy_state`)
- **Restore**: Read from DB at tick start (picks up UI changes)
- **Auto-persist**: Every 5 minutes + on disable + on error

State is passed to hooks via the `state` field in the context and updated via the `state` field in the hook response.

---

## Error Handling Config

Configure how the engine handles failures via `config.errors`:

```yaml
config:
  errors:
    sourceFail: skip       # What to do when a source fetch fails
    executeFail: skip      # What to do when an action fails
    maxRetries: 3          # Max consecutive retries before pausing
    cooldown: "5m"         # Pause duration after max retries
```

| Field | Type | Default | Options | Description |
|-------|------|---------|---------|-------------|
| `sourceFail` | string | `skip` | `skip`, `retry`, `pause` | Behavior on source fetch failure |
| `executeFail` | string | `skip` | `skip`, `pause` | Behavior on action execution failure |
| `maxRetries` | number | — | — | Consecutive error count before pausing |
| `cooldown` | string | — | Duration string | Pause duration (e.g., `"5m"`, `"1h"`) |

---

## Validation Rules

The loader (`server/lib/strategy/loader.ts`) enforces these rules. A manifest that fails validation is skipped with a console error.

### Required Structure

- Must have **at least one** of: `ticker`, `jobs`, or `hooks.message`
- If `ticker` or `jobs` is set, `hooks.tick` is **required**
- `ticker` must be one of: `sniper`, `active`, `standard`, `slow`, `maintenance`
- Each job must have `id` and a valid `ticker`

### Source Validation

- Source `depends` must reference an existing source `id`
- No circular dependencies between sources
- Source URLs cannot point to private/reserved hosts (`localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `::1`, etc.)
- If a source URL uses templates (`${var}`) and points externally, `allowedHosts` must be declared
- Source hosts must be listed in `allowedHosts` (auto-derived from static URLs, but templated URLs need explicit declaration)

### Host Validation

- `allowedHosts` entries cannot be private/reserved IPs or hostnames
- Hostnames only (no protocol, no path, no port)

---

## Tool-Use in Hooks

Hook AIs can call the wallet API mid-conversation:

- **`wallet_api`** — `{ method, endpoint, body }` — call any wallet server endpoint
- **`request_human_action`** — request approval for a privileged action (message hooks only)

See [AI.md](./AI.md#tool-use-api-access) for the full tool-use reference.

---

## AI Provider Selection and Tiered Models

Models are auto-selected using a 3-tier system based on the hook name and the token's permissions. No user configuration needed.

| Tier | When |
|------|------|
| `fast` | `init`/`shutdown` hooks, no token, or read-only permissions |
| `standard` | Write permissions (`wallet:create:hot`, `wallet:create:temp`) |
| `powerful` | Financial permissions (`swap`, `send:hot`, `send:temp`, `fund`, `launch`) or `admin:*` |

See [AI.md](./AI.md#ai-provider-selection) for provider details, model mappings, and configuration.

---

## DB-Backed Template Strategies

In addition to file-based `app.md` manifests, strategies can be created via the API from pre-built templates. These use the same `StrategyManifest` shape internally but are stored in the database.

Available templates: `recurring_buy`, `buy_on_drop`, `stop_loss`, `portfolio_report`.

```bash
# Create from template
curl -X POST http://localhost:4242/strategies \
  -H "Authorization: Bearer <token>" \
  -d '{ "templateId": "recurring_buy", "name": "Daily ETH Buy", "config": { ... } }'

# Install from raw manifest
curl -X POST http://localhost:4242/strategies/install \
  -H "Authorization: Bearer <token>" \
  -d '{ "manifest": { ... }, "approve": false }'
```

Template strategies have Zod-validated config schemas and capped permissions/limits defined by the template. See `server/lib/strategy/templates.ts` for template definitions.

---

## Example: Tick-Mode Strategy

A price-alert app that monitors a token and emits a notification when the price drops.

```markdown
---
name: Price Alert
icon: Bell
category: strategy
size: 2x1
permissions:
  - wallet:list
allowedHosts: []

ticker: standard

sources:
  - id: price
    url: /price/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
    method: GET
    select:
      items: $
      priceUsd: $.priceUsd

hooks:
  init: |
    Initialize state with empty lastPrice. No wallets needed for this strategy.
    Return: { "state": { "lastPrice": null, "alertCount": 0 } }

  tick: |
    Compare current price to state.lastPrice.
    If price dropped more than 5% since last check, return a notify intent.
    Always update state.lastPrice with current price.

    If no significant change:
    { "state": { "lastPrice": <current> }, "intents": [] }

    If price dropped >5%:
    {
      "state": { "lastPrice": <current>, "alertCount": <state.alertCount + 1> },
      "intents": [],
      "emit": { "channel": "price-alert", "data": { "price": <current>, "drop": <percent> } }
    }

  shutdown: |
    No cleanup needed.
    Return: { "state": {} }

config:
  dropThreshold: 5
  mode: live
---

Monitors USDC price on Base and emits an alert when it drops more than 5%.
Simple read-only strategy with no trading actions.
```

### What makes this valid

- Has `ticker: standard` (1-minute interval)
- Has `hooks.tick` (required when ticker is set)
- Source URL starts with `/` (internal endpoint, no SSRF restrictions)
- Uses `emit` to push events to the app iframe instead of executing actions
- Minimal permissions (`wallet:list` is read-only)

---

## Example: Message-Mode Chat App

A chat assistant that helps users check balances and request swaps.

```markdown
---
name: Swap Chat
icon: MessageCircle
category: tools
size: 2x2
permissions:
  - wallet:list
  - action:create
allowedHosts: []

hooks:
  message: |
    You are a token swap assistant for AuraMaxx on Base chain.

    Use wallet_api to look up wallets and balances. NEVER guess addresses.

    When the user wants to swap tokens:
    1. Look up their wallets with wallet_api GET /wallets
    2. Try the swap with wallet_api POST /swap
    3. If you get 403, call request_human_action with the swap details
    4. Tell the user approval has been requested

    NEVER say "I don't have permission." ALWAYS use request_human_action.

    Keep replies concise (2-3 sentences).

config: {}
---

A simple swap assistant. Ask it to swap tokens and it will
handle wallet lookup and approval requests automatically.
```

### What makes this valid

- Has `hooks.message` (message-only app, no ticker needed)
- Uses tool-call flow: `wallet_api` for reads/writes, `request_human_action` for 403s
- `action:create` permission enables the `request_human_action` tool
- No `intents` in the response — tool-call mode handles actions directly
- No response format instructions needed — the engine auto-injects the format spec
