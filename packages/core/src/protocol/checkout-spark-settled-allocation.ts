import { calculateConduitCheckoutFeeSats } from "./checkout-spark-router-obligations"

const MAX_SAFE_SATS = BigInt(Number.MAX_SAFE_INTEGER)
const INBOUND_ALLOWANCE_NUMERATOR = 15n
const INBOUND_ALLOWANCE_DENOMINATOR = 10_000n

export interface CheckoutSparkAllocationWeights {
  readonly commerceWeightSats: number
  readonly conduitWeightSats: number
}

export interface CheckoutSparkSettledAllocation {
  readonly commerceAllocationSats: number
  readonly conduitAllocationSats: number
}

export type CheckoutSparkLightningLegCapacity =
  | { readonly state: "ready"; readonly maxFeeSats: number }
  | {
      readonly state: "pending"
      readonly reason:
        | "invoice_exhausts_allocation"
        | "fee_estimate_unavailable"
        | "estimated_fee_exceeds_allocation"
    }

/**
 * Calculate weights for the pre-funding signed plan. Freezing this JS object
 * does not itself authorize the economics; the caller must bind the weights,
 * funding gross, recipients, and rounding rule to that plan.
 */
export function calculateCheckoutSparkAllocationWeights(
  commerceTotalSats: number
): CheckoutSparkAllocationWeights {
  const conduitWeightSats = calculateConduitCheckoutFeeSats(commerceTotalSats)
  if (BigInt(commerceTotalSats) + BigInt(conduitWeightSats) > MAX_SAFE_SATS) {
    throw new Error("Checkout Spark allocation weights are unsafe.")
  }
  return Object.freeze({
    commerceWeightSats: commerceTotalSats,
    conduitWeightSats,
  })
}

/** Include 0.15% of authorized commerce in the funding invoice. */
export function calculateCheckoutSparkInboundNetworkAllowanceSats(
  commerceTotalSats: number
): number {
  if (!Number.isSafeInteger(commerceTotalSats) || commerceTotalSats <= 0) {
    throw new Error("Checkout Spark inbound allowance base is invalid.")
  }
  return Number(
    (BigInt(commerceTotalSats) * INBOUND_ALLOWANCE_NUMERATOR +
      INBOUND_ALLOWANCE_DENOMINATOR -
      1n) /
      INBOUND_ALLOWANCE_DENOMINATOR
  )
}

export function calculateCheckoutSparkSettledGrossFundingSats(
  commerceTotalSats: number
): number {
  const weights = calculateCheckoutSparkAllocationWeights(commerceTotalSats)
  const gross =
    BigInt(weights.commerceWeightSats) +
    BigInt(weights.conduitWeightSats) +
    BigInt(calculateCheckoutSparkInboundNetworkAllowanceSats(commerceTotalSats))
  if (gross * 1_000n > MAX_SAFE_SATS) {
    throw new Error("Checkout Spark gross funding is unsafe.")
  }
  return Number(gross)
}

/** Buyer-facing totals only; recipient allocations remain in the signed plan. */
export interface CheckoutSparkBuyerPrice {
  readonly itemSubtotalSats: number
  readonly shippingSubtotalSats: number
  readonly commerceTotalSats: number
  readonly conduitFeeSats: number
  readonly networkAllowanceSats: number
  readonly coordinationFeeSats: number
  readonly totalSats: number
  readonly minimumApplies: boolean
}

/** Estimate the existing router funding policy once per order, not per item. */
export function calculateCheckoutSparkBuyerPrice(input: {
  itemSubtotalSats: number
  shippingSubtotalSats: number
}): CheckoutSparkBuyerPrice {
  const { itemSubtotalSats, shippingSubtotalSats } = input
  if (
    !Number.isSafeInteger(itemSubtotalSats) ||
    itemSubtotalSats < 0 ||
    !Number.isSafeInteger(shippingSubtotalSats) ||
    shippingSubtotalSats < 0 ||
    BigInt(itemSubtotalSats) + BigInt(shippingSubtotalSats) > MAX_SAFE_SATS
  ) {
    throw new Error("Checkout Spark buyer price is invalid.")
  }
  const commerceTotalSats = itemSubtotalSats + shippingSubtotalSats
  const totalSats =
    commerceTotalSats === 0
      ? 0
      : calculateCheckoutSparkSettledGrossFundingSats(commerceTotalSats)
  const conduitFeeSats =
    commerceTotalSats === 0
      ? 0
      : calculateConduitCheckoutFeeSats(commerceTotalSats)
  return Object.freeze({
    itemSubtotalSats,
    shippingSubtotalSats,
    commerceTotalSats,
    conduitFeeSats,
    networkAllowanceSats: totalSats - commerceTotalSats - conduitFeeSats,
    coordinationFeeSats: totalSats - commerceTotalSats,
    totalSats,
    minimumApplies: conduitFeeSats === calculateConduitCheckoutFeeSats(1),
  })
}

