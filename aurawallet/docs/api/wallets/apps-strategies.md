# Wallet Apps, Adapters & Strategies

This page groups app/adapter/strategy surfaces under wallet operations.

Action-approval endpoints live in [`docs/api/authentication.md`](/api?doc=api/authentication.md).

## Adapter Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/adapters` | GET | `adapter:manage` | List adapter config/status |
| `/adapters` | POST | `adapter:manage` | Create/update adapter config |
| `/adapters/:type` | DELETE | `adapter:manage` | Delete adapter |
| `/adapters/test` | POST | `adapter:manage` | Test adapter delivery |
| `/adapters/chat` | POST | `adapter:manage` | Send adapter chat message |
| `/adapters/:type/message` | POST | Public route with validation | Adapter inbound message ingestion |
| `/adapters/telegram/setup-link` | POST | `adapter:manage` | Telegram setup helper |
| `/adapters/telegram/detect-chat` | POST | `adapter:manage` | Detect Telegram chat/channel |
| `/adapters/restart` | POST | `adapter:manage` | Reload/restart adapters |

## App Storage + Messaging Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/apps/:appId/storage` | GET | `app:storage` | List app storage items |
| `/apps/:appId/storage/:key` | GET | `app:storage` | Read app storage key |
| `/apps/:appId/storage/:key` | PUT | `app:storage` | Set app storage key |
| `/apps/:appId/storage/:key` | DELETE | `app:storage` | Delete app storage key |
| `/apps/:appId/message` | POST | `app:storage` | Send app message |
| `/apps/:appId/fetch` | POST | `app:storage` | Proxy outbound HTTP fetch with SSRF controls |
| `/apps/:appId/token` | GET | Bearer | Issue app-scoped token |
| `/apps/:appId/apikey/:keyName` | GET | `app:accesskey` | Resolve app API key |
| `/apps/:appId/reload` | POST | Bearer | Reload app runtime |
| `/apps/:appId/approve` | POST | `strategy:manage` | Approve app |
| `/apps/:appId/approve` | DELETE | `strategy:manage` | Revoke app approval |

## Strategy Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/strategies` | GET | `strategy:read` | List installed strategies |
| `/strategies/templates` | GET | `strategy:read` | List templates |
| `/strategies` | POST | `strategy:manage` | Create template strategy |
| `/strategies/install` | POST | `strategy:manage` | Install third-party strategy |
| `/strategies/health` | GET | `strategy:read` | Runtime health |
| `/strategies/:id/toggle` | POST | `strategy:manage` | Toggle strategy |
| `/strategies/:id/enable` | POST | `strategy:manage` | Enable strategy |
| `/strategies/:id/disable` | POST | `strategy:manage` | Disable strategy |
| `/strategies/:id/config` | GET | `strategy:read` | Read strategy config |
| `/strategies/:id/config` | PUT | `strategy:manage` | Update strategy config |
| `/strategies/:id/approve` | POST | `strategy:manage` | Approve/reject pending intents |
| `/strategies/:id/state` | GET | `strategy:read` | Strategy debug state |
| `/strategies/history` | GET | `strategy:read` | Strategy action history |
| `/strategies/reload` | POST | `strategy:manage` | Reload runtime metadata |

## WebSocket/Event Notes

Common event channels referenced in wallet + app UI flows include:

- `asset:changed`
- `tx:created`
- `action:created`
- `action:resolved`
- `action:executed`

Use `/logs` and `/dashboard` for HTTP snapshots.
