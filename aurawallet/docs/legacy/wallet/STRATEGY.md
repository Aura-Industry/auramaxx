# Strategies

High-level overview of AuraMaxx's strategy system — apps that run on a schedule or respond to messages.

For the full developer reference (manifest fields, hooks, sources, examples), see [DEVELOPING-STRATEGIES.md](./DEVELOPING-STRATEGIES.md). For AI engine internals, see [AI.md](./AI.md).

## What Are Strategies?

Strategies extend apps with AI-powered automation. A strategy is a regular app whose `app.md` manifest includes additional fields — hooks, a ticker, sources — that activate the AI engine. The engine then orchestrates the AI ↔ API ↔ human-approval loop automatically.

Every strategy starts as a regular app — see [APPS.md](../APPS.md). Strategies live in `apps/<id>/` alongside regular UI apps. Adding a `ticker`, `jobs`, or `hooks.message` field to the manifest is what activates the AI engine.

## Two Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Tick mode** | `ticker` or `jobs` field | Engine fetches sources on a schedule, calls `tick` hook, processes intents through `execute` and `result` hooks. The full strategy lifecycle. |
| **Message mode** | `hooks.message` field | No scheduled ticks. AI responds to user messages via tool-call flow. Chat-style apps. |

Both can coexist — a strategy that ticks on a schedule and also handles chat messages.

## Tick Tiers

Tick-mode strategies run at one of five intervals:

| Tier | Interval | Use Case |
|------|----------|----------|
| `sniper` | 10 seconds | Time-critical sniping, MEV |
| `active` | 30 seconds | Active trading, price triggers |
| `standard` | 1 minute | General monitoring |
| `slow` | 5 minutes | Portfolio tracking, reporting |
| `maintenance` | 1 hour | Daily buys, maintenance tasks |

For strategies that need multiple intervals, use `jobs` instead of `ticker` (see [DEVELOPING-STRATEGIES.md](./DEVELOPING-STRATEGIES.md#jobs)).

## Hooks at a Glance

Six lifecycle hooks, each a natural-language string instructing the AI what to do:

| Hook | When Called | Mode |
|------|-----------|------|
| `init` | Strategy enabled | Tick |
| `tick` | Every scheduled interval | Tick |
| `execute` | Per approved intent (if no pre-computed action) | Tick |
| `result` | After action execution | Tick |
| `shutdown` | Strategy disabled | Tick |
| `message` | Human sends a message | Message |

The engine auto-injects API docs, response format specs, and wallet context — keep hook instructions focused on your app's specific behavior.

## Minimal Example

A SOL DCA bot that buys ETH on a schedule:

```markdown
---
name: Daily ETH Buy
icon: Repeat
category: strategy
ticker: maintenance

permissions:
  - swap
  - wallet:list
limits:
  swap: 0.01

hooks:
  tick: |
    Buy 0.01 ETH worth of the configured token using the hot wallet.
    If no hot wallet exists, return empty intents.

config:
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  mode: live
  approve: true
---

Buys a small amount of a token every hour. Simple recurring buy strategy.
```

This is a complete, valid strategy. The engine handles source fetching, AI dispatch, human approval, and action execution.

## Next Steps

- [DEVELOPING-STRATEGIES.md](./DEVELOPING-STRATEGIES.md) — Full developer reference: manifest fields, hook contexts, sources, intents, examples
- [APPS.md](../APPS.md) — App overview: what apps are, installing, the app store
- [DEVELOPING-APPS.md](../DEVELOPING-APPS.md) — Building UI apps: SDK API, theming, security, storage
- [AI.md](./AI.md) — AI engine internals: provider selection, tool-use, testing
