# Share a Secret (CLI + UI)

Share with a GitHub Gist link when possible; use local links only when the recipient can reliably reach your host/network.  
Use CLI for repeatable automation and UI for one-off/manual review flows.

---

## Prerequisite: GitHub CLI auth (for Gist sharing)

Check auth:

```bash
gh auth status
```

If not authenticated:

```bash
gh auth login
```

If `gh` is missing, install GitHub CLI first, then authenticate.

---

## CLI sharing

### Recommended command

```bash
aurawallet agent share OPENAI_KEY --expires-after 24h
```

### Alias path (same behavior)

```bash
aurawallet share OPENAI_KEY --expires-after 24h
```

### What to expect

- If GitHub auth is available, CLI generates a share via Gist and returns a shareable link.
- If GitHub/Gist path is unavailable, use local-link fallback (see below).

---

## UI sharing

1. Open Agent and select a credential.
2. Click **SHARE** in credential detail.
3. In the share modal:
   - Prefer **SHARE GIST** (recommended for remote recipients).
   - Use local link only when recipient can reach your host/network.

---

## Local-link limitation (important)

A local link is often **not reachable** by remote recipients.

Use local links only when:
- recipient is on the same network, or
- you provide a secure tunnel/network path.

---

## Tunnel/network fallback options

If Gist sharing is unavailable and recipient is remote, use one of these:

- Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- Tailscale: https://tailscale.com/kb

These options can make local-hosted share endpoints reachable in a controlled way.
