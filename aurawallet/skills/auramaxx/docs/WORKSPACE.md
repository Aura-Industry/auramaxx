# Workspace API - Agent Control Guide

Programmatic control of the AuraMaxx dashboard via WebSocket.

## Authentication

**Read-only operations** (querying state) work without authentication.

**Mutation operations** (creating/updating/deleting workspaces and apps, changing themes) require a valid token with `workspace:modify` permission or admin access (`admin:*`).

For authentication details, see [AUTH.md](AUTH.md).

## Quick Start (CLI Script)

The easiest way to add apps is via the CLI script:

```bash
# Set your token (required for mutations)
export AURA_TOKEN="your-agent-token"

# Add an iframe app
node scripts/add-app.js iframe --url "https://dexscreener.com/base/0x123" --title "Price Chart"

# Add a built-in app
node scripts/add-app.js wallets
node scripts/add-app.js logs --x 400 --y 100

# Add an installed app (from apps/ folder)
node scripts/add-app.js installed:example-kanban

# Specify position and size
node scripts/add-app.js iframe --url "https://example.com" --x 100 --y 200 --width 600 --height 400

# Custom app ID (for multi-instance)
node scripts/add-app.js iframe --id "my-chart" --url "https://example.com"
```

Run `node scripts/add-app.js --help` for full usage.

> **Note**: Adding apps requires a token with `workspace:modify` permission or admin access. See [AUTH.md](AUTH.md) for obtaining tokens.

---

## Quick Start (WebSocket)

For programmatic control from code:

```javascript
// Connect with authentication token for mutations
// Token is passed as URL query parameter
const token = 'your-agent-token';  // From /auth endpoint or admin token from /unlock
const ws = new WebSocket(`ws://localhost:4748?token=${encodeURIComponent(token)}`);

