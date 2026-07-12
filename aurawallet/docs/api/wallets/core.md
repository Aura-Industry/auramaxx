# Wallet Core & Trading Endpoints

## Human Agent Lifecycle

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/setup` | POST | Public | Create primary agent/cold wallet |
| `/setup/password` | POST | Admin | Change primary agent password |
| `/setup/agent` | POST | Admin | Create additional agent |
| `/setup/agent/import` | POST | Admin | Import additional agent from seed |
| `/setup/agents` | GET | Public | List agents/unlock state |
| `/wallet/export-seed` | GET/POST | Admin | Export seed phrase (agent must be unlocked) |
| `/unlock` | POST | Public | Unlock primary agent |
| `/unlock/:agentId` | POST | Public | Unlock specific agent |
| `/unlock/rekey` | POST | Public | Rekey unlock session to a new `pubkey` |
| `/unlock/recover` | POST | Public | Recovery flow |
| `/lock` | POST | Admin | Lock all agents |
| `/lock/:agentId` | POST | Admin | Lock one agent |

## Wallet Action Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/wallets` | GET | Token optional | List wallets + balances |
| `/wallet/:address` | GET | Token optional | Read one wallet detail by address |
| `/wallet/create` | POST | Bearer | Create hot/temp wallet |
| `/wallet/search` | GET | Token optional | Search wallets |
| `/wallet/rename` | POST | Bearer | Update wallet metadata |
| `/wallet/:address/export` | POST | Token optional | Export wallet private key |
| `/send` | POST | Bearer | Send native/token transaction |
| `/send/estimate` | POST | Public | Estimate EVM gas |
| `/fund` | POST | Bearer | Transfer cold -> hot wallet |
| `/swap` | POST | Bearer | Execute swap |
| `/swap/quote` | POST | Bearer | Quote swap without execution |
| `/swap/dexes` | GET | Public | List DEX adapters |
| `/launch` | POST | Bearer | Launch token (Doppler) |
| `/launch/:tokenAddress/collect-fees` | POST | Bearer | Collect launch fees for one token |
| `/launch/collect-fees` | POST | Bearer | Collect launch fees for all launched tokens |

## Notes

- Wallet routes support both `/wallet/*` and `/wallets/*` prefixes for compatibility.
- This doc uses `/wallets` for list reads and `/wallet/*` for item/mutation examples.
- Amount units are raw base units (`wei`/`lamports`/token base units).
- Token-based operations enforce permissions + wallet access + optional spend limits.
- Use `/actions` escalation flow on permission-denied automation cases.
