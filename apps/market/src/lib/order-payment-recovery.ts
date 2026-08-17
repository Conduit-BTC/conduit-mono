import {
  isLegacyInterruptedOrderPayment,
  reconcileInterruptedOrderPayment,
  reconcileLegacyInterruptedOrderPayment,
  type OrderLifecycle,
} from "@conduit/core"

import { isOrderPaymentRunning } from "./order-payment-service"
import {
  clearOrderPaymentClaim,
  readOrderPaymentClaim,
} from "./order-payment-session"

export interface OrderPaymentRecoveryDependencies {
  readOrderPaymentClaim: typeof readOrderPaymentClaim
  clearOrderPaymentClaim: typeof clearOrderPaymentClaim
  isOrderPaymentRunning: typeof isOrderPaymentRunning
  reconcileInterruptedOrderPayment: typeof reconcileInterruptedOrderPayment
  reconcileLegacyInterruptedOrderPayment: typeof reconcileLegacyInterruptedOrderPayment
}

const defaultDependencies: OrderPaymentRecoveryDependencies = {
  readOrderPaymentClaim,
  clearOrderPaymentClaim,
  isOrderPaymentRunning,
  reconcileInterruptedOrderPayment,
  reconcileLegacyInterruptedOrderPayment,
}

/**
 * Best-effort display recovery. A transient IndexedDB failure must not hide an
 * otherwise readable local order; the regular Orders refetch will retry it.
 */
export async function reconcileOrderPaymentForDisplay(
  lifecycle: OrderLifecycle,
  dependencyOverrides: Partial<OrderPaymentRecoveryDependencies> = {}
): Promise<OrderLifecycle> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides }
  try {
    const localClaimId = dependencies.readOrderPaymentClaim(lifecycle.orderId)
    if (localClaimId && lifecycle.paymentClaimId !== localClaimId) {
      dependencies.clearOrderPaymentClaim(lifecycle.orderId, localClaimId)
    }
    if (dependencies.isOrderPaymentRunning(lifecycle.orderId)) return lifecycle

    if (lifecycle.paymentClaimId) {
      const result = await dependencies.reconcileInterruptedOrderPayment(
        lifecycle.orderId,
        lifecycle.paymentClaimId
      )
      if (
        localClaimId === lifecycle.paymentClaimId &&
        result.status !== "claim_active" &&
        result.status !== "not_interrupted"
      ) {
        dependencies.clearOrderPaymentClaim(lifecycle.orderId, localClaimId)
      }
      return result.lifecycle ?? lifecycle
    }

    if (!isLegacyInterruptedOrderPayment(lifecycle)) return lifecycle

    const result = await dependencies.reconcileLegacyInterruptedOrderPayment(
      lifecycle.orderId
    )
    return result.lifecycle ?? lifecycle
  } catch {
    console.warn(
      "Payment recovery reconciliation failed; retrying on the next refresh."
    )
    return lifecycle
  }
}
