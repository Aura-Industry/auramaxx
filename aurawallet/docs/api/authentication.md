# API Authentication

This page is the detailed auth/token reference used by `/api` Getting Started.

## Agent Bootstrap Flow

1. `POST /auth` with `agentId`, profile, and `pubkey`
2. Human approves request
3. Agent polls `GET /auth/:requestId` with header `x-aura-claim-secret: <secret>`
4. Agent receives approved token payload and uses it as `Authorization: Bearer <token>`

## Core Auth Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/auth/connect` | GET | Public | Returns server ephemeral RSA public key |
| `/auth` | POST | Public | Create approval request for agent token |
| `/auth/:requestId` | GET | Public (with claim secret header) | Poll pending/approved/rejected token request (`x-aura-claim-secret`; query `?secret=` is deprecated fallback) |
| `/auth/pending` | GET | Public | List pending auth requests |
| `/auth/validate` | POST | Public | Validate token payload/shape |

## Passkey Session Endpoints

Agent-unlock passkeys for session auth (separate from credential passkeys):

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/auth/passkey/status` | GET | Public | Passkey auth readiness/status |
| `/auth/passkey/register/options` | POST | Admin | Generate registration options |
| `/auth/passkey/register/verify` | POST | Admin | Verify registration response |
| `/auth/passkey/authenticate/options` | POST | Public | Generate authentication options |
| `/auth/passkey/authenticate/verify` | POST | Public | Verify assertion and mint token |
| `/auth/passkey/:credentialId` | DELETE | Admin | Remove registered agent passkey |

For credential passkeys (`/credentials/passkeys/*`), see security and auth references in [`AUTH.md`](/docs/ai-agents-workflow/AUTH.md) and [`security.md`](/docs/why-auramaxx/security.md).

## Human/Admin Session Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/unlock` | GET | Public | Browser unlock fallback page |
| `/unlock` | POST | Public | Unlock primary agent; mint admin token |
| `/unlock/:agentId` | POST | Public | Unlock specific agent; mint admin token |
| `/unlock/rekey` | POST | Public | Re-key session with new `pubkey` |
| `/unlock/recover` | POST | Public | Seed-based recovery path |
| `/lock` | POST | Admin | Lock all agents |
| `/lock/:agentId` | POST | Admin | Lock one agent |

## Human Action + Token Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/actions/pending` | GET | `action:read` | List pending actions |
| `/actions` | POST | `action:create` | Create action request (or notify-only request) |
| `/actions/:id/resolve` | POST | `action:resolve` (reject), Admin (approve) | Resolve action (`approved: false` only requires `action:resolve`; `approved: true` requires `admin:*`) |
| `/actions/:id/approve` | POST | Admin | Admin-only approve shortcut |
| `/actions/token` | POST | Admin | Direct token mint (no human approval) |
| `/actions/token/preview` | POST | Admin | Preview token policy before mint |
| `/actions/tokens` | GET | Admin | List issued tokens by status |
| `/actions/tokens/revoke` | POST | Bearer | Revoke token |

## Setup + Agent Auth Lifecycle

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/setup` | GET | Public | Setup state (`hasWallet`, `unlocked`) |
| `/setup` | POST | Public | Create primary agent/cold wallet |
| `/setup/password` | POST | Admin | Rotate primary agent password |
| `/setup/agent` | POST | Admin | Create additional agent |
| `/setup/agent/import` | POST | Admin | Import agent from mnemonic |
| `/setup/agents` | GET | Public | List agents + unlock status |

## Required Mint Input

Token minting paths require a valid RSA `pubkey` (`/auth`, `/unlock`, `/setup`, `/actions/token`, etc.).
Credential read payloads are encrypted to the token's pubkey.

## Full Permissions Reference

For the complete permission matrix and profile rules, use [AUTH.md](/docs/ai-agents-workflow/AUTH.md).
