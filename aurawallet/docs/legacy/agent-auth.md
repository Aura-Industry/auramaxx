# Agent Auth Model

This page is intentionally minimal to avoid duplicating `AUTH.md`.

Use these entrypoints:

- Full auth/token model and getting secrets: [AUTH.md](../ai-agents-workflow/AUTH.md)

Quick summary:

1. Agent requests access via `POST /auth` with `pubkey`.
2. Human approves.
3. Agent claims token via `GET /auth/:requestId` with `x-aura-claim-secret`.
