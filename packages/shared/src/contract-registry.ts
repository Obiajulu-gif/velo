export type SettlementAsset = "XLM" | "USDC" | (string & {});
export type ContractNetwork = "testnet" | "mainnet";

export interface EscrowContractDeployment {
  id: string;
  network: ContractNetwork;
  settlementAsset: SettlementAsset;
  version: string;
  status: "active" | "draining" | "retired";
  activatedAt: string;
  retiredAt?: string;
}

export interface EscrowTradeBinding {
  tradeId: string;
  contractId: string;
  settlementAsset: SettlementAsset;
  contractVersion: string;
}

const BUILTIN_DEPLOYMENTS: readonly EscrowContractDeployment[] = [
  {
    id: "CAEYSVTKTCZYTSMPD7CU3NOFYOO4S5V6LJLGRNV7LKTNZ65N66PCHLMC",
    network: "testnet",
    settlementAsset: "USDC",
    version: "1.0.0",
    status: "active",
    activatedAt: "2026-01-01T00:00:00.000Z",
  },
];

function parseOverrides(raw?: string): EscrowContractDeployment[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("ESCROW_CONTRACT_REGISTRY_JSON must be a JSON array");
  }
  return parsed as EscrowContractDeployment[];
}

export function getEscrowContractRegistry(
  registryJson = process.env.ESCROW_CONTRACT_REGISTRY_JSON,
): readonly EscrowContractDeployment[] {
  const overrides = parseOverrides(registryJson);
  return overrides.length ? overrides : BUILTIN_DEPLOYMENTS;
}

export function resolveEscrowContract(
  settlementAsset: SettlementAsset,
  network: ContractNetwork,
  deployments = getEscrowContractRegistry(),
): EscrowContractDeployment {
  const candidates = deployments
    .filter(
      (deployment) =>
        deployment.network === network &&
        deployment.settlementAsset.toUpperCase() === settlementAsset.toUpperCase() &&
        deployment.status === "active",
    )
    .sort((a, b) => b.activatedAt.localeCompare(a.activatedAt));

  const selected = candidates[0];
  if (!selected) {
    throw new Error(`No active escrow contract for ${settlementAsset} on ${network}`);
  }
  return selected;
}

export function resolveEscrowContractForTrade(
  binding: EscrowTradeBinding,
  deployments = getEscrowContractRegistry(),
): EscrowContractDeployment {
  const deployment = deployments.find((entry) => entry.id === binding.contractId);
  if (!deployment) {
    throw new Error(`Escrow contract ${binding.contractId} is missing from the registry`);
  }
  return deployment;
}

export function bindTradeToEscrowContract(
  tradeId: string,
  settlementAsset: SettlementAsset,
  network: ContractNetwork,
  deployments = getEscrowContractRegistry(),
): EscrowTradeBinding {
  const deployment = resolveEscrowContract(settlementAsset, network, deployments);
  return {
    tradeId,
    contractId: deployment.id,
    settlementAsset: deployment.settlementAsset,
    contractVersion: deployment.version,
  };
}
