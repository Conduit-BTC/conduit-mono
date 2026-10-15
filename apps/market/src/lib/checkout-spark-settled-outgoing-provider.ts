import {
  CheckoutSparkInvoiceOriginUnavailableError,
  checkoutSparkSettledOutgoingStatusObservation,
  classifyCheckoutSparkSettledExactOutgoingHistory,
  requireCheckoutSparkSettledExactOutgoingRequest,
  type CheckoutSparkSettledOutgoingProvider,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledPlan,
} from "@conduit/core"

import type {
  SparkLightningSendAttempt,
  SparkWalletManager,
} from "./spark-wallet"

type SparkOutgoingManager = Pick<
  SparkWalletManager,
  | "reconcileInvoiceAttempt"
  | "preflightCheckoutLightningObligation"
  | "sendCheckoutLightningObligation"
  | "getFundsState"
>

class CheckoutSparkReserveUnavailableError extends Error {}

async function checkUnpaidReserve(
  manager: SparkOutgoingManager,
  target: CheckoutSparkSettledOutgoingTarget
): Promise<"ready" | "unavailable" | "insufficient_funds"> {
  let availableSats: number
  try {
    availableSats = (await manager.getFundsState(target.walletId)).availableSats
  } catch {
    return "unavailable"
  }
  if (!Number.isSafeInteger(availableSats) || availableSats < 0) {
    return "unavailable"
  }
  return availableSats < target.unpaidAllocationSats
    ? "insufficient_funds"
    : "ready"
}

/**
 * Map the pinned Spark SDK's exact transfer-ID history to the v3 settled leg.
 * The manager checks the provider transfer total equals invoice + actual fee;
 * this adapter additionally requires the exact invoice preimage and bound fee.
 */
export function createCheckoutSparkSettledOutgoingProvider(input: {
  plan: CheckoutSparkSettledPlan
  manager: SparkOutgoingManager
  assertBeforeSend: (
    target: CheckoutSparkSettledOutgoingTarget
  ) => Promise<void>
}): CheckoutSparkSettledOutgoingProvider {
  const { plan, manager, assertBeforeSend } = input
  return {
    async reconcile(target) {
      const request = requireCheckoutSparkSettledExactOutgoingRequest(
        plan,
        target
      )
      const attempt: SparkLightningSendAttempt = {
        schemaVersion: 1,
        walletId: plan.walletId,
        network: plan.network,
        transferId: request.transferId,
        paymentRequest: request.paymentRequest,
        amountSats: request.amountSats,
        maxFeeSats: request.maxFeeSats,
        createdAt: target.intent.preparedAt,
      }
      const result = await manager.reconcileInvoiceAttempt(
        plan.walletId,
        attempt
      )
      return classifyCheckoutSparkSettledExactOutgoingHistory(target, result)
    },
    async preflight(target) {
      const request = requireCheckoutSparkSettledExactOutgoingRequest(
        plan,
        target
      )
      try {
        await assertBeforeSend(target)
      } catch (error) {
        if (error instanceof CheckoutSparkInvoiceOriginUnavailableError) {
          return "recipient_unverified"
        }
        throw error
      }
      // The exact inbound credit attributes this checkout's sats, but is not
      // proof they are still spendable. Reserve every unpaid sibling share.
      // A stale, unavailable, or depleted wallet must not borrow from it.
      const reserve = await checkUnpaidReserve(manager, target)
      if (reserve !== "ready") return reserve
      return manager.preflightCheckoutLightningObligation(
        plan.walletId,
        request
      )
    },
    async send(target) {
      const request = requireCheckoutSparkSettledExactOutgoingRequest(
        plan,
        target
      )
      let result: Awaited<
        ReturnType<SparkOutgoingManager["sendCheckoutLightningObligation"]>
      >
      try {
        result = await manager.sendCheckoutLightningObligation(plan.walletId, {
          ...request,
          assertBeforeSend: async () => {
            await assertBeforeSend(target)
            // Exact-history and fee reads happen after preflight. Re-read
            // spendable sats at the final app-owned pre-send boundary so a
            // newly depleted sibling share cannot authorize this leg.
            if ((await checkUnpaidReserve(manager, target)) !== "ready") {
              throw new CheckoutSparkReserveUnavailableError()
            }
            await assertBeforeSend(target)
          },
        })
      } catch (error) {
        // The pinned adapter invokes the guard before Spark's send call.
        // Only this exact pre-send rejection is known not to have moved funds.
        if (
          error instanceof CheckoutSparkReserveUnavailableError ||
          error instanceof CheckoutSparkInvoiceOriginUnavailableError
        ) {
          return { status: "not_sent" }
        }
        throw error
      }
      if (result.status === "not_sent") return { status: "not_sent" }
      // The immediate send result is not the receipt. Only the independent
      // exact transfer readback carries the provider-verified final debit.
      const exact = await this.reconcile(target)
      return exact.status === "not_found"
        ? checkoutSparkSettledOutgoingStatusObservation(target, "pending")
        : exact
    },
  }
}
