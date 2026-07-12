# Architecture

This explains how AuraMaxx is wired end-to-end, from local services to auth and approval flow.  
Start with the simple version first, then read deeper sections as needed.

---

## What AuraMaxx Is

AuraMaxx is a local-first credential and wallet manager designed for AI agents. It runs on your machine, stores secrets encrypted on disk, and gives agents scoped access through short-lived tokens that a human must approve.

```
Human unlocks agent → Agent requests access → Human approves → Agent gets scoped token
```

That's it. Everything else is enforcement.

---

## The Simple Version

**Three things run locally:**

1. **Wallet server** (`:4242`) — the API. Handles auth, wallets, credentials, transactions.
2. **Dashboard** (`:4747`) — web UI for approvals, wallet management, monitoring.
3. **Cron** — background jobs (balance sync, price updates). No HTTP port.

**Data lives in `~/.auramaxx/`** — SQLite database, encrypted agent files, config. All local, outside the repo.

**Agents talk to the wallet server** with a Bearer token. Humans interact through the dashboard or CLI.

---

## How Agents Get Access

Agents cannot self-issue tokens. Every token starts with a human decision.

### The standard flow

```
1. Agent sends POST /auth with { agentId, profile, pubkey }
2. Server creates a pending request, returns requestId + secret + approveUrl
3. Human opens approval URL, reviews permissions, approves or denies
4. Agent polls GET /auth/:requestId with header x-aura-claim-secret and claims the encrypted token
5. Agent uses token as Bearer header on all subsequent API calls
```

The token is encrypted to the agent's RSA public key during transport — the server never sends a plaintext token over the wire.

### Why profiles instead of raw permissions

Agents request access by **profile name** (`strict`, `dev`, `admin`), not by listing individual permissions. This is intentional:

- Profiles bundle sensible defaults — permissions, agent scopes, field redactions, TTL, read limits
- Agents cannot request arbitrary permission sets on the standard path (`POST /auth` rejects raw `permissions`, `ttl`, and `credentialAccess`)
- Humans review a known profile with predictable behavior, not an ad-hoc permission list
- Overrides are **tighten-only** — an agent can ask for less access than a profile grants, never more

