# Best Practices

Use these defaults to reduce security risk and avoid brittle automation behavior.  
Apply them unless you have a specific, tested reason to deviate.

---

## For Humans

### Password Management

- Use a strong, unique password for each agent (min 8 characters, passphrase recommended)
- Never share your agent password - it unlocks all child agents
- Never store your agent password digitally — treat it like a seed phrase
- If you forget your password, the seed phrase is your only recovery path

### Multi-Agent Usage

- Use separate agents for separate purposes (e.g., trading agent, savings agent)
- Child agents can auto-unlock when the parent agent is unlocked; independent agents stay separate
- Hot wallets are bound to their agent and cannot be moved between agents

### Backup Schedule

- Back up your seed phrase on paper immediately after agent creation
- Store it offline in a secure location (safe, safety deposit box)
- Never photograph, screenshot, or digitally copy your seed phrase
- Test your backup by verifying the cold wallet address matches

### Token Hygiene

- Revoke tokens you're no longer using — don't leave stale tokens active
- Each agent should have its own token with its own limits
- Review active tokens periodically in the dashboard
- Server restart invalidates all tokens — this is intentional security, not a bug

### Secret Input Safety

- Never give your agent a plaintext secret directly in chat/prompt text — model providers may see prompt content.
- Only set secrets manually via AuraWallet CLI or UI.

---

## For Agents

### Permission Scoping

- Request the minimum permissions needed for your task
- Use `trade:all` for trading operations instead of listing individual permissions
- `trade:all` does NOT include `apikey:set` or `adapter:manage` — request those explicitly if needed for onboarding
- Never request `admin:*` unless you genuinely need full access

### Token Lifecycle

- Tokens live only in server memory — expect them to vanish on restart
- Always implement re-authentication logic: catch 401 → `POST /auth` request → human approve → claim by `reqId` → retry
- Don't persist tokens to disk — request fresh ones each session
- The token from `GET /auth/:id` (`x-aura-claim-secret` header) can only be read once — save it immediately

### Error Handling Patterns

| Error | Pattern |
|-------|---------|
| 401 `Invalid or expired token` | Request via `POST /auth`, get `approveUrl`, human approves, claim via `reqId`, then retry |
| 401 `Cold wallet must be unlocked` | Tell human to unlock at dashboard or `http://localhost:4242/unlock` |
| 403 `Insufficient permissions` | Follow structured approval payload (`approveUrl` + `claimAction` + `retryAction`); if no `reqId`, request new token via `POST /auth` with the needed profile/scope |
| 403 `Amount exceeds spending limit` | Follow structured approval payload and complete approve → claim → retry |
| Connection refused | Server not running — tell human to run `auramaxx` |

### Credential Access

- Use `secret:read` with narrow `credentialAccess.read` scopes — don't request wildcard access unless needed
- Use `excludeFields` to strip fields you don't need (e.g., exclude `refresh_token` if you only need `access_token`)
- For OAuth2 credentials, just read the credential — auto-refresh handles expired tokens transparently
- For TOTP, use `POST /credentials/:id/totp` to get the current code rather than reading the raw secret
- Check credential health badges — flag compromised credentials to the user proactively

### Multi-Step Operations

- Check `GET /setup` before starting any workflow — know what's configured
- For operations that require multiple endpoints (e.g., create wallet → fund → swap), verify each step succeeded before proceeding
- If a multi-step operation fails partway through, report what completed and what didn't — don't silently retry
