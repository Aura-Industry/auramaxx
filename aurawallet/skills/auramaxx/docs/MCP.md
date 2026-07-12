# MCP

AuraWallet MCP server exposes credential agent and wallet APIs to MCP clients over stdio.

## Start

```bash
aurawallet
aurawallet mcp
```

`aurawallet` starts the API server on `http://localhost:4242` and dashboard UI on `http://localhost:4747`.

Auto-configure local IDE MCP files:

```bash
aurawallet mcp --install
```

## Per-client setup (exact locations + JSON)

Use the client-specific setup guide:

- `docs/AGENT_SETUP.md`

It includes exact config locations, copy-paste JSON, restart steps, and quick verification for Cursor, Codex, Claude Desktop, OpenClaw, and generic MCP clients.

## Quickstart (TL;DR: get / set / list)

Use this flow first. It mirrors the `WORKING_WITH_SECRETS.md` command patterns.

### Set a secret (`put_secret`)

```json
{
  "name": "OURSECRET",
  "value": "123"
}
```

### Get a secret (`get_secret`)

```json
{
  "name": "DONTLOOK"
}
```

- This returns redacted output (`"secret": "*******"`) and sets `AURA_DONTLOOK` in MCP server process scope.

Command-scoped injection (recommended):

```json
{
  "name": "DONTLOOK",
  "command": ["/bin/zsh", "-lc", "printenv AURA_DONTLOOK"]
}
```

Unsafe plaintext debug output:

```json
{
  "name": "DONTLOOK",
  "dangerPlaintext": true
}
```

### List secrets (`list_secrets`)

```json
{}
```

Filter by name/tag/agent:

```json
{
  "q": "github",
  "tag": "prod",
  "agent": "primary"
}
```

### Custom env var name (`inject_secret`)

```json
{
  "name": "DONTLOOK",
  "envVar": "AURA_DONTNOTE",
  "command": ["/bin/zsh", "-lc", "printenv AURA_DONTNOTE"]
}
```

## MCP Resources

- `docs://api`
- `docs://auth`
- `docs://guide`

## Tools (12)

| # | Tool | Description |
|---|------|-------------|
| 1 | `get_secret` | Look up a credential, inject default env var (`AURA_{SECRETNAME}`), return redacted metadata by default |
| 2 | `put_secret` | Store a new credential (note type) in the default agent |
| 3 | `list_secrets` | List credentials with optional query/tag/agent/lifecycle filters |
| 4 | `del_secret` | Delete a credential by name |
| 5 | `inject_secret` | Read a credential and inject into env var (custom name optional), redacted output by default |
| 6 | `share_secret` | Create a time-limited shareable link for a credential |
| 7 | `api` | Generic AuraWallet API caller (any endpoint, any method) |
| 8 | `auth` | Request an authenticated session token (ephemeral RSA + human approval polling) |
| 9 | `get_token` | Check if session has an active token (poll after `auth` for approval status) |
| 10 | `status` | Get server setup/unlock health state |
| 11 | `start` | Start the AuraWallet server in headless mode if not already running |
| 12 | `write_diary` | Append an entry to a daily diary note |

`api` is the generic fallback for any endpoint; the other tools provide typed, higher-level operations.

## Skill Install

Install AuraWallet skills for your AI agents:

```bash
npx aurawallet skill
```

This auto-installs skills for Claude, Codex, and OpenClaw. Verify with:

```bash
npx aurawallet skill --doctor
```

If auto-install fails, use the fallback:

```bash
cd <your-codebase> && npx -y skills add Aura-Industry/aurawallet
```

For a pushed GitHub ref (branch or commit):

```bash
python3 ~/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py \
  --repo Aura-Industry/aurawallet \
  --path skills/auramaxx \
  --ref <branch-or-commit>
```

`write_diary` appends to `{YYYY-MM-DD}_LOGS` notes using agent agent by default, with fallback to primary agent.
Diary notes use canonical note field key `content` (`value` is accepted as a legacy alias and normalized).

## Credential read flow via MCP

1. Obtain token (`auth` tool, or socket bootstrap, or `AURA_TOKEN` env var)
2. If using `auth`, poll with `get_token` until `hasToken: true` (approval is async)
3. Call `get_secret` (high-level) or `api` POST `/credentials/:id/read` (low-level)
4. Use `command` when you need command-scoped injection; omit `command` to set env var in MCP process and receive WHATDO guidance

Note:
- Typed tools (`get_secret`, `put_secret`, `del_secret`, `share_secret`, `inject_secret`, `write_diary`) use the active MCP token directly.
- `get_secret` and `inject_secret` are redacted by default (`secret: "*******"`). Set `dangerPlaintext: true` only for break-glass local debugging.
- `get_secret` uses the default env var name `AURA_{SECRETNAME}`.
- Both tools accept optional `command` (array of executable + args). When omitted, they return a `whatDo` guidance block and keep scope in MCP server process.
- Typed helpers have **built-in 403 escalation** — on permission denied they automatically return a structured `requiresHumanApproval` response. You do not need to detect 403s yourself for typed tools.
- The generic `api` tool does **not** auto-escalate — on 403, check the error response and request appropriate permissions via `auth`.

## 403 escalation ladder

1. Call the typed tool or `api`.
2. If 403, typed tools auto-return a `nextStep` with the `api` call params — follow it.
   For `api`, request a new token via `auth` with the required profile/permissions.
3. Tell the human to approve in the dashboard at `http://localhost:4747` (or via Telegram/CLI adapter).
4. **Never** retry the same blocked call without escalating first.

## Safety pattern

- Start with least privilege (`secret:read`, narrow `credentialAccess.read` scopes)
- Typed tools auto-escalate on 403; for `api`, use `auth` to request a new token
- Tell the human to approve at `http://localhost:4747`
- Avoid broad long-lived tokens

## Example call

```json
{
  "method": "POST",
  "endpoint": "/credentials/cred-123/read",
  "body": {}
}
```

See also: [GETTING_SECRETS](./external/HOW_TO_AURAMAXX/GETTING_SECRETS.md), [AUTH](AUTH.md), and [Troubleshooting](TROUBLESHOOTING.md).
