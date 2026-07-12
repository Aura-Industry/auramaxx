# Troubleshooting

## Quick Fixes

| Problem | Fix |
|---------|-----|
| Server not running | `npx aurawallet` or `npx aurawallet start` |
| Agent locked after restart | Open `http://localhost:4747` and enter your password, or run `npx aurawallet unlock` |
| `aurawallet: command not found` | Open a new terminal, or use `npx aurawallet` directly |
| MCP tools missing in agent | `npx aurawallet mcp --install`, then restart your IDE/agent |
| Token expired / 401 error | Re-authenticate: `npx aurawallet auth request --agent-id <id> --profile strict` |

---

## Setup & Onboarding

### Server won't start / connection refused

**Symptom:** Any CLI command returns "connection refused" or "fetch failed".

**Cause:** The Aura server isn't running.

**Fix:**
```bash
npx aurawallet start
```
Then retry your command. If port 4242 is in use, check for other processes: `lsof -i :4242`.

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

### Database migration errors on startup

**Symptom:** Errors mentioning Prisma, migrations, or database schema during start.

**Cause:** Database schema is out of date, or the database file is corrupted.

**Fix:**
```bash
npx aurawallet start --debug
```
If migration errors persist, try resetting the database (this preserves agent files):
```bash
rm -f dev.db
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
3. If using token auth, re-request: `npx aurawallet auth request --agent-id <id> --profile strict`.

---

### MCP config JSON parse error

**Symptom:** IDE shows "invalid JSON" or fails to load MCP config.

**Cause:** Malformed JSON in the MCP config file (trailing comma, missing bracket).

**Fix:** Run `npx aurawallet doctor` — it checks MCP config files for parse errors. Fix the JSON syntax in the reported file.

---

## Auth & Tokens

### 401 "Invalid or expired token"

**Symptom:** API calls return 401 with "Invalid or expired token".

**Cause:** Server was restarted (all tokens are memory-only) or the token TTL expired.

**Fix:**
```bash
npx aurawallet auth request --agent-id <your-agent-id> --profile strict
```
Approve the request in the dashboard, then use the new token.

---

### 403 "Insufficient permissions"

**Symptom:** API call returns 403 with "Insufficient permissions".

**Cause:** Your token doesn't have the required permission for this operation.

**Fix:** The 403 response includes structured guidance with a `nextStep` field — follow it. Typically:
```bash
npx aurawallet auth request --profile strict
```
Approve in the dashboard, then retry. See [AUTH.md](AUTH.md) for permission names.

---

### 403 "Amount exceeds spending limit"

**Symptom:** Transaction returns 403 with spending limit error.

**Cause:** The token's spending budget for this operation type is exhausted.

**Fix:** Follow the `nextStep` in the 403 response, or request a new token:
```bash
npx aurawallet auth request --profile strict
```
Approve in the dashboard, then retry with the new token.

---

### Auth request stays "pending" forever

**Symptom:** `npx aurawallet auth request` keeps polling but never completes.

**Cause:** No one approved the request. Approval must happen in the dashboard, Telegram, or CLI.

**Fix:**
- Open `http://localhost:4747` and approve the pending request.
- Or check Telegram if adapter is configured.
- The request times out after 2 minutes by default.

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

**Cause:** Agent JSON files were deleted but the database still references them.

**Fix:** If you have no backup of the old agent files, choose "wipe" when prompted and re-setup. Old encrypted data cannot be recovered without the original agent files.

---

### Agent deleted but unlock still requested

**Symptom:** After deleting agent, the server still asks to unlock.

**Cause:** Agent files are in a different location than expected.

**Fix:** Check the data path. Default is `~/.auramaxx` (not `~/.aurawallet`). Delete agent files from the correct location:
```bash
ls ~/.auramaxx/agent-*.json
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

---

### Server crashes on startup

**Symptom:** Server starts but immediately exits with an error.

**Cause:** Various — dependency issue, database corruption, or configuration error.

**Fix:**
1. Run with debug output: `npx aurawallet start --debug`.
2. Run diagnostics: `npx aurawallet doctor`.
3. If database-related: `rm -f dev.db && npx aurawallet start`.
4. If dependency-related: `rm -rf node_modules && npm install`.

---

### WebSocket connection drops

**Symptom:** Dashboard shows "disconnected" or real-time updates stop.

**Cause:** Server restarted, network interruption, or browser tab was inactive too long.

**Fix:** Refresh the dashboard page. If the server restarted, you'll need to re-unlock the agent.

---

## Last Resort Reset (Destructive)

⚠️ This permanently removes local agent files. All encrypted data will be unrecoverable.

```bash
rm -f ~/.auramaxx/agent-*.json ~/.auramaxx/cold.json
rm -f dev.db
npx aurawallet
```

---

## Still stuck?

Run full diagnostics and share the output:
```bash
npx aurawallet doctor --json
```

See also:
- [Setup guide](AGENT_SETUP.md)
- [Auth reference](AUTH.md)
- [MCP setup](MCP.md)
- [CLI reference](CLI.md)
