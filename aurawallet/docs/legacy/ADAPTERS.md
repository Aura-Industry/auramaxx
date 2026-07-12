# Approval Adapters

External approval channels for agent actions. Adapters forward `action:created` events to external services (Telegram, Discord, webhooks, etc.) and relay human decisions back to `POST /actions/:id/resolve`.

---

## How It Works

```
Agent requests token
       │
       ▼
POST /actions/:id/resolve ◄─── Dashboard UI
       ▲                   ◄─── CLI terminal
       │                   ◄─── Adapter (Telegram, webhook, etc.)
       │
All channels converge on the same endpoint
```

Adapters don't change the resolve endpoint or any existing code paths. They simply:
1. Receive the `action:created` WebSocket event
2. Present it to a human in some external medium
3. POST back to resolve when the human responds

---

## Configuration

Adapter config is stored in the database, not in config files. This keeps secrets out of plain-text JSON and aligns with how API keys (Alchemy, etc.) are already managed.

**Two pieces:**
- **Secrets** (bot tokens, HMAC keys) → `POST /apikeys` with `service: "adapter:<type>"`
- **Settings** (enabled flags, non-secret config) → `POST /adapters`

### 1. Store secrets via `/apikeys`

```bash
# Telegram bot token
curl -X POST http://localhost:4242/apikeys \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"service": "adapter:telegram", "name": "botToken", "key": "123456:ABC-DEF..."}'

# Webhook HMAC secret
curl -X POST http://localhost:4242/apikeys \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"service": "adapter:webhook", "name": "secret", "key": "my-hmac-secret"}'
```

### 2. Configure adapter settings via `/adapters`

```bash
# Enable Telegram adapter (chatId is non-secret, stored in AppConfig)
curl -X POST http://localhost:4242/adapters \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"type": "telegram", "enabled": true, "config": {"chatId": "987654321"}}'

# Enable webhook adapter
curl -X POST http://localhost:4242/adapters \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"type": "webhook", "enabled": true, "config": {"url": "https://hooks.slack.com/services/T.../B.../xxx"}}'
```

### 3. Restart the adapter router

After changing config, restart to pick up changes:

```bash
curl -X POST http://localhost:4242/adapters/restart \
  -H "Authorization: Bearer <admin-token>"
```

### Adapter Management Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/adapters` | List configured adapters (with secret status) |
| `POST` | `/adapters` | Add/update adapter config `{ type, enabled, config, chat? }` |
| `POST` | `/adapters/chat` | Set top-level chat config (defaultApp) |
| `POST` | `/adapters/:type/message` | Inbound chat from adapter webhook (HMAC auth) |
| `DELETE` | `/adapters/:type` | Remove adapter config |
| `POST` | `/adapters/restart` | Restart approval router with current DB config |

All adapter endpoints require `adapter:manage` permission (or `admin:*` which includes it).

Adapters are opt-in. If no adapters are configured, the approval router doesn't start.

---

## Built-in Adapters

### Webhook (notification-only)

POSTs action events to a URL. Useful for Slack/Discord incoming webhooks, ntfy, or any HTTP endpoint.

**Config (`POST /adapters`):**

| Field | Type | Storage | Description |
|-------|------|---------|-------------|
| `url` | string | `POST /adapters` config | URL to POST to |
| `secret` | string | `POST /apikeys` | HMAC-SHA256 secret for `X-Signature-256` header |
| `headers` | object | `POST /adapters` config | Custom headers to include |

**Setup:**
```bash
# 1. Store HMAC secret (optional)
curl -X POST http://localhost:4242/apikeys \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"service": "adapter:webhook", "name": "secret", "key": "my-hmac-secret"}'

# 2. Configure webhook URL and custom headers
curl -X POST http://localhost:4242/adapters \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"type": "webhook", "enabled": true, "config": {"url": "https://hooks.slack.com/services/...", "headers": {"X-Custom": "value"}}}'

# 3. Restart
curl -X POST http://localhost:4242/adapters/restart \
  -H "Authorization: Bearer <admin-token>"
```

