# Aura Open Protocol (.aura) v1

## Scope
Vendor-neutral `.aura` parsing + resolution contract.

## Grammar (v1)
- UTF-8, optional BOM ignored, CRLF normalized to LF.
- Statements: blank, full-line comment (`#`), assignment (`KEY = VALUE`).
- Key regex: `^[A-Z][A-Z0-9_]{0,127}$`.
- Duplicate keys: `E_PARSE_DUPLICATE_KEY`.
- Value forms:
  - bare string
  - quoted string (`\"`, `\\`, `\n`, `\r`, `\t`, `\uXXXX`)
  - provider ref `${provider://resource?query}`
  - var ref `${KEY}`
- Inline trailing comments are not supported in v1.

## Parse output contract
`parse(text)` returns:
- `version: "aura.v1"`
- `nodes[]` with required `type` and `loc`
- assignment nodes also include `keyRaw`, `keyNorm`, `valueType`, `valueRaw`, `valueNorm`

## Validation + normalization contract
`validate(doc)` returns deterministic lexical ordering by key:
- `normalized.entries[]`
- entry fields: `key`, `value`, `origin`, `dependencies`, optional `providerRef`

## Resolver determinism
- Fixed error precedence:
  1) parse
  2) validate
  3) reference graph
  4) provider resolution
  5) merge/output policy
- Bounded limits:
  - max depth: 32 (`E_RESOLVE_DEPTH_EXCEEDED`)
  - provider budget: 256 (`E_RESOLVE_PROVIDER_BUDGET`)
  - default provider timeout: 5000ms

## Compatibility matrix
- Supported baseline: spec 1.x + parser 1.x + provider API 1.x
- Unknown major spec: `E_COMPAT_SPEC_UNSUPPORTED`
- Provider API major mismatch: `E_COMPAT_PROVIDER_API`

## Trust/signature model (v1)
- JCS canonicalization for signed payload.
- Signature algorithm: `ed25519` only.
- Required envelope fields:
  - `algorithm`, `keyId`, `sig`, `createdAt`, `payloadSha256`

## Error envelope
All failures should expose:
- `code`, `category`, `severity`, `message`, `retryable`
- optional `details`, `loc`

Code families:
- `E_PARSE_*`, `E_VALIDATE_*`, `E_RESOLVE_*`, `E_POLICY_*`, `E_TRUST_*`, `E_COMPAT_*`

## Canonical fixtures
See `docs/specs/fixtures/` for v1 parse fixtures.
