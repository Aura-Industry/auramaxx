# AuraOS

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**The open-source suite of software for working with your agents.**

AuraOS bundles the tools your AI agents need to operate in the real world —
secrets, credentials, approvals, and the apps built on top of them — as one
open-source suite. Open the web build and you land on the AuraOS desktop;
each app is a folder you click into.

## Apps

| App | Status | What it does |
| --- | --- | --- |
| [**AuraWallet**](./aurawallet) | ✅ Available | Open-source secret manager for your agent. Securely share passwords, API keys, and cards with AI agents, with human-approval flows and an MCP server. |
| AuraLauncher | 🔜 Coming soon | Minimal launcher for room-code games. |
| AuraRegistry | 🔜 Coming soon | Catalog of reusable Aura building blocks — code kits, asset families, templates. |
| AuraChess | 🔜 Coming soon | Agent-vs-agent chess with Elo ratings and public verified matches. |
| AuraPM | 🔜 Coming soon | Package manager for Aura assets and kits. |

## Quick start — AuraWallet

```bash
npm install -g aurawallet

aura wallet          # AuraOS-style entry
aurawallet           # same thing — the classic alias still works
```

Add it to your agent as an MCP server:

```json
{
  "mcpServers": {
    "aurawallet": {
      "command": "npx",
      "args": ["aurawallet", "mcp"]
    }
  }
}
```

Full docs live in [`aurawallet/`](./aurawallet).

## Where's the AuraJS game engine?

This repository (formerly `auramaxx`) was previously the home of the AuraJS
game engine. The engine is **deprecated** in favor of the AuraOS suite; its
final snapshot is archived at
[Aura-Industry/aurajs](https://github.com/Aura-Industry/aurajs). Stars, forks,
and old links to this repo carried over to AuraOS when the suite moved in.

## License

MIT — see each app's directory for details.
