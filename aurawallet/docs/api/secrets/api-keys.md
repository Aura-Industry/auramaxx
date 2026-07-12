# API Keys Endpoints

API keys are stored as credential-agent records (`type: "apikey"`) with compatibility support for legacy rows.

## API Key Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/apikeys` | GET | `apikey:get` | List API keys |
| `/apikeys` | POST | `apikey:set` | Create/update API key |
| `/apikeys/validate` | POST | `apikey:set` | Validate provider key format/connectivity |
| `/apikeys/:id` | DELETE | `apikey:set` | Delete API key |
| `/apikeys/revoke-all` | DELETE | `apikey:set` | Revoke/remove all API keys |

## App Access-Key Endpoint

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/apps/:appId/apikey/:keyName` | GET | `app:accesskey` | Read app-scoped key material |

## Adapter Secret Pattern

Adapter secrets (Telegram bot token, webhook signing secret, etc.) are commonly stored via `/apikeys` with `service` values like:

- `adapter:telegram`
- `adapter:webhook`

See [ADAPTERS.md](/docs/legacy/ADAPTERS.md) for adapter-specific setup details.
