import type { ParsedShippingOption, Product } from "@conduit/core"
import {
  getCartCommerceFingerprint,
  rebuildCurrentCartItems,
  type CartItem,
} from "./cart-model"
import {
  getCartShippingOptionCoordinates,
  prepareCartFulfillment,
} from "./cart-shipping-options"

export type CheckoutAuthorizationResult =
  { status: "ok"; items: CartItem[] } | { status: "changed" }

export type CheckoutAuthorizationMode = "direct_payment" | "order_first"

export type CheckoutShippingOptionReader = (
  coordinates: readonly string[]
) => Promise<ParsedShippingOption[]>

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
}): Promise<CheckoutAuthorizationResult> {
  const refreshedRawItems = rebuildCurrentCartItems(
    input.rawItems,
    input.refreshedProducts
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
  const prepared = prepareCartFulfillment(refreshedRawItems, shippingOptions)

  if (
    getCartCommerceFingerprint(prepared.items) !==
    getCartCommerceFingerprint(input.reviewedItems)
  ) {
    return { status: "changed" }
  }

  return { status: "ok", items: prepared.items }
}
