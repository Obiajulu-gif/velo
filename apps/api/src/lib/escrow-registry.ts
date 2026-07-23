import { z } from "zod";
import {
  ESCROW_DEPLOYMENTS,
  normalizeSettlementAsset,
  selectEscrowDeployment,
  supportedSettlementAssets,
  type EscrowDeployment,
  type VeloNetwork,
} from "@velo/shared";

const deploymentSchema = z.object({
  deploymentId: z.string().trim().min(1),
  network: z.enum(["testnet", "mainnet"]),
  settlementAsset: z.string().trim().min(1),
  version: z.number().int().positive(),
  contractId: z.string().trim().min(1),
  status: z.enum(["active", "draining", "retired"]),
  activatedAt: z.string().datetime().optional(),
  replaces: z.string().trim().min(1).optional(),
});

const registrySchema = z.union([
  z.array(deploymentSchema),
  z.object({
    testnet: z.array(deploymentSchema).optional(),
    mainnet: z.array(deploymentSchema).optional(),
  }),
]);

export class UnsupportedSettlementAssetError extends Error {
  constructor(
    readonly settlementAsset: string,
    readonly supportedAssets: string[],
  ) {
    super(
      `No active escrow deployment is configured for ${settlementAsset}. Supported assets: ${supportedAssets.join(", ") || "none"}`,
    );
    this.name = "UnsupportedSettlementAssetError";
  }
}

export function networkFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): VeloNetwork {
  return env.STELLAR_NETWORK?.trim().toUpperCase() === "PUBLIC"
    ? "mainnet"
    : "testnet";
}

function environmentDeployments(
  network: VeloNetwork,
  env: NodeJS.ProcessEnv,
): EscrowDeployment[] {
  const raw = env.ESCROW_CONTRACT_REGISTRY_JSON?.trim();
  if (!raw) return [];

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `ESCROW_CONTRACT_REGISTRY_JSON is not valid JSON: ${String(error)}`,
    );
  }

  const parsed = registrySchema.parse(decoded);
  const deployments = Array.isArray(parsed) ? parsed : parsed[network] ?? [];
  return deployments
    .filter((deployment) => deployment.network === network)
    .map((deployment) => ({
      ...deployment,
      settlementAsset: normalizeSettlementAsset(deployment.settlementAsset),
    }));
}

function legacyEnvironmentDeployments(
  network: VeloNetwork,
  env: NodeJS.ProcessEnv,
): EscrowDeployment[] {
  const deployments: EscrowDeployment[] = [];
  const defaultContractId = env.ESCROW_CONTRACT_ID?.trim();
  if (defaultContractId) {
    const settlementAsset = normalizeSettlementAsset(
      env.ESCROW_DEFAULT_SETTLEMENT_ASSET ?? "USDC",
    );
    const version = Number(env.ESCROW_CONTRACT_VERSION ?? 1);
    deployments.push({
      deploymentId: `${network}-${settlementAsset.toLowerCase()}-env-v${version}`,
      network,
      settlementAsset,
      version,
      contractId: defaultContractId,
      status: "active",
    });
  }

  const xlmContractId = env.ESCROW_XLM_CONTRACT_ID?.trim();
  if (xlmContractId) {
    const version = Number(env.ESCROW_XLM_CONTRACT_VERSION ?? 1);
    deployments.push({
      deploymentId: `${network}-xlm-env-v${version}`,
      network,
      settlementAsset: "XLM",
      version,
      contractId: xlmContractId,
      status: "active",
    });
  }

  return deployments;
}

/**
 * Merge source-controlled defaults with operator-managed registry entries.
 * Environment entries with the same deploymentId replace defaults. Legacy
 * single-address variables also replace the source-controlled active instance
 * for their asset, preserving backwards compatibility while enabling rollout.
 */
export function getEscrowDeployments(
  env: NodeJS.ProcessEnv = process.env,
): EscrowDeployment[] {
  const network = networkFromEnvironment(env);
  const builtIns = [...ESCROW_DEPLOYMENTS[network]];
  const configured = environmentDeployments(network, env);
  const legacy = legacyEnvironmentDeployments(network, env);

  const legacyAssets = new Set(
    legacy.map((deployment) => deployment.settlementAsset),
  );
  const merged = new Map<string, EscrowDeployment>();

  for (const deployment of builtIns) {
    if (
      deployment.status === "active" &&
      legacyAssets.has(normalizeSettlementAsset(deployment.settlementAsset))
    ) {
      continue;
    }
    merged.set(deployment.deploymentId, deployment);
  }
  for (const deployment of configured) {
    merged.set(deployment.deploymentId, deployment);
  }
  for (const deployment of legacy) {
    merged.set(deployment.deploymentId, deployment);
  }

  return [...merged.values()].sort(
    (a, b) =>
      a.settlementAsset.localeCompare(b.settlementAsset) ||
      b.version - a.version,
  );
}

export function resolveEscrowDeployment(
  settlementAsset = "USDC",
  env: NodeJS.ProcessEnv = process.env,
): EscrowDeployment {
  const asset = normalizeSettlementAsset(settlementAsset);
  const deployments = getEscrowDeployments(env);
  const selected = selectEscrowDeployment(deployments, asset);
  if (!selected) {
    throw new UnsupportedSettlementAssetError(
      asset,
      supportedSettlementAssets(deployments),
    );
  }
  return selected;
}
