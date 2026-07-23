# Escrow contract versioning and migration

Velo deploys one escrow contract instance per settlement token because the token address is bound during contract initialization. Contract upgrades are therefore handled as immutable deployments in a registry rather than by replacing one global address.

## Deployment model

Every registry entry contains:

- `deploymentId`: stable operational identifier, such as `testnet-usdc-v2`
- `network`: `testnet` or `mainnet`
- `settlementAsset`: canonical asset code, such as `USDC` or `XLM`
- `version`: increasing integer for that asset
- `contractId`: deployed Soroban contract address
- `status`: `active`, `draining`, or `retired`
- optional `activatedAt` and `replaces` metadata

The source-controlled defaults live in `packages/shared/src/index.ts`. Operators can add or replace entries at runtime with `ESCROW_CONTRACT_REGISTRY_JSON`, so onboarding another settlement token does not require an API code deployment.

## Routing rules

Clients discover deployments with:

```http
GET /api/v1/cash/escrow-contracts
```

New asset-aware trades use:

```http
POST /api/v1/cash/request/prepare/:settlementAsset
```

The API normalizes the asset code and selects the highest-version deployment whose status is `active`. The response and QR payload include the selected contract, deployment ID, asset, and version.

The existing `POST /api/v1/cash/request/prepare` route remains the backward-compatible default-asset path.

## Why in-flight trades survive migration

At trade creation, Velo persists the selected `contractId` together with `escrowDeploymentId`, `settlementAsset`, and `contractVersion`. All later operations—submission, release, refund, dispute resolution, and payout batching—use the contract address stored on the trade rather than resolving the current active deployment again.

Consequently, changing the registry affects only new trades. An old trade continues to call the exact contract instance that holds its funds, even after a newer version becomes active.

## Status lifecycle

### Active

Receives new trades. Only the highest active version for an asset is selected.

### Draining

Receives no new trades, but remains monitored and fully usable for existing trades. Keep a deployment in this state until every non-terminal trade has reached `released` or `refunded`, all pending payout batches are empty, and the dispute/refund window has elapsed.

### Retired

Receives no new trades and is no longer included in anomaly monitoring. Retirement does not delete the address or prevent explicit historical reads; it indicates that operations have confirmed no live liabilities remain.

## Upgrade procedure

1. Deploy and initialize the new escrow instance with the intended settlement token.
2. Verify its token binding, admin configuration, timeout behavior, and lock/release/refund paths on the target network.
3. Add the new entry to `ESCROW_CONTRACT_REGISTRY_JSON` as `active` with a version greater than the old entry.
4. Change the previous active entry to `draining` in the same configuration update.
5. Confirm `GET /api/v1/cash/escrow-contracts` returns the new active deployment.
6. Create a small new trade and verify it records the new `contractId`.
7. Release or refund an older trade and verify it still calls its original contract.
8. Continue monitoring both contracts until the draining criteria are met.
9. Mark the old entry `retired` only after operational sign-off.

## Adding a third settlement asset

Deploy its escrow contract, then add one active registry entry. No route or application code change is required. For example:

```json
{
  "deploymentId": "mainnet-eurc-v1",
  "network": "mainnet",
  "settlementAsset": "EURC",
  "version": 1,
  "contractId": "C...",
  "status": "active"
}
```

Clients can immediately discover `EURC` and request it through the asset-aware prepare route.

## Rollback

If a newly activated deployment is faulty:

1. Mark it `draining` to stop new locks.
2. Restore the last known-good deployment to `active` with the highest selectable version, or publish a new patched version.
3. Do not rewrite contract IDs on trades already created against the faulty deployment. Resolve those trades through that original contract using its supported release, refund, or dispute path.

This avoids split-brain settlement and preserves an auditable mapping from every trade to the contract holding its funds.
