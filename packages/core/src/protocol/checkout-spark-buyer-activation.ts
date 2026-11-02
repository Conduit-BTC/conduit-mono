import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import type { CheckoutSparkSettledPlan } from "./checkout-spark-settled-router"

/** New checkout terms defer the finite Buyer window until its first Pay action. */
export interface CheckoutSparkPayActivationTiming {
  readonly type: "pay_activation_v1"
  readonly windowMs: 120_000
}

/**
 * This is format/binding validation, not authentication. Consumers may introduce
 * a marker only from the bound Buyer's authenticated recovery progress; an
 * actor's own progress cannot introduce or replace the original Buyer marker.
 */
export function createCheckoutSparkBuyerActivation(
  plan: CheckoutSparkSettledPlan,
  input: { buyerPubkey: string; activatedAt: number }
): CheckoutSparkBuyerActivation {
  if (plan.schemaVersion !== 6) {
    throw new Error(
      "Checkout Spark historical terms do not use Buyer activation."
    )
  }
  const timing = restoreCheckoutSparkPayActivationTiming(plan.executionTiming)
  const takeoverAt = input.activatedAt + timing.windowMs
  if (
    !/^[0-9a-f]{64}$/.test(input.buyerPubkey) ||
    !Number.isSafeInteger(input.activatedAt) ||
    input.activatedAt < plan.createdAt ||
    input.activatedAt >= plan.funding.expiresAt ||
    !Number.isSafeInteger(takeoverAt)
  ) {
    throw new Error("Checkout Spark Buyer activation terms are invalid.")
  }
  const activationId = bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          "conduit:checkout-spark-buyer-activation:v1",
          plan.checkoutId,
          plan.orderId,
          plan.planDigest,
          plan.walletId,
          plan.network,
          plan.funding.requestId,
          plan.funding.paymentHash,
          input.buyerPubkey,
          input.activatedAt,
          takeoverAt,
        ])
      )
    )
  )
  return Object.freeze({
    schemaVersion: 1,
    activationId,
    buyerPubkey: input.buyerPubkey,
    activatedAt: input.activatedAt,
    takeoverAt,
  })
}

export function restoreCheckoutSparkBuyerActivation(
  plan: CheckoutSparkSettledPlan,
  value: CheckoutSparkBuyerActivation
): CheckoutSparkBuyerActivation {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 5 ||
    value.schemaVersion !== 1
  ) {
    throw new Error("Checkout Spark Buyer activation record is invalid.")
  }
  const canonical = createCheckoutSparkBuyerActivation(plan, value)
  if (
    value.activationId !== canonical.activationId ||
    value.takeoverAt !== canonical.takeoverAt
  ) {
    throw new Error("Checkout Spark Buyer activation binding is invalid.")
  }
  return canonical
}

/** Null means not activated, never permission for either actor to dispatch. */
export function getCheckoutSparkBuyerTakeoverAt(
  plan: CheckoutSparkSettledPlan,
  activation?: CheckoutSparkBuyerActivation | null
): number | null {
  if (plan.schemaVersion !== 6) {
    if (activation !== undefined && activation !== null) {
      throw new Error("Checkout Spark historical Buyer deadline is immutable.")
    }
    return plan.takeoverAt
  }
  return activation
    ? restoreCheckoutSparkBuyerActivation(plan, activation).takeoverAt
    : null
}

/** Authenticated Buyer progress binds this once-only marker to its frozen plan. */
export interface CheckoutSparkBuyerActivation {
  readonly schemaVersion: 1
  readonly activationId: string
  readonly buyerPubkey: string
  readonly activatedAt: number
  readonly takeoverAt: number
}

export function restoreCheckoutSparkPayActivationTiming(
  value: CheckoutSparkPayActivationTiming
): CheckoutSparkPayActivationTiming {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 2 ||
    value.type !== "pay_activation_v1" ||
    value.windowMs !== 120_000
  ) {
    throw new Error("Checkout Spark Pay activation policy is invalid.")
  }
  return Object.freeze({ type: "pay_activation_v1", windowMs: 120_000 })
}
