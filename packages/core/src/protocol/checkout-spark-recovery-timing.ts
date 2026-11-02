import {
  getCheckoutSparkBuyerTakeoverAt,
  type CheckoutSparkBuyerActivation,
} from "./checkout-spark-buyer-activation"
import type { CheckoutSparkPlan } from "./checkout-spark-reconciliation"
import type { CheckoutSparkSettledPlan } from "./checkout-spark-settled-router"

/** Private discovery hints only. Opening the authenticated source is mandatory. */
export type CheckoutSparkRecoveryTiming =
  | {
      executionTiming?: never
      buyerActivationId?: never
      takeoverAt: number
    }
  | {
      executionTiming: "pay_activation_v1"
      buyerActivationId: null
      takeoverAt: null
    }
  | {
      executionTiming: "pay_activation_v1"
      buyerActivationId: string
      takeoverAt: number
    }

export function checkoutSparkRecoveryTiming(
  plan: CheckoutSparkPlan | CheckoutSparkSettledPlan,
  activation?: CheckoutSparkBuyerActivation | null
): CheckoutSparkRecoveryTiming {
  if (plan.schemaVersion !== 6) {
    if (activation != null)
      throw new Error("Historical recovery timing cannot contain activation.")
    return { takeoverAt: plan.takeoverAt }
  }
  const takeoverAt = getCheckoutSparkBuyerTakeoverAt(plan, activation)
  return takeoverAt === null
    ? {
        executionTiming: "pay_activation_v1",
        buyerActivationId: null,
        takeoverAt: null,
      }
    : {
        executionTiming: "pay_activation_v1",
        buyerActivationId: activation!.activationId,
        takeoverAt,
      }
}

/** Pin a selection before async work; never accept a half-activated descriptor. */
export function restoreCheckoutSparkRecoveryTiming(value: {
  executionTiming?: unknown
  buyerActivationId?: unknown
  takeoverAt: unknown
}): CheckoutSparkRecoveryTiming {
  if (value.executionTiming === "pay_activation_v1") {
    if (value.buyerActivationId === null && value.takeoverAt === null)
      return {
        executionTiming: "pay_activation_v1",
        buyerActivationId: null,
        takeoverAt: null,
      }
    if (
      typeof value.buyerActivationId === "string" &&
      /^[0-9a-f]{64}$/.test(value.buyerActivationId) &&
      typeof value.takeoverAt === "number" &&
      Number.isSafeInteger(value.takeoverAt) &&
      value.takeoverAt > 0
    )
      return {
        executionTiming: "pay_activation_v1",
        buyerActivationId: value.buyerActivationId,
        takeoverAt: value.takeoverAt,
      }
  } else if (
    value.executionTiming === undefined &&
    value.buyerActivationId === undefined &&
    typeof value.takeoverAt === "number" &&
    Number.isSafeInteger(value.takeoverAt) &&
    value.takeoverAt >= 0
  ) {
    return { takeoverAt: value.takeoverAt }
  }
  throw new Error("Checkout recovery timing selection is invalid.")
}

export function checkoutSparkRecoveryTimingMatches(
  left: CheckoutSparkRecoveryTiming,
  right: CheckoutSparkRecoveryTiming
): boolean {
  return (
    left.executionTiming === right.executionTiming &&
    left.buyerActivationId === right.buyerActivationId &&
    left.takeoverAt === right.takeoverAt
  )
}

/** Active deadlines first; inactive preparation never masquerades as overdue. */
export function compareCheckoutSparkRecoveryTiming(
  left: CheckoutSparkRecoveryTiming,
  right: CheckoutSparkRecoveryTiming
): number {
  if (left.takeoverAt === null) return right.takeoverAt === null ? 0 : 1
  if (right.takeoverAt === null) return -1
  return left.takeoverAt - right.takeoverAt
}
