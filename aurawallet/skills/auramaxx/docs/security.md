# Security

This document reflects the current security model implemented in the codebase.

## Security Overview (why the model is safe)

AuraMaxx uses a **three-layer model**:

1. **Profile-based issuance** (how a token is created)
2. **Permission-based runtime enforcement** (what a token can do)
3. **Granular credential access policy** (which secrets and fields can be touched)

The result: tokens are easy to issue, strict to scope, and hard to overscope.

### The model in one pass

- Agents usually start with an **agent profile** (`POST /auth`) that defines:
  - base permissions
  - credential read/write scopes (agents/tags/ids)
  - TTL and read limits
  - field redaction policies
- Issuance is intentionally **human-approved** and not self-service by default.
- Every API request is still validated again using runtime permission checks.
- Secret access is additionally constrained by selector checks and read budgets.
- Tokens are short-lived and can be revoked proactively.

### What “least privilege” means here

- Profiles give sensible defaults, but they are not blanket trust.
- Every request is still gated by permissions + scope.
- Agent callers can only operate on explicitly authorized agents and fields.
- If a profile must be tighter, overrides must be **tighten-only**.

---

## Core Principles

1. **Memory-rooted auth/session state** — in-memory SIGNING_KEY, sessions, and revocation state drive runtime trust boundaries.
2. **Restart invalidates all tokens** — new SIGNING_KEY is generated each restart.
3. **Minimal permissions** — tokens carry exactly the permissions needed.
4. **Encrypted secrets at rest** — credential fields are encrypted in local DB with agent-derived keys.
5. **Encrypted credential transport** — secret reads are encrypted to the caller's RSA pubkey.
6. **Human-controlled unlocks** — privileged operations require explicit human action.
7. **Scoped ownership** — credential access requires explicit credential selectors + permission checks.

## Current Security Model

AuraMaxx is **profile-first** for issuance, but **permission- and scope-enforced at runtime**.

- Issuance determines token payload (permissions, TTL, credential selectors, exclusions).
- Middleware enforces per-route permissions on every call.
- Credential read/write governance adds extra controls:
  - selector checks
  - per-token read budgets
  - max read/window throttles
  - excluded field minimization

Auth/session truth source is still memory-first:

- Tokens are signed in memory (`SIGNING_KEY`).
- Session counters/tracking are memory-backed.
- Revocations are memory-backed (`revokedTokens`).
- DB is authoritative for UI/audit views, not for runtime auth decisions.

## Agent Token Paths

> For quickstart usage and CLI examples, see [AUTH.md](AUTH.md). This section describes the security enforcement model for each path.

### 1) `POST /auth` (profile-only request + human approval)

Standard agent onboarding path.

- Required: `agentId`, `profile`, `pubkey`.
- Rejects raw issuance (`permissions`, `ttl`, `credentialAccess`) on `/auth`.
- Resolves profile policy and stores approval request in memory.
- After approval, claim via `GET /auth/:requestId?secret=...`.

### 2) `POST /actions` + `/actions/:id/resolve` (internal — strategy engine only)

> **Note**: `/actions` routes are internal. Agents should use `POST /auth` with an optional `action` field for one-off escalation with auto-execute.

- Used internally by the strategy engine's `request_human_action` tool.
- Caller needs `action:create` to submit.
- Payload is permission-based.
- Self-escalation is blocked for `admin:*` and `action:create`.
- Approved request gets a scoped token and escrowed claim path.

### 3) `POST /actions/token` (admin direct issuance)

Admin-only endpoint with XOR mode:

- `profile` mode: profile + optional tighten-only overrides
- `permissions` mode: explicit permissions

Exactly one mode must be supplied.

### 4) Validation and revocation

- `POST /auth/validate` validates token status, expiry, and revocation.
- `POST /actions/tokens/revoke` forcibly removes active token trust.

## Profile-Based Security (Current)

Built-in profile IDs (`v1`): `strict`, `dev`, `admin`.

See [AUTH.md — Built-in Profiles](AUTH.md#built-in-profiles-v1) for the full breakdown of permissions, scopes, excluded fields, TTL, and max reads per profile.

Profile resolution (`resolveProfileToEffectivePolicy`) produces:

- expanded permissions
- `credentialAccess.read` / `credentialAccess.write`
- `excludeFields`
- `ttlSeconds`
- `maxReads`
- `effectivePolicyHash`

### Tighten-only overrides

Overrides are only allowed to reduce privilege:

- shorter TTL / fewer reads
- narrower permission scope
- narrower credential selectors
- stronger field exclusions

## Permission Enforcement (Runtime)

Runtime enforcement always applies:

- route middleware validates signature, expiry, revocation
- permission checks (`requirePermission`, `hasAnyPermission`) gate capabilities
- `admin:*` remains privileged bypass flag where explicitly required

Profile is issuance; permission enforcement is the live guardrail.

## Granular credential access controls

AuraMaxx supports fine-grained secret governance:

- `secret:read` and `secret:write` route gating
- credential selectors:
  - `agent:agent`, `agent:primary`, `agent:*`, `*`
  - `tag:<label>`
  - `cred-xxxxx`
- policy TTL and `maxReads`
- per-credential/minute rate limits
- field minimization via `excludeFields`

This means permissions can say “can read secrets,” and selectors define **where** and **what field-level data** is reachable.

### Recommended mental model

- Permissions say **action** (`read`/`write`/`totp`),
- selectors say **scope** (agent/field scope),
- TTL/limits say **time/volume**.

## Encrypted transport boundaries

- `GET /auth/connect` returns a short-lived server public key.
- `/setup` and `/unlock` accept encrypted payloads.
- Agent token claim endpoints return `encryptedToken`.
- Secret reads return ciphertext suitable to caller key material.

This prevents plaintext secrets in transit for normal operations.

## Strict mode and local auto-approve

Strict posture is preferred for high-trust environments.

Set strict local defaults:

- `trust.localProfile = strict`
- `trust.localAutoApprove = false`

Quick commands:

```bash
curl -sS -X PATCH http://localhost:4242/defaults/trust.localProfile \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"value":"strict"}'

curl -sS -X PATCH http://localhost:4242/defaults/trust.localAutoApprove \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"value":false}'
```

## Profile creation and validation

Profiles are derived from built-ins + tighten-only overrides.

Supported override keys:

- `ttlSeconds`
- `maxReads`
- `scope`
- `readScopes`
- `writeScopes`
- `excludeFields`

Prefer preview before issuing:

- `POST /actions/token/preview`
- `aurawallet token preview --profile <id> [--profile-version v1] [--overrides '{...}']`

## Endpoint Cheat Sheet

| Endpoint | Style | Typical use |
|---|---|---|
| `POST /auth` | Profile onboarding | Standard agent setup (human approval) |
| `GET /auth/:requestId?secret=...` | Profile claim | Agent retrieves encrypted token |
| `POST /auth/validate` | Validation | Verify token validity before use |
| `POST /actions` | Internal (strategy engine) | Temporary action request |
| `POST /actions/:id/resolve` | Internal (approval) | Human approves action request |
| `POST /actions/token` | Admin direct issue | Admin direct token issuance |
| `POST /actions/tokens/revoke` | Revocation | Immediate invalidate token |
| `POST /actions/token/preview` | Preview | Validate effective policy before issue |
| `POST /unlock` / `POST /setup` | Session bootstrap | Human local admin access |

## Related Docs

- [Auth](AUTH.md)
- [API Authentication](./api/authentication.md)
- [API System](./api/system.md)
- [CLI](CLI.md)
- [Best Practices](./BEST-PRACTICES.md)
