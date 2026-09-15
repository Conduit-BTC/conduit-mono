import {
  hasSamePickupEvidenceRevision,
  resolveOrderPickupHandoffAuthority,
  type OrderPickupFulfillmentSchema,
  type ParsedShippingOption,
  type PricingRateInput,
  type Product,
} from "@conduit/core"
import {
  getCartCommerceFingerprint,
  getCartItemKey,
  rebuildCurrentCartItems,
  type CartItem,
  type CartItemFulfillment,
} from "./cart-model"
import {
  getCartShippingOptionCoordinates,
  prepareCartFulfillment,
} from "./cart-shipping-options"
import {
  resolveCheckoutProductFulfillments,
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

function hasSamePickupFulfillmentEvidenceRevision(
  left: OrderPickupFulfillmentSchema,
  right: OrderPickupFulfillmentSchema
): boolean {
  const leftAuthority = resolveOrderPickupHandoffAuthority(left)
  const rightAuthority = resolveOrderPickupHandoffAuthority(right)

  return (
    left.organizerPubkey === right.organizerPubkey &&
    left.product.merchantPubkey === right.product.merchantPubkey &&
    leftAuthority.mode === rightAuthority.mode &&
    leftAuthority.handlerPubkey === rightAuthority.handlerPubkey &&
    hasSamePickupEvidenceRevision(left.product, right.product) &&
    hasSamePickupEvidenceRevision(left.calendar, right.calendar) &&
    hasSamePickupEvidenceRevision(left.collection, right.collection) &&
    hasSamePickupEvidenceRevision(left.option, right.option)
  )
}

function getSubmitAuthorizationFingerprint(
  items: readonly CartItem[],
  currentItems: readonly CartItem[]
): string {
  const currentByKey = new Map(
    currentItems.map((item) => [getCartItemKey(item), item])
  )
  return getCartCommerceFingerprint(
    items.map((item) => {
      const current = currentByKey.get(getCartItemKey(item))
      if (
        item.fulfillment?.type !== "pickup" ||
        current?.fulfillment?.type !== "pickup" ||
        item.fulfillment.option.countries !== undefined ||
        current.fulfillment.option.countries === undefined ||
        !hasSamePickupFulfillmentEvidenceRevision(
          item.fulfillment,
          current.fulfillment
        )
      ) {
        return item
      }

      return {
        ...item,
        fulfillment: {
          ...item.fulfillment,
          option: {
            ...item.fulfillment.option,
            countries: current.fulfillment.option.countries,
          },
        },
      }
    })
  )
}

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
  accountPubkey?: string | null
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  resolveProductFulfillment?: CheckoutProductFulfillmentResolver
  authorizePickupHandlers?: CheckoutPickupHandlerAuthorizer
}): Promise<CheckoutAuthorizationResult> {
  const fulfillmentResolutions = input.resolveProductFulfillment
    ? await Promise.all(
        input.refreshedProducts.map((product) =>
          input.resolveProductFulfillment!(product, input.rateInput ?? null)
        )
      )
    : await resolveCheckoutProductFulfillments(
        input.refreshedProducts,
        input.rateInput,
        input.authenticatedPubkey,
        input.shouldContinue
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
      getSubmitAuthorizationFingerprint(input.rawItems, refreshedRawItems)
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
    getSubmitAuthorizationFingerprint(input.reviewedItems, prepared.items)
  ) {
    return { status: "changed" }
  }

  const authorizePickupHandlers =
    input.authorizePickupHandlers ??
    ((items: readonly CartItem[]) =>
      assertCartPickupHandlerReady(items, undefined, {
        requestingAccountPubkey: input.accountPubkey,
        authenticatedPubkey: input.authenticatedPubkey,
        shouldContinue: input.shouldContinue,
      }))
  await authorizePickupHandlers(prepared.items)

  return { status: "ok", items: prepared.items }
}
