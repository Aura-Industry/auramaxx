# Skills

Skills are local instruction packs that teach agents AuraWallet workflows without requiring a live MCP session.  
Install once per client/workspace, then run tasks with consistent commands and guardrails.

```bash
cd <your-codebase>
npx -y skills add Aura-Industry/aurawallet
```

---

## Install

Install all supported clients at once:

```bash
aurawallet skill
```

In an interactive terminal, `aurawallet skill` shows an arrow-key selector
(`all compatible agents`, `codex only`, `claude only`, `openclaw only`, `cancel`)
with `all compatible agents` as default.

Or install per client:

### Claude Code

```bash
aurawallet skill --claude

# Or manually, from your project:
mkdir -p .claude/skills
cd .claude/skills
npx -y skills add Aura-Industry/aurawallet
```

Installs to `~/.claude/skills/auramaxx`.

### Codex CLI

```bash
aurawallet skill --codex

# Or manually, from anywhere:
mkdir -p ~/.codex/skills
cd ~/.codex/skills
npx -y skills add Aura-Industry/aurawallet
```

Installs to `~/.codex/skills/auramaxx`.

### OpenClaw

```bash
aurawallet skill --openclaw

# Or manually, install globally for all OpenClaw agents:
mkdir -p ~/.openclaw/skills
cd ~/.openclaw/skills
npx -y skills add Aura-Industry/aurawallet
```

Installs to `~/.openclaw/skills/auramaxx`.
OpenClaw resolves workspace-local `skills/` first; for shared skills across agents, keep this in `~/.openclaw/skills` and avoid same-name workspace copies.

### Other clients

```bash
cd <your-codebase>
npx -y skills add Aura-Industry/aurawallet
```

---

## Manual Install (download from GitHub)

If you don't want to use the CLI or `npx`, you can grab the skill folder directly from GitHub:

1. Go to [github.com/Aura-Industry/aurawallet](https://github.com/Aura-Industry/aurawallet)
2. Download or clone the repo
3. Copy the `skills/auramaxx` folder into your client's skill directory:

```bash
# Claude Code
cp -r skills/auramaxx ~/.claude/skills/auramaxx

# Codex CLI
cp -r skills/auramaxx ~/.codex/skills/auramaxx

# OpenClaw
cp -r skills/auramaxx ~/.openclaw/skills/auramaxx

# Any other client — drop it wherever your agent reads skills from
cp -r skills/auramaxx /path/to/your/skills/auramaxx
```

The folder contains:
- `SKILL.md` — main skill file (commands, workflows, error recovery)
- `HEARTBEAT.md` — periodic check-in routine (agent status, secret access, human updates)
- `docs/` — bundled reference docs (API, auth, MCP, security, etc.)

---

## Verify

```bash
aurawallet skill --doctor
```

Then test with your agent:

```bash
aurawallet set OURSECRET "hello from the agent"
```

Ask your agent:

`Use the AuraWallet skill to get OURSECRET.`

---

## What's in the skill

| File | Purpose |
|------|---------|
| `SKILL.md` | Setup flow, wallet operations, permissions, error recovery, tool-call and intent modes |
| `HEARTBEAT.md` | Periodic heartbeat routine — checks agent status, reports secret access, updates human |
| `docs/` | Flattened copies of API.md, AUTH.md, MCP.md, security.md, and other reference docs |

---

## Troubleshooting

See [TROUBLESHOOTING.md](../how-to-auramaxx/TROUBLESHOOTING.md).
