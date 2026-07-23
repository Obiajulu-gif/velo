import { afterEach, describe, expect, it } from "vitest";
import {
  getEscrowDeployments,
  resolveEscrowDeployment,
  UnsupportedSettlementAssetError,
} from "./escrow-registry.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("escrow deployment registry", () => {
  it("routes each asset to its highest active contract version", () => {
    process.env.STELLAR_NETWORK = "TESTNET";
    process.env.ESCROW_CONTRACT_ID = "CLEGACYUSDC";
    process.env.ESCROW_CONTRACT_VERSION = "1";
    process.env.ESCROW_XLM_CONTRACT_ID = "CXLMV1";
    process.env.ESCROW_CONTRACT_REGISTRY_JSON = JSON.stringify([
      {
        deploymentId: "testnet-usdc-v1",
        network: "testnet",
        settlementAsset: "USDC",
        version: 1,
        contractId: "CUSDCV1",
        status: "draining",
      },
      {
        deploymentId: "testnet-usdc-v2",
        network: "testnet",
        settlementAsset: "usdc",
        version: 2,
        contractId: "CUSDCV2",
        status: "active",
        replaces: "testnet-usdc-v1",
      },
    ]);

    expect(resolveEscrowDeployment("USDC")).toMatchObject({
      deploymentId: "testnet-usdc-v2",
      contractId: "CUSDCV2",
      version: 2,
    });
    expect(resolveEscrowDeployment("native")).toMatchObject({
      contractId: "CXLMV1",
      settlementAsset: "XLM",
    });
  });

  it("keeps draining deployments in the registry but never selects them", () => {
    process.env.STELLAR_NETWORK = "TESTNET";
    process.env.ESCROW_CONTRACT_ID = "";
    process.env.ESCROW_CONTRACT_REGISTRY_JSON = JSON.stringify([
      {
        deploymentId: "testnet-eurc-v1",
        network: "testnet",
        settlementAsset: "EURC",
        version: 1,
        contractId: "CEURCV1",
        status: "draining",
      },
      {
        deploymentId: "testnet-eurc-v2",
        network: "testnet",
        settlementAsset: "EURC",
        version: 2,
        contractId: "CEURCV2",
        status: "active",
      },
    ]);

    expect(getEscrowDeployments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contractId: "CEURCV1", status: "draining" }),
        expect.objectContaining({ contractId: "CEURCV2", status: "active" }),
      ]),
    );
    expect(resolveEscrowDeployment("EURC").contractId).toBe("CEURCV2");
  });

  it("returns the supported assets when no active deployment exists", () => {
    process.env.STELLAR_NETWORK = "TESTNET";
    process.env.ESCROW_CONTRACT_ID = "CUSDC";

    expect(() => resolveEscrowDeployment("BTC")).toThrow(
      UnsupportedSettlementAssetError,
    );
    try {
      resolveEscrowDeployment("BTC");
    } catch (error) {
      expect(error).toMatchObject({
        settlementAsset: "BTC",
        supportedAssets: expect.arrayContaining(["USDC"]),
      });
    }
  });
});
