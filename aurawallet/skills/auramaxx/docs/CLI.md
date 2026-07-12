# CLI

## Commands

The most common commands. All use `aurawallet` (or `npx aurawallet`).

| Command | Description |
|---------|-------------|
| `aurawallet get <name>` | Read a credential (`--json` for full payload) |
| `aurawallet set <name> <value>` | Create or update a secret |
| `aurawallet list` | List credential names |
| `aurawallet diary write --entry "<text>"` | Append an authenticated daily diary entry |
| `aurawallet share <name>` | Create a shareable secret gist link |
| `aurawallet inject <name> [-- <cmd>]` | Save to env var and optionally run command |
| `aurawallet del <name>` | Delete a credential |

> **Note:** `aurawallet get` returns encrypted ciphertext by default — this is a protected route.
> To decrypt and print a value, use `aurawallet inject <name> -- printenv AURA_SECRET`.
> To pass a secret to a command under a custom env var: `aurawallet inject <name> --env MY_VAR -- <your-command>`.

## First Success (Run In Order)

```bash
aurawallet status
aurawallet list
aurawallet set OURSECRET 123
aurawallet get OURSECRET
aurawallet share OURSECRET --expires-after 24h
```

If `status` fails, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
`status` checks both services: API server (`http://localhost:4242`) and dashboard UI (`http://localhost:4747`).

## Admin Commands

Essential admin commands for setup and maintenance.

| Command | Description |
|---------|-------------|
| `aurawallet start` | Start Aura services (includes first-run bootstrap) |
| `aurawallet status` | Check runtime health |
| `aurawallet init` | Advanced/recovery setup flow (most users should run `start`) |
| `aurawallet mcp` | Start MCP server for Claude Code, Cursor, etc. |
| `aurawallet skill` | Install AuraMaxx skills for Claude/Codex/OpenClaw |
| `aurawallet auth` | Request/poll agent auth approvals |

Run `aurawallet --help --all` to see all commands including advanced admin (stop, lock, unlock, doctor, restore, etc.).

## Stopping Servers

```bash
aurawallet stop
```

Stops all running AuraMaxx processes:

- **Wallet server** (`server/index.ts` on port 4242)
- **Cron server** (`server/cron/index.ts` — balance sync, price sync)
- **Dashboard** (`next dev` on port 4747)

Also cleans up temp files (CLI lock file, Unix socket).

This does **not** affect the MCP server — that runs in its own stdio process managed by the client (Claude Code, Cursor, etc.) that started it.

## Examples

```bash
# Check services
aurawallet status

# Credentials
aurawallet list                                                 # List credential names
aurawallet get OURSECRET                                        # Read a credential
aurawallet set OURSECRET 123                                    # Create or update a credential value
aurawallet set GITHUB_LOGIN hunter2 --type login                # Store as login credential (password field)
aurawallet share OURSECRET --expires-after 24h                  # Create a shareable secret gist link
aurawallet del OURSECRET                                        # Delete a credential

# Inject secret into a command
aurawallet inject DONTLOOK --env HIDETHIS -- printenv HIDETHIS  # Execute command with injected secret env var

# Auth and approvals
aurawallet auth request --agent-id codex --profile strict
aurawallet auth request --profile strict --action '{"endpoint":"/send","method":"POST","body":{"to":"0x...","amount":"0.01"}}'
aurawallet auth poll <requestId> --secret <secret>
aurawallet diary write --entry "Heartbeat: no pending requests, sync ok"

# Advanced
aurawallet api GET /health --no-auth                            # Call any API endpoint
aurawallet doctor                                               # Run diagnostics
```

Sensitive output defaults:

- Sensitive fields return encrypted output by default.
- To auto-decrypt sensitive output, set `AUTO_DECRYPT=true` and `AURA_AGENT_PASSWORD=<password>`.

## All Commands

Full list visible via `aurawallet --help --all`. Summary:

| Command | Description |
|---------|-------------|
| `start` | Start Aura services (includes bootstrap/setup) |
| `stop` | Stop running servers |
| `status` | Check runtime health |
| `init` | Advanced/recovery setup flow |
| `unlock` / `lock` | Unlock or lock agents |
| `mcp` | Start MCP server for Claude Code, Cursor, etc. |
| `skill` | Install AuraMaxx skills for agents |
| `auth` | Request/poll agent auth approvals |
| `diary` | Append daily diary entries (auth-aware) |
| `actions` | Internal: human actions and token management (use `auth` instead) |
| `api` | Call any wallet API endpoint from CLI |
| `doctor` | Run diagnostics |
| `restore` | Restore backup + run migrations |
| `app` | Manage installed apps |
| `apikey` | List/validate/set/delete API keys |
| `env` | Load env vars from agent via .aura file |
| `shell-hook` | Auto-load .aurawallet env vars on cd (like direnv) |
| `experimental` | Toggle dev feature flags |
| `cron` | Run cron server standalone |
| `secret` | Run commands with injected secret env vars |
| `token` | Preview profile-based token policy |
| `wallet` | Wallet API wrappers (status, assets, swap, send, fund) |

## Next Steps

- Builder / AI integration -> [MCP.md](MCP.md)
- Operator / Security -> [security.md](security.md)
