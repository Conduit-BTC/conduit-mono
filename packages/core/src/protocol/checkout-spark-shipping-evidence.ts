import type { CheckoutSparkCommerceQuote } from "./checkout-spark-reconciliation"
import {
  isSatsLikeCurrency,
  isPricingRateQuoteFresh,
  canonicalizeShippingCost,
  getShippingCostSats,
} from "../pricing"
import { parseCheckoutSparkSignedProductFields } from "./checkout-spark-product-fields"
import {
  parseShippingOptionFieldsForPrivateOrder,
  resolveProductFulfillment,
  type ParsedShippingOption,
} from "./shipping"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import {
  assertCheckoutSparkCommerceProductPrice,
  freezeCheckoutSparkCommercePricing,
  hasSameCheckoutSparkSourcePrice,
  type CheckoutSparkCommercePricing,
} from "./checkout-spark-commerce-pricing"
import {
  convertShippingMinor,
  hasSameShippingPolicyQuote,
  shippingPolicyQuoteSchema,
  type ShippingPolicyQuote,
} from "./shipping-policy"

/** One canonical whole-line allocation rule used by pricing and signed quote proof. */
export function allocateCheckoutSparkShippingPolicySats(
  quote: ShippingPolicyQuote
): ReadonlyMap<string, number> {
  const amount =
    quote.amountSats ??
    convertShippingMinor(quote.amountMinor, quote.currency, "SATS")
  const totalQuantity = quote.items.reduce(
    (sum, item) => sum + item.quantity,
    0
  )
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    !Number.isSafeInteger(totalQuantity) ||
    totalQuantity <= 0 ||
    quote.items.some(
      (item) => !Number.isSafeInteger(item.quantity) || item.quantity <= 0
    )
  )
    unavailable()
  const ordered = [...quote.items].sort((a, b) =>
    a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0
  )
  const result = new Map(
    ordered.map((item) => [
      item.productId,
      Number((BigInt(amount) * BigInt(item.quantity)) / BigInt(totalQuantity)),
    ])
  )
  if (result.size !== ordered.length) unavailable()
  let remaining =
    amount - [...result.values()].reduce((sum, value) => sum + value, 0)
  for (const item of ordered) {
    if (remaining-- <= 0) break
    result.set(item.productId, result.get(item.productId)! + 1)
  }
  return result
}

/** Require every quoted shipped line, including its exact per-line rounding share. */
export function assertCheckoutSparkCommerceShippingPolicies(
  quote: CheckoutSparkCommerceQuote,
  acceptedAtMs?: number
): void {
  const groups = new Map<
    string,
    CheckoutSparkCommerceQuote["lines"][number][]
  >()
  for (const line of quote.lines) {
    if (!line.shippingPolicy) continue
    const key = line.shippingPolicy.quote.policyEventId
    const group = groups.get(key) ?? []
    group.push(line)
    groups.set(key, group)
  }
  for (const lines of groups.values()) {
    const policy = shippingPolicyQuoteSchema.parse(
      lines[0]!.shippingPolicy!.quote
    )
    // Table conversion is independently frozen; it may predate the merchandise
    // quote, but new router admission still requires a known, fresh snapshot.
    if (policy.pricingRate != null) {
      const pricing = freezeCheckoutSparkCommercePricing({
        version: 1,
        rate: policy.pricingRate,
      })
      if (
        acceptedAtMs === undefined ||
        !isPricingRateQuoteFresh(pricing.rate, acceptedAtMs)
      )
        unavailable()
    }
    const allocated = allocateCheckoutSparkShippingPolicySats(policy)
    if (
      policy.items.length !== lines.length ||
      lines.some((line) => {
        const source = policy.items.find(
          (item) => item.productId === line.productCoordinate
        )
        return (
          !source ||
          !hasSameShippingPolicyQuote(line.shippingPolicy!.quote, policy) ||
          source.productEventId !== line.productEventId ||
          source.quantity !== line.quantity ||
          policy.merchantPubkey !== line.merchantPubkey ||
          line.shippingOption?.coordinate !== policy.policyCoordinate ||
          line.shippingOption.eventId !== policy.policyEventId ||
          line.unitShippingSats !== 0 ||
          line.sourceShippingCost !== undefined ||
          line.shippingPolicy!.allocatedCostSats !==
            allocated.get(line.productCoordinate)
        )
      })
    )
      unavailable()
  }
}

