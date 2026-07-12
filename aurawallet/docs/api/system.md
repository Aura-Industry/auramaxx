# System & Public Endpoints

## Public/General Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/health` | GET | Public | Server liveness/health |
| `/logs` | GET | Admin | Event logs with filters/pagination (sensitive fields redacted) |
| `/dashboard` | GET | Public | Dashboard summary payload |
| `/what_is_happening` | GET | Public | Heartbeat snapshot |
| `/what_is_happening/diary` | POST | Bearer (`secret:write`) | Append `{YYYY-MM-DD}_LOGS` note (raw entry text, no auto time prefix, blank-line entry separation) |
| `/resolve/:name` | GET | Public | ENS resolution (`.eth`) |
| `/price/:address` | GET | Public | Token/native USD price lookup |
| `/token/search` | GET | Public | Token search by ticker/name/address |
| `/token/safety/:address` | GET | Public | Token safety report |
| `/token/holders/:address` | GET | Public | Token top holders |
| `/token/:tokenAddress/balance/:walletAddress` | GET | Public | Token balance lookup |
| `/batch` | POST | Public endpoint; subrequest auth enforced | Execute wave-based multi-call requests |
| `/swap/dexes` | GET | Public | List configured DEX adapters |

## System/Admin Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/defaults` | GET | Admin | List system defaults |
| `/defaults/:key` | PATCH | Admin | Update one default |
| `/defaults/reset` | POST | Admin | Reset one/all defaults |
| `/security/credential-access/recent` | GET | Admin | Recent credential access events |
| `/security/credential-access/noisy-credentials` | GET | Admin | Credential hot-spot report |
| `/security/credential-access/noisy-tokens` | GET | Admin | Token hot-spot report |
| `/ai/status` | GET | Admin | AI provider status |
| `/backup` | GET | Admin | List backups |
| `/backup` | POST | Admin | Create backup |
| `/backup` | PUT | Admin | Restore backup |
| `/nuke` | POST | Admin | Destructive full reset |
| `/nuke/import` | POST | Admin | Reinitialize/import from mnemonic |

## Notes

- `/setup` and `/dashboard` are often used as first probes by CLI/UI.
- `/batch` is useful for reducing round-trips when workflows chain reads and writes.
- `/what_is_happening` is public but returns sanitized action/event payloads.
