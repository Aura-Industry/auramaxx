# Authentication & Permissions

This document is the practical entry point for onboarding and using AuraMaxx auth safely.
Use explicit `request -> approve -> claim -> retry` flows and keep requested scope minimal for each task.

### Requesting A Temp Token

```bash
# Trigger a protected read (if denied, response includes reqId + approveUrl)
aurawallet get <SECRET_NAME>

# After human approves:
aurawallet auth claim <reqId> --json

# Use reqId once on the retry (consumes temp token)
aurawallet get <SECRET_NAME> --reqId <reqId>
```

### Requesting A Session Token

```bash
# Request a session token (returns reqId + approveUrl)
aurawallet auth request --agent-id <agent> --profile dev

# After human approves:
aurawallet auth claim <reqId> --json

# Retry original command (reqId optional after claim)
aurawallet get <SECRET_NAME>
```

`POST /auth` session token TTLs: `strict=3600s` (default), `dev/admin=604800s` (7 days).

## Quick Start (read this first)

### Who is this for?

- 🤖 **Agents/CI tooling**: prefer `POST /auth` and explicit claim/retry flows.
- 🧑 **Humans**: open the approval link (`/approve/<reqId>`) to review and approve/deny requests.
- 🛠️ **Developers running local MCP/CLI**: use MCP/socket defaults only when local trust is intentionally configured.

### Fastest path (recommended)

#### 1) Agent onboarding (least privilege, human approval)

```bash
# Request an agent token under a named profile (returns reqId + approveUrl + claim/retry actions).
aurawallet auth request --agent-id my-agent --profile dev

# After human approves, explicitly claim/activate token for this CLI session:
aurawallet auth claim <reqId> --json
```

#### 2) Human unlock (admin session)

```bash
aurawallet unlock
# (or: curl POST /unlock for script-driven unlock with encrypted password)
```

#### 3) Validate and troubleshoot

```bash
curl -sS http://localhost:4242/auth/validate \
  -H "Authorization: Bearer <token>"
```

- `200` = token is currently valid for permission checks.
- non-200 = expired/revoked/syntax mismatch, re-run onboarding.

---

## Decision Matrix (pick the right path)

| Use case | Best flow | Why | Typical command/endpoint |
|---|---|---|---|
| Standard agent needs ongoing access | **Profile onboarding** | Bound by profile defaults + tighten-only overrides | `POST /auth` (via `aurawallet auth request`) |
| One-off escalation for one action | **Auth + action** | Token + auto-execute in one approval | `POST /auth` with `action` field |
| Trusted admin automation / headless tool | **Direct issue (admin only)** | Explicit admin-controlled issuance | `POST /actions/token` |
| Local MCP/CLI bootstrap on same host | **Socket bootstrap** | Fast path for trusted local callers | Unix socket + trust defaults |
| Validate active token before use | **Token check** | Detect expiration/revocation before a failing call | `POST /auth/validate` |
| Revoke compromised token | **Revoke token** | Immediate disable for one token | `POST /actions/tokens/revoke` |

If uncertain, default to **profile onboarding** and keep it strict.

---

## Auth Flow Summary

- `POST /auth` is **profile-based** and requires human approval. Supports an optional `action` field for auto-execute on approval.
- `POST /actions` is **internal** (used by the strategy engine). Agents should use `POST /auth` with `action` instead.
  - Internal action requests reject privileged wildcard asks (`admin:*`, `*`, `action:create`).
- `POST /actions/token` is **admin-only** and supports profile-mode or permissions-mode (never both).
- `POST /auth/validate` checks token validity at runtime.
- `POST /actions/tokens/revoke` invalidates issued tokens.

---

## For Agents

> **IMPORTANT**: Agents should request tokens via `POST /auth` and use the approval flow. Human approval is still the security boundary, even when local trust is enabled.

## CLI (recommended)

```bash
# Create auth request (profile flow; default is no-wait payload output)
aurawallet auth request --agent-id my-agent --profile dev

# Claim the approved request by reqId (activates session token)
aurawallet auth claim <reqId> --json
```

Legacy compatibility mode (wait):

```bash
aurawallet auth request --agent-id my-agent --profile dev --wait
```

## MCP / socket bootstrap

```bash
# Start runtime
aurawallet

# Optional one-time IDE setup
aurawallet mcp --install
```

MCP bootstrap path:
1. Unix socket auto-approve (if local trust permits)
2. `AURA_TOKEN` env fallback

If socket bootstrap is blocked, fall back to normal token flow:

```bash
AURA_TOKEN=<token> aurawallet mcp
```

## Raw HTTP / cURL examples

### `POST /auth` (profile flow)

`POST /auth` is profile-based. Raw permission payloads and raw TTL are rejected.

