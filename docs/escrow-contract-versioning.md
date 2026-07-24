# Escrow contract versioning and migration

Velo treats every deployed escrow contract as an immutable settlement target. A deployment is identified by its contract ID, network, settlement asset, semantic version, activation time, and lifecycle status.

## Routing new trades

API services must call `resolveEscrowContract(asset, network)` (or `bindTradeToEscrowContract`) from `@velo/shared` instead of reading one global escrow address. The registry is supplied through `ESCROW_CONTRACT_REGISTRY_JSON`, so adding a token or activating a patched contract does not require an application code deployment.

Example:

```json
[
  {
    "id": "C_USDC_V2",
    "network": "testnet",
    "settlementAsset": "USDC",
    "version": "2.0.0",
    "status": "active",
    "activatedAt": "2026-08-01T00:00:00.000Z"
  },
  {
    "id": "C_USDC_V1",
    "network": "testnet",
    "settlementAsset": "USDC",
    "version": "1.0.0",
    "status": "draining",
    "activatedAt": "2026-01-01T00:00:00.000Z"
  },
  {
    "id": "C_XLM_V1",
    "network": "testnet",
    "settlementAsset": "XLM",
    "version": "1.0.0",
    "status": "active",
    "activatedAt": "2026-06-01T00:00:00.000Z"
  }
]
```

When several active entries match, the newest `activatedAt` wins. Operators should normally leave only one active deployment per asset and network.

## Binding trades

At trade creation, persist these fields with the trade:

- `contractId`
- `contractVersion`
- `settlementAsset`

Every later release, refund, status, and event-indexing operation must use the persisted `contractId`. It must not resolve the current active contract again. `resolveEscrowContractForTrade` intentionally accepts draining and retired deployments so old trades continue working.

## Lifecycle

1. **active**: receives new trades and serves existing trades.
2. **draining**: receives no new trades but remains available for existing trades.
3. **retired**: no new trades; retained in the registry and event index for historical or exceptional operations.

Do not remove a deployment while any non-terminal trade references it. Contract IDs should remain queryable indefinitely for audit history.

## Migration procedure

1. Deploy and initialize the new contract for its settlement asset.
2. Add it to the registry as `active`; change the previous deployment to `draining` in the same configuration update.
3. Reload/restart API instances so they consume the new registry. No code change is required.
4. Confirm new trades persist the new contract ID while existing trades still use their original ID.
5. Monitor the old deployment until all bound trades reach a terminal state.
6. Mark the old deployment `retired`, but keep it in the registry and event index.

## Client discovery

Clients should submit the requested settlement asset, not a contract address. The API returns the selected contract ID and version in the trade creation response. Advanced clients may cache that value for display, but the server-side trade binding remains authoritative.

## Rollback

To roll back, mark the faulty deployment `draining` and reactivate the previous compatible deployment. New trades route back immediately after configuration reload; trades already bound to the faulty deployment remain addressable and can be handled through the normal migration or recovery process.
