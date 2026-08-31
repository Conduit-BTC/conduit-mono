import type {
  ParsedShippingOption,
  PricingRateInput,
  Product,
} from "@conduit/core"
import {
  getCartCommerceFingerprint,
  rebuildCurrentCartItems,
  type CartItem,
  type CartItemFulfillment,
} from "./cart-model"
import {
  getCartShippingOptionCoordinates,
  prepareCartFulfillment,
} from "./cart-shipping-options"
import {
  getProductEventMarketCandidates,
  resolveProductCartFulfillment,
  type ProductCartFulfillmentResolution,
} from "./event-market-adapter"
import { assertCartPickupHandlerReady } from "./pickup-handoff"

export type CheckoutAuthorizationResult =
  { status: "ok"; items: CartItem[] } | { status: "changed" }

export type CheckoutAuthorizationMode = "direct_payment" | "order_first"

export type CheckoutShippingOptionReader = (
  coordinates: readonly string[]
) => Promise<ParsedShippingOption[]>

export type CheckoutProductFulfillmentResolver = (
  product: Product,
  rateInput: PricingRateInput
) => Promise<ProductCartFulfillmentResolution>

export type CheckoutPickupHandlerAuthorizer = (
  items: readonly CartItem[]
) => Promise<void>

/**
 * Rebuilds one checkout snapshot from authoritative 30402 and 30406 reads.
 * The caller must use the returned items for every subsequent pricing,
 * destination, payload, and lifecycle decision in the submit attempt.
 */
export async function authorizeCurrentCheckoutItems(input: {
  mode: CheckoutAuthorizationMode
  reviewedItems: readonly CartItem[]
  rawItems: readonly CartItem[]
  refreshedProducts: readonly Product[]
  readShippingOptions: CheckoutShippingOptionReader
  rateInput?: PricingRateInput
  resolveProductFulfillment?: CheckoutProductFulfillmentResolver
  authorizePickupHandlers?: CheckoutPickupHandlerAuthorizer
  shippingDestination?: {
    country: string
    state?: string
    postalCode: string
  }
}): Promise<CheckoutAuthorizationResult> {
  const resolveFulfillment =
    input.resolveProductFulfillment ?? resolveProductCartFulfillment
  const fulfillmentResolutions = await Promise.all(
    input.refreshedProducts.map(async (product) => {
      if (getProductEventMarketCandidates(product).length === 0) {
        return {
          status: "standard",
          type: product.format === "digital" ? "digital" : "shipping",
          product,
        } satisfies ProductCartFulfillmentResolution
      }
      return resolveFulfillment(product, input.rateInput ?? null)
    })
  )
  if (
    fulfillmentResolutions.some((resolution) => resolution.status === "blocked")
  ) {
    return { status: "changed" }
  }

  const fulfillmentByProductId = new Map<string, CartItemFulfillment>()
  const resolvedProducts = fulfillmentResolutions.map((resolution) => {
    if (resolution.status === "blocked") {
      throw new Error("Blocked fulfillment escaped checkout authorization.")
    }
    fulfillmentByProductId.set(
      resolution.product.id,
      resolution.status === "pickup"
        ? resolution.fulfillment
        : { type: resolution.type }
    )
    return resolution.product
  })
  const refreshedRawItems = rebuildCurrentCartItems(
    input.rawItems,
    resolvedProducts,
    fulfillmentByProductId
  )
  if (
    !refreshedRawItems ||
    getCartCommerceFingerprint(refreshedRawItems) !==
      getCartCommerceFingerprint(input.rawItems)
  ) {
    return { status: "changed" }
  }

  const shippingCoordinates =
    getCartShippingOptionCoordinates(refreshedRawItems)
  let shippingOptions: ParsedShippingOption[]
  try {
    shippingOptions =
      shippingCoordinates.length === 0
        ? []
        : await input.readShippingOptions(shippingCoordinates)
  } catch (error) {
    if (input.mode === "direct_payment") throw error

    // Order-first is the safe fallback for incomplete or unavailable 30406
    // evidence. Keep the fresh 30402 terms, but clear every prepared shipping
    // field so the order cannot claim a stale coordinate, destination, or cost.
    return {
      status: "ok",
      items: prepareCartFulfillment(refreshedRawItems, []).items,
    }
  }
  const prepared = prepareCartFulfillment(
    refreshedRawItems,
    shippingOptions,
    input.shippingDestination
  )

  if (
    getCartCommerceFingerprint(prepared.items) !==
    getCartCommerceFingerprint(input.reviewedItems)
  ) {
    return { status: "changed" }
  }

  await (input.authorizePickupHandlers ?? assertCartPickupHandlerReady)(
    prepared.items
  )

  return { status: "ok", items: prepared.items }
}