**Payload format:**

```json
{
  "type": "action:created",
  "data": {
    "id": "abc-123",
    "type": "action",
    "source": "agent:my-agent",
    "summary": "Swap 0.01 ETH for USDC",
    "expiresAt": null,
    "metadata": {
      "agentId": "my-agent",
      "permissions": ["swap"],
      "verifiedSummary": {
        "action": "/swap",
        "oneLiner": "Buy 0xABC...DEF with 0.01 ETH on base",
        "facts": [{ "label": "Amount", "value": "0.01 ETH" }],
        "discrepancies": [],
        "verified": true,
        "generatedAt": "2026-02-11T..."
      }
    }
  },
  "timestamp": 1738599000000
}
```

**HMAC verification (if secret configured):**

```javascript
const crypto = require('crypto');
const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
const valid = req.headers['x-signature-256'] === `sha256=${expected}`;
```

The webhook adapter is notification-only — it doesn't handle responses. To approve/reject from a webhook target, have your service POST directly to `/actions/:id/resolve` with an admin token, or build a bidirectional adapter.

### Telegram (bidirectional)

Full approval flow via Telegram Bot API. Sends inline keyboard buttons, handles callbacks.

**Config:**

| Field | Type | Storage | Description |
|-------|------|---------|-------------|
| `botToken` | string | `POST /apikeys` | Bot API token from @BotFather |
| `chatId` | string/number | `POST /adapters` config | Chat ID for notifications and callbacks |

Compatibility notes:
- Token lookup prefers `service=adapter:telegram, name=botToken`, but falls back to any stored `adapter:telegram` key for legacy/manual setups.
- Chat ID lookup accepts legacy config keys (`chat_id`, `chatID`) when reading existing configs. Use `chatId` for new writes.
- `POST /adapters/test` now does a best-effort `getUpdates` lookup when `chatId` is missing, then persists the detected chat ID before sending.

**Setup:**
1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Get your chat ID (message the bot, check `getUpdates`)
3. Store the bot token as an API key and configure the adapter:

```bash
# Store bot token
curl -X POST http://localhost:4242/apikeys \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"service": "adapter:telegram", "name": "botToken", "key": "123456:ABC-DEF..."}'

# Configure adapter
curl -X POST http://localhost:4242/adapters \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"type": "telegram", "enabled": true, "config": {"chatId": "987654321"}}'

# Restart to apply
curl -X POST http://localhost:4242/adapters/restart \
  -H "Authorization: Bearer <admin-token>"
```

**How it works:**
- `action:created` → sends message with Approve/Reject inline keyboard
- `action:created` with `type: 'notify'` → sends plain info message (no buttons, no resolution)
- Human taps Approve/Reject → adapter calls `POST /actions/:id/resolve`
- `action:resolved` → edits original message to show result, removes keyboard
- Only responds to callbacks from the configured `chatId` (security)
- When a `verifiedSummary` is present, the Telegram message shows the server-generated one-liner as primary action text and displays discrepancy warnings with severity icons

**Notification metadata:** When `type: 'notify'`, the Telegram adapter renders known metadata fields if present: `contractAddress` (DexScreener link), `symbol`, `marketCap`, `risk`, `socialLinks` (clickable links), and `evaluation` (full AI analysis text).

**No npm dependencies** — uses raw `fetch` calls to `api.telegram.org` and long-polling via `getUpdates`.

#### Agent Chat

The Telegram adapter supports opt-in agent chat — send text messages in Telegram and your AI agent replies.

**Enable chat:**

```bash
curl -X POST http://localhost:4242/adapters \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"type": "telegram", "enabled": true, "config": {"chatId": "987654321"}, "chat": {"enabled": true}}'
```

