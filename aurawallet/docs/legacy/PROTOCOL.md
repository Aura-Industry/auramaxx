# The `.aura` File Format

**Version:** 0.1.0 (Draft)
**Status:** Draft
**Date:** 2026-02-16

## 1. Introduction

### 1.1 Why

Applications need secrets. Developers pass them via environment variables, typically stored in `.env` files. This creates a problem: `.env` files contain plaintext secrets and must never be committed to version control. Teams share them over Slack, email, or sticky notes. They drift. They leak.

The `.aura` format solves this by separating **what a project needs** from **the secrets themselves**. A `.aura` file maps environment variables to credential references in a agent. It contains no secrets — only pointers. It is safe to commit, review, and share.

### 1.2 Design Goals

- **Commit-safe.** No secrets, ever.
- **Simple.** One mapping per line. No templating, no interpolation, no nesting.
- **Agent-agnostic.** Any secret store can implement resolution.
- **Familiar.** If you've used `.env`, you already know 90% of `.aura`.

## 2. File Format

### 2.1 General

- **Filename:** `.aura` (lowercase, leading dot)
- **Encoding:** UTF-8
- **Line endings:** LF or CRLF (implementations MUST accept both)

### 2.2 Grammar

```
file        = *line
line        = blank / comment / mapping
blank       = *WSP NEWLINE
comment     = "#" *CHAR NEWLINE
mapping     = key "=" reference NEWLINE
key         = 1*( ALPHA / DIGIT / "_" )
reference   = [ "@" agent-name "/" ] credential-name "/" field
agent-name  = 1*( ALPHA / DIGIT / "-" / "_" )
credential-name = 1*( ALPHA / DIGIT / "-" / "_" / "." )
field       = 1*( ALPHA / DIGIT / "-" / "_" / "." )
```

### 2.3 Mappings

Each mapping is a single line of the form:

```
ENV_VAR=reference
```

- **No whitespace** around `=`. `KEY = ref` is invalid.
- **No quoting.** Values are never quoted.
- **No multiline values.**
- **No duplicate keys.** If a key appears more than once, implementations MUST reject the file.

### 2.4 References

A reference points to a field within a credential in a agent:

| Form | Meaning |
|------|---------|
| `credential/field` | Field `field` of credential `credential` in the primary agent |
| `@agent/credential/field` | Field `field` of credential `credential` in agent `agent` |

The **primary agent** is determined by the resolution environment (e.g., a CLI config or SDK default). The `.aura` file itself does not define which agent is primary.

### 2.5 Comments and Blank Lines

Lines beginning with `#` (optionally preceded by whitespace) are comments. Blank lines are ignored. Both are preserved for human readability.

## 3. Resolution Algorithm

Given a `.aura` file, a resolver MUST:

1. **Parse** the file into an ordered list of `(key, reference)` mappings.
2. **For each mapping**, decompose the reference into `(agent, credential, field)`. If no `@agent` prefix, use the primary agent.
3. **Resolve** each `(agent, credential, field)` tuple against the agent provider. Obtain the plaintext secret value.
4. **Fail loudly** if any credential or field does not exist. Implementations MUST NOT substitute defaults, empty strings, or fallback values. A missing secret is a fatal error.
5. **Inject** each `key=resolved_value` pair into the target environment.

### 3.1 Error Handling

| Condition | Behavior |
|-----------|----------|
| Credential not found | MUST fail with error identifying the missing credential |
| Field not found | MUST fail with error identifying the credential and missing field |
| Agent not reachable | MUST fail with connection error |
| Duplicate key | MUST fail at parse time |
| Malformed line | MUST fail at parse time with line number |

Implementations MUST NOT partially inject. Either all mappings resolve or none do.

## 4. Example

```aura
# Database
DATABASE_URL=database-prod/url
DATABASE_POOL_SIZE=database-prod/pool_size

# Payments
STRIPE_SECRET_KEY=stripe/secret_key
STRIPE_WEBHOOK_SECRET=stripe/webhook_secret

# AWS (staging agent)
AWS_ACCESS_KEY_ID=@staging/aws/access_key
AWS_SECRET_ACCESS_KEY=@staging/aws/secret_key
```

## 5. Implementing a Resolver

Any tool can resolve `.aura` files. A resolver needs:

1. **A parser** — split lines, ignore comments/blanks, extract `(key, reference)` pairs.
2. **A agent backend** — given `(agent, credential, field)`, return the secret value. This could be AuraMaxx, 1Password, HashiCorp Agent, AWS Secrets Manager, a YAML file — anything.
3. **An injector** — set environment variables or write a `.env` file.

That's it. The format is intentionally trivial to parse. A working parser is ~30 lines in any language.

### 5.1 Reference CLI

The `aura` CLI provides a reference implementation:

| Command | Description |
|---------|-------------|
| `aurawallet env -- <cmd>` | Resolve `.aura`, inject env vars, run `<cmd>` |
| `aurawallet env inject` | Resolve `.aura`, write `.env` file |
| `aurawallet env check` | Verify all referenced credentials exist (no values printed) |
| `aurawallet env list` | Print mappings without resolving values |
| `aurawallet init --from-dotenv` | Generate `.aura` from an existing `.env` file |

## 6. Security Considerations

- `.aura` files contain **no secrets** and are safe to commit to version control.
- Resolved `.env` files (output of `aurawallet env inject`) MUST be gitignored.
- Implementations SHOULD NOT log resolved secret values.
- Implementations SHOULD clear resolved values from memory after injection when possible.

## 7. MIME Type

`text/x-aura` (informational, not registered).
