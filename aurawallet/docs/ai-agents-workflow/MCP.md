# MCP

AuraMaxx MCP exposes credential and wallet operations to MCP clients over stdio with a single local server entrypoint.  
Use this page for setup and tool surface, then follow client-specific config in `AGENT_SETUP.md`.

## Start

```bash
aurawallet
aurawallet mcp
```

`aurawallet` starts the API server on `http://localhost:4242` and dashboard UI on `http://localhost:4747`.
It also runs best-effort skill sync (`aurawallet skill --all --yes`) and MCP config sync (`aurawallet mcp --install`) on `start` so local agents stay current.
These startup syncs are always-on (no env opt-out toggles).

Auto-configure local IDE MCP files:

```bash
aurawallet mcp --install
```

## Per-client setup (exact locations + JSON)

Use the client-specific setup guide:

- `docs/quickstart/AGENT_SETUP.md`

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

Explicit protected field request:

```json
{
  "name": "DONTLOOK",
  "field": "password"
}
```

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
  "field": "password",
  "envVar": "AURA_DONTNOTE",
  "command": ["/bin/zsh", "-lc", "printenv AURA_DONTNOTE"]
}
```

## MCP Resources

- `docs://api`
- `docs://auth`
- `docs://guide`

## Tools

| # | Tool | Description |
|---|------|-------------|
| 1 | `get_secret` | Look up a credential, inject default env var (`AURA_{SECRETNAME}`), return redacted metadata by default |
| 2 | `put_secret` | Store a new credential (note type) in the default agent |
| 3 | `list_secrets` | List credentials with optional query/tag/agent/lifecycle filters |
| 4 | `del_secret` | Delete a credential by name |
| 5 | `inject_secret` | Read a credential and inject into env var (custom name optional), redacted output by default |
| 6 | `share_secret` | Create a time-limited shareable link for a credential |
| 7 | `api` | Generic AuraMaxx API caller for non-sensitive endpoints (sensitive/internal routes blocked) |
| 8 | `auth` | Request an authenticated session token and return approve/claim URLs (no background auto-poll) |
| 9 | `get_token` | Check if session has an active token; explicitly claim pending auth or one-shot reqId approvals |
| 10 | `approve` | Admin-only shortcut: approve a pending human action by id |
| 11 | `status` | Get server setup/unlock health state |
| 12 | `start` | Start the AuraMaxx server in headless mode if not already running |

`api` is the generic fallback for non-sensitive endpoints; the other tools provide typed, higher-level operations.

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

## Credential read flow via MCP

1. Obtain token (`auth` tool, or socket bootstrap, or `AURA_TOKEN` env var)
2. If using `auth`, call `get_token` to explicitly poll/claim until `hasToken: true` (approval is async)
3. Call `get_secret` (high-level) or `api` POST `/credentials/:id/read` (low-level)
4. Use `command` when you need immediate command-scoped injection; omit `command` to set env var in MCP process and receive WHATDO guidance

Note:
- Typed tools (`get_secret`, `put_secret`, `del_secret`, `share_secret`, `inject_secret`, `approve`) use the active MCP token directly.
- `get_secret` and `inject_secret` are redacted by default (`secret: "*******"`). Set `dangerPlaintext: true` only for break-glass local debugging.
- `dangerPlaintext` only controls output masking. It does not request additional credential fields and does not trigger approval by itself.
- `get_secret` uses the default env var name `AURA_{SECRETNAME}`.
- `get_secret` and `inject_secret` accept optional `field`. When set, MCP sends `requestedFields` to `/credentials/:id/read` so excluded-field approvals happen only for explicitly requested protected fields.
- Both tools accept optional `command` (array of executable + args). When omitted, they return a `whatDo` guidance block and keep scope in MCP server process.
- Typed helpers have **built-in 403 escalation** — on permission denied they automatically return a structured `requiresHumanApproval` response. You do not need to detect 403s yourself for typed tools.
- `auth` does not auto-poll in background. It returns explicit `approveUrl` + `pollUrl` + `claim` guidance plus typed actions (`claimAction`, `retryAction`); callers must claim explicitly via `get_token`.
- `get_token` echoes the same auth context (`reqId`, `approveUrl`, `pollUrl`, `claim`) and includes `requiresHumanApproval` + `approvalFlow` while approval is still required.
- `get_token` now returns deterministic claim fields: `claimStatus` (`pending|approved|rejected|expired`) and `retryReady` (`true|false`).
- For excluded-field read denials (`DENY_EXCLUDED_FIELD`), typed secret-read tools return explicit approval guidance: `approveUrl`, absolute `pollUrl`, `claim` metadata, and ordered `approvalFlow` steps.
- There is no hidden MCP auto-claim in this flow. Agents must explicitly claim before retrying.
- The generic `api` tool does **not** auto-escalate — on 403, check the error response and request appropriate permissions via `auth`.
- The generic `api` tool blocks sensitive claim/plaintext-secret routes (for example `/auth/:reqId`, `/credentials/:id/totp`, `/credential-shares/:token/read`).
- `get_secret` and `inject_secret` accept optional `reqId` for strict retry binding. `reqId` can resolve either a one-shot claim or a claimed session challenge. If `reqId` is provided but no bound claim exists, they return `errorCode: "missing_or_expired_claim"` (no silent fallback).
- Approval-required payloads include:
  - `approvalScope`: `one_shot_read` or `session_token`
  - `claimAction`: `{ transport: "mcp", kind: "tool", tool, args }`
  - `retryAction`: `{ transport: "mcp", kind: "tool", tool, args }`
  - ordered `instructions`

## 403 escalation ladder

1. Call the typed tool or `api`.
2. If 403, typed tools auto-return escalation guidance.
   If the payload includes `requiresHumanApproval` + `reqId`, run:
   1) show `approveUrl` to the human
   2) claim via `get_token` with `{ "reqId": "<reqId>" }` until `claimStatus` is `approved` and `retryReady=true`
   3) retry the original secret read/inject call with the same `reqId`
   Otherwise, follow the returned `nextStep` (`api` call params).
   For `api`, request a new token via `auth` with the required profile/permissions.
   If the denial requires `admin:*`, request `--profile admin`; otherwise default to `--profile dev`.
3. Tell the human to approve in the dashboard at `http://localhost:4747` (or via Telegram/CLI adapter).
4. **Never** retry the same blocked call without escalating first.

## Safety pattern

- Start with least privilege (`secret:read`, narrow `credentialAccess.read` scopes)
- Typed tools auto-escalate on 403; explicitly claim by `reqId` before retry
- For `api`, use `auth` to request a new token
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

See also: [AUTH](./AUTH.md) and [Troubleshooting](../how-to-auramaxx/TROUBLESHOOTING.md).
