import type {
  ParsedShippingOption,
  PricingRateInput,
  Product,
} from "@conduit/core"
import {
  createEventMarketPickupSnapshot,
  readEventMarketProduct,
  readEventMarketRoster,
  type OrderEventMarketPickupFulfillmentSchema,
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

/**
 * A future Event Market purchase must have live, complete and retained signed
 * market, calendar, grant and product evidence at the submit boundary. The
 * exact current revisions are put into the order; older cart terms require
 * the buyer to review the listing again.
 */
export async function resolveCurrentFutureEventMarketFulfillments(
  input: {
    items: readonly CartItem[]
    products: readonly Product[]
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
  },
  dependencies: {
    readMarket: typeof readEventMarketRoster
    readProduct: typeof readEventMarketProduct
    snapshot: typeof createEventMarketPickupSnapshot
  } = {
    readMarket: readEventMarketRoster,
    readProduct: readEventMarketProduct,
    snapshot: createEventMarketPickupSnapshot,
  }
): Promise<Map<string, OrderEventMarketPickupFulfillmentSchema> | null> {
  const futureItems = input.items.filter(
    (item) => item.fulfillment?.type === "event_market_pickup"
  )
  const snapshots = new Map<string, OrderEventMarketPickupFulfillmentSchema>()
  const marketReads = new Map<
    string,
    Awaited<ReturnType<typeof readEventMarketRoster>>
  >()
  for (const item of futureItems) {
    const saved = item.fulfillment
    if (saved?.type !== "event_market_pickup") return null
    const currentProduct = input.products.find(
      (product) =>
        product.id === item.productId && product.pubkey === item.merchantPubkey
    )
    if (!currentProduct || currentProduct.format !== "physical") return null
    let marketRead = marketReads.get(saved.market.coordinate)
    if (!marketRead) {
      marketRead = await dependencies.readMarket({
        reference: saved.market.coordinate,
        authenticatedPubkey: input.authenticatedPubkey,
        shouldContinue: input.shouldContinue,
      })
      marketReads.set(saved.market.coordinate, marketRead)
    }
    const productRead = await dependencies.readProduct({
      marketRead,
      productCoordinate: item.productId,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
    })
    if (
      !productRead.actionable ||
      productRead.resolution.state !== "eligible" ||
      currentProduct.sourceEventId !== productRead.resolution.revision.id ||
      currentProduct.updatedAt !==
        productRead.resolution.revision.created_at * 1_000
    ) {
      return null
    }
    let current: OrderEventMarketPickupFulfillmentSchema
    try {
      current = dependencies.snapshot({
        marketRead,
        productRead,
        selectedOccurrenceCoordinate: saved.calendar.coordinate,
      })
    } catch {
      return null
    }
    if (JSON.stringify(saved) !== JSON.stringify(current)) return null
    snapshots.set(item.productId, current)
  }
  return snapshots
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
  const futureSnapshots = await resolveCurrentFutureEventMarketFulfillments({
    items: input.rawItems,
    products: input.refreshedProducts,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
  })
  if (!futureSnapshots) return { status: "changed" }
  const ordinaryProducts = input.refreshedProducts.filter(
    (product) => !futureSnapshots.has(product.id)
  )
  const fulfillmentResolutions = input.resolveProductFulfillment
    ? await Promise.all(
        ordinaryProducts.map((product) =>
          input.resolveProductFulfillment!(product, input.rateInput ?? null)
        )
      )
    : await resolveCheckoutProductFulfillments(
        ordinaryProducts,
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
  for (const [productId, snapshot] of futureSnapshots) {
    fulfillmentByProductId.set(productId, snapshot)
  }
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
    [
      ...resolvedProducts,
      ...input.refreshedProducts.filter((product) =>
        futureSnapshots.has(product.id)
      ),
    ],
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
  const prepared = prepareCartFulfillment(refreshedRawItems, shippingOptions)

  if (
    getCartCommerceFingerprint(prepared.items) !==
    getCartCommerceFingerprint(input.reviewedItems)
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
