# Wallet Data, Portfolio, Address Book, Bookmarks

## Transaction Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/wallets/transactions` | GET | Token optional | Global transaction list |
| `/wallet/:address/transactions` | GET | Token optional | Wallet transactions (DB path or on-chain fallback) |
| `/wallet/:address/transactions` | POST | Bearer | Add manual transaction record |

## Asset + Portfolio Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/wallet/:address/assets` | GET | Token optional | List tracked assets for wallet |
| `/wallet/:address/asset` | POST | Bearer | Track/add asset |
| `/wallet/:address/asset/:assetId` | DELETE | Bearer | Remove tracked asset |
| `/portfolio` | GET | Token optional | Aggregated portfolio (chain/token rollups) |

## Address Book Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/address-labels` | GET | Token optional | List labels (supports query filter) |
| `/address-labels` | POST | Bearer | Create/update label |
| `/address-labels/:id` | DELETE | Bearer | Delete label |

## Bookmark Endpoints

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/bookmarks` | GET | Token optional | List token bookmarks |
| `/bookmarks` | POST | Bearer | Create bookmark |
| `/bookmarks/:id` | DELETE | Bearer | Delete bookmark |

## Related Public Data Endpoints

For token metadata/intel lookups used in portfolio flows, see:

- [`docs/api/system.md`](/api?doc=api/system.md)

Compatibility note: wallet asset/transaction routes are available under both `/wallet/*` and `/wallets/*` prefixes.
