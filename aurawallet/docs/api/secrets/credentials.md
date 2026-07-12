# Secrets & Credentials API

## MCP Tool Mapping

| MCP Tool | Typical HTTP Path |
|---|---|
| `get_secret` | `GET /credentials` -> `POST /credentials/:id/read` |
| `put_secret` | `POST /credentials` or `PUT /credentials/:id` |
| `write_diary` | `POST /what_is_happening/diary` |

## Credential Agent Management

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/agents/credential` | GET | Admin | List credential agents + counts/unlock state |
| `/agents/credential` | POST | Admin | Create credential agent (`linked` or `independent`) |
| `/agents/credential/:id/lock` | POST | Admin | Lock credential agent |
| `/agents/credential/:id` | DELETE | Admin | Delete agent and assigned credentials |

## Credential CRUD + Lifecycle

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/credentials` | GET | `secret:read` | List metadata; supports scope filters |
| `/credentials` | POST | `secret:write` | Create credential |
| `/credentials/:id` | GET | `secret:read` | Read metadata |
| `/credentials/:id` | PUT | `secret:write` | Update credential |
| `/credentials/:id` | DELETE | `secret:write` | Lifecycle delete (active -> archive -> recently deleted -> purge) |
| `/credentials/:id/restore` | POST | `secret:write` | Restore archived/deleted credential |
| `/credentials/purge` | POST | `secret:write` | Purge retention-expired deleted credentials |
| `/credentials/:id/read` | POST | `secret:read` | Read encrypted secret payload (agent pubkey required) |
| `/credentials/:id/totp` | POST | `totp:read` | Generate current TOTP code |
| `/credentials/:id/reauth` | POST | `secret:write` | OAuth2 re-auth handoff helper |

## Credential Health

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/credentials/health/summary` | GET | `secret:read` | Aggregate health summary |
| `/credentials/health` | GET | `secret:read` | Per-credential health rows |
| `/credentials/health/rescan` | POST | `secret:read` | Trigger async rescan job |
| `/credentials/health/rescan/:scanId` | GET | `secret:read` | Poll scan job status |

## Import + Passkey Credential Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/credentials/import` | POST | Admin | Import credentials (CSV/1PUX, preview/commit behavior) |
| `/credentials/passkey/register` | POST | Bearer | Register credential-passkey entry |
| `/credentials/passkey/authenticate` | POST | Bearer | Authenticate using stored credential passkey |
| `/credentials/passkey/match` | GET | Bearer | Match passkeys for `rpId` |

## Minimal Create/Read Examples

Create:

```http
POST /credentials
Authorization: Bearer <token>
Content-Type: application/json

{
  "agentId": "primary",
  "type": "apikey",
  "name": "OPENAI_API_KEY",
  "fields": [
    { "key": "key", "value": "sk-...", "type": "secret", "sensitive": true }
  ]
}
```

Read:

```http
POST /credentials/:id/read
Authorization: Bearer <token>
Content-Type: application/json

{
  "requestedFields": ["password"]
}
```

Response returns encrypted payload (never plaintext secret fields for non-admin agents).

`requestedFields` is optional:
- If omitted, excluded fields are redacted/omitted and no excluded-field approval is raised.
- If present and it explicitly includes an excluded field (for example `cvv`), the route can return `DENY_EXCLUDED_FIELD` and one-shot approval metadata.
