export type VeloNetwork = "testnet" | "mainnet";
export type EscrowDeploymentStatus = "active" | "draining" | "retired";

export interface EscrowDeployment {
  /** Stable identifier used in logs and persisted trade metadata. */
  deploymentId: string;
  network: VeloNetwork;
  /** Canonical upper-case settlement asset code, for example USDC or XLM. */
  settlementAsset: string;
  /** Monotonically increasing contract implementation/configuration version. */
  version: number;
  contractId: string;
  /** New trades route only to active deployments. */
  status: EscrowDeploymentStatus;
  activatedAt?: string;
  /** Optional deployment id superseded by this instance. */
  replaces?: string;
}

export function normalizeSettlementAsset(asset: string): string {
  const normalized = asset.trim().toUpperCase();
  if (normalized === "NATIVE") return "XLM";
  return normalized;
}

/**
 * Select the newest active escrow for an asset. Draining and retired contracts
 * remain addressable by persisted trades but never receive new locks.
 */
export function selectEscrowDeployment(
  deployments: readonly EscrowDeployment[],
  settlementAsset: string,
): EscrowDeployment | undefined {
  const asset = normalizeSettlementAsset(settlementAsset);
  return deployments
    .filter(
      (deployment) =>
        deployment.status === "active" &&
        normalizeSettlementAsset(deployment.settlementAsset) === asset,
    )
    .sort((a, b) => b.version - a.version)[0];
}

export function supportedSettlementAssets(
  deployments: readonly EscrowDeployment[],
): string[] {
  return Array.from(
    new Set(
      deployments
        .filter((deployment) => deployment.status === "active")
        .map((deployment) => normalizeSettlementAsset(deployment.settlementAsset)),
    ),
  ).sort();
}
