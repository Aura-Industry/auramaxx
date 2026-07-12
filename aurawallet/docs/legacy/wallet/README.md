# Wallet & Trading Features

AuraMaxx also includes the original wallet and agent-trading stack.

Use this doc if you are focused on onchain workflows. For credential-agent-first setup, start at the root [README](../../README.md).

## What wallet mode provides

- Trade on EVM + Solana chains
- Create and manage hot wallets from a cold agent
- Execute send/fund/swap/launch flows
- Human approval flows for sensitive actions
- Agent tokens with permission and spend limits

## Typical wallet prompts

- "Buy me $50 of PEPE"
- "Bridge my ETH from Base to Arbitrum"
- "Sell all PEPE if price drops 20%"
- "Launch a token with name AURA"

## Quick wallet setup

```bash
npx aurawallet
npx aurawallet status
```

Open dashboard UI: `http://localhost:4747/` (API server runs at `http://localhost:4242`).

## Access paths

- Dashboard UI
- CLI (`npx aurawallet ...`)
- MCP (`npx aurawallet mcp`)
- Approval listener (`npx tsx server/cli/index.ts`)

## Wallet docs

- [API reference](../../ai-agents-workflow/API.md)
- [Auth + permissions](../../ai-agents-workflow/AUTH.md)
- [MCP reference](../../ai-agents-workflow/MCP.md)
- [AI / strategy docs](./AI.md)
- [Strategy overview](./STRATEGY.md)
- [Strategy developer reference](./DEVELOPING-STRATEGIES.md)
- [Apps](../APPS.md)
- [Adapters](../ADAPTERS.md)