function unavailable(): never {
  throw new Error("Checkout Spark signed fulfillment evidence is unavailable.")
}

/**
 * Reconstruct the frozen line's fulfillment from exact signed revisions.
 * This verifies historical terms, not live freshness or destination eligibility.
 * Callers must separately validate the buyer address before funding/publication.
 */
export function resolveCheckoutSparkSignedShipping(input: {
  productEvent: SignedPublicNostrEvent
  line: CheckoutSparkCommerceQuote["lines"][number]
  shippingEvents?: readonly SignedPublicNostrEvent[]
  pricing?: CheckoutSparkCommercePricing
  acceptedAtMs?: number
}): ParsedShippingOption | undefined {
  const { productEvent, line } = input
  if (
    line.pickup !== undefined ||
    !isValidSignedPublicNostrEvent(productEvent) ||
    productEvent.kind !== 30_402 ||
    productEvent.id !== line.productEventId ||
    productEvent.pubkey !== line.merchantPubkey
  ) {
    unavailable()
  }
  const product = parseCheckoutSparkSignedProductFields(productEvent)
  if (product.id !== line.productCoordinate || product.priceEvidenceMalformed) {
    unavailable()
  }
  assertCheckoutSparkCommerceProductPrice({
    product,
    line,
    pricing: input.pricing,
    acceptedAtMs: input.acceptedAtMs,
  })
  if (product.format === "digital") {
    if (
      line.shippingOption !== undefined ||
      line.unitShippingSats !== 0 ||
      line.sourceShippingCost !== undefined ||
      line.shippingPolicy !== undefined
    ) {
      unavailable()
    }
    return undefined
  }
  const reference = line.shippingOption
  if (
    product.format !== "physical" ||
    !reference ||
    !Number.isSafeInteger(line.unitShippingSats) ||
    line.unitShippingSats < 0
  ) {
    unavailable()
  }
  const event = input.shippingEvents?.find(
    (candidate) => candidate.id === reference.eventId
  )
  if (
    !event ||
    !isValidSignedPublicNostrEvent(event) ||
    event.kind !== 30_406 ||
    event.pubkey !== product.pubkey
  ) {
    unavailable()
  }
  const option = parseShippingOptionFieldsForPrivateOrder(event)
  if (line.shippingPolicy) {
    const policy = shippingPolicyQuoteSchema.parse(line.shippingPolicy.quote)
    const fulfillment = option
      ? resolveProductFulfillment(product, [option])
      : null
    if (
      !option?.shippingPolicy ||
      option.id !== policy.policyCoordinate ||
      event.id !== policy.policyEventId ||
      reference.coordinate !== policy.policyCoordinate ||
      line.unitShippingSats !== 0 ||
      fulfillment?.intent !== "weight_table" ||
      fulfillment.status !== "ready" ||
      !policy.items.some(
        (item) =>
          item.productId === line.productCoordinate &&
          item.productEventId === productEvent.id &&
          item.quantity === line.quantity
      )
    )
      unavailable()
    return option
  }
  const source = option
    ? canonicalizeShippingCost(option.price, option.currency)
    : undefined
  const converted = source
    ? getShippingCostSats(source, input.pricing?.rate ?? null, {
        currencyPolicy: "historical",
      })
    : null
  if (
    !option ||
    option.id !== reference.coordinate ||
    !converted ||
    converted.sats !== line.unitShippingSats ||
    (line.sourceShippingCost !== undefined &&
      !hasSameCheckoutSparkSourcePrice(
        line.sourceShippingCost,
        source?.sourceShippingCost
      )) ||
    (!isSatsLikeCurrency(option.currency) &&
      line.sourceShippingCost === undefined) ||
    (converted.approximate &&
      (!input.pricing ||
        input.acceptedAtMs === undefined ||
        !isPricingRateQuoteFresh(input.pricing.rate, input.acceptedAtMs)))
  ) {
    unavailable()
  }
  const fulfillment = resolveProductFulfillment(product, [option])
  if (
    fulfillment.intent !== "fixed_standard" ||
    fulfillment.status !== "ready" ||
    fulfillment.option?.eventId !== reference.eventId
  ) {
    unavailable()
  }
  return option
}
