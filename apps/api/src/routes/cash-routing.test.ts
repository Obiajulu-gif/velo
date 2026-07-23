import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cashRoutes } from "./cash.js";
import { cashRoutingRoutes } from "./cash-routing.js";
import {
  buildLockEscrowTransaction,
  lockEscrow,
  releaseEscrow,
} from "../lib/stellar.js";
import { getCashRequest, saveCashRequest } from "../lib/store.js";

vi.mock("../lib/stellar.js", () => ({
  lockEscrow: vi.fn().mockResolvedValue(1_000),
  releaseEscrow: vi.fn().mockResolvedValue(undefined),
  refundEscrow: vi.fn().mockResolvedValue(undefined),
  disputeEscrow: vi.fn().mockResolvedValue(undefined),
  buildLockEscrowTransaction: vi.fn().mockResolvedValue("unsigned-xdr"),
  submitSignedTransaction: vi.fn().mockResolvedValue({
    hash: "hash",
    status: "SUCCESS",
    ledger: 1_000,
  }),
  submitReleaseTx: vi.fn().mockResolvedValue({ hash: "release-hash" }),
  submitRefundTx: vi.fn().mockResolvedValue({ hash: "refund-hash" }),
  getLatestLedgerSequence: vi.fn().mockResolvedValue(1_000),
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
}));

vi.mock("./chat.js", () => ({ notifyTradeStatus: vi.fn() }));
vi.mock("../lib/chat-infrastructure.js", () => ({
  registerTradeForChat: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/chat-capability.js", () => ({
  issueChatCapability: vi.fn().mockReturnValue("chat-token"),
}));
vi.mock("../lib/notification.js", () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/webhook.js", () => ({ sendRefundAlert: vi.fn() }));

const originalEnv = { ...process.env };
const seller = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const buyer = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function registerPayment(app: ReturnType<typeof Fastify>) {
  app.decorate(
    "requirePayment",
    async (_req: unknown, _reply: unknown, _price: string) => true,
  );
}

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("asset-aware cash routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STELLAR_NETWORK = "TESTNET";
    process.env.ESCROW_CONTRACT_ID = "CUSDCV1";
    process.env.ESCROW_XLM_CONTRACT_ID = "CXLMV1";
    process.env.ESCROW_CONTRACT_REGISTRY_JSON = "";
  });

  it("routes a requested settlement asset to its configured contract", async () => {
    const app = Fastify();
    registerPayment(app);
    await app.register(cashRoutingRoutes, { prefix: "/api/v1" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request/prepare/XLM",
      payload: {
        seller,
        buyer,
        amount_stroops: "10000000",
        secret_hash: "a".repeat(64),
        mode: "custodial",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(lockEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: "CXLMV1" }),
    );
    expect(response.json()).toMatchObject({
      escrow: {
        contract_id: "CXLMV1",
        settlement_asset: "XLM",
        version: 1,
      },
    });

    const requestId = response.json().request_id;
    expect(getCashRequest(requestId)).toMatchObject({
      contractId: "CXLMV1",
      settlementAsset: "XLM",
      contractVersion: 1,
    });
  });

  it("builds non-custodial transactions against the selected deployment", async () => {
    const app = Fastify();
    registerPayment(app);
    await app.register(cashRoutingRoutes, { prefix: "/api/v1" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request/prepare/USDC",
      payload: {
        seller,
        buyer,
        amount_stroops: "10000000",
        secret_hash: "b".repeat(64),
        mode: "non_custodial",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(buildLockEscrowTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: "CUSDCV1" }),
    );
  });

  it("releases an in-flight trade through its original contract after migration", async () => {
    const tradeId = `migration-${Date.now()}`;
    saveCashRequest({
      id: tradeId,
      contractId: "CUSDCV1",
      escrowDeploymentId: "testnet-usdc-v1",
      settlementAsset: "USDC",
      contractVersion: 1,
      seller,
      buyer,
      amountStroops: "10000000",
      secretHex: "",
      secretHashHex: "c".repeat(64),
      qrPayload: `velo://claim?request_id=${tradeId}&contract=CUSDCV1`,
      status: "locked",
      createdAt: new Date().toISOString(),
    });

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
        settlementAsset: "USDC",
        version: 2,
        contractId: "CUSDCV2",
        status: "active",
      },
    ]);

    const app = Fastify();
    registerPayment(app);
    await app.register(cashRoutes, { prefix: "/api/v1" });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/cash/request/${tradeId}/release`,
      payload: { secret: "d".repeat(64) },
    });

    expect(response.statusCode).toBe(200);
    expect(releaseEscrow).toHaveBeenCalledWith({
      contractId: "CUSDCV1",
      tradeId,
      secretHex: "d".repeat(64),
    });
  });
});