ws.onopen = () => {
  // Add an app (requires workspace:modify permission or admin:*)
  ws.send(JSON.stringify({
    type: 'app:added',
    timestamp: Date.now(),
    source: 'agent',
    data: {
      workspaceId: 'your-workspace-id',
      appType: 'iframe',
      config: { url: 'https://example.com/chart' },
      x: 100, y: 100, width: 400, height: 300
    }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  // Check for permission errors
  if (msg.type === 'error') {
    console.error('Permission denied:', msg.error);
    return;
  }

  console.log('Received:', msg.type, msg.data);
};
```

**Without a token**, you can still query state (read-only):

```javascript
const ws = new WebSocket('ws://localhost:4748');  // No token

ws.onopen = () => {
  // Query current state (no auth required)
  ws.send(JSON.stringify({
    type: 'workspace:state:request',
    timestamp: Date.now(),
    source: 'agent',
    data: { requestId: 'req-123' }
  }));
};
```

---

## WebSocket Events

### Connection

```
ws://localhost:4748
```

On connect, you'll receive: `{ type: 'connected', timestamp: ... }`

---

## Query Events (Request/Response)

### Get Current State

Request the full workspace state:

```javascript
ws.send(JSON.stringify({
  type: 'workspace:state:request',
  timestamp: Date.now(),
  source: 'agent',
  data: {
    requestId: 'req-123',        // Your unique ID to match response
    workspaceId: 'optional-id'   // Omit for default workspace
  }
}));
```

Response:

```javascript
{
  type: 'workspace:state:response',
  data: {
    requestId: 'req-123',
    workspaces: [
      { id: 'ws-1', name: 'HOME', slug: 'home', icon: 'Home', isDefault: true, isCloseable: false }
    ],
    activeWorkspaceId: 'ws-1',
    apps: [
      { id: 'w-1', workspaceId: 'ws-1', appType: 'logs', x: 20, y: 20, width: 600, height: 300, zIndex: 10, isVisible: true, isLocked: false }
    ]
  }
}
```

---

## Mutation Events

> **Authentication Required**: All mutation events require a valid token with `workspace:modify` permission or admin access. Connect with `ws://localhost:4748?token=YOUR_TOKEN`. See [AUTH.md](AUTH.md) for obtaining tokens.

All mutations are broadcast to other connected clients automatically.

### Create Workspace

```javascript
ws.send(JSON.stringify({
  type: 'workspace:created',
  timestamp: Date.now(),
  source: 'agent',
  data: {
    id: 'ws-' + Date.now(),      // Optional - auto-generated if omitted
    name: 'TRADING',
    slug: 'trading',              // Optional - generated from name
    icon: 'TrendingUp',           // Lucide icon name
    order: 1,                     // Tab order
    isDefault: false,
    isCloseable: true
  }
}));
```

### Delete Workspace

```javascript
ws.send(JSON.stringify({
  type: 'workspace:deleted',
  timestamp: Date.now(),
  source: 'agent',
  data: { workspaceId: 'ws-123' }
}));
```

### Update Workspace

```javascript
ws.send(JSON.stringify({
  type: 'workspace:updated',
  timestamp: Date.now(),
  source: 'agent',
  data: {
    id: 'ws-123',
    name: 'NEW NAME',
    icon: 'Zap'
  }
}));
```

---

## App Events

### Add App

```javascript
ws.send(JSON.stringify({
  type: 'app:added',
  timestamp: Date.now(),
  source: 'agent',
  data: {
    id: 'app-' + Date.now(),  // Optional
    workspaceId: 'ws-123',        // Required
    appType: 'iframe',         // Required - see App Types below
    x: 100,                       // Position (default: 20)
    y: 100,
    width: 400,                   // Size (default varies by type)
    height: 300,
    zIndex: 50,                   // Layering (auto-incremented if omitted)
    isVisible: true,
    isLocked: false,
    config: {                     // Type-specific config
      url: 'https://example.com'
    }
  }
}));
```

### Remove App

```javascript
ws.send(JSON.stringify({
  type: 'app:removed',
  timestamp: Date.now(),
  source: 'agent',
  data: { appId: 'app-123' }
}));
```

### Update App

Update position, size, visibility, lock state, or config:

```javascript
ws.send(JSON.stringify({
  type: 'app:updated',
  timestamp: Date.now(),
  source: 'agent',
  data: {
    appId: 'app-123',
    x: 200,                // Move app
    y: 150,
    width: 500,            // Resize
    height: 400,
    isVisible: true,       // Show/hide
    isLocked: true,        // Prevent dragging
    config: { ... }        // Update config
  }
}));
```

---

## App Types

### Singleton vs Multi-Instance

Apps are categorized as **singleton** or **multi-instance**:

- **Singleton**: Only one instance per workspace. ID = app type. If you try to add a duplicate, it brings the existing one to front.
- **Multi-instance**: Can have multiple instances with different IDs. Use custom `id` like `wallet:0x123` or `iframe:my-chart`.

### Built-in Apps (Singleton)

| Type | Description | Default Size |
|------|-------------|--------------|
| `logs` | Event log viewer | 600x300 |
| `send` | Send ETH form | 320x280 |
| `agentKeys` | Agent keys & approvals | 340x400 |
| `setup` | Getting started wizard | 420x520 |
| `transactions` | Transaction history log | 520x400 |

### Multi-Instance Apps

These app types can be opened multiple times with different IDs:

| Type | Description | Default Size |
|------|-------------|--------------|
| `token` | Market data for a token | 380x480 |
| `walletDetail` | Detailed view of a single wallet | 320x380 |
| `iframe` | Embed external URL | 400x300 |
| `installed:*` | Installed apps from `apps/` folder | varies |

**Custom IDs**: Pass an `id` field to control identity:

```javascript
// Multiple iframe apps with different IDs
{ id: 'chart-eth', appType: 'iframe', config: { url: '...' } }
{ id: 'chart-btc', appType: 'iframe', config: { url: '...' } }

// Wallet detail apps
{ id: 'wallet:0x123...', appType: 'walletDetail', config: { address: '0x123...' } }

// Installed third-party apps
{ appType: 'installed:example-kanban', config: { appPath: 'example-kanban', appName: 'Kanban Board' } }
```

If no `id` is provided, one is auto-generated (e.g., `iframe-1738505123456`).

> For full details on creating and installing third-party apps, see [docs/APPS.md](./APPS.md).

#### IFrame App

Embed any URL:

```javascript
{
  appType: 'iframe',
  config: {
    url: 'https://example.com/chart',
    title: 'Price Chart',                    // Optional
  }
}
```

> **Security note:** Iframes are sandboxed with `allow-scripts allow-forms` (no `allow-same-origin`). The sandbox policy is not configurable by agents to prevent sandbox escape.

#### Installed Apps

Third-party apps installed as folders under `apps/`. Each installed app consists of a `app.md` manifest and an `index.html` entry point, rendered inside a sandboxed iframe.

```javascript
{
  appType: 'installed:example-kanban',
  config: {
    appPath: 'example-kanban',
    appName: 'Kanban Board'
  }
}
```

Installed apps appear in the App Store under the "INSTALLED" tab. For full details on creating, installing, and developing third-party apps (manifest format, SDK API, storage, security model), see [APPS.md](./APPS.md) and [DEVELOPING-APPS.md](./DEVELOPING-APPS.md).

---

## Strategy Events

The strategy engine broadcasts events over the WebSocket as strategies execute.

| Event | When | Data |
|-------|------|------|
| `strategy:tick` | Tick completes | `strategyId`, `intents` (count), `duration` (ms) |
| `strategy:enabled` | Strategy enabled | `strategyId` |
| `strategy:paused` | Strategy paused | `strategyId`, `reason` |
| `strategy:error` | Hook or action failed | `strategyId`, `error`, `phase` |
| `strategy:approve` | Intents awaiting approval | `strategyId`, `intents[]` |

### Example: strategy:tick

```json
{
  "type": "strategy:tick",
  "timestamp": 1707052800000,
  "source": "express",
  "data": {
    "strategyId": "dca-eth",
    "intents": 2,
    "duration": 145
  }
}
```

### Example: strategy:approve

Sent when a strategy produces intents that require human approval before execution.

```json
{
  "type": "strategy:approve",
  "timestamp": 1707052800000,
  "source": "express",
  "data": {
    "strategyId": "dca-eth",
    "intents": [
      { "id": "approval-123", "action": "swap", "params": { "token": "0x...", "amount": "0.05" } }
    ]
  }
}
```

### Example: strategy:error

```json
{
  "type": "strategy:error",
  "timestamp": 1707052800000,
  "source": "express",
  "data": {
    "strategyId": "dca-eth",
    "error": "Hook 'beforeTick' threw: network timeout",
    "phase": "hook"
  }
}
```

---

## REST API

Alternative to WebSocket for simple CRUD operations.

### Workspaces

```bash
# List all workspaces
GET /api/workspace

# Create workspace
POST /api/workspace
{ "name": "TRADING", "icon": "TrendingUp" }

# Get workspace with apps
GET /api/workspace/:id

# Update workspace
PATCH /api/workspace/:id
{ "name": "NEW NAME" }

# Delete workspace
DELETE /api/workspace/:id
```

### Apps

```bash
# Add app to workspace
POST /api/workspace/:id/apps
{
  "appType": "iframe",
  "config": { "url": "https://example.com" },
  "x": 100, "y": 100
}

# Update app
PATCH /api/workspace/:id/apps/:wid
{ "x": 200, "y": 150, "width": 500 }

# Remove app
DELETE /api/workspace/:id/apps/:wid
```

### Export/Import

```bash
# Export workspace as JSON
GET /api/workspace/:id/export

# Import workspace from JSON
POST /api/workspace/import
{
  "workspace": { "name": "Imported", "icon": "Download" },
  "apps": [
    { "appType": "logs", "x": 20, "y": 20 }
  ]
}
```

---

## Persistence

- All changes auto-save to SQLite database (500ms debounce)
- Workspaces persist across server restarts
- Default "HOME" workspace created automatically

---

## Example: Full Agent Session

```javascript
// Connect with authentication token
const token = 'your-agent-token';  // Obtained from /auth endpoint
const ws = new WebSocket(`ws://localhost:4748?token=${encodeURIComponent(token)}`);

ws.onopen = async () => {
  // 1. Get current state (no auth required for queries)
  const requestId = 'req-' + Date.now();
  ws.send(JSON.stringify({
    type: 'workspace:state:request',
    timestamp: Date.now(),
    source: 'agent',
    data: { requestId }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'workspace:state:response') {
    const workspaceId = msg.data.activeWorkspaceId;

    // 2. Add a price chart iframe
    ws.send(JSON.stringify({
      type: 'app:added',
      timestamp: Date.now(),
      source: 'agent',
      data: {
        workspaceId,
        appType: 'iframe',
        config: { url: 'https://www.tradingview.com/chart/', title: 'TradingView' },
        x: 400, y: 20, width: 800, height: 500
      }
    }));

    // 3. Add an installed third-party app
    ws.send(JSON.stringify({
      type: 'app:added',
      timestamp: Date.now(),
      source: 'agent',
      data: {
        workspaceId,
        appType: 'installed:example-kanban',
        config: { appPath: 'example-kanban', appName: 'Kanban Board' },
        x: 20, y: 20, width: 640, height: 560
      }
    }));
  }
};
```

---

## Theme System

The dashboard supports light/dark mode and accent color customization via WebSocket events.

### Query Current Theme

```javascript
ws.send(JSON.stringify({
  type: 'theme:request',
  timestamp: Date.now(),
  source: 'agent',
  data: { requestId: 'req-123' }
}));
```

Response:

```javascript
{
  type: 'theme:response',
  data: {
    requestId: 'req-123',
    activeThemeId: 'light',
    accentColor: '#ccff00',
    mode: 'light'
  }
}
```

### Change Theme Mode (Light/Dark)

> **Authentication Required**: Theme changes require `workspace:modify` permission or admin access.

```javascript
ws.send(JSON.stringify({
  type: 'theme:mode:changed',
  timestamp: Date.now(),
  source: 'agent',
  data: { mode: 'dark' }  // 'light' or 'dark'
}));
```

### Change Accent Color

```javascript
ws.send(JSON.stringify({
  type: 'theme:accent:changed',
  timestamp: Date.now(),
  source: 'agent',
  data: { accent: '#ff4d00' }  // Any hex color
}));
```

### Theme-Aware Apps

When creating installed apps, use CSS variables for automatic theme support. The host injects theme CSS variables into every app iframe, so your app automatically adapts to light/dark mode and accent color changes.

```html
<!-- In your installed app's index.html -->
<style>
  body {
    background: var(--color-surface, #fff);
    color: var(--color-text, #0a0a0a);
    border: 1px solid var(--color-border, #d4d4d8);
    padding: 16px;
    font-family: ui-monospace, monospace;
  }
  .label {
    color: var(--color-text-muted, #6b7280);
    font-size: 10px;
  }
  .highlight {
    color: var(--color-accent, #ccff00);
    font-weight: bold;
  }
</style>
```

> For the full list of injected CSS variables and theming details for installed apps, see [DEVELOPING-APPS.md](./DEVELOPING-APPS.md#theming).

### Available CSS Variables

**Core Colors:**
- `--color-accent` - Primary accent color (default: #ccff00)
- `--color-background` - Page background
- `--color-background-alt` - Alternate background (e.g., sidebar)
- `--color-surface` - Card/app background
- `--color-surface-alt` - Alternate surface

**Text:**
- `--color-text` - Primary text
- `--color-text-muted` - Secondary text
- `--color-text-faint` - Tertiary/disabled text

**Borders:**
- `--color-border` - Default border
- `--color-border-muted` - Subtle border
- `--color-border-focus` - Focus ring

**Semantic:**
- `--color-warning` - Warning state (#ff4d00)
- `--color-danger` - Error/danger state (#ef4444)
- `--color-success` - Success state (#00c853)
- `--color-info` - Info state (#0047ff)

**App Palette:**
- `--app-{color}-band` - App header band color
- `--app-{color}-accent` - App border accent
- `--app-{color}-bg` - App background tint
- `--app-{color}-text` - App text color

Where `{color}` is: `blue`, `orange`, `lime`, `purple`, `gray`, `teal`, `rose`

### Theme Events Reference

| Event | Direction | Description |
|-------|-----------|-------------|
| `theme:request` | Agent → Server | Query current theme state |
| `theme:response` | Server → Agent | Response with theme data |
| `theme:mode:changed` | Agent/UI → Server → Broadcast | Toggle light/dark mode |
| `theme:accent:changed` | Agent/UI → Server → Broadcast | Change accent color |
| `workspace:theme:updated` | Agent/UI → Server → Broadcast | Per-workspace overrides |

### CLI Theme Control

Quick theme toggle from command line (requires authentication):

```bash
# Set your token
TOKEN="your-agent-token"

# Switch to dark mode
node -e "const ws = new (require('ws'))('ws://localhost:4748?token=$TOKEN'); ws.on('open', () => { ws.send(JSON.stringify({type:'theme:mode:changed',timestamp:Date.now(),source:'agent',data:{mode:'dark'}})); setTimeout(() => process.exit(), 500); });"

# Switch to light mode
node -e "const ws = new (require('ws'))('ws://localhost:4748?token=$TOKEN'); ws.on('open', () => { ws.send(JSON.stringify({type:'theme:mode:changed',timestamp:Date.now(),source:'agent',data:{mode:'light'}})); setTimeout(() => process.exit(), 500); });"

# Change accent color
node -e "const ws = new (require('ws'))('ws://localhost:4748?token=$TOKEN'); ws.on('open', () => { ws.send(JSON.stringify({type:'theme:accent:changed',timestamp:Date.now(),source:'agent',data:{accent:'#ff4d00'}})); setTimeout(() => process.exit(), 500); });"
```
