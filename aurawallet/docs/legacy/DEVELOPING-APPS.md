# Developing Apps

Detailed reference for building AuraMaxx UI apps — manifest format, SDK API, theming, security, and storage.

For a high-level overview and installation guide, see [APPS.md](./APPS.md). For building strategy apps (tick-based and message-based), see DEVELOPING-STRATEGIES.md in the wallet docs. For AI engine internals, see AI.md in the wallet docs.

## Table of Contents

1. [File Structure](#file-structure)
2. [App SDK API (window.AuraApp)](#app-sdk-api-windowauraapp)
3. [Theming](#theming)
4. [Manifest Reference](#manifest-reference)
5. [Security Model](#security-model)
6. [Storage API (REST)](#storage-api-rest)
7. [Example: Annotated Kanban App](#example-annotated-kanban-app)

---

## File Structure

```
apps/
  my-app/
    app.md         # Manifest (YAML frontmatter + description)
    index.html     # UI entry point (HTML + inline JS/CSS)
```

- `app.md` is required. The engine discovers apps by scanning `apps/*/app.md`.
- `index.html` is optional. Apps without it show a default placeholder on the dashboard. Strategy-only (headless) apps commonly omit it.
- The folder name becomes the app `id`.

---

## App SDK API (`window.AuraApp`)

The SDK is automatically injected into every installed app iframe. It is available as `window.AuraApp` (or just `AuraApp`). Storage methods and `fetch()` use direct HTTP calls with an injected Bearer token; `send()` uses direct HTTP; `on()` uses postMessage to communicate with the host.

### `AuraApp.storage.get(key)`

Read a value from persistent storage.

```javascript
var data = await AuraApp.storage.get('myKey');
// data is the parsed JSON value, or null if not found
```

- **Parameters:** `key` (string) -- the storage key
- **Returns:** `Promise<any>` -- the stored value, or `null` if the key does not exist

### `AuraApp.storage.set(key, value)`

Write a value to persistent storage. Values are JSON-serialized.

```javascript
await AuraApp.storage.set('myKey', { count: 42, items: ['a', 'b'] });
```

- **Parameters:** `key` (string), `value` (any JSON-serializable value)
- **Returns:** `Promise<any>` -- the stored value on success
- **Behavior:** Upserts -- creates the key if it does not exist, updates if it does

### `AuraApp.storage.delete(key)`

Delete a key from persistent storage.

```javascript
var ok = await AuraApp.storage.delete('myKey');
```

- **Parameters:** `key` (string)
- **Returns:** `Promise<boolean>` -- `true` on success
- **Error:** Rejects if the key does not exist

### `AuraApp.send(message)`

Send a natural language message to the app's AI and receive a reply.

```javascript
var reply = await AuraApp.send('Check the ETH balance on my hot wallet');
console.log(reply); // "Your hot wallet has 2.5 ETH"
```

- **Parameters:** `message` (string) -- natural language instruction
- **Returns:** `Promise<string | null>` -- the AI's text reply, or `null` if no reply was generated
- **Rate limit:** 10 messages per 60 seconds per app
- **Requires:** App must have a `hooks.message` field in its manifest

### `AuraApp.fetch(url, options)`

Fetch an external URL via the server-side proxy. Apps run in sandboxed `blob:` iframes with an opaque origin, so direct `fetch()` calls to external APIs will fail with CORS errors. This method proxies the request through the wallet server.

```javascript
// Simple GET
var data = await AuraApp.fetch('https://api.example.com/prices');

// POST with headers
var result = await AuraApp.fetch('https://api.example.com/submit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: '0xABC' })
});
```

- **Parameters:**
  - `url` (string) -- the external URL to fetch (must be HTTP or HTTPS)
  - `options` (object, optional): `method`, `headers`, `body`
- **Returns:** `Promise<any>` -- parsed JSON or text string
- **Rate limit:** 60 requests per 60 seconds per app
- **Restrictions:** Only HTTP/HTTPS; private IPs blocked (SSRF prevention); 10s timeout

### `AuraApp.action(params)`

Request human approval for a privileged operation. Creates a pending action request. On approval, a temporary scoped token is created and the action auto-executes.

```javascript
var result = await AuraApp.action({
  summary: 'Buy $DOGE2 for 0.005 ETH',
  permissions: ['swap'],
  limits: { swap: 0.005 },
  walletAccess: ['0x...'],
  ttl: 60
});
// result = { success: true, requestId: '...', secret: '...' }
```

- **Parameters:** `params` (object): `summary` (string, required), `permissions` (string[], required), `limits` (object), `walletAccess` (string[]), `ttl` (number)
- **Returns:** `Promise<{ success, requestId, secret }>`
- **Requires:** `action:create` permission in the manifest

**Event sequence on approval:** `action:resolved` → `action:executed` → `agent:message`

### `AuraApp.on(channel, callback)`

Subscribe to a real-time event channel. Events are forwarded from the WebSocket to your iframe via postMessage.

```javascript
var unsub = AuraApp.on('tx:created', function(data) {
  console.log('New transaction:', data);
});
unsub(); // unsubscribe
```

- **Parameters:** `channel` (string), `callback` (function)
- **Returns:** unsubscribe function

#### Common Event Channels

| Channel | Data | Description |
|---------|------|-------------|
| `tx:created` | `{walletAddress, id, type, txHash, amount}` | New transaction |
| `asset:changed` | `{walletAddress, tokenAddress, symbol}` | Asset added/removed |
| `wallet:created` | `{address, tier, chain}` | New wallet created |
| `strategy:tick` | `{strategyId, intents, duration, state}` | Strategy tick completed |
| `strategy:error` | `{strategyId, error, phase}` | Strategy error |
| `action:executed` | `{requestId, approved, status, result}` | Action auto-executed (app-scoped) |
| `agent:message` | `{message}` | AI follow-up after action (app-scoped) |

Strategy hooks can emit custom app-scoped events via the `emit` field in hook responses:

```json
{ "emit": { "channel": "price-update", "data": { "price": 42 } } }
```

---

## Theming

The host injects CSS variables from the current theme into every app iframe. Use these to match the dashboard in both light and dark modes.

### CSS Variables

| Variable | Purpose | Fallback |
|----------|---------|----------|
| `--color-background` | Page background | `#fafafa` |
| `--color-background-alt` | Alternate background | `#f4f4f5` |
| `--color-surface` | App/card background | `#ffffff` |
| `--color-surface-alt` | Alternate surface | `#f9fafb` |
| `--color-text` | Primary text | `#0a0a0a` |
| `--color-text-muted` | Secondary text | `#6b7280` |
| `--color-text-faint` | Tertiary text | `#9ca3af` |
| `--color-border` | Standard borders | `#d4d4d8` |
| `--color-border-muted` | Subtle borders | `#e4e4e7` |
| `--color-border-focus` | Focused borders | `#0a0a0a` |
| `--color-accent` | Accent/highlight | `#ccff00` |
| `--color-info` | Info accent | `#0047ff` |
| `--color-success` | Success state | `#22c55e` |
| `--color-warning` | Warning state | `#ff4d00` |
| `--color-danger` | Error/danger state | `#ef4444` |

Always provide fallback values:

```css
body {
  background: var(--color-surface, #fff);
  color: var(--color-text, #0a0a0a);
  font-family: ui-monospace, monospace;
}
```

### Injected Base Styles

The host injects a base reset into every app:

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: ui-monospace, monospace;
  overflow: auto;
  background: var(--color-surface, #fff);
  color: var(--color-text, #0a0a0a);
}
```

Your app's own `<style>` blocks are applied after this reset.

---

## Manifest Reference

The manifest is a Markdown file with YAML frontmatter. The body text after `---` is the description shown in the App Store.

```markdown
---
name: My App
icon: Zap
# ...fields...
---

Description shown in the App Store listing.
```

### Base Fields

| Field | Type | Required | Default | Description |
|-------|------|:---:|---------|-------------|
| `name` | string | yes | folder name | Display name |
| `icon` | string | no | `Box` | [Lucide](https://lucide.dev) icon name |
| `category` | string | no | `general` | App Store category filter |
| `size` | string | no | `1x1` | Default grid size `WxH` (1=320x280, 2=640x560, 3=960x840) |
| `permissions` | string[] | no | `[]` | Wallet permissions the app needs |
| `data` | string[] | no | `[]` | Real-time WebSocket channels to subscribe to (informational) |

### Permissions

Declare the permissions your app needs. Apps with permissions or limits require human approval before the engine creates auth tokens for them. Zero-permission apps skip approval.

Valid permission strings (see [AUTH.md](../ai-agents-workflow/AUTH.md) for full details):

| Permission | Description |
|------------|-------------|
| `wallet:list` | List/view wallets and balances |
| `wallet:create:hot` | Create hot wallets |
| `wallet:create:temp` | Create temp wallets |
| `wallet:rename` | Rename wallets |
| `wallet:export` | Export private keys |
| `send:hot` | Send from hot wallets |
| `send:temp` | Send from temp wallets |
| `swap` | Execute token swaps |
| `fund` | Transfer cold to hot |
| `launch` | Launch tokens via Doppler |
| `action:create` | Create human action requests |
| `apikey:get` | Read API keys |
| `apikey:set` | Manage API keys |
| `strategy:read` | View strategies |
| `strategy:manage` | Enable/disable strategies |
| `trade:all` | Compound: all trading + apikey:get |
| `wallet:write` | Compound: all wallet write ops |

### Extending Your App with Strategy Fields

Any app can become AI-powered by adding strategy fields to its `app.md` manifest. A strategy is just an app that activates the AI engine — there is no separate directory or manifest format.

The strategy-specific fields are:

| Field | Purpose |
|-------|---------|
| `ticker` | Schedule tick interval (`sniper`, `active`, `standard`, `slow`, `maintenance`) |
| `jobs` | Multi-interval scheduling (alternative to `ticker`) |
| `hooks` | Natural-language AI instructions (`tick`, `message`, `init`, `execute`, `result`, `shutdown`) |
| `sources` | External data endpoints fetched each tick |
| `keys` | API key declarations |
| `config` | Strategy configuration passed to hooks |
| `limits` | Spending caps (`fund`, `send`) |
| `allowedHosts` | Hostnames allowed for external fetches |

Adding any of these fields turns your app into a strategy. The base fields (`name`, `icon`, `category`, `size`, `permissions`, `data`) remain the same.

See DEVELOPING-STRATEGIES.md in the wallet docs for the full reference on these fields, hook lifecycle, sources, intents, and examples.

---

## Security Model

Installed apps run in a strict sandbox with isolation guarantees.

### Sandbox Restrictions

The iframe is created with `sandbox="allow-scripts"` **without** `allow-same-origin`:

| Capability | Allowed? | Reason |
|-----------|----------|--------|
| JavaScript execution | Yes | `allow-scripts` is set |
| Access parent DOM | No | No `allow-same-origin` |
| Read/write cookies | No | Opaque origin |
| Use localStorage/sessionStorage | No | Opaque origin |
| Submit forms | No | No `allow-forms` |
| Open popups | No | No `allow-popups` |
| Navigate top frame | No | No `allow-top-navigation` |

Apps are loaded via blob URLs (opaque origin `null`). Each app runs in complete isolation from the parent page and other apps.

### Communication Model

```
App iframe  --fetch()-------->  Express :4242/apps/<id>/storage/*  (Bearer token)
App iframe  --fetch()-------->  Express :4242/apps/<id>/message    (Bearer token)
App iframe  --fetch()-------->  Express :4242/apps/<id>/fetch      (Bearer token, proxied)
App iframe  --postMessage-->  Host (subscriptions via on())
```

The Bearer token is injected as `window.__AURA_TOKEN__` before the SDK loads. Tokens are scoped per-app and carry only `app:storage` permission by default.

### What Apps Cannot Do

- Access the parent page's DOM, JavaScript scope, or React state
- Read admin tokens or wallet credentials (apps get scoped tokens)
- Access other apps' storage (tokens scoped by app ID)
- Load external scripts (`<script src="...">` tags are stripped)
- Fetch private/internal IPs (SSRF prevention)

---

## Storage API (REST)

The SDK wraps these endpoints, but they can also be called directly with a Bearer token.

### Endpoints (Express :4242)

| Endpoint | Method | Permission | Description |
|----------|--------|------------|-------------|
| `/apps/:appId/storage` | GET | `app:storage` | List all keys and values |
| `/apps/:appId/storage/:key` | GET | `app:storage` | Read a single value |
| `/apps/:appId/storage/:key` | PUT | `app:storage` | Write a value (upsert) |
| `/apps/:appId/storage/:key` | DELETE | `app:storage` | Delete a key |
| `/apps/:appId/apikey/:keyName` | GET | `app:accesskey` | Read an API key |
| `/apps/:appId/approve` | POST | `strategy:manage` | Approve app permissions |
| `/apps/:appId/approve` | DELETE | `strategy:manage` | Revoke app approval |
| `/apps/:appId/token` | GET | admin | Get app's Bearer token |

Storage is scoped by `appId`. A token with `app:storage` can only access storage matching its own `agentId`. Use `app:storage:all` for cross-app access.

---

## Example: Annotated Kanban App

A complete UI app (`apps/example-kanban/`) demonstrating storage, theming, and vanilla JS patterns.

### Manifest (`app.md`)

```markdown
---
name: Kanban Board
icon: LayoutGrid
category: productivity
size: 2x2
permissions:
data:
---

A simple kanban board for tracking tasks. Demonstrates app storage
persistence -- your cards survive page reloads.
```

### Entry Point (`index.html`)

```html
<!DOCTYPE html>
<html>
<head>
<style>
  body {
    font-family: ui-monospace, monospace;
    background: var(--color-surface, #fff);
    color: var(--color-text, #0a0a0a);
    padding: 8px;
    font-size: 10px;
  }
  .column {
    border: 1px solid var(--color-border, #d4d4d8);
    background: var(--color-background-alt, #f4f4f5);
  }
  .card {
    background: var(--color-surface, #fff);
    border: 1px solid var(--color-border, #d4d4d8);
  }
  .card:hover {
    border-color: var(--color-border-focus, #0a0a0a);
  }
</style>
</head>
<body>
  <div class="header">
    <span class="title">Kanban</span>
    <button class="add-btn" onclick="showAddForm()">+ ADD</button>
  </div>
  <div class="columns" id="columns"></div>

<script>
var app = window.AuraApp;
var state = { cards: [] };

function save() {
  if (app && app.storage) {
    app.storage.set('kanban', state).catch(function() {});
  }
}

function init() {
  if (app && app.storage) {
    app.storage.get('kanban').then(function(data) {
      if (data && data.cards) { state = data; }
      render();
    }).catch(function() { render(); });
  } else {
    render();
  }
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function render() {
  // Build columns, cards, drag-and-drop handlers
  // Each state change calls save() then render()
}

init();
</script>
</body>
</html>
```

### Key Patterns

1. **Theme integration** -- All colors use `var(--color-*)` with fallbacks
2. **Storage persistence** -- `storage.get()` on init, `storage.set()` on every change
3. **Graceful degradation** -- Works even if `AuraApp` is not available
4. **XSS prevention** -- User input escaped via `textContent`/`innerHTML`
5. **Vanilla JS only** -- No build step, no external dependencies
6. **Inline everything** -- All CSS and JS in a single file (external `<script src>` tags are stripped)