See [AUTH.md — Built-in Profiles](../ai-agents-workflow/AUTH.md#built-in-profiles-v1) for the full profile breakdown.

### TL;DR: Why this security model

AuraMaxx is optimized for one practical goal: let agents work fast without giving them permanent implicit trust.

- **Human intent stays in the loop**: high-impact access still requires explicit approval.
- **Least privilege is the default**: profiles, scopes, TTL, and read limits minimize blast radius.
- **Compromise is short-lived**: memory-rooted signing state means restart invalidates old tokens.
- **Approval is deterministic**: agents follow explicit `approve -> claim -> retry` actions instead of guessing.
- **One-shot and session access stay separate**: temporary escalation cannot silently become durable privilege.

For the full approval challenge contract and transport rules, see [Security](./security.md#canonical-approval-challenge-flow-cli--mcp).

---

## Why It's Secure

### 1. Memory-only auth state

The core security property: **auth decisions never touch the database**.

```
IN MEMORY (drives all auth):           IN DATABASE (display only):
├── SIGNING_KEY (random 32 bytes)      ├── AgentToken table
├── sessions Map (spending tracking)    │   ├── tokenHash
├── revokedTokens Set                   │   ├── agentId, limit, spent
└── pendingRequests Map                 │   └── isRevoked, expiresAt
```

- `SIGNING_KEY` is generated fresh on every server start — all old tokens are instantly invalid
- A stolen database is useless without the in-memory key
- Token validation checks memory signature + expiry + revocation status, never the DB
- Restart = forced re-approval = security feature, not a bug

### 2. Three-layer enforcement

Every API call passes through three independent checks:

**Layer 1 — Profile issuance** (what the token was created with):
- Permissions, agent scopes, field exclusions, TTL, read budget
- Set at creation time, cannot be modified after

**Layer 2 — Route middleware** (checked on every request):
- Signature validation against in-memory `SIGNING_KEY`
- Expiry check
- Revocation check
- Permission check (`requirePermission` / `hasAnyPermission`)

**Layer 3 — Credential access policy** (for secret operations):
- Agent/tag/ID selector matching
- Per-token read budget tracking
- Field minimization (`excludeFields` strips sensitive data before encryption)
- Rate limiting per credential per minute

A request must pass all three layers. Issuance defines the ceiling; runtime enforcement is the live guardrail.

### 3. Encrypted transport everywhere

- **Agent unlock**: password is RSA-OAEP encrypted before transmission (server pubkey from `GET /auth/connect`)
- **Token claim**: token is encrypted to the agent's RSA public key
- **Secret reads**: credential fields are encrypted to the caller's key material
- No plaintext secrets cross the wire in normal operation

### 4. Human approval gate

Every token issuance path requires human involvement:

| Path | Human gate |
|------|-----------|
| `POST /auth` | Human must approve the pending request |
| `POST /actions` | Human must resolve the action (`/actions/:id/resolve`) |
| `POST /actions/token` | Caller must already have admin token |
| Socket bootstrap | Trust-dependent (configurable, default: `localAutoApprove = true`) |

Agents cannot escalate their own permissions — `admin:*` and `action:create` are blocked from self-escalation via `POST /actions`.

---

## Credential Agent

Credentials are the core data type. The agent provides encrypted storage with scoped access.

### Encryption

```
Agent Mnemonic → HKDF("credential-v1:<agentId>") → Per-Agent Key → AES-256-GCM per credential
```

- Each agent derives its own encryption key from its mnemonic
- Credentials are individual encrypted files under `~/.auramaxx/credentials/`
- Metadata (name, type, tags) stays plaintext for listing/search
- Sensitive fields are encrypted at rest and in transport

### Access control

Token-level scoping via `credentialAccess`:

- **Selectors** define where: `agent:agent`, `agent:*`, `tag:<label>`, `cred-xxxxx`, `*`
- **Permissions** define what: `secret:read`, `secret:write`, `totp:read`
- **Limits** define how much: `maxReads`, `ttl`, per-credential rate limits
- **Field minimization** defines visibility: `excludeFields` strips fields before they're encrypted to the caller

Mental model: permissions say **action**, selectors say **scope**, limits say **budget**.

---

## Process Model

```
┌────────────────────┐     ┌────────────────────┐
│   Express :4242    │     │   Dashboard :4747   │
│   Wallet API       │◄────│   Next.js UI        │
└────────┬───────────┘     └────────┬────────────┘
         │                          │
         ▼                          ▼
┌────────────────────┐     ┌────────────────────┐
│  WebSocket :4748   │◄────│   Cron (background) │
│  Event broadcast   │     │   Balance sync      │
└────────────────────┘     │   Price updates     │
                           └────────────────────┘
┌────────────────────┐
│  MCP Server        │
│  stdio transport   │──── HTTP ───► Express :4242
│  Claude/Cursor/etc │
└────────────────────┘
```

| Process | Port | Purpose |
|---------|------|---------|
| **Express** | 4242 | Wallet API — auth, wallets, credentials, transactions |
| **Dashboard** | 4747 / 4748 (WS) | Web UI + real-time event broadcast |
| **Cron** | None | Background jobs — balance sync, price updates |
| **MCP** | None (stdio) | Tool interface for AI agents (Claude, Cursor, etc.) |

All processes communicate through WebSocket broadcasts and HTTP calls to Express.

### Data directory (`~/.auramaxx/`)

| Path | Purpose |
|------|---------|
| `auramaxx.db` | SQLite database |
| `agent-primary.json` | Primary agent (encrypted seed phrase) |
| `agent-*.json` | Additional agents |
| `config.json` | Chain configs, server port |

---

## Middleware Stack

```
Request
  │
  ├─ CORS
  ├─ JSON body parser
  ├─ Rate limiters (hot-reloadable)
  │   ├─ Brute-force: 5/15min  → /unlock, /setup, /actions, /nuke
  │   ├─ Auth:        10/min   → /auth
  │   ├─ Transaction:  30/min  → /send, /swap, /fund, /launch
  │   └─ General:     100/min  → everything else
  ├─ Request logging
  └─ Error handler
```

Rate limits are configurable via SystemDefaults (hot-reloadable without restart).

---

## Token Lifecycle

```
Agent requests token  →  Pending (in memory, waiting for human)
Human approves        →  Token signed with SIGNING_KEY, encrypted to agent pubkey
Agent claims token    →  One-time claim, token cleared from escrow
Agent uses token      →  Every call: signature + expiry + revocation + permission check
                         Spending tracked in memory, synced to DB for display
Server restarts       →  Memory wiped, new SIGNING_KEY, all tokens invalid
                         Agent must re-request, human must re-approve
Token revoked         →  Added to revokedTokens set, immediately rejected
```

---

## Related Docs

- [Auth](../ai-agents-workflow/AUTH.md) — practical auth guide, profile builder, CLI examples
- [Security](./security.md) — security model deep dive, enforcement details
- [MCP](../ai-agents-workflow/MCP.md) — MCP server configuration and tool reference
- [CLI](../ai-agents-workflow/CLI.md) — headless CLI mode
- [Credentials](../ai-agents-workflow/credentials.md) — credential types and agent reference
