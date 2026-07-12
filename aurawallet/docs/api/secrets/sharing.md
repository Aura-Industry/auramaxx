# Credential Sharing API

These endpoints power secure one-time/expiring credential share links and optional GitHub secret gist publishing.

## Endpoint Summary

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/credential-shares/:token` | GET | Public | Read share metadata/state |
| `/credential-shares/:token/read` | POST | Public | Consume shared credential payload |
| `/credential-shares` | POST | `secret:read` | Create direct share link |
| `/credential-shares/gist` | POST | `secret:read` | Create share + publish GitHub secret gist |

## Create Share Request

```json
{
  "credentialId": "cred-abc123",
  "expiresAfter": "24h",
  "accessMode": "password",
  "password": "optional-if-password-mode",
  "oneTimeOnly": true,
  "shareBaseUrl": "https://your-public-host"
}
```

- `expiresAfter`: `15m | 1h | 24h | 7d | 30d`
- `accessMode`: `anyone | password`
- `password` required when `accessMode="password"`

## Public Read Flow

1. `GET /credential-shares/:token` checks metadata and status (`expired`, `already_viewed`, etc.)
2. `POST /credential-shares/:token/read` returns sanitized credential payload (password may be required)

## Gist Share Response (shape)

`POST /credential-shares/gist` returns a regular share payload plus gist metadata, including gist URL and generated title.

## UI Path

Web share page route:

```text
/share/:token
```

This page calls `/credential-shares/:token` and `/credential-shares/:token/read`.
