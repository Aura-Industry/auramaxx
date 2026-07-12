# Token Policy Reference

This page is the field-by-field reference for token policy and runtime enforcement behavior.  
Use [AUTH.md](./AUTH.md) first for onboarding flow, then this file for exact policy semantics.

## Policy Surface (Full)

Canonical token payload shape:

```json
{
  "agentId": "string",
  "permissions": ["secret:read"],
  "exp": 1735689600000,
  "iat": 1735686000000,
  "limits": {
    "fund": 0,
    "send": 0,
    "swap": 0,
    "launch": 0
  },
  "walletAccess": ["0x..."],
  "credentialAccess": {
    "read": ["agent:primary"],
    "write": ["agent:primary"],
    "excludeFields": ["cvv", "password"],
    "ttl": 3600,
    "maxReads": 500
  },
  "agentPubkey": "PEM-or-base64",
  "limit": 0
}
```

Notes:

- `exp`/`iat` are issuer-managed timestamps.
- `limit` is legacy compatibility (`limits.fund` is the canonical path).

## Where Policy Is Set

### 1) `/auth` (recommended: CLI + MCP path)

- Profile-first issuance only.
- Accepts: `profile`, `profileVersion`, tighten-only `profileOverrides`, optional `limit`/`limits`, optional `walletAccess`.
- Rejects raw issuance knobs: `permissions`, `ttl`, `credentialAccess`.

### 2) `/actions/token` (admin/internal issuance)

- Supports full direct policy issuance.
- XOR contract: exactly one mode:
  - `profile` mode, or
  - `permissions` mode (raw permissions policy).

## Permission Values

Supported permission vocabulary:

- Wallet: `wallet:list`, `wallet:create:hot`, `wallet:create:temp`, `wallet:rename`, `wallet:export`, `wallet:tx:add`, `wallet:asset:add`, `wallet:asset:remove`
- Transactions: `send:hot`, `send:temp`, `swap`, `fund`, `launch`
- Credentials: `secret:read`, `secret:write`, `totp:read`
- Actions: `action:create`, `action:read`, `action:resolve`
- Apps/strategy/workspace: `strategy:read`, `strategy:manage`, `workspace:modify`, `app:storage`, `app:storage:all`, `app:accesskey`, `adapter:manage`
- Misc: `apikey:get`, `apikey:set`, `addressbook:write`, `bookmark:write`
- Compound: `trade:all`, `wallet:write`, `extension:*`
- Full admin: `admin:*`

`trade:all`, `wallet:write`, `extension:*`, and `admin:*` expand to additional permissions during enforcement.

## Credential Policy (`credentialAccess`)

### `read` / `write` scope selectors

Accepted selectors:

- `*` (all credentials)
- `cred-...` (exact credential id)
- `tag:<value>`
- `agent:<value>`
- `tag:*`, `agent:*`
- Prefix wildcard with trailing `*` (example: `agent:prod*`, `tag:team/*`)

### `excludeFields`

Field redaction precedence:

1. Token `credentialAccess.excludeFields` (explicit, even `[]`)
2. Credential-type default (`defaults.credential.excludeFields.<type>`)
3. Empty list

Current defaults include:

- `defaults.credential.excludeFields.card = ["cvv"]`
- `defaults.credential.excludeFields.login = ["password"]`
- `defaults.credential.excludeFields.note = []`

### `ttl` and `maxReads`

- `credentialAccess.ttl`: max seconds since token issue for credential-read/TOTP access.
- `credentialAccess.maxReads`: max successful credential read operations before deny.

## Financial/Wallet Policy

### `limits`

Supported keys:

- `fund`, `send`, `swap`, `launch`

Value type:

- Number (single-currency legacy path), or
- Address-keyed map (`Record<string, number>`) for currency-specific budgets.

Enforcement today:

- `fund`, `send`, `swap`: enforced in spend reservation checks.
- `launch`: present in token schema but not currently enforced by spend-limit checks.

### `walletAccess`

- Array of wallet addresses the token may operate on.
- Access check allows either:
  - explicit grant in `walletAccess`, or
  - ownership fallback (wallet created by the same token hash).

## Profile Overrides (`profileOverrides`)

Tighten-only keys:

- `ttlSeconds`
- `maxReads`
- `scope`
- `readScopes`
- `writeScopes`
- `excludeFields` (can add exclusions, cannot remove profile-required exclusions)

If an override broadens scope, the request is rejected.

## Enforcement Summary

- Route permissions: permission middleware (`requirePermission` / `hasAnyPermission`), with `admin:*` bypass.
- Wallet operation gating: permission + walletAccess/ownership checks.
- Spending limits: in-memory session budget (`fund/send/swap`) with reservation accounting.
- Credential reads/TOTP: scope checks + `ttl` + `maxReads` + per-credential rate limits + `excludeFields` filtering.
- Temp approval escalations for excluded fields mint scoped one-shot read policy (`secret:read`, single credential scope, `maxReads=1`, short TTL).

## Temp Policy Compiler Contract (403 Escalations)

When credential read escalation returns `requiresHumanApproval: true` (`approvalScope: one_shot_read`), payloads can include:

- `requestedPolicySource`: `derived_403`
- `effectivePolicy` (server-compiled policy used at token mint)
- `policyHash` (deterministic hash of compiled policy + compiler version)
- `compilerVersion` (current: `v1`)
- `routeId` (denial-level route key, for example `credentials.read.excluded_field`, `credentials.totp.permission_denied`)
- `routeContractId` (operation-level one-shot contract key, for example `credentials.read`, `credentials.totp`)
- `binding`:
  - `actorId`
  - `method`
  - `routeId`
  - `resourceHash`
  - `bodyHash`
  - `bindingHash`

Rules:

- Client `requestedPolicy` is rejected in one-shot `derived_403` flows (`errorCode: client_policy_not_allowed_for_derived_source`).
- Server always compiles/clamps policy to route constraints before minting (`effectivePolicy` is canonical).
- Current route-contract coverage includes:
  - `credentials.read` (one-shot excluded-field escalation path)
  - `credentials.totp` (one-shot TOTP permission escalation path)
- Retry with explicit `reqId` must use the token bound to that `reqId`; missing/expired binding returns `missing_or_expired_claim`.
- If retry operation does not match the bound operation context, response is deterministic `operation_binding_mismatch`.

## Canonical Escalation Envelope v1

Escalation policy transport now relies on one canonical envelope contract:

- `contractVersion: "v1"` (required)
- approval-required envelopes: `requiresHumanApproval: true`, `reqId`, `approvalScope`, `approveUrl`, typed `claimAction`, typed `retryAction`, `instructions`
- hard-deny envelopes: `requiresHumanApproval: false`, deterministic `errorCode`, `claimStatus`, `retryReady`

Adapters are canonical-only for escalation payloads:

- CLI and MCP reject legacy/missing-version escalation payloads with `errorCode: "unsupported_contract_version"`.
- Transport shaping is minimal: adapters only fill typed claim/retry actions when missing from the canonical payload.

## Related Docs

- [Auth](./AUTH.md)
- [Permissions](../legacy/PERMISSION.md)
- [CLI](./CLI.md)
- [MCP](./MCP.md)
