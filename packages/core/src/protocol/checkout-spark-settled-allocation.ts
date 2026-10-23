import {
  calculateConduitCheckoutFeeSats,
  type CheckoutSparkConduitFeePolicy,
} from "./checkout-spark-router-obligations"

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

export interface CheckoutSparkEventAllocationWeights extends CheckoutSparkAllocationWeights {
  readonly organizerWeightSats: number
}

export interface CheckoutSparkEventSettledAllocation extends CheckoutSparkSettledAllocation {
  readonly organizerAllocationSats: number
}

/** Event fees are additive, never part of the Conduit percentage base. */
export function calculateCheckoutSparkEventAllocationWeights(
  commerceTotalSats: number,
  organizerFeeSats: number,
  conduitFeePolicy?: CheckoutSparkConduitFeePolicy
): CheckoutSparkEventAllocationWeights {
  if (
    !Number.isSafeInteger(commerceTotalSats) ||
    commerceTotalSats < 0 ||
    !Number.isSafeInteger(organizerFeeSats) ||
    organizerFeeSats < 0 ||
    (commerceTotalSats === 0 && organizerFeeSats === 0)
  )
    throw new Error("Checkout Spark event allocation weights are invalid.")
  const conduitWeightSats = calculateConduitCheckoutFeeSats(
    conduitFeePolicy === undefined ? commerceTotalSats || 1 : commerceTotalSats,
    conduitFeePolicy
  )
  if (
    BigInt(commerceTotalSats) +
      BigInt(organizerFeeSats) +
      BigInt(conduitWeightSats) >
    MAX_SAFE_SATS
  )
    throw new Error("Checkout Spark event allocation weights are unsafe.")
  return Object.freeze({
    commerceWeightSats: commerceTotalSats,
    conduitWeightSats,
    organizerWeightSats: organizerFeeSats,
  })
}

export function calculateCheckoutSparkEventSettledGrossFundingSats(
  commerceTotalSats: number,
  organizerFeeSats: number,
  conduitFeePolicy?: CheckoutSparkConduitFeePolicy
): number {
  const weights = calculateCheckoutSparkEventAllocationWeights(
    commerceTotalSats,
    organizerFeeSats,
    conduitFeePolicy
  )
  const allowanceBase = commerceTotalSats + organizerFeeSats
  const gross =
    BigInt(allowanceBase) +
    BigInt(weights.conduitWeightSats) +
    BigInt(calculateCheckoutSparkInboundNetworkAllowanceSats(allowanceBase))
  if (gross * 1_000n > MAX_SAFE_SATS)
    throw new Error("Checkout Spark event gross funding is unsafe.")
  return Number(gross)
}

/** The signed organizer budget is exact; only the remaining credit uses C/D rounding. */
export function allocateCheckoutSparkEventSettledSats(input: {
  settledSats: number
  fundingInvoiceGrossSats: number
  weights: CheckoutSparkEventAllocationWeights
  conduitFeePolicy?: CheckoutSparkConduitFeePolicy
}): CheckoutSparkEventSettledAllocation {
  const { settledSats, fundingInvoiceGrossSats, weights, conduitFeePolicy } =
    input
  const expected = calculateCheckoutSparkEventAllocationWeights(
    weights.commerceWeightSats,
    weights.organizerWeightSats,
    conduitFeePolicy
  )
  if (
    expected.conduitWeightSats !== weights.conduitWeightSats ||
    !Number.isSafeInteger(settledSats) ||
    !Number.isSafeInteger(fundingInvoiceGrossSats) ||
    settledSats > fundingInvoiceGrossSats ||
    BigInt(settledSats) <
      BigInt(expected.commerceWeightSats) +
        BigInt(expected.conduitWeightSats) +
        BigInt(expected.organizerWeightSats) ||
    fundingInvoiceGrossSats !==
      calculateCheckoutSparkEventSettledGrossFundingSats(
        expected.commerceWeightSats,
        expected.organizerWeightSats,
        conduitFeePolicy
      )
  )
    throw new Error(
      "Checkout Spark event credit does not cover frozen obligations."
    )
  const remaining = settledSats - weights.organizerWeightSats
  const divided =
    weights.commerceWeightSats === 0
      ? { commerceAllocationSats: 0, conduitAllocationSats: remaining }
      : allocateCheckoutSparkSettledSats({
          settledSats: remaining,
          fundingInvoiceGrossSats:
            fundingInvoiceGrossSats - weights.organizerWeightSats,
          weights,
          conduitFeePolicy,
        })
  return Object.freeze({
    ...divided,
    organizerAllocationSats: weights.organizerWeightSats,
  })
}

