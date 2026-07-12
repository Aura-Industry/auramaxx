# Apps

Overview of the AuraMaxx app system — what apps are, how to install them, and how to create a minimal one.

For the full developer reference (manifest format, SDK API, theming, security model, strategy hooks, examples), see [DEVELOPING-APPS.md](./DEVELOPING-APPS.md).

---

## Overview

Apps are self-contained HTML applications that run inside sandboxed iframes on the AuraMaxx dashboard. There are two kinds:

- **Built-in apps** -- React components registered in `src/lib/app-registry.ts` (wallets, logs, send, etc.)
- **Installed apps** -- standalone HTML+JS bundles installed as folders under `apps/`

Apps can also be extended with AI capabilities by adding strategy fields (`ticker`, `hooks`, `sources`, etc.) to the manifest. This activates the AI engine, turning the app into a strategy that runs on a schedule or responds to messages. See STRATEGY.md in the wallet docs for an overview and DEVELOPING-STRATEGIES.md for the full reference.

Installed apps consist of two files in a folder inside `apps/`:

```
apps/
  my-app/
    app.md      <-- manifest (YAML frontmatter + description)
    index.html     <-- app entry point (HTML + inline JS/CSS)
```

The system discovers apps at runtime by scanning `apps/*/app.md`. Each app's `index.html` is served via `/api/apps/static/<folder>/index.html`, then loaded into a sandboxed iframe as a blob URL with the SDK and theme CSS injected.

### How It Works (Lifecycle)

```
1. Server starts: scans apps/ → creates scoped Bearer tokens for each app
2. GET /api/apps/manifests returns parsed manifest data to the App Store UI
3. User clicks "ADD" in App Store
4. ThirdPartyApp component fetches /api/apps/static/<id>/index.html
5. ThirdPartyApp fetches GET /apps/<id>/token to get the app's Bearer token
6. Host injects: theme CSS + token globals + App SDK script + app HTML
7. Combined HTML is turned into a blob URL and loaded in a sandboxed iframe
8. SDK makes direct fetch() calls to Express :4242/apps/<id>/storage/* with Bearer token
9. SDK makes direct fetch() calls to Express :4242/apps/<id>/message for send()
10. SDK proxies external API requests through Express :4242/apps/<id>/fetch
11. postMessage used only for on() subscriptions (host-bridged)
```

---

## Installing Apps

Apps can be installed from git repos, tarballs, zips, or local paths using the CLI or the dashboard UI.

### CLI

```bash
# Install from a git repo
aurawallet app install github.com/user/my-app

# Install from a git repo subdirectory
aurawallet app install github.com/user/repo#path=apps/my-app

# Install from a local path
aurawallet app install ./path/to/app

# Install from a tarball or zip
aurawallet app install https://example.com/app.tar.gz

# Override the app folder name
aurawallet app install github.com/user/app --name custom-id

# Overwrite an existing app
aurawallet app install github.com/user/app --force

# List all installed apps
aurawallet app list

# Update an app from its original source
aurawallet app update my-app

# Remove an app
aurawallet app remove my-app

# Remove without confirmation prompt
aurawallet app remove my-app --yes
```

### Dashboard UI

1. Open the App Store drawer (click the "+" button on the dashboard)
2. Select the **ALL** or **INSTALLED** tab
3. Paste a source URL into the "Install from URL" input at the top
4. Click **INSTALL** (or press Enter)
5. The app appears in the installed list immediately

### Supported Sources

| Pattern | Type | Example |
|---------|------|---------|
| Starts with `.` or `/` | Local copy | `./apps/my-app` |
| Ends with `.tar.gz` / `.tgz` | Tarball download | `https://example.com/app.tar.gz` |
| Ends with `.zip` | Zip download | `https://example.com/app.zip` |
| Everything else | Git clone | `github.com/user/repo` |
| `#path=subdir` fragment | Subdirectory | `github.com/user/repo#path=apps/foo` |

### Validation

The installer validates each app before copying it to `apps/`:

- `app.md` must exist with valid YAML frontmatter
- `index.html` is loaded if present (optional — headless apps use a default UI)
- No symlinks escaping the app directory
- No file larger than 5MB
- Total size under 20MB
- No ID conflict with existing apps (unless `--force`)

### Provenance

Each installed app gets a `.source.json` file recording where it was installed from:

```json
{
  "type": "git",
  "url": "https://github.com/user/my-app.git",
  "ref": null,
  "subdir": null,
  "installedAt": "2026-02-10T12:00:00.000Z"
}
```

This file is used by `aurawallet app update <id>` to re-install from the original source.

---

## Quick Start

Create a minimal app in 3 steps:

### 1. Create the folder

```bash
mkdir apps/hello-world
```

### 2. Create the manifest (`apps/hello-world/app.md`)

```markdown
---
name: Hello World
icon: Smile
category: general
size: 1x1
permissions:
data:
---

A minimal example app that displays a greeting.
```

### 3. Create the entry point (`apps/hello-world/index.html`)

```html
<!DOCTYPE html>
<html>
<head>
<style>
  body {
    font-family: ui-monospace, monospace;
    background: var(--color-surface, #fff);
    color: var(--color-text, #0a0a0a);
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    font-size: 12px;
  }
</style>
</head>
<body>
  <div>Hello from an app!</div>
</body>
</html>
```

The app will appear in the App Store under the "INSTALLED" tab. Click "ADD" to place it on your workspace.

---

## Built-in Apps

These apps ship with AuraMaxx and appear in the App Store under "BUILT-IN":

| Type | Title | Singleton | Description |
|------|-------|:---------:|-------------|
| `logs` | EVENT LOGS | Yes | Real-time event log viewer |
| `send` | SEND | Yes | Send transactions from hot wallets |
| `agentKeys` | AGENT KEYS | Yes | View and manage agent tokens |
| `token` | TOKEN | No | Market data for a token |
| `setup` | GETTING STARTED | Yes | First-time setup wizard |
| `transactions` | TRANSACTIONS | Yes | Transaction history log |
| `walletDetail` | WALLET | No | Detailed view of a single wallet |
| `iframe` | IFRAME | No | Embed any URL in an iframe |
