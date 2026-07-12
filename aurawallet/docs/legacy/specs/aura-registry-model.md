# Aura Registry + Trust Model (v1)

## Version and namespace basics
- Namespace ownership is explicit (e.g., `org/name`).
- Immutable published versions.
- Dist tags/channels are aliases, not mutable artifacts.

## Compatibility
- Spec major mismatch => hard-fail.
- Provider API major mismatch => hard-fail.
- Minor/patch mismatch is allowed unless provider declares stricter minimum runtime.

## Signing
- Canonical payload: JCS (RFC 8785) without `signature` field.
- Algorithm: Ed25519 only for v1.
- Envelope fields required:
  - `algorithm`, `keyId`, `sig`, `createdAt`, `payloadSha256`

## Key lifecycle
States:
- `active`
- `retired`
- `compromised`

Compromised key cutoff:
- Artifacts signed at/after compromise timestamp are blocked.
- Historical signatures before cutoff remain valid unless explicitly revoked.

## Revocation behavior
- strict mode: revocation unavailable => `E_TRUST_REVOCATION_UNAVAILABLE`
- permissive mode: warn + continue with audit event
