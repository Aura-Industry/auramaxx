# Features

AuraWallet combines local encryption, scoped agent access, and operator controls in one system.  
Scan highlights first, then use the full list to choose what to adopt next.

---

## ✨ Highlights

| | Feature | What it does |
|---|---------|-------------|
| 🔐 | **Security First** | Everything is encrypted locally. Model providers never see your secrets in plain text |
| ⚡ | **Fast & Local** | Your keys never leave your machine |
| 🧾 | **Open Source (MIT)** | Security and source code can be audited by anyone on [GitHub](https://github.com/Aura-Industry/aurawallet) |
| 🤖 | **Works with Multiple AIs** | Connect Claude, Codex, Cursor, VS Code, and more, then give each agent scoped access |
| 🛡️ | **Fine-Grained Control** | Scoped permissions per agent so each tool only gets the access it needs |
| 🔌 | **MCP Integration** | Works with Claude, Codex, Cursor, VS Code, and any MCP-compatible client |
| 💸 | **Wallet Operations** | Send, swap, fund, and launch tokens across Ethereum, Base, and Solana (coming soon) |
| 📱 | **Mobile Approval** | Approve agent access to your agent while away via Telegram, WhatsApp, and other channels |
| 🧩 | **Agent Skills** | One command installs Aura capabilities into Claude, Codex, and OpenClaw agents |

---

## Full Feature List

### Credentials & Agent

- **Encrypted local agent** — AES-256 encrypted credential storage on your machine
- **Get / set / list / delete** — Simple CLI for credential management (`aurawallet get`, `aurawallet set`, `aurawallet list`, `aurawallet del`)
- **Credential types** — API keys, passwords, login credentials, OAuth tokens, wallet seeds
- **Secret sharing** — Create time-limited GitHub gist share links (`aurawallet share`)
- **Environment injection** — Inject secrets into env vars and run commands (`aurawallet inject`)
- **`.aura` file mapping** — Project-level credential mapping for team workflows
- **Credential health monitoring** — Track expiry, usage, and rotation status
- **Import** — Bulk import credentials from `.env` files and other formats
- **Agent tiers** — Cold (human-only), Hot (agent-accessible), Temp (ephemeral)

### CLI

- **Single entry point** — `npx aurawallet` or `aura` for all operations
- **Interactive setup** — Guided first-run experience with dashboard
- **Status & diagnostics** — `aurawallet status` and `aurawallet doctor` for health checks
- **Headless mode** — `aurawallet start --headless` for server-only environments
- **Feature flags** — `aurawallet experimental` to toggle dev features
- **Skill installer** — `aurawallet skill` to install agent skills with doctor verification
- **Lock / unlock** — Agent lock management from CLI
- **Quiet by default** — Concise output with `--debug` for verbose details

### Authentication & Security

- **Profile-based tokens** — Request tokens by profile name (strict, dev, admin)
- **Open source + MIT license** — Security model and implementation are publicly auditable
- **Human approval flow** — Every agent token requires human approval
- **Action requests** — One-time elevated permissions for specific operations
- **Spending limits** — Per-token budget caps for send, swap, fund, and launch
- **Token lifecycle** — Memory-only tokens with configurable TTL (auto-expire on restart)
- **Encrypted transport** — RSA-OAEP encrypted password/token exchange
- **Credential access controls** — TTL, read-count limits, and scope restrictions per credential
- **Strict mode** — Disable auto-approve for maximum security
- **Token revocation** — Revoke active tokens via CLI or API

### MCP Integration

- **Auto-install** — `aurawallet mcp --install` detects and configures all supported IDEs
- **Supported clients** — Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, OpenClaw, Codex
- **Stdio server** — Standard MCP stdio transport (`npx aurawallet mcp`)
- **Socket auth** — Local Unix socket for zero-config authentication
- **Tool discovery** — Full credential and wallet toolset available to MCP clients

### Dashboard

- **Web UI** — Local dashboard at `http://localhost:4747`
- **Agent management** — Create, unlock, and manage agents in the browser
- **Approval cards** — Approve/reject agent token and action requests visually
- **Credential browser** — View, search, and manage stored credentials
- **Wallet overview** — See balances, transactions, and asset tracking
- **Real-time updates** — WebSocket-powered live state sync

### Wallet & Trading (coming soon)

- **Multi-chain** — Ethereum, Base, and Solana support
- **Send** — Transfer native currency and tokens
- **Swap** — Token swaps via Relay (cross-chain), Uniswap (Base), Jupiter (Solana)
- **Fund** — Transfer from cold wallet to hot wallet with spending limits
- **Launch** — Deploy tokens via Doppler fair launch
- **Gas estimation** — Pre-transaction gas cost estimation
- **Transaction history** — Full history with type, status, and amount tracking
- **Asset tracking** — Token balance monitoring per wallet

### Adapters & Notifications

- **Mobile approvals** — Approve requests while away via Telegram, WhatsApp, and other channels
- **Webhook adapter** — HTTP webhook notifications for events
- **Agent chat** — AI-powered conversational interface via Telegram
- **Adapter management** — Enable, configure, and test adapters from CLI or API

### Apps & Extensibility

- **App platform** — Install and run custom apps in the dashboard
- **App storage** — Per-app isolated key-value storage
- **Strategy hooks** — Tick-based and event-driven strategy execution
- **Workspace control** — WebSocket API for dashboard widget management

### Skills & Agent Setup

- **Skill installer** — `npx aurawallet skill` for Claude, Codex, and OpenClaw
- **Bundled docs** — Skills include portable documentation for agent context
- **Doctor verification** — `npx aurawallet skill --doctor` checks install status
- **Fallback guidance** — Clear fallback commands when auto-install fails

---

See also:
- [Getting Started](../quickstart/AGENT_SETUP.md)
- [CLI Reference](../ai-agents-workflow/CLI.md)
- [Auth & Permissions](../ai-agents-workflow/AUTH.md)
- [Troubleshooting](../how-to-auramaxx/TROUBLESHOOTING.md)
