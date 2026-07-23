export {
  normalizeSettlementAsset,
  selectEscrowDeployment,
  supportedSettlementAssets,
} from "./escrow-registry.js";
export type {
  EscrowDeployment,
  EscrowDeploymentStatus,
  VeloNetwork,
} from "./escrow-registry.js";

import type { EscrowDeployment, VeloNetwork } from "./escrow-registry.js";

/**
 * Legacy single-address constants retained for compatibility. New API code
 * should route through ESCROW_DEPLOYMENTS plus environment registry entries.
 */
export const CONTRACTS = {
  testnet: {
    escrow: "CAEYSVTKTCZYTSMPD7CU3NOFYOO4S5V6LJLGRNV7LKTNZ65N66PCHLMC",
    atomicSwapA: "SET_ME_AFTER_FIRST_DEPLOY",
    zkVerifierRegistry: "SET_ME_AFTER_FIRST_DEPLOY",
  },
  mainnet: {
    escrow: "DEPLOY_ESCROW_FIRST",
    atomicSwapA: "DEPLOY_ATOMIC_SWAP_FIRST",
    zkVerifierRegistry: "",
  },
} as const;

/**
 * Repository-managed escrow instances. Deployments added through
 * ESCROW_CONTRACT_REGISTRY_JSON are merged with these at API startup, allowing
 * a new token or patched contract to be activated without a code deployment.
 */
export const ESCROW_DEPLOYMENTS: Record<VeloNetwork, readonly EscrowDeployment[]> = {
  testnet: [
    {
      deploymentId: "testnet-usdc-v1",
      network: "testnet",
      settlementAsset: "USDC",
      version: 1,
      contractId: CONTRACTS.testnet.escrow,
      status: "active",
    },
  ],
  mainnet: [],
};

/** Stellar Mainnet USDC metadata */
export const USDC_MAINNET = {
  issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  /** Stellar Asset Contract address for USDC on mainnet */
  sac: "CCW67TSZV3SSWZ6NAU4B46GSAV4IX3ODU6OVU5Q2ZWCEO6PJ6W7JXK2O",
  code: "USDC",
} as const;

export type Network = keyof typeof CONTRACTS;

export interface CashRequest {
  id: string;
  claim_url: string;
  qr_payload: string;
  status: "pending" | "locked" | "released" | "refunded";
}