```bash
# 1) Generate ephemeral RSA keypair for token transport
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/aura-agent-private.pem
openssl rsa -in /tmp/aura-agent-private.pem -pubout -out /tmp/aura-agent-public.pem
PUBKEY_B64="$(base64 < /tmp/aura-agent-public.pem | tr -d '\n')"

# 2) Request token issuance
curl -sS -X POST http://localhost:4242/auth \
  -H "Content-Type: application/json" \
  -d "{\"agentId\":\"my-agent\",\"profile\":\"strict\",\"profileVersion\":\"v1\",\"pubkey\":\"$PUBKEY_B64\"}"

# 3) Claim request status (manual claim endpoint)
curl -sS -H "x-aura-claim-secret: <secret>" \
  "http://localhost:4242/auth/<reqId>"
```

### `POST /auth/validate`

```bash
curl -sS -X POST http://localhost:4242/auth/validate \
  -H "Authorization: Bearer <token>"
```

### `POST /actions/token`

`/actions/token` supports **exactly one** issue mode:

- `profile` mode: `profile`, `profileVersion`, optional tighten-only overrides
- `permissions` mode: explicit permission grant

```bash
curl -sS -X POST http://localhost:4242/actions/token \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"profile":"strict","profileVersion":"v1","pubkey":"'$PUBKEY_B64'"}'
```

### Revoke a token

```bash
curl -sS -X POST http://localhost:4242/actions/tokens/revoke \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"jti":"<token_id>","reason":"Compromised agent key"}'
```

## Auth Flow Comparison

| Flow | Endpoint | Human gate? | Intended for |
|---|---|---|---|
| Agent Request | `POST /auth` + claim | Yes | Standard agent onboarding |
| Auth + Action | `POST /auth` with `action` field | Yes | One-off action-scoped escalation (auto-executes on approval) |
| Direct Admin Issue | `POST /actions/token` | Yes (admin required) | Headless/admin orchestration |
| Local Socket | Unix socket bootstrap | Trust-dependent | Fast local MCP bootstrap |
| Unlock/session | `POST /unlock` | Yes | Local machine setup/bootstrap |

## Profile-Based Issuance

### `/auth` is profile-only

`POST /auth` requires:
- `agentId`
- `profile`
- `pubkey`

Optional:
- `profileVersion` (defaults to `v1`)
- `profileOverrides` (tighten-only)
- `limit` / `limits.fund`
- `action` — pre-computed action to auto-execute on approval: `{ endpoint, method, body? }`

Rejected:
- raw `permissions`
- raw `ttl`
- raw `credentialAccess`

### `/actions/token` strict mode

`POST /actions/token` accepts **exactly one** issuance strategy:

- profile mode (`profile`, `profileVersion`, `profileOverrides`)
- permissions mode (`permissions`)

### Built-in Profiles (v1)

| Profile | Permissions | Read Scopes | Write Scopes | Excluded Fields | TTL | Max Reads |
|---------|------------|-------------|-------------|-----------------|-----|-----------|
| `strict` | `secret:read` | `agent:primary, agent:agent` | none | `password, cvv, privateKey, seedPhrase, refresh_token` | 1 hour | 50 |
| `dev` | `wallet:list, secret:read, secret:write, action:create, action:read, action:resolve` | `agent:primary, agent:agent` | `agent:primary, agent:agent` | `cvv, seedPhrase, privateKey, refresh_token` | 7 days | 500 |
| `admin` | `admin:*` | `*` | `*` | none | 7 days | unlimited |

Strict one-shot (temp) approval claims are capped to 5 minutes (`300s`).

### Credential Scope Selectors

Use selectors to bound what an agent can see or edit:

- `agent:agent` — legacy agent id
- `agent:primary` — primary agent only
- `agent:*` — all agents
- `*` — all credentials
- `tag:<label>` — credentials with a specific tag
- `cred-xxxxx` — a specific credential by ID

### Profile Overrides (`profileOverrides`)

Overrides are **tighten-only** — they can only reduce privilege, never broaden it.

| Override Key | Type | Tighten-only Rule |
|---|---|---|
| `ttlSeconds` | number | Must be shorter than profile default |
| `maxReads` | number | Must be ≤ profile default |
| `scope` | string[] | Must be subset of profile permissions |
| `readScopes` | string[] | Must be subset of profile read scopes |
| `writeScopes` | string[] | Must be subset of profile write scopes |
| `excludeFields` | string[] | Can only add exclusions, never remove profile-required ones |

For `POST /auth` session issuance, `dev`/`admin` tokens expire in 7 days (`604800` seconds). `strict` defaults to 1 hour and allows tighten-only TTL overrides.

Example — request a `dev` profile but restrict to agent agent and shorten TTL:

```bash
curl -sS -X POST http://localhost:4242/auth \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "profile": "dev",
    "pubkey": "'$PUBKEY_B64'",
    "profileOverrides": {
      "ttlSeconds": 600,
      "readScopes": ["agent:agent"],
      "writeScopes": ["agent:agent"],
      "excludeFields": ["cvv", "seedPhrase", "privateKey", "refresh_token", "password"]
    }
  }'
```

Use `POST /actions/token/preview` to inspect the effective policy before issuing:

```bash
curl -sS -X POST http://localhost:4242/actions/token/preview \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"profile": "dev", "profileOverrides": {"ttlSeconds": 600}}'
```

## Socket defaults and trust

Defaults:

- API server: `http://localhost:4242`
- Socket path: `/tmp/aura-cli-<uid>.sock`
- Local socket perms: `0600`
- Default trust profile: `admin`
- `trust.localAutoApprove = true`
- `/auth` fallback profile resolution: explicit `--profile`/API value -> `trust.localProfile` -> `dev`

Use admin auth for trust tuning:

```bash
curl -sS -X PATCH http://localhost:4242/defaults/trust.localAutoApprove \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"value": true}'
```

## Approving Requests (for humans)

When an agent requests access, a human must approve it. Every request gets a dedicated approval page:

```
http://localhost:4747/approve/<reqId>
```

The page shows the action summary, requested permissions, risk level, and spending limits. Review the details, then click **Approve** or **Deny**.

**Where to find the link:**
- The `POST /auth` response includes an `approveUrl` field — agents should surface this to the human
- MCP `auth` tool returns `approveUrl` — give this link to the human
- CLI `aurawallet auth request` prints the approval URL
- The dashboard at `http://localhost:4747` also shows pending requests
- Local approval links use `http://localhost:4747/...` (not `https://`)

**For agents:** Always give the human the approval URL. Do not just say "approve in the dashboard" — provide the direct link so they can review and approve with one click.

## Token lifecycle and claim behavior

1) Agent requests token → returns `reqId` + `secret` + `approveUrl`.
2) Human opens approval URL, reviews permissions, and approves.
3) Agent claims by reqId (`aurawallet auth claim <reqId>` or MCP `get_token { reqId }`) → claim semantics.
   - If claim endpoint returns HTTP `403`, adapters return deterministic `errorCode: "claim_invalid_secret"` (not `claim_rejected`).
4) On approval returns `encryptedToken` + metadata.
5) On restart: in-memory state rotates, tokens may be invalidated.
6) On revoke: `POST /actions/tokens/revoke` removes active token from trust boundary immediately.

## Encrypted password transport

Passwords for `/unlock` and `/setup` are RSA-OAEP encrypted before transmission.

- RSA keypair generated on server startup
- Frontend fetches `/auth/connect` pubkey and encrypts password
- Password decrypts server-side; token returns only to validated clients
- Private key stays in process memory

## Canonical Escalation Contract v1 (Appendix)

All escalatable 403 responses now use one envelope contract:

- `contractVersion: "v1"`
- `requiresHumanApproval`
- `reqId`
- `approvalScope`: `one_shot_read | session_token`
- `approveUrl`
- typed `claimAction` + typed `retryAction`
- ordered `instructions`
- deterministic `claimStatus` + `retryReady`

CLI and MCP are canonical-only for escalation payloads. If a 403 escalation payload is missing `contractVersion` or has an unknown version, adapters fail closed with `errorCode: "unsupported_contract_version"`.

### Server example: approval required

```json
{
  "contractVersion": "v1",
  "requiresHumanApproval": true,
  "error": "Insufficient permissions",
  "reqId": "req_123",
  "approvalScope": "session_token",
  "approveUrl": "http://localhost:4747/approve/req_123",
  "claimStatus": "pending",
  "retryReady": false,
  "claimAction": {
    "transport": "http",
    "kind": "request",
    "method": "GET",
    "endpoint": "/auth/req_123"
  },
  "retryAction": {
    "transport": "http",
    "kind": "request",
    "method": "POST",
    "endpoint": "<retry_original_endpoint>",
    "args": { "reqId": "req_123" }
  },
  "instructions": [
    "1) Human approves approveUrl",
    "2) Agent claims reqId",
    "3) Agent retries with reqId"
  ]
}
```

### Server example: deterministic hard deny

```json
{
  "contractVersion": "v1",
  "requiresHumanApproval": false,
  "error": "Route is not escalation-allowlisted",
  "errorCode": "route_not_allowlisted",
  "claimStatus": "expired",
  "retryReady": false
}
```

### CLI projection (typed action filled if missing)

```json
{
  "contractVersion": "v1",
  "requiresHumanApproval": true,
  "reqId": "req_123",
  "claimAction": {
    "transport": "cli",
    "kind": "command",
    "command": "npx aurawallet auth claim req_123 --json"
  },
  "retryAction": {
    "transport": "cli",
    "kind": "command",
    "command": "npx aurawallet get OURSECRET --json --reqId req_123"
  }
}
```

CLI projections now include the exact replay command when the original command context is available.

### MCP projection (typed action filled if missing)

```json
{
  "contractVersion": "v1",
  "requiresHumanApproval": true,
  "reqId": "req_123",
  "claimAction": {
    "transport": "mcp",
    "kind": "tool",
    "tool": "get_token",
    "args": { "reqId": "req_123" }
  },
  "retryAction": {
    "transport": "mcp",
    "kind": "tool",
    "tool": "<retry_original_tool>",
    "args": { "reqId": "req_123" }
  }
}
```

## Related references

- [MCP](./MCP.md)
- [CLI](./CLI.md)
- [Security](../why-auramaxx/security.md)
- [API](./API.md)
- [Troubleshooting](../how-to-auramaxx/TROUBLESHOOTING.md)
