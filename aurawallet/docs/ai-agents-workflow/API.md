# AuraMaxx API

This is the API entrypoint for agents integrating with AuraMaxx programmatically.  
Follow the common auth-first path here, then move to deeper endpoint references.

Server base URL:

```text
http://localhost:4242
```

## Common Path (Agent First)

### 1) Request an agent token

```http
POST /auth
Content-Type: application/json

{
  "agentId": "my-agent",
  "profile": "strict",
  "profileVersion": "v1",
  "pubkey": "<RSA public key PEM or base64>",
  "action": {                          // optional: auto-execute on approval
    "endpoint": "/send",
    "method": "POST",
    "body": { "to": "0x...", "amount": "0.01" }
  }
}
```

When `action` is provided, the pre-computed action auto-executes with the newly-minted token after human approval.

Human approves in dashboard, then poll:

```http
GET /auth/:requestId
x-aura-claim-secret: :secret
```

### 2) Read a secret (`get_secret`)

`get_secret` maps to credential APIs under the hood:

- find credential metadata: `GET /credentials`
- read encrypted fields: `POST /credentials/:id/read`

### 3) Set/update a secret (`put_secret`)

Most common write path:

```http
POST /credentials
```

Update existing credential:

```http
PUT /credentials/:id
```

### 4) Write diary (`write_diary`)

```http
POST /what_is_happening/diary
```

### 5) Call broader APIs (`wallet_api`)

Common starts:

```http
GET /wallets
GET /token/search?q=PEPE&chain=base
POST /wallet/create
POST /send
POST /swap
POST /fund
```

If you get `403`, request human approval via `POST /auth` (include an `action` field for auto-execute on approval).

## Quick Common Endpoints

| Endpoint | Method | Typical Use |
|---|---|---|
| `/auth` | POST | Request token (approval flow) |
| `/auth/:requestId` | GET | Poll token request status (`x-aura-claim-secret` header; query `?secret=` is deprecated fallback) |
| `/credentials` | GET | List credential metadata |
| `/credentials` | POST | Create credential |
| `/credentials/:id/read` | POST | Read credential (encrypted response) |
| `/credentials/:id` | PUT | Update credential |
| `/credential-shares` | POST | Create share link |
| `/credential-shares/gist` | POST | Create GitHub secret gist share |
| `/what_is_happening/diary` | POST | Append diary note (entry text is stored as provided; entries are separated by a blank line) |
| `/wallets` | GET | List wallets |

## Read More In Depth (Complete API Docs Map)

All API docs files are listed here. Keep this section updated when adding/moving API docs.

### Getting Started

- `docs/ai-agents-workflow/API.md` (this file)
- [`docs/api/authentication.md`](/api?doc=api/authentication.md)

### Secrets

- [`docs/api/secrets/credentials.md`](/api?doc=api/secrets/credentials.md)
- [`docs/api/secrets/sharing.md`](/api?doc=api/secrets/sharing.md)
- [`docs/api/secrets/api-keys.md`](/api?doc=api/secrets/api-keys.md)

### Wallets

- [`docs/api/wallets/core.md`](/api?doc=api/wallets/core.md)
- [`docs/api/wallets/data-portfolio.md`](/api?doc=api/wallets/data-portfolio.md)
- [`docs/api/wallets/apps-strategies.md`](/api?doc=api/wallets/apps-strategies.md)

### System

- [`docs/api/system.md`](/api?doc=api/system.md)

## Related Docs

- [AUTH.md](/docs/ai-agents-workflow/AUTH.md) — full auth/permission model
- [MCP.md](/docs/ai-agents-workflow/MCP.md) — MCP tools and usage
