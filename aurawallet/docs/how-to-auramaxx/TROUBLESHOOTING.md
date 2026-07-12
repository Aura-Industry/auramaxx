# Troubleshooting

Start with the Quick Fixes table for the fastest recovery path, then use deeper sections only if the first command fails.  
Most issues are startup, auth, or configuration drift and can be resolved in a few checks.
Windows users: command examples are primarily Bash; PowerShell equivalents are included where OS-specific tooling differs.

## Quick Fixes

| Problem | Fix |
|---------|-----|
| Server not running | `npx aurawallet` or `npx aurawallet start` (if UI is already open: `npx aurawallet restart`) |
| Agent locked after restart | Open `http://localhost:4747` and enter your password, or run `npx aurawallet unlock` |
| `aurawallet: command not found` | Open a new terminal, or use `npx aurawallet` directly |
| MCP tools missing in agent | `npx aurawallet mcp --install`, then restart your IDE/agent |
| Approval link not working | Use `http://localhost:4747/approve/<reqId>` (not `https://...`) |
| "Nothing works" after startup or migrations | This often indicates data corruption; go to [Last Resort Reset (Destructive)](#last-resort-reset-destructive) |
| Token expired / 401 error | Re-authenticate: `npx aurawallet auth request --agent-id <id> --profile dev`, approve, then `npx aurawallet auth claim <reqId> --json` |
| `Cannot find module '.prisma/client/default'` | `cd "$(npm root -g)/auramaxx" && npx prisma generate --schema prisma/schema.prisma`, then `aurawallet start` |
| Need startup/runtime diagnostics | `tail -f .logs/server.log .logs/dashboard.log` (PowerShell: `Get-Content .logs\server.log, .logs\dashboard.log -Wait`) |

---

## Setup & Onboarding

### Server won't start / connection refused

**Symptom:** Any CLI command returns "connection refused" or "fetch failed".

**Cause:** The Aura server isn't running.

**Fix:**
```bash
npx aurawallet start
```
Then retry your command. If port 4242 is in use, check for other processes:
- macOS/Linux: `lsof -i :4242`
- Windows PowerShell: `Get-NetTCPConnection -LocalPort 4242 | Select-Object -ExpandProperty OwningProcess`

---

### Dashboard not loading at localhost:4747

**Symptom:** Browser shows "connection refused" or blank page at `http://localhost:4747`.

**Cause:** Server started in headless mode, or hasn't finished starting yet.

**Fix:**
- Wait a few seconds and refresh.
- If started with `--headless`, the dashboard is intentionally disabled. Restart without `--headless`: `npx aurawallet start`.
- Check server status: `npx aurawallet status`.

---

### First run hangs or shows no output

**Symptom:** Running `npx aurawallet` for the first time shows nothing for several seconds.

**Cause:** npm is downloading the package and dependencies. This is normal on first run.

**Fix:** Wait 30–60 seconds. If it takes longer, check your internet connection. Run with `--debug` for verbose output: `npx aurawallet start --debug`.

---

### Windows native dependency caveat (better-sqlite3 / node-gyp)

**Symptom:** `npm install`/`npm ci` fails on Windows with `better-sqlite3`, `node-gyp`, MSBuild, or Python errors.

**Cause:** If prebuilt binaries are unavailable, native modules must compile locally.

**Fix:**
- Install Python 3 and ensure `py -3` works.
- Install Visual Studio 2022 Build Tools with Desktop C++ workload (MSVC v143 + Windows SDK).
- Re-run install: `npm ci` (or `npm install`).
- Optional npm config:
  - `npm config set msvs_version 2022`
  - `npm config set python "py -3"`

---

### Database migration errors on startup

**Symptom:** Errors mentioning Prisma, migrations, or database schema during start.

**Cause:** Database schema is out of date, or the database file is corrupted.

**Fix:**
```bash
npx aurawallet start --debug
```
If migration errors persist, check for backups first:
```bash
npx aurawallet restore --list
```
If a recent backup exists, restore it:
```bash
npx aurawallet restore --latest
```
If no backups are available, reset the database (this preserves agent files and backups):
```bash
rm -f ~/.auramaxx/auramaxx.db
npx aurawallet start
```
Windows PowerShell:
```powershell
Remove-Item "$env:USERPROFILE\.auramaxx\auramaxx.db" -ErrorAction SilentlyContinue
npx aurawallet start
```

> **Note:** Backups are stored in `~/.aurabak/`, separate from the main data directory. Nuking `~/.auramaxx/` will not destroy your backups.

---

### `Cannot find module '.prisma/client/default'` after update/install

**Symptom:** Startup fails with an error like:
`Cannot find module '.prisma/client/default'`

**Cause:** Prisma generated runtime files are missing from the installed package.

**Fix (global install):**
```bash
cd "$(npm root -g)/auramaxx"
npx prisma generate --schema prisma/schema.prisma
aurawallet start
```

**Fix (repo/local run):**
```bash
cd /path/to/aurawallet
npx prisma generate --schema prisma/schema.prisma
npx aurawallet start
```

---

## CLI Commands

### `aurawallet: command not found`

**Symptom:** Running `aurawallet` returns "command not found".

**Cause:** The CLI isn't installed globally, or the shell alias wasn't loaded.

**Fix:**
- Use `npx aurawallet` instead (always works).
- Or open a new terminal (aliases are loaded on shell start).
- Or run `npx aurawallet doctor --fix` to install shell fallbacks.
- Or install globally: `npm install -g aurawallet`.
- Windows note: if global install succeeds but command is still missing, ensure `%AppData%\npm` is on your `PATH`.

---

### Unknown command error

**Symptom:** `Unknown command: <name>` when running a CLI command.

**Cause:** Typo, or the command doesn't exist. Some commands are only visible with `--all`.

**Fix:**
```bash
npx aurawallet --help --all
```

---

### `npx aurawallet doctor` shows failures

**Symptom:** Doctor reports `FAIL` checks in red.

**Cause:** Various — each check has its own remediation.

**Fix:** Read the `remediation` line for each failed check. Common ones:
- "Run: npx aurawallet" → server isn't running
- "Export AURA_TOKEN" → no token set for explicit auth checks
- "Run: npx aurawallet doctor --fix" → shell fallback missing

---

## MCP Integration

### MCP tools not showing up in IDE

**Symptom:** After adding MCP config, your agent/IDE doesn't see Aura tools.

**Cause:** MCP config not saved correctly, or IDE not restarted after config change.

**Fix:**
1. Run `npx aurawallet mcp --install` to auto-configure.
2. Restart your IDE/agent completely (not just reload).
3. Verify config exists: check `.mcp.json` or your IDE's MCP config file.
4. Test manually: `npx aurawallet mcp` should start without errors.

---

### MCP auth fails / tools return 401

**Symptom:** MCP tools exist but return authentication errors.

**Cause:** Server restarted (tokens are memory-only) or token expired.

**Fix:**
1. Make sure the server is running: `npx aurawallet status`.
2. If using socket auth, ensure the server was started by the same user.
3. If using token auth, request + claim:
   - `npx aurawallet auth request --agent-id <id> --profile dev`
   - `npx aurawallet auth claim <reqId> --json`

---

### MCP config JSON parse error

**Symptom:** IDE shows "invalid JSON" or fails to load MCP config.

**Cause:** Malformed JSON in the MCP config file (trailing comma, missing bracket).

**Fix:** Run `npx aurawallet doctor` — it checks MCP config files for parse errors. Fix the JSON syntax in the reported file.

---

## Auth & Tokens

### Common auth flow (TLDR)

1. Agent runs `npx aurawallet auth request --agent-id <id> --profile dev`.
2. Human approves the `approveUrl`.
3. Agent runs `npx aurawallet auth claim <reqId> --json`.
4. Agent retries the original command.

`reqId` usage:
- Temp token: pass `--reqId <reqId>` once on the retry that consumes it.
- Session token: claim with `reqId` once, then later calls can omit `reqId`.

---

### 401 "Invalid or expired token"

**Symptom:** API calls return 401 with "Invalid or expired token".

**Cause:** Server was restarted (all tokens are memory-only) or the token TTL expired.

**Fix:**
```bash
npx aurawallet auth request --agent-id <your-agent-id> --profile dev
npx aurawallet auth claim <reqId> --json
```
Approve the request in the dashboard, then claim and retry.

---

### 403 "Insufficient permissions"

**Symptom:** API call returns 403 with "Insufficient permissions".

**Cause:** Your token doesn't have the required permission for this operation.

**Fix:** The 403 response includes structured guidance with a `nextStep` field — follow it. Typically:
```bash
npx aurawallet auth request --profile dev
npx aurawallet auth claim <reqId> --json
```
Approve in the dashboard, then claim and retry. See [AUTH.md](../ai-agents-workflow/AUTH.md) for permission names.

---

### 403 "Amount exceeds spending limit"

**Symptom:** Transaction returns 403 with spending limit error.

**Cause:** The token's spending budget for this operation type is exhausted.

**Fix:** Follow the `nextStep` in the 403 response, or request a new token:
```bash
npx aurawallet auth request --profile dev
npx aurawallet auth claim <reqId> --json
```
Approve in the dashboard, then claim and retry with the new token.

---

### Auth claim stays "pending" forever

**Symptom:** `npx aurawallet auth claim <reqId>` keeps returning pending.

**Cause:** No one approved the request. Approval must happen in the dashboard, Telegram, or CLI.

**Fix:**
- Open `http://localhost:4747` (or the direct `approveUrl`) and approve the pending request.
- Or check Telegram if adapter is configured.
- Re-run claim: `npx aurawallet auth claim <reqId> --json`.
- The request times out after 2 minutes by default.

---

### Approval link opens but does not work

**Symptom:** Approval page fails to load, shows SSL error, or redirects incorrectly.

**Cause:** Using `https://` instead of `http://` for local dashboard approvals.

**Fix:**
- Use `http://localhost:4747/approve/<reqId>` (must be `http`, not `https`).
- If your link starts with `https://`, replace it with `http://`.
- Then retry claim: `npx aurawallet auth claim <reqId> --json`.

---

## Agent & Credentials

### Agent locked after server restart

**Symptom:** Commands return "Cold wallet must be unlocked" or 401.

**Cause:** Unlock state is memory-only — it resets on every server restart.

**Fix:**
- Open `http://localhost:4747` and enter your agent password.
- Or run `npx aurawallet unlock`.
- For headless/automated environments: `AGENT_PASSWORD=... npx aurawallet start --headless`.

---

### "Database exists but agent files missing"

**Symptom:** Startup prompts about missing agent files.

**Cause:** Agent JSON files were deleted while `auramaxx.db` remained (manual partial delete or older reset flow).

**Fix:**
- If this happened after an intentional nuke, rerun `npx aurawallet` and continue setup (`init`).
- If this was accidental and you have no backup of the old agent files, choose **wipe** when prompted and re-setup.
- Old encrypted data cannot be recovered without the original agent files.

---

### Agent deleted but unlock still requested

**Symptom:** After deleting agent, the server still asks to unlock.

**Cause:** Agent files are in a different location than expected.

**Fix:** Check the data path. Default is `~/.auramaxx` (not `~/.aurawallet`). Delete agent files from the correct location:
```bash
ls ~/.auramaxx/agent-*.json
```
Windows PowerShell:
```powershell
Get-ChildItem "$env:USERPROFILE\.auramaxx\agent-*.json"
```

---

### Credential not found / .aura mapping fails

**Symptom:** `npx aurawallet env run` or `.aura` mapping reports missing credentials.

**Cause:** The credential name in `.aura` doesn't match any stored credential, or the agent is locked.

**Fix:**
1. Check agent is unlocked: `npx aurawallet status`.
2. List credentials: `npx aurawallet list`.
3. Verify `.aura` file names match: `npx aurawallet env check`.

---

## Agent & Skills

### Skill install fails

**Symptom:** `npx aurawallet skill` reports failures for one or more targets.

**Cause:** Permission denied on target directory, or source skill files missing.

**Fix:**
- Check the error message for which target failed and why.
- Fallback: `cd <your-codebase> && npx -y skills add Aura-Industry/aurawallet`.
- Verify with: `npx aurawallet skill --doctor`.

---

### Agent can't find skills after install

**Symptom:** Agent (Claude/Codex/OpenClaw) doesn't use Aura skills even after `skill` install.

**Cause:** Agent needs to be restarted to pick up new skills, or skill was installed to wrong directory.

**Fix:**
1. Run `npx aurawallet skill --doctor` to verify install paths.
2. Restart the agent session.
3. Check the agent's skill directory matches the installed path.

---

## Runtime & Server

### Port 4242 or 4747 already in use

**Symptom:** Server fails to start with "address already in use" error.

**Cause:** Another instance of Aura or another process is using the port.

**Fix:**
```bash
npx aurawallet stop
npx aurawallet start
```
If that doesn't work, find and kill the process:
```bash
lsof -i :4242
kill <PID>
```
Windows PowerShell:
```powershell
Get-NetTCPConnection -LocalPort 4242,4747 | Select-Object LocalPort, OwningProcess, State
Stop-Process -Id <PID> -Force
```

---

### Server crashes on startup

**Symptom:** Server starts but immediately exits with an error.

**Cause:** Various — dependency issue, database corruption, or configuration error.

**Fix:**
1. Run with debug output: `npx aurawallet start --debug`.
2. Run diagnostics: `npx aurawallet doctor`.
3. If database-related:
   - macOS/Linux: `rm -f ~/.auramaxx/auramaxx.db && npx aurawallet start`
   - Windows PowerShell: `Remove-Item "$env:USERPROFILE\.auramaxx\auramaxx.db" -ErrorAction SilentlyContinue; npx aurawallet start`
4. If dependency-related:
   - macOS/Linux: `rm -rf node_modules && npm install`
   - Windows PowerShell: `Remove-Item .\node_modules -Recurse -Force -ErrorAction SilentlyContinue; npm install`

---

### WebSocket connection drops

**Symptom:** Dashboard shows "disconnected" or real-time updates stop.

**Cause:** Server restarted, network interruption, or browser tab was inactive too long.

**Fix:** Refresh the dashboard page. If the server restarted, you'll need to re-unlock the agent.

---

## Last Resort Reset (Destructive)

⚠️ This permanently removes local Aura data (agent files, database, credentials, logs, config). All encrypted data will be unrecoverable.

Before nuking, check if you can restore from a backup:
```bash
npx aurawallet restore --list
```

If no backup helps, nuke and re-setup:
```bash
npx aurawallet nuke
npx aurawallet start
```

> **Your backups are safe.** Backups live in `~/.aurabak/`, not `~/.auramaxx/`, so the nuke above won't touch them.

---

## Still stuck?

Run full diagnostics and share the output:
```bash
npx aurawallet doctor --json
```

See also:
- [Setup guide](../quickstart/AGENT_SETUP.md)
- [Auth reference](../ai-agents-workflow/AUTH.md)
- [MCP setup](../ai-agents-workflow/MCP.md)
- [CLI reference](../ai-agents-workflow/CLI.md)