**Set default app** (which app's AI handles messages):

```bash
curl -X POST http://localhost:4242/adapters/chat \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"defaultApp": "swap-chat"}'
```

**How it works:**
- Human sends text in Telegram → adapter routes to app's `message` hook
- AI processes with full tool-use (wallet_api, request_human_action)
- Reply sent back as Telegram message
- Long replies (>4096 chars) are split into multiple messages
- Same rate limiting as dashboard chat (10 messages / 60 seconds per app)
- Chat is **off by default** — must be explicitly enabled with `chat: { enabled: true }`
- Approval callbacks (Approve/Reject buttons) continue to work alongside chat

---

## Agent Chat

Adapters can route text messages to app AI agents via the strategy engine's `handleAppMessage()`. This reuses existing message hooks, tool-use, rate limiting, and conversation memory — no new AI infrastructure.

### How It Works

```
Human sends text via adapter
       │
       ▼
AdapterContext.resolveApp()  →  find target app
       │
       ▼
AdapterContext.sendMessage()    →  handleAppMessage()
       │                             │
       │                        processMessage()
       │                             │
       │                        AI hook + tool-use
       │                             │
       ▼                             ▼
Adapter sends reply             { reply, error }
```

### Configuration

Chat config is stored in `AppConfig.adapterConfig`:

```json
{
  "enabled": true,
  "chat": {
    "defaultApp": "swap-chat"
  },
  "adapters": [
    {
      "type": "telegram",
      "enabled": true,
      "config": { "chatId": "123456789" },
      "chat": { "enabled": true }
    }
  ]
}
```

**Two levels of config:**
- **Top-level `chat.defaultApp`**: Which app receives messages (system-wide)
- **Per-adapter `chat.enabled`**: Whether that adapter accepts chat messages (default: false)

### Webhook Chat Endpoint

For adapters that use HTTP callbacks (webhooks, Slack, Discord):

```bash
POST /adapters/:type/message
Content-Type: application/json
X-Signature-256: sha256=<hmac>

{
  "text": "What is my balance?",
  "senderId": "user-123",
  "targetApp": "swap-chat"
}
```

**Response:**
```json
{
  "success": true,
  "reply": "You have 1.5 ETH in your hot wallet.",
  "error": null
}
```

**Authentication:** HMAC-SHA256 signature required if the adapter has a secret configured (same `X-Signature-256` header pattern as webhook notifications).

### Security

- **Same auth model**: Chat messages use the app's existing token + permissions
- **Rate limiting**: Existing 10 msg/60s per app applies to adapter messages
- **Sender validation**: Telegram validates chatId; webhooks validate HMAC
- **App scoping**: The app's token determines what the AI can do
- **No new attack surface**: Messages flow through the same `handleAppMessage()` as dashboard chat

---

## Security Model

### Secrets in Database, Not Config Files

Adapter secrets (bot tokens, HMAC keys) are stored in the `ApiKey` database table with `service: "adapter:<type>"`. This is the same pattern used for Alchemy API keys and other service credentials. Non-secret settings (enabled flags, chat IDs, URLs) are stored in the `AppConfig.adapterConfig` JSON field.

### Direct In-Process Calls

The adapter router is an in-process trusted component that calls `resolveAction()` and `handleAppMessage()` directly — no admin tokens, no HTTP round-trips. This eliminates token management overhead and retry logic.

**Key properties:**
- `resolve()` calls `resolveAction()` from `server/lib/resolve-action.ts` directly
- `sendMessage()` calls `handleAppMessage()` / `enqueueAppMessage()` from the strategy engine directly
- `fetchPendingActions()` queries prisma directly (same query as `GET /actions/pending`)
- If the wallet is locked when resolving an `auth`/`agent_access` action, `resolveAction()` returns a 401-equivalent error

### Adapter Isolation

- Each adapter runs independently — one failing adapter doesn't affect others
- Adapter errors are caught and logged per-adapter
- The router catches all adapter exceptions in `notify()` and `resolved()` calls

### Webhook Security

- HMAC-SHA256 signatures (optional but recommended) verify payload authenticity
- Custom headers can be used for additional authentication
- Webhook URLs should use HTTPS

### Telegram Security

- Only callbacks from the configured `chatId` are processed
- The bot token should be kept secret (treat it like a password)
- Long-polling means no publicly accessible webhook endpoint is needed

---

## Building Custom Adapters

Implement the `ApprovalAdapter` interface:

```typescript
import type { ApprovalAdapter, AdapterContext, ActionNotification, ActionResolution } from './types';

class MyAdapter implements ApprovalAdapter {
  readonly name = 'my-adapter';

  async start(ctx: AdapterContext): Promise<void> {
    // ctx.resolve(actionId, approved, opts?) — call this to resolve actions
    // ctx.serverUrl — base URL of the wallet server
    // ctx.sendMessage(appId, text) — route chat messages to app AI
    // ctx.resolveApp(target?) — resolve which app handles chat
  }

  async notify(action: ActionNotification): Promise<void> {
    // Present action to human: action.id, action.type, action.summary, etc.
    // action.verifiedSummary contains server-generated facts and discrepancy warnings
    // action.metadata?.verifiedSummary is also available (from WebSocket events)
  }

  async resolved(resolution: ActionResolution): Promise<void> {
    // Clean up UI: resolution.id, resolution.approved, resolution.resolvedBy
  }

  async stop(): Promise<void> {
    // Clean up resources
  }
}
```

Register it before server start:

```typescript
import { registerAdapterType } from './server/lib/adapters';

registerAdapterType('my-adapter', (config) => new MyAdapter(config));
```

Then configure via API:

```bash
# Store any secrets
curl -X POST http://localhost:4242/apikeys \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"service": "adapter:my-adapter", "name": "apiKey", "key": "secret-value"}'

# Configure adapter
curl -X POST http://localhost:4242/adapters \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"type": "my-adapter", "enabled": true, "config": {"myOption": "value"}}'

# Restart
curl -X POST http://localhost:4242/adapters/restart \
  -H "Authorization: Bearer <admin-token>"
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    ApprovalRouter                              │
│  ┌─────────┐  ┌──────────────────────────────────────────┐   │
│  │WebSocket │  │ Adapters                                 │   │
│  │Listener  │  │  ├── WebhookAdapter                      │   │
│  │          │  │  ├── TelegramAdapter                      │   │
│  └────┬─────┘  │  └── CustomAdapter...                     │   │
│       │        └──────────────────────────────────────────┘   │
│       │                                                       │
│  action:created ────► adapter.notify()                        │
│  action:resolved ───► adapter.resolved()                      │
│  action:executed ───► (app-scoped, not adapter)               │
│                                                               │
│  adapter calls ─────► resolveAction() (direct, in-process)    │
│  chat message ──────► sendMessage() → engine (direct)         │
│  resolveApp() ──────► DB lookup (cached)                      │
└──────────────────────────────────────────────────────────────┘
```

**Storage:**

| Data | Storage | Key |
|------|---------|-----|
| Secrets (bot tokens, HMAC keys) | `ApiKey` table | `service: "adapter:<type>"` |
| Settings (enabled, chatId, URL) | `AppConfig.adapterConfig` | JSON field |

**Files:**

| File | Description |
|------|-------------|
| `server/lib/adapters/types.ts` | Core interfaces |
| `server/lib/adapters/router.ts` | WebSocket listener + resolve proxy |
| `server/lib/adapters/webhook.ts` | Webhook adapter |
| `server/lib/adapters/telegram.ts` | Telegram adapter |
| `server/lib/adapters/factory.ts` | Registry + factory + `loadAdaptersFromDb` |
| `server/lib/adapters/index.ts` | Public exports |
| `server/routes/adapters.ts` | Admin REST endpoints |
