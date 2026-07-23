import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  buildLockEscrowTransaction,
  lockEscrow,
  NETWORK_PASSPHRASE,
} from "../lib/stellar.js";
import { RpcTimeoutError } from "../lib/rpc-errors.js";
import { randomHex32 } from "../lib/crypto.js";
import { getCashRequest, saveCashRequest } from "../lib/store.js";
import { parseBody } from "../lib/validation.js";
import { t } from "../lib/i18n.js";
import { issueChatCapability } from "../lib/chat-capability.js";
import { registerTradeForChat } from "../lib/chat-infrastructure.js";
import {
  getEscrowDeployments,
  networkFromEnvironment,
  resolveEscrowDeployment,
  UnsupportedSettlementAssetError,
} from "../lib/escrow-registry.js";

const DEFAULT_TIMEOUT_LEDGERS = 100;

const routedRequestSchema = z.object({
  seller: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
  buyer: z.string().trim().min(1).regex(/^G[1-9A-HJ-NP-Za-km-z]{55}$/),
  amount_stroops: z.string().trim().min(1).regex(/^\d+$/),
  secret_hash: z.string().trim().length(64).regex(/^[0-9a-fA-F]+$/),
  mode: z.enum(["custodial", "non_custodial"]).default("custodial"),
  notification_type: z.enum(["email", "sms", "none"]).optional(),
  contact_info: z.string().optional(),
});

function publicDeployment(
  deployment: ReturnType<typeof resolveEscrowDeployment>,
) {
  return {
    deployment_id: deployment.deploymentId,
    contract_id: deployment.contractId,
    settlement_asset: deployment.settlementAsset,
    version: deployment.version,
  };
}

/**
 * Version-aware escrow routes. Existing `/cash/request/prepare` remains the
 * backwards-compatible default-asset route; clients that select an asset use
 * `/cash/request/prepare/:settlementAsset`.
 */
