# HOW TO AURAMAXX

This is the single external entrypoint for understanding and using AuraMaxx.

## Fast start

### First run

```bash
npx aurawallet
npx aurawallet status
```

Open `http://localhost:4747/`, create/unlock your agent, and add one credential.

### Returning run

- Service already running: `npx aurawallet status`
- Service not running: `npx aurawallet && npx aurawallet status`

If using global install and prompted to update:

```bash
npm i -g auramaxx
```

## Core concepts (condensed)

- **Auth:** access is explicit and scoped (not just process identity).
- **Safety:** least-privilege defaults + approval flows.
- **Understanding Aura:** local-first credential runtime for humans + agents.
- **Security transparency:** source is auditable on GitHub: <https://github.com/Aura-Industry/auramaxx>

## Main usage path

- **Start here:** [WORKING_WITH_SECRETS.md](../../../how-to-auramaxx/WORKING_WITH_SECRETS.md)
- Then configure MCP clients: [AGENT_SETUP.md](../../../quickstart/AGENT_SETUP.md)

## Next references

- [CLI](../../../ai-agents-workflow/CLI.md)
- [MCP](../../../ai-agents-workflow/MCP.md)
- [Auth + permissions](../../../ai-agents-workflow/AUTH.md)
- [Security model](../../../why-auramaxx/security.md)
- [Share secret guide](../../../how-to-auramaxx/share-secret.md)
