import { app } from "./app.js";
import { cashRoutes } from "./routes/cash.js";
import { cashRoutingRoutes } from "./routes/cash-routing.js";
import { adminRoutes } from "./routes/admin.js";
import { startPayoutBatchScheduler } from "./lib/payout-batcher.js";
import { EscrowAnomalyMonitor } from "./lib/escrow-anomaly-monitor.js";
import { getEscrowDeployments } from "./lib/escrow-registry.js";
import { server } from "./lib/stellar.js";

const port = Number(process.env.PORT ?? 3000);

// Initialize and register routes before starting the server
async function startServer() {
  try {
    // Register asset-aware contract discovery/prepare routes first. Existing
    // cash routes remain backward compatible with the default escrow asset.
    await app.register(cashRoutingRoutes, { prefix: "/api/v1" });

    // Register User Cash & Geolocation discovery routes (with /api/v1 prefix)
    await app.register(cashRoutes, { prefix: "/api/v1" });

    // Register Admin/Ops monitoring & intervention routes (with /api/v1 prefix)
    await app.register(adminRoutes, { prefix: "/api/v1" });

    // Start listening
    await app.listen({ port, host: "0.0.0.0" });
    app.log.info(`velo api listening on :${port}`);

    // Background scheduler for opt-in provider payout batching — see
    // docs/provider-payout-batching.md. Not started for the test app
    // instance (app.test.ts imports ./app.js directly, not this entrypoint).
    startPayoutBatchScheduler();

    // Monitor every active or draining deployment. Old contracts remain
    // observable while in-flight trades finish; retired contracts are omitted.
    const monitoredContractIds = new Set(
      getEscrowDeployments()
        .filter((deployment) => deployment.status !== "retired")
        .map((deployment) => deployment.contractId),
    );
    for (const contractId of monitoredContractIds) {
      new EscrowAnomalyMonitor(server, {
        contractId,
        startLedger: process.env.ESCROW_MONITOR_START_LEDGER
          ? Number(process.env.ESCROW_MONITOR_START_LEDGER)
          : undefined,
      }).start();
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

startServer();
