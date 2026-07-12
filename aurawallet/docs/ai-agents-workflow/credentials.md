# Credentials

AuraMaxx stores credentials as locally encrypted records scoped by agent, with strict read/write controls.  
Use this page to understand credential types, canonical fields, and access policy behavior.

## Credential Types

| Type | Description | Key Fields |
|------|-------------|------------|
| `login` | Website logins | username, password, URL, TOTP |
| `sso` | SSO login references | website, provider, identifier |
| `note` | Secure notes | freeform text |
| `card` | Payment cards | card number, expiry, CVV |
| `api` | API credentials | API key, secret, endpoint |
| `apikey` | Service API keys (internal) | service, name, key |
| `ssh` | SSH keys | private key (PEM), public key, key type, passphrase, fingerprint, hosts |
| `gpg` | GPG keys | private key (armored), public key, key ID, fingerprint, email/UID, expiration |
| `passkey` | WebAuthn/FIDO2 passkeys | credential ID, public key, private key (ECDSA P-256), RP ID, user handle |
| `oauth2` | OAuth2 refresh tokens | access_token, refresh_token, token_endpoint, client_id, client_secret, expires_at, scopes |
| `custom` | Freeform key-value | user-defined fields |

## Data Model

Each credential has:

- `id` — unique identifier
- `agentId` — which agent owns this credential
- `type` — one of the types above
- `name` — human-readable label
- `meta` — search/filter fields, tags, type-specific metadata (plaintext for listing)
- Encrypted sensitive fields (encrypted with agent credential key)

## Field Model

Field shape:

- `key` (string)
- `value` (string)
- `type` (`text`, `secret`, `url`, `email`, `number`)
- `sensitive` (boolean)

Non-sensitive fields can be mirrored into `meta` for searchability.

### Canonical Built-In Field Keys

AuraMaxx uses canonical field keys for built-in credential types. Current baseline:

| Type | Canonical Field Keys | Notes |
|------|----------------------|-------|
| `login` | `url`, `username`, `password`, `notes`, `totp` | `otp` is accepted as legacy alias for `totp` |
| `card` | `cardholder`, `brand`, `billing_zip`, `last4`, `number`, `cvv`, `expiry`, `notes` | `last4` is derived metadata; `number`/`cvv`/`expiry` are sensitive |
| `sso` | `website`, `provider`, `identifier` | `website` + `provider` are required on create; `identifier` is optional |
| `note` | `content` | `value` is accepted as legacy alias and normalized to `content` on read/write paths |
| `apikey` | `key`, `value` | `key` is metadata/display, `value` is secret |
| `oauth2` | `token_endpoint`, `scopes`, `auth_method`, `expires_at`, `access_token`, `refresh_token`, `client_id`, `client_secret` | `access_token`/`refresh_token`/`client_id`/`client_secret` are sensitive |
| `ssh` | `fingerprint`, `key_type`, `hosts`, `public_key`, `private_key`, `passphrase` | `private_key`/`passphrase` are sensitive |
| `gpg` | `fingerprint`, `key_id`, `uid_email`, `expires_at`, `public_key`, `private_key` | `private_key` is sensitive |

## Access Model

- `secret:read` — list metadata and read encrypted fields
- `secret:write` — create, update, and delete credentials
- Optional credential scopes (`credentialAccess.read` / `.write`) — restrict to specific agents, tags, or credential IDs
- Optional `excludeFields` — strip sensitive fields before response encryption
- Optional `ttl` and `maxReads` — governance limits on credential reads

Credential read endpoint returns data encrypted to the caller's `agentPubkey` (RSA-OAEP or hybrid RSA+AES-GCM for larger payloads).

## Credential Health

Credentials are scanned for security issues:

- **Weak passwords** — entropy/length heuristics
- **Reused passwords** — duplicate detection across credentials
- **Breached passwords** — HIBP k-anonymity API (only 5-char SHA-1 prefix sent, never the full hash)

Health badges appear per-credential in the agent UI. MCP `get_secret` includes a `health` field so agents can flag compromised credentials.

CLI: `aurawallet doctor` includes health summary, `aurawallet agent health` for standalone check.

## Credential Lifecycle

Credentials support soft-delete:

1. First delete → archived
2. Second delete → recently deleted
3. After 30 days → permanently purged

## TOTP Support

Any credential with a `totp` or `otp` field automatically gains TOTP code generation:

- `POST /credentials/:id/totp` — returns current 6-digit code + time remaining
- MCP `get_secret` returns current TOTP code when present
- Extension autofills 2FA fields automatically

## OAuth2 Auto-Refresh

`oauth2` credentials auto-refresh expired access tokens:

- On `get_secret` or credential read, if `access_token` is expired, transparently refreshes via `token_endpoint`
- Updated tokens are saved back to the credential
- Agents receive fresh `access_token` without seeing `refresh_token`

## Endpoints

- `POST /credentials` — create credential
- `GET /credentials` — list credentials (metadata, scope-filtered)
- `GET /credentials/:id` — get credential metadata
- `PUT /credentials/:id` — update credential
- `DELETE /credentials/:id` — soft-delete (archive → recently deleted → purge)
- `POST /credentials/:id/read` — read credential (encrypted to `agentPubkey`)
- `POST /credentials/:id/totp` — generate current TOTP code
- `POST /credentials/import` — bulk import (1Password CSV, Bitwarden, Chrome, etc.)

## Notes

- `oauth2` credentials are restricted to the primary agent.
- TOTP capability is auto-detected when `totp`/`otp` field exists.
- Credential files are stored under AuraMaxx data directory (`~/.auramaxx/credentials/`).
- SSH/GPG credentials store keys in PEM/armored format with auto-computed fingerprints.
- `aura ssh-agent` can act as an SSH agent (SSH_AUTH_SOCK) backed by agent keys.
