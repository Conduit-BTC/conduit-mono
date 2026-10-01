import {
  createEventMarketPickupSnapshot,
  getProductsByIds,
  hasExactLiveProductAvailabilityEvidence,
  readEventMarketProduct,
  readEventMarketRoster,
  type Product,
} from "@conduit/core"
import {
  createCartItemFromProduct,
  type CartItem,
  type CartItemInput,
} from "./cart-model"

export function hasEventShippingChoice(product: Product): boolean {
  return (
    product.format === "physical" &&
    !!product.shippingOptionId &&
    product.shippingOptionLaunchUnsupported !== true
  )
}

/** Ordinary shipping uses exact listing evidence, independently of pickup authority. */
export async function readEventShippingProduct(
  input: {
    productId: string
    merchantPubkey: string
    authenticatedPubkey: string | null
    expectedEventId?: string
    shouldContinue: () => boolean
  },
  readProducts: typeof getProductsByIds = getProductsByIds
): Promise<Product> {
  const result = await readProducts([input.productId], {
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
  })
  const record = result.data.find(
    (entry) => entry.addressId === input.productId
  )
  const diagnostic = result.diagnostics.find(
    (entry) => entry.addressId === input.productId
  )
  if (
    !input.shouldContinue() ||
    result.meta.source !== "commerce" ||
    !hasExactLiveProductAvailabilityEvidence(diagnostic, input.productId) ||
    !record ||
    record.product.pubkey !== input.merchantPubkey ||
    !hasEventShippingChoice(record.product)
  )
    throw new Error(
      "Current shipping terms could not be verified. Review the listing and try again."
    )
  if (input.expectedEventId && record.eventId !== input.expectedEventId)
    throw new Error(
      "Product details changed. Review the refreshed item before adding it."
    )
  return record.product
}

export async function prepareEventFulfillmentChoice(
  item: CartItem,
  choice: "shipping" | "event_market_pickup",
  authenticatedPubkey: string | null,
  shouldContinue: () => boolean = () => true
): Promise<CartItemInput> {
  const context =
    item.eventMarketContext ??
    (item.fulfillment?.type === "event_market_pickup"
      ? {
          marketCoordinate: item.fulfillment.market.coordinate,
          calendarCoordinate: item.fulfillment.calendar.coordinate,
        }
      : undefined)
  if (!context)
    throw new Error("Open the event catalog to choose this item's fulfillment.")
  if (choice === "shipping") {
    const product = await readEventShippingProduct({
      productId: item.productId,
      merchantPubkey: item.merchantPubkey,
      authenticatedPubkey,
      shouldContinue,
    })
    return {
      ...createCartItemFromProduct(product, { type: "shipping" }),
      eventMarketContext: context,
      familyProductId:
        product.type === "variation" ? product.parentProductId : undefined,
    }
  }
  const marketRead = await readEventMarketRoster({
    reference: context.marketCoordinate,
    authenticatedPubkey,
    shouldContinue,
  })
  const productRead = await readEventMarketProduct({
    marketRead,
    productCoordinate: item.productId,
    authenticatedPubkey,
    shouldContinue,
  })
  if (!shouldContinue() || productRead.resolution.state !== "eligible")
    throw new Error("Current event handoff terms could not be verified.")
  const fulfillment = createEventMarketPickupSnapshot({
    marketRead,
    productRead,
    selectedOccurrenceCoordinate: context.calendarCoordinate,
  })
  return {
    ...createCartItemFromProduct(productRead.resolution.product, fulfillment),
    familyProductId:
      productRead.resolution.product.type === "variation"
        ? productRead.resolution.product.parentProductId
        : undefined,
  }
}
