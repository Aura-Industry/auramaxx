# Working With Secrets

Use this guide to read, write, and inject secrets without pasting plaintext credentials into prompts or code.  
Start with `get`, `set`, and `list`, then use `inject` for controlled command execution.

## Getting Secrets

In local socket mode, `aurawallet get` confirms the credential can be decrypted (`SECRET DECRYPTED`), but it does **not** export an env var into your parent shell.
Use `aurawallet inject` when you want a value available to a command.

```bash
# local socket read: verifies/decrypts
aurawallet get DONTLOOK

# command-scoped injection (recommended)
aurawallet get DONTLOOK -- printenv AURA_DONTLOOK

# unsafe plaintext debug output (prints secret in terminal)
aurawallet get DONTLOOK --danger-plaintext

# custom env var name:
aurawallet inject DONTLOOK --env AURA_DONTNOTE -- printenv AURA_DONTNOTE
```

With explicit token auth (for example `AURA_TOKEN=...`), `aurawallet get` can print primary fields or full payloads. Use flags for specific fields or full payloads:

```bash
aurawallet get OURSECRET                     # primary value field only
aurawallet get OURSECRET --field username    # specific field
aurawallet get OURSECRET --json              # full credential payload
aurawallet get OURSECRET --totp              # current TOTP code only
aurawallet get OURSECRET --agent primary     # restrict match to a agent
aurawallet get OURSECRET                     # if name is ambiguous, first match is selected by default
aurawallet get OURSECRET --first             # compatibility flag (same behavior)
aurawallet get OURSECRET --reqId <reqId>     # retry with claimed one-shot approval token
```

## Setting Secrets

### Fast Path

```bash
aurawallet set OURSECRET 123
```

### Helper Flags

```bash
# set explicit type/field
aurawallet set GITHUB_LOGIN hunter2 --type login --field password

# attach tags
aurawallet set STRIPE_KEY sk_live_123 --type apikey --tags prod,api

# set extra structured fields
aurawallet set GITHUB_LOGIN hunter2 --type login --field password --username alice
```

MCP path:

- call `put_secret` with `name: "OURSECRET"` and `value: "123"`

## Listing Secrets

### Fast Path

```bash
aurawallet list
```

### Helper Flags

```bash
# filter by credential name/title substring
aurawallet list --name github

# filter by field key/value substring (best effort; reads credential payloads)
aurawallet list --field token

# filter by agent name or id
aurawallet list --agent primary
aurawallet list --agent agent-2

# combine filters + structured output
aurawallet list --agent primary --name github --json
```

MCP path:

- call `list_secrets`

## If It Fails

1. Check runtime health: `aurawallet status`
2. If agent is locked: unlock in dashboard (`http://localhost:4747`) or run `aurawallet unlock`
3. If MCP call gets permission denied: follow [AGENT_SETUP.md](../quickstart/AGENT_SETUP.md), then [AUTH.md](../ai-agents-workflow/AUTH.md)