/**
 * Divide only the sats attributed to the exact completed inbound receive, not
 * the checkout wallet's aggregate balance. The caller must establish that
 * attribution from provider evidence; the frozen invoice gross is a separate
 * upper bound. Floor Conduit's proportional share and give the whole-sat
 * remainder to commerce. Historical short-funded projections remain readable
 * for exact reconciliation, but this arithmetic does not authorize a payout:
 * new credit admission and dispatch require the full frozen funding weights.
 */
export function allocateCheckoutSparkSettledSats(input: {
  settledSats: number
  fundingInvoiceGrossSats: number
  weights: CheckoutSparkAllocationWeights
}): CheckoutSparkSettledAllocation {
  const { settledSats, fundingInvoiceGrossSats, weights } = input
  if (
    !Number.isSafeInteger(settledSats) ||
    settledSats <= 0 ||
    !Number.isSafeInteger(fundingInvoiceGrossSats) ||
    fundingInvoiceGrossSats <= 0 ||
    settledSats > fundingInvoiceGrossSats
  ) {
    throw new Error("Checkout Spark settled amount is invalid.")
  }
  if (
    !weights ||
    !Number.isSafeInteger(weights.commerceWeightSats) ||
    weights.commerceWeightSats <= 0 ||
    !Number.isSafeInteger(weights.conduitWeightSats) ||
    weights.conduitWeightSats !==
      calculateConduitCheckoutFeeSats(weights.commerceWeightSats)
  ) {
    throw new Error("Checkout Spark allocation weights are invalid.")
  }
  const totalWeight =
    BigInt(weights.commerceWeightSats) + BigInt(weights.conduitWeightSats)
  if (totalWeight > MAX_SAFE_SATS) {
    throw new Error("Checkout Spark allocation weights are unsafe.")
  }
  if (BigInt(fundingInvoiceGrossSats) < totalWeight) {
    throw new Error("Checkout Spark funding invoice is below frozen weights.")
  }
  const conduitAllocationSats = Number(
    (BigInt(settledSats) * BigInt(weights.conduitWeightSats)) / totalWeight
  )
  return Object.freeze({
    commerceAllocationSats: settledSats - conduitAllocationSats,
    conduitAllocationSats,
  })
}

/**
 * A fixed Lightning invoice and its estimated aggregate send fee must fit
 * entirely within this recipient's settled allocation. The resulting budget
 * is a pre-send limit, not proof that Spark will honor it on final settlement;
 * the adapter must verify provider behavior before enabling a live payout.
 */
export function assessCheckoutSparkLightningLegCapacity(input: {
  allocationSats: number
  invoiceAmountSats: number
  estimatedFeeSats: number | null
}): CheckoutSparkLightningLegCapacity {
  const { allocationSats, invoiceAmountSats, estimatedFeeSats } = input
  if (
    !Number.isSafeInteger(allocationSats) ||
    allocationSats < 0 ||
    !Number.isSafeInteger(invoiceAmountSats) ||
    invoiceAmountSats <= 0 ||
    (estimatedFeeSats !== null &&
      (!Number.isSafeInteger(estimatedFeeSats) || estimatedFeeSats < 0))
  ) {
    throw new Error("Checkout Spark Lightning leg capacity is invalid.")
  }
  if (invoiceAmountSats >= allocationSats) {
    return { state: "pending", reason: "invoice_exhausts_allocation" }
  }
  if (estimatedFeeSats === null) {
    return { state: "pending", reason: "fee_estimate_unavailable" }
  }
  const maxFeeSats = allocationSats - invoiceAmountSats
  if (estimatedFeeSats > maxFeeSats) {
    return { state: "pending", reason: "estimated_fee_exceeds_allocation" }
  }
  return { state: "ready", maxFeeSats }
}
