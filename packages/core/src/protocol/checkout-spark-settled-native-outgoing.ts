import { hasCheckoutSparkProviderSendWindow } from "./checkout-spark-invoice-expiry"
import { CheckoutSparkInvoiceOriginUnavailableError } from "./checkout-spark-lnurl-invoice"
import {
  checkoutSparkSettledOutgoingStatusObservation,
  requireCheckoutSparkSettledExactOutgoingRequest,
} from "./checkout-spark-settled-outgoing-history"
import type {
  CheckoutSparkSettledOutgoingObservation,
  CheckoutSparkSettledOutgoingProvider,
  CheckoutSparkSettledOutgoingTarget,
} from "./checkout-spark-settled-outgoing"
import type { CheckoutSparkSettledPlan } from "./checkout-spark-settled-router"

export interface CheckoutSparkSettledNativeOutgoingWallet {
  getAvailableSats(): Promise<bigint>
  estimateFee(input: { paymentRequest: string }): Promise<number>
  sendFrozen(input: {
    paymentRequest: string
    maxFeeSats: number
    transferId: string
  }): Promise<unknown>
}

type PreflightResult = Awaited<
  ReturnType<CheckoutSparkSettledOutgoingProvider["preflight"]>
>

/**
 * Actor-neutral provider for an already-open checkout wallet. The caller owns
 * wallet access, exact-ID history classification, and live actor/fencing
 * authority. Neither an SDK return value nor empty post-send history is a
 * payment receipt.
 */
export function createCheckoutSparkSettledNativeOutgoingProvider(input: {
  plan: CheckoutSparkSettledPlan
  wallet: CheckoutSparkSettledNativeOutgoingWallet
  reconcile(
    target: CheckoutSparkSettledOutgoingTarget
  ): Promise<CheckoutSparkSettledOutgoingObservation>
  assertBeforeSend(): void | Promise<void>
  now(): number
}): CheckoutSparkSettledOutgoingProvider {
  const exactRequest = (target: CheckoutSparkSettledOutgoingTarget) =>
    requireCheckoutSparkSettledExactOutgoingRequest(input.plan, target)

  const hasWindow = (paymentRequest: string) =>
    hasCheckoutSparkProviderSendWindow({
      paymentRequest,
      nowMs: input.now(),
    })

  const exactReconcile = async (target: CheckoutSparkSettledOutgoingTarget) => {
    exactRequest(target)
    const observation = await input.reconcile(target)
    if (
      observation.legId !== target.legId ||
      observation.transferId !== target.intent.transferId ||
      observation.paymentRequest !== target.intent.paymentRequest ||
      observation.paymentHash !== target.intent.paymentHash ||
      observation.invoiceAmountSats !== target.intent.invoiceAmountSats ||
      observation.maxFeeSats !== target.intent.maxFeeSats ||
      (observation.status === "paid" &&
        (!Number.isSafeInteger(observation.finalFeeSats) ||
          observation.finalFeeSats < 0 ||
          observation.finalFeeSats > target.intent.maxFeeSats ||
          !Number.isSafeInteger(observation.finalDebitSats) ||
          observation.finalDebitSats !==
            target.intent.invoiceAmountSats + observation.finalFeeSats ||
          observation.finalDebitSats > target.allocationSats))
    ) {
      return checkoutSparkSettledOutgoingStatusObservation(
        target,
        "conflicting_evidence"
      )
    }
    return observation
  }

  const assertSendAuthority = async (): Promise<
    "ready" | "recipient_unverified"
  > => {
    try {
      await input.assertBeforeSend()
      return "ready"
    } catch (error) {
      if (error instanceof CheckoutSparkInvoiceOriginUnavailableError)
        return "recipient_unverified"
      throw error
    }
  }

  const currentSafety = async (
    target: CheckoutSparkSettledOutgoingTarget,
    paymentRequest: string
  ): Promise<
    "ready" | "insufficient_funds" | "unavailable" | "recipient_unverified"
  > => {
    if ((await assertSendAuthority()) !== "ready") return "recipient_unverified"
    if (!hasWindow(paymentRequest)) return "unavailable"
    let availableSats: bigint
    try {
      availableSats = await input.wallet.getAvailableSats()
    } catch {
      return "unavailable"
    }
    if ((await assertSendAuthority()) !== "ready") return "recipient_unverified"
    if (
      !hasWindow(paymentRequest) ||
      typeof availableSats !== "bigint" ||
      availableSats < 0n
    ) {
      return "unavailable"
    }
    return availableSats < BigInt(target.unpaidAllocationSats)
      ? "insufficient_funds"
      : "ready"
  }

  const feeSafety = async (
    target: CheckoutSparkSettledOutgoingTarget,
    paymentRequest: string
  ): Promise<PreflightResult> => {
    let feeSats: number
    try {
      feeSats = await input.wallet.estimateFee({ paymentRequest })
    } catch {
      return "unavailable"
    }
    const safety = await currentSafety(target, paymentRequest)
    if (safety !== "ready") return safety
    if (!Number.isSafeInteger(feeSats) || feeSats < 0) return "unavailable"
    return feeSats > target.intent.maxFeeSats ? "fee_over_cap" : "ready"
  }

  return {
    reconcile: exactReconcile,
    async preflight(target) {
      const request = exactRequest(target)
      const safety = await currentSafety(target, request.paymentRequest)
      if (safety !== "ready") return safety
      return feeSafety(target, request.paymentRequest)
    },
    async send(target) {
      const request = exactRequest(target)
      // The runner already inspected history before persisting its submitted
      // marker. Re-read the exact transfer close to the irreversible call.
      let before: CheckoutSparkSettledOutgoingObservation
      try {
        before = await exactReconcile(target)
      } catch {
        return checkoutSparkSettledOutgoingStatusObservation(
          target,
          "lookup_unavailable"
        )
      }
      if (before.status !== "not_found") return before
      const safety = await currentSafety(target, request.paymentRequest)
      if (safety !== "ready") return { status: "not_sent" }
      const fee = await feeSafety(target, request.paymentRequest)
      if (fee !== "ready") return { status: "not_sent" }
      // Fee/balance reads can be slow; do not rely on the earlier absence.
      try {
        before = await exactReconcile(target)
      } catch {
        return checkoutSparkSettledOutgoingStatusObservation(
          target,
          "lookup_unavailable"
        )
      }
      if (before.status !== "not_found") return before
      const finalSafety = await currentSafety(target, request.paymentRequest)
      if (finalSafety !== "ready") return { status: "not_sent" }

      try {
        await input.wallet.sendFrozen({
          paymentRequest: request.paymentRequest,
          maxFeeSats: request.maxFeeSats,
          transferId: request.transferId,
        })
      } catch {
        // A thrown provider call may have published the payment. Only exact
        // history can settle it, and an absent read must remain possible-send.
      }
      try {
        const after = await exactReconcile(target)
        return after.status === "not_found"
          ? checkoutSparkSettledOutgoingStatusObservation(target, "pending")
          : after
      } catch {
        return checkoutSparkSettledOutgoingStatusObservation(target, "pending")
      }
    },
  }
}
