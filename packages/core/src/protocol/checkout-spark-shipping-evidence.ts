import type { CheckoutSparkCommerceQuote } from "./checkout-spark-reconciliation"
import { isSatsLikeCurrency } from "../pricing"
import { parseProductEvent } from "./products"
import {
  parseShippingOptionEvent,
  resolveProductFulfillment,
  type ParsedShippingOption,
} from "./shipping"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

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
  const product = parseProductEvent(productEvent)
  if (
    product.id !== line.productCoordinate ||
    product.type !== "simple" ||
    product.currency !== "SATS" ||
    product.priceEvidenceMalformed ||
    product.priceSats !== line.unitMerchandiseSats
  ) {
    unavailable()
  }
  if (product.format === "digital") {
    if (line.shippingOption !== undefined || line.unitShippingSats !== 0) {
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
  const option = parseShippingOptionEvent(event)
  if (
    !option ||
    option.id !== reference.coordinate ||
    !isSatsLikeCurrency(option.currency) ||
    option.price !== line.unitShippingSats
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