export async function cashRoutingRoutes(app: FastifyInstance) {
  app.get("/cash/escrow-contracts", async () => {
    const deployments = getEscrowDeployments();
    return {
      network: networkFromEnvironment(),
      default_settlement_asset:
        process.env.ESCROW_DEFAULT_SETTLEMENT_ASSET ?? "USDC",
      deployments: deployments.map((deployment) => ({
        ...publicDeployment(deployment),
        status: deployment.status,
        activated_at: deployment.activatedAt,
        replaces: deployment.replaces,
      })),
    };
  });

  app.post<{
    Params: { settlementAsset: string };
    Body: z.infer<typeof routedRequestSchema>;
  }>(
    "/cash/request/prepare/:settlementAsset",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const paid = await (app as any).requirePayment(req, reply, "0.01");
      if (!paid) return;

      const body = parseBody(routedRequestSchema, req.body, reply);
      if (!body) return;

      const {
        seller,
        buyer,
        amount_stroops,
        secret_hash,
        mode,
        notification_type,
        contact_info,
      } = body;

      if (notification_type && notification_type !== "none") {
        if (!contact_info) {
          reply.code(400).send({
            error:
              "contact_info is required when notification_type is specified",
          });
          return;
        }
        if (
          notification_type === "email" &&
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_info)
        ) {
          reply.code(400).send({ error: "Invalid email address format" });
          return;
        }
        if (
          notification_type === "sms" &&
          !/^\+?[1-9]\d{5,14}$/.test(contact_info)
        ) {
          reply.code(400).send({ error: "Invalid phone number format" });
          return;
        }
      }

      let deployment: ReturnType<typeof resolveEscrowDeployment>;
      try {
        deployment = resolveEscrowDeployment(req.params.settlementAsset);
      } catch (error) {
        if (error instanceof UnsupportedSettlementAssetError) {
          reply.code(400).send({
            error: "unsupported_settlement_asset",
            settlement_asset: error.settlementAsset,
            supported_assets: error.supportedAssets,
          });
          return;
        }
        throw error;
      }

      const tradeId = randomHex32();
      const qrPayload =
        `velo://claim?request_id=${tradeId}` +
        `&contract=${deployment.contractId}` +
        `&asset=${encodeURIComponent(deployment.settlementAsset)}` +
        `&version=${deployment.version}`;
      const baseUrl =
        process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
      const locale = (req as any).locale ?? "en";

      if (mode === "custodial") {
        let lockedAtLedger: number;
        try {
          lockedAtLedger = await lockEscrow({
            contractId: deployment.contractId,
            tradeId,
            seller,
            buyer,
            amountStroops: BigInt(amount_stroops),
            secretHashHex: secret_hash,
            timeoutLedgers: DEFAULT_TIMEOUT_LEDGERS,
          });
        } catch (error) {
          req.log.error(error, "routed lockEscrow failed");
          if (error instanceof RpcTimeoutError) {
            reply.code(504).send({
              error: "rpc_timeout",
              detail: error.message,
              operation: error.operation,
              elapsed_ms: error.elapsedMs,
            });
          } else {
            reply.code(502).send({
              error: "escrow lock failed",
              detail: String(error),
            });
          }
          return;
        }

        saveCashRequest({
          id: tradeId,
          contractId: deployment.contractId,
          escrowDeploymentId: deployment.deploymentId,
          settlementAsset: deployment.settlementAsset,
          contractVersion: deployment.version,
          seller,
          buyer,
          amountStroops: amount_stroops,
          secretHex: "",
          secretHashHex: secret_hash,
          qrPayload,
          status: "locked",
          timeoutLedger: lockedAtLedger + DEFAULT_TIMEOUT_LEDGERS,
          createdAt: new Date().toISOString(),
          notificationType: notification_type,
          contactInfo: contact_info,
        });
        await registerTradeForChat(getCashRequest(tradeId)!);

        reply.code(201).send({
          request_id: tradeId,
          claim_url: `${baseUrl}/claim/${tradeId}`,
          chat_token: issueChatCapability(tradeId, buyer),
          qr_payload: qrPayload,
          escrow: publicDeployment(deployment),
          instructions: t(locale, "instructions.showQR"),
        });
        return;
      }

      try {
        const unsignedXdr = await buildLockEscrowTransaction({
          contractId: deployment.contractId,
          tradeId,
          seller,
          buyer,
          amountStroops: BigInt(amount_stroops),
          secretHashHex: secret_hash,
          timeoutLedgers: DEFAULT_TIMEOUT_LEDGERS,
          signerPublicKey: buyer,
        });

        saveCashRequest({
          id: tradeId,
          contractId: deployment.contractId,
          escrowDeploymentId: deployment.deploymentId,
          settlementAsset: deployment.settlementAsset,
          contractVersion: deployment.version,
          seller,
          buyer,
          amountStroops: amount_stroops,
          secretHex: "",
          secretHashHex: secret_hash,
          qrPayload,
          status: "pending_signature",
          createdAt: new Date().toISOString(),
          notificationType: notification_type,
          contactInfo: contact_info,
        });
        await registerTradeForChat(getCashRequest(tradeId)!);

        reply.code(201).send({
          request_id: tradeId,
          unsigned_xdr: unsignedXdr,
          network_passphrase: NETWORK_PASSPHRASE,
          submit_url: `/api/v1/cash/request/${tradeId}/submit`,
          claim_url: `${baseUrl}/claim/${tradeId}`,
          chat_token: issueChatCapability(tradeId, buyer),
          qr_payload: qrPayload,
          escrow: publicDeployment(deployment),
          instructions: t(locale, "instructions.signAndSubmit"),
        });
      } catch (error) {
        req.log.error(error, "routed buildLockEscrowTransaction failed");
        reply.code(502).send({
          error: "failed to build transaction",
          detail: String(error),
        });
      }
    },
  );
}