/**
 * Calculate weights for the pre-funding signed plan. Freezing this JS object
 * does not itself authorize the economics; the caller must bind the weights,
 * funding gross, recipients, and rounding rule to that plan.
 */
export function calculateCheckoutSparkAllocationWeights(
  commerceTotalSats: number,
  conduitFeePolicy?: CheckoutSparkConduitFeePolicy
): CheckoutSparkAllocationWeights {
  if (!Number.isSafeInteger(commerceTotalSats) || commerceTotalSats <= 0)
    throw new Error("Checkout Spark allocation weights are invalid.")
  const conduitWeightSats = calculateConduitCheckoutFeeSats(
    commerceTotalSats,
    conduitFeePolicy
  )
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
  commerceTotalSats: number,
  conduitFeePolicy?: CheckoutSparkConduitFeePolicy
): number {
  const weights = calculateCheckoutSparkAllocationWeights(
    commerceTotalSats,
    conduitFeePolicy
  )
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

export interface CheckoutSparkEventBuyerPrice extends CheckoutSparkBuyerPrice {
  readonly organizerFeeSats: number
}

export function calculateCheckoutSparkEventBuyerPrice(input: {
  itemSubtotalSats: number
  shippingSubtotalSats: number
  organizerFeeSats: number
  conduitFeePolicy?: CheckoutSparkConduitFeePolicy
}): CheckoutSparkEventBuyerPrice {
  const ordinary = calculateCheckoutSparkBuyerPrice(input)
  if (ordinary.commerceTotalSats === 0 && input.organizerFeeSats === 0)
    return Object.freeze({ ...ordinary, organizerFeeSats: 0 })
  const weights = calculateCheckoutSparkEventAllocationWeights(
    ordinary.commerceTotalSats,
    input.organizerFeeSats,
    input.conduitFeePolicy
  )
  const totalSats = calculateCheckoutSparkEventSettledGrossFundingSats(
    ordinary.commerceTotalSats,
    input.organizerFeeSats,
    input.conduitFeePolicy
  )
  return Object.freeze({
    ...ordinary,
    organizerFeeSats: weights.organizerWeightSats,
    conduitFeeSats: weights.conduitWeightSats,
    networkAllowanceSats:
      totalSats -
      ordinary.commerceTotalSats -
      weights.conduitWeightSats -
      weights.organizerWeightSats,
    coordinationFeeSats:
      totalSats - ordinary.commerceTotalSats - weights.organizerWeightSats,
    totalSats,
    minimumApplies:
      input.conduitFeePolicy === undefined &&
      weights.conduitWeightSats === calculateConduitCheckoutFeeSats(1),
  })
}

/** Estimate the selected policy once per order; omission preserves historical totals. */
export function calculateCheckoutSparkBuyerPrice(input: {
  itemSubtotalSats: number
  shippingSubtotalSats: number
  conduitFeePolicy?: CheckoutSparkConduitFeePolicy
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
      : calculateCheckoutSparkSettledGrossFundingSats(
          commerceTotalSats,
          input.conduitFeePolicy
        )
  const conduitFeeSats =
    commerceTotalSats === 0 && input.conduitFeePolicy === undefined
      ? 0
      : calculateConduitCheckoutFeeSats(
          commerceTotalSats,
          input.conduitFeePolicy
        )
  return Object.freeze({
    itemSubtotalSats,
    shippingSubtotalSats,
    commerceTotalSats,
    conduitFeeSats,
    networkAllowanceSats: totalSats - commerceTotalSats - conduitFeeSats,
    coordinationFeeSats: totalSats - commerceTotalSats,
    totalSats,
    minimumApplies:
      input.conduitFeePolicy === undefined &&
      conduitFeeSats === calculateConduitCheckoutFeeSats(1),
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
  conduitFeePolicy?: CheckoutSparkConduitFeePolicy
}): CheckoutSparkSettledAllocation {
  const { settledSats, fundingInvoiceGrossSats, weights, conduitFeePolicy } =
    input
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
      calculateConduitCheckoutFeeSats(
        weights.commerceWeightSats,
        conduitFeePolicy
      )
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
