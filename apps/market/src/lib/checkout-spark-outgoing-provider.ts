import {
  decodeLightningInvoicePaymentHash,
  type CheckoutSparkOutgoingObservation,
  type CheckoutSparkOutgoingProvider,
  type CheckoutSparkOutgoingTarget,
  type CheckoutSparkPlan,
} from "@conduit/core"

import type {
  SparkCheckoutLightningObligationInput,
  SparkLightningSendAttempt,
  SparkSdkPayment,
  SparkWalletManager,
} from "./spark-wallet"

type SparkOutgoingManager = Pick<
  SparkWalletManager,
  | "reconcileInvoiceAttempt"
  | "preflightCheckoutLightningObligation"
  | "sendCheckoutLightningObligation"
>

function exactRequest(
  plan: CheckoutSparkPlan,
  target: CheckoutSparkOutgoingTarget
): SparkCheckoutLightningObligationInput {
  const expected = plan.obligations[target.obligation.position]
  if (
    plan.schemaVersion !== 2 ||
    target.walletId !== plan.walletId ||
    target.network !== plan.network ||
    !expected ||
    target.idempotencyKey !== expected.outgoingId ||
    target.obligation.obligationId !== expected.obligationId ||
    target.obligation.outgoingId !== expected.outgoingId ||
    target.obligation.position !== expected.position ||
    target.obligation.kind !== expected.kind ||
    target.obligation.recipientId !== expected.recipientId ||
    target.obligation.paymentRequest !== expected.paymentRequest ||
    target.obligation.amountSats !== expected.amountSats ||
    target.obligation.maxFeeSats !== expected.maxFeeSats
  ) {
    throw new Error(
      "Checkout Spark outgoing target differs from its frozen plan."
    )
  }
  return {
    network: plan.network,
    transferId: expected.outgoingId,
    paymentRequest: expected.paymentRequest,
    amountSats: expected.amountSats,
    maxFeeSats: expected.maxFeeSats,
  }
}

function observation(
  target: CheckoutSparkOutgoingTarget,
  state: CheckoutSparkOutgoingObservation["state"]
): CheckoutSparkOutgoingObservation {
  return {
    obligationId: target.obligation.obligationId,
    outgoingId: target.idempotencyKey,
    paymentRequest: target.obligation.paymentRequest,
    amountSats: target.obligation.amountSats,
    maxFeeSats: target.obligation.maxFeeSats,
    state,
  }
}

async function resolvedPaymentState(
  payment: SparkSdkPayment,
  request: SparkCheckoutLightningObligationInput
): Promise<CheckoutSparkOutgoingObservation["state"]> {
  if (
    payment.details?.type !== "lightning" ||
    typeof payment.fees !== "bigint" ||
    payment.fees < 0n ||
    payment.fees > BigInt(request.maxFeeSats)
  ) {
    return "conflicting_evidence"
  }
  if (payment.status === "completed") {
    const htlc = payment.details.htlcDetails
    const expectedHash = decodeLightningInvoicePaymentHash(
      request.paymentRequest
    )
    const preimageHex = htlc?.preimage
    if (
      !expectedHash ||
      !htlc ||
      !preimageHex ||
      !/^[0-9a-f]{64}$/i.test(preimageHex) ||
      htlc.paymentHash?.toLowerCase() !== expectedHash.toLowerCase() ||
      !globalThis.crypto?.subtle
    ) {
      return "conflicting_evidence"
    }
    const preimage = Uint8Array.from(preimageHex.match(/.{2}/g)!, (byte) =>
      Number.parseInt(byte, 16)
    )
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", preimage)
    )
    const digestHex = Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
    return digestHex === expectedHash.toLowerCase()
      ? "paid"
      : "conflicting_evidence"
  }
  if (payment.status === "pending") return "pending"
  if (payment.status === "failed") return "terminal_failure"
  return "conflicting_evidence"
}

/**
 * Adapt Spark's exact transfer-ID history to the actor-neutral one-leg runner.
 * This adapter never generates an invoice, replaces a transfer ID, or treats an
 * empty/failed history read as proof that a prior send did not happen.
 */
export function createCheckoutSparkOutgoingProvider(input: {
  plan: CheckoutSparkPlan
  manager: SparkOutgoingManager
}): CheckoutSparkOutgoingProvider {
  const { plan, manager } = input
  return {
    async reconcile(target) {
      const request = exactRequest(plan, target)
      const attempt: SparkLightningSendAttempt = {
        schemaVersion: 1,
        walletId: plan.walletId,
        network: plan.network,
        transferId: request.transferId,
        paymentRequest: request.paymentRequest,
        amountSats: request.amountSats,
        maxFeeSats: request.maxFeeSats,
        createdAt: plan.createdAt,
      }
      const result = await manager.reconcileInvoiceAttempt(
        plan.walletId,
        attempt
      )
      if (result.status === "not_found") {
        return observation(target, "not_found")
      }
      if (result.status === "lookup_unavailable") {
        return observation(target, "lookup_unavailable")
      }
      if (result.status === "conflicting_evidence") {
        return observation(target, "conflicting_evidence")
      }
      return observation(
        target,
        await resolvedPaymentState(result.payment, request)
      )
    },
    async preflight(target) {
      const request = exactRequest(plan, target)
      return manager.preflightCheckoutLightningObligation(
        plan.walletId,
        request
      )
    },
    async send(target) {
      const request = exactRequest(plan, target)
      const result = await manager.sendCheckoutLightningObligation(
        plan.walletId,
        request
      )
      if (result.status === "not_sent") return result
      if (result.status === "ambiguous") {
        return observation(target, "ambiguous")
      }
      const state = await resolvedPaymentState(result.payment, request)
      return observation(
        target,
        result.status === "paid" && state !== "paid"
          ? "conflicting_evidence"
          : result.status === "terminal_failure" && state !== "terminal_failure"
            ? "conflicting_evidence"
            : state
      )
    },
  }
}
