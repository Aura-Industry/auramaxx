# PERMISSION

Canonical reference for AuraMaxx permission surfaces, request flows, and policy controls.

## 1) Permission map (runtime vocabulary)

High-impact permissions observed in code/docs surfaces:

- `admin:*` — full administrative bypass for guarded routes.
- `action:create` — create human-approval requests (internal `POST /actions`, or `POST /auth` with `action` field).
- `action:read` — list/view pending action requests.
- `action:resolve` — approve/reject pending actions.
- `secret:read` — list/read credential material (subject to token policy + field controls).
- `secret:write` — create/update/delete credential data.
- `trade:all` — broad trade operation scope (high risk).
- `workspace:modify` — workspace mutation capabilities.
- `extension:*` — extension-related broad scope.

Risk guidance:
- **Blocker/High:** `admin:*`, broad write/trade scopes.
- **Medium:** `action:resolve`, `secret:write` (without narrow selectors).
- **Lower (still sensitive):** narrow `secret:read` with strict selector + redaction policy.

## 2) Issuance paths and where permissions come from

### A) `POST /auth` (profile-first, human approval)
- Inputs: `agentId`, `profile`, `pubkey` (+ optional tighten-only overrides).
- Returns request + secret; after approval, agent claims encrypted token.
- Raw permission arrays are not the primary `/auth` contract.

### B) `POST /actions` (internal — strategy engine only)
- Internal route used by the strategy engine's `request_human_action` tool.
- Agents should use `POST /auth` with an optional `action` field instead.
- Requires caller permission: `action:create`.
- Payload includes requested permissions for temporary escalation.
- Human resolves via approve/reject; approved action mints scoped token.

### C) `POST /actions/token` (direct issuance)
- Admin-gated path.
- XOR mode: exactly one of `profile` or `permissions`.
- Supports preview via `POST /actions/token/preview`.

## 3) Runtime enforcement model

- Bearer token validated at route middleware.
- Route guards apply permission checks (`requirePermission`, compound expansion helpers).
- Additional secret-access governance is layered on top of route perms:
  - selector scope checks
  - TTL limits
  - read-count limits
  - field exclusion/redaction

## 4) Config-passable policy controls (code-scan aligned)

Common controls seen in policy/profile surfaces:

- `ttlSeconds` — token lifetime window.
- `maxReads` — cap on successful secret reads.
- `scope` — permission scope list.
- `readScopes` / `writeScopes` — selector constraints.
- `excludeFields` — redact sensitive fields from readable payloads.
- `profileOverrides` — tighten-only adjustments (cannot broaden base profile).

Practical examples:

```json
{
  "profile": "strict",
  "profileVersion": "v1",
  "profileOverrides": {
    "ttlSeconds": 900,
    "maxReads": 25,
    "excludeFields": ["refresh_token", "seedPhrase"]
  }
}
```

```json
{
  "permissions": ["secret:read"],
  "credentialAccess": {
    "read": ["agent:prod/*"],
    "excludeFields": ["password", "privateKey"],
    "maxReads": 10
  }
}
```

## 5) Request flows (quick examples)

### Agent escalation flow (recommended)
1. Agent calls `POST /auth` with `action` field containing the operation to execute.
2. Human approves in dashboard.
3. Token is created and the pre-computed action auto-executes on approval.

### `/actions` API flow (internal — strategy engine)
1. Strategy engine creates action request with needed permissions.
2. Human approves/rejects (`/actions/:id/approve` for admin approval shortcut, or `/actions/:id/resolve`).
3. Approved action auto-executes with scoped token.

### CLI flow
```bash
# Recommended (agents):
npx aurawallet auth request --profile dev --action '{"endpoint":"/send","method":"POST","body":{...}}'

# Internal (strategy engine / admin):
npx aurawallet actions create --summary "Read prod creds" --permissions secret:read
npx aurawallet actions pending
npx aurawallet approve <actionId>
npx aurawallet actions resolve <actionId> --reject
```

### MCP flow
- Start with least-privilege token.
- On 403, the MCP `auth` tool handles escalation via `POST /auth`.
- Retry only after approved token/policy is active.

## 6) Deny, revoke, and escalation implications

- **Deny:** operation remains blocked; caller must request different scope or abort.
- **Revoke:** use token revoke surfaces (`/actions/tokens/revoke` / console) to invalidate issued tokens.
- **Escalation limits:** privileged self-escalation patterns should be blocked; use human-reviewed action/token flows.

## 7) Operator defaults checklist

- Prefer profile-based issuance for normal onboarding.
- Keep TTL short and selectors narrow.
- Always set `excludeFields` when full fields are unnecessary.
- Use approve links/actions for one-time elevated tasks.
- Revoke stale/high-risk tokens after task completion.

## Related docs

- `docs/ai-agents-workflow/AUTH.md`
- `docs/why-auramaxx/security.md`
- `docs/api/authentication.md`
- `docs/ai-agents-workflow/CLI.md`
- `docs/ai-agents-workflow/MCP.md`
