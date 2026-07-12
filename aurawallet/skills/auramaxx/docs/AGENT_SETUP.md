# Agent Setup

Make sure AuraWallet is running first:

```bash
aurawallet
aurawallet status
```

---

## What are you using?

| Client | Setup |
|--------|-------|
| 🦞 OpenClaw | [Skills](#skills) |
| 🤖 Claude Code | [Skills](#skills) |
| 📟 Codex CLI | [Skills](#skills) |
| 🖥️ Claude Desktop | [MCP](#mcp) |
| 🖱️ Cursor IDE | [MCP](#mcp) |
| 🏄 Windsurf | [MCP](#mcp) |
| 🚀 Antigravity | [MCP](#mcp) |
| 🔌 VS Code + Continue | [MCP](#mcp) |
| 🧩 Any MCP client | [MCP](#mcp) |

---

## Skills

Skills give your agent built-in knowledge of AuraWallet commands and workflows.

Install all at once:

```bash
aurawallet skill
```

Or install per client:

### 🤖 Claude Code

```bash
aurawallet skill --claude

# Or manually, from your project:
mkdir -p .claude/skills
cd .claude/skills
npx -y skills add Aura-Industry/aurawallet
```

Installs to `~/.claude/skills/auramaxx`.

### 📟 Codex CLI

```bash
aurawallet skill --codex

# Or manually, from anywhere:
mkdir -p ~/.codex/skills
cd ~/.codex/skills
npx -y skills add Aura-Industry/aurawallet
```

Installs to `~/.codex/skills/auramaxx`.

### 🦞 OpenClaw

```bash
aurawallet skill --openclaw

# Or manually, install globally for all OpenClaw agents:
mkdir -p ~/.openclaw/skills
cd ~/.openclaw/skills
npx -y skills add Aura-Industry/aurawallet

# Or install into your workspace (project-local):
mkdir -p skills
cd skills
npx -y skills add Aura-Industry/aurawallet
```

Global installs to `~/.openclaw/skills/auramaxx`. Workspace installs to `./skills/auramaxx` (OpenClaw resolves workspace-local `skills/` first).

### Other clients

```bash
cd <your-codebase>
npx -y skills add Aura-Industry/aurawallet
```

### Verify

```bash
aurawallet skill --doctor
```

---

## MCP

MCP gives your agent direct tool access to the agent (read secrets, write secrets, manage wallets). If your client supports [Skills](#skills), use those instead — they're simpler and don't require a running server connection.

Auto-configure all detected clients at once:

```bash
aurawallet mcp --install
```

Or paste this config block into your client's MCP config:

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

### 🤖 Claude Code

```bash
claude mcp add aurawallet -- npx aurawallet mcp
```

### 📟 Codex CLI

```bash
codex mcp add aurawallet -- npx aurawallet mcp
```

### Where to paste the config block

- 🖥️ **Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- 🖱️ **Cursor IDE** — MCP settings JSON editor
- 🏄 **Windsurf** — `~/.windsurf/mcp.json`
- 🔌 **VS Code + Continue** — `.vscode/mcp.json` in your project
- 🦞 **OpenClaw** — add stdio server `npx aurawallet mcp` in MCP settings

Restart your client after saving.

---

## Verify

```bash
aurawallet get OURSECRET
```

Then ask your agent:

`Use the AuraWallet skill to get OURSECRET.`

---

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
