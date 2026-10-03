import {
  hasCurrentShippingPolicyEvidence,
  type ParsedShippingOption,
  type PricingRateInput,
  type Product,
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
import { getEventMarketCartReviewReasons } from "./event-market-cart-review"
import { assertCartPickupHandlerReady } from "./pickup-handoff"
import {
  resolveProductCartFulfillment,
  type ProductCartFulfillmentResolution,
} from "./product-cart-fulfillment"

type CheckoutProductFulfillmentResolution =
  | ProductCartFulfillmentResolution
  | { status: "blocked"; product: Product; reason: string }

export type CheckoutShippingOptionEvidence =
  | { status: "verified"; options: readonly ParsedShippingOption[] }
  | { status: "not_required"; options: readonly [] }
  | { status: "unavailable_order_first"; options: readonly [] }

export type CheckoutAuthorizationResult =
  | {
      status: "ok"
      items: CartItem[]
      /** Products returned by the checkout's live listing/availability read. */
      listingReadProducts: readonly Product[]
      /** Products chosen by current fulfillment resolution and used to rebuild
       * every ordinary and Event Market item. Later quotes reconcile this
       * projection with the exact signed listing read. */
      fulfillmentResolvedProducts: readonly Product[]
      /** Preserve the source read state; [] alone cannot mean both no option
       * was needed and an order-first shipping lookup failed. */
      shippingOptionEvidence: CheckoutShippingOptionEvidence
    }
  | { status: "changed" }

export type CheckoutAuthorizationMode = "direct_payment" | "order_first"

export type CheckoutShippingOptionReader = (
  coordinates: readonly string[]
) => Promise<ParsedShippingOption[]>

export type CheckoutProductFulfillmentResolver = (
  product: Product,
  rateInput: PricingRateInput
) => Promise<CheckoutProductFulfillmentResolution>

export type CheckoutPickupHandlerAuthorizer = (
  items: readonly CartItem[]
) => Promise<void>

/**
 * A future Event Market purchase must have live and retained signed
 * market, calendar, grant and product evidence at the submit boundary. The
 * exact current revisions are put into the order; material cart term changes
 * require the buyer to review the listing again. Partial optional source
 * coverage does not replace the positive signed-evidence requirement.
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
    if (
      getEventMarketCartReviewReasons({
        saved,
        current,
        savedPrice: item.price,
        currentPrice: currentProduct.price,
      }).length > 0
    )
      return null
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
  destination?: { country: string; subdivision?: string; postalCode?: string }
  rateInput?: PricingRateInput
  accountPubkey?: string | null
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  resolveProductFulfillment?: CheckoutProductFulfillmentResolver
  authorizePickupHandlers?: CheckoutPickupHandlerAuthorizer
  futureEventMarketDependencies?: Parameters<
    typeof resolveCurrentFutureEventMarketFulfillments
  >[1]
}): Promise<CheckoutAuthorizationResult> {
  // Only supported fulfillment can reach authorization; never reinterpret an
  // unsupported saved cart as ordinary shipping.
  if (
    [...input.rawItems, ...input.reviewedItems].some(
      (item) =>
        item.fulfillment !== undefined &&
        !["digital", "shipping", "event_market_pickup"].includes(
          item.fulfillment.type
        )
    )
  )
    return { status: "changed" }

  const futureSnapshots = await resolveCurrentFutureEventMarketFulfillments(
    {
      items: input.rawItems,
      products: input.refreshedProducts,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
    },
    input.futureEventMarketDependencies
  )
  if (!futureSnapshots) return { status: "changed" }
  for (const item of input.reviewedItems) {
    const saved = item.fulfillment
    const current = futureSnapshots.get(item.productId)
    const product = input.refreshedProducts.find(
      (entry) =>
        entry.id === item.productId && entry.pubkey === item.merchantPubkey
    )
    if (
      current &&
      (saved?.type !== "event_market_pickup" ||
        !product ||
        getEventMarketCartReviewReasons({
          saved,
          current,
          savedPrice: item.price,
          currentPrice: product.price,
        }).length > 0)
    )
      return { status: "changed" }
  }
  // The future resolver checks accepted material terms before refreshing the
  // signed custody snapshot. Compare the other cart fields against that same
  // current evidence so harmless roster or schedule revisions do not veto the
  // full submit seam after successful authorization.
  const withCurrentFutureEvidence = (items: readonly CartItem[]): CartItem[] =>
    items.map((item) => {
      const current = futureSnapshots.get(item.productId)
      return current && item.fulfillment?.type === "event_market_pickup"
        ? { ...item, fulfillment: current }
        : item
    })
  const ordinaryProducts = input.refreshedProducts.filter(
    (product) => !futureSnapshots.has(product.id)
  )
  const fulfillmentResolutions = input.resolveProductFulfillment
    ? await Promise.all(
        ordinaryProducts.map((product) =>
          input.resolveProductFulfillment!(product, input.rateInput ?? null)
        )
      )
    : ordinaryProducts.map(resolveProductCartFulfillment)
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
    fulfillmentByProductId.set(resolution.product.id, { type: resolution.type })
    return resolution.product
  })
  // Event Market products already matched the exact current signed revision;
  // keep them beside ordinary products in the evidence passed to later quotes.
  resolvedProducts.push(
    ...input.refreshedProducts.filter((product) =>
      futureSnapshots.has(product.id)
    )
  )
  const refreshedRawItems = rebuildCurrentCartItems(
    input.rawItems,
    resolvedProducts,
    fulfillmentByProductId
  )
  if (
    !refreshedRawItems ||
    getCartCommerceFingerprint(refreshedRawItems) !==
      getCartCommerceFingerprint(withCurrentFutureEvidence(input.rawItems))
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
    if (
      shippingOptions.some(
        (option) =>
          shippingCoordinates.includes(option.id) &&
          option.shippingPolicy &&
          !hasCurrentShippingPolicyEvidence(option)
      )
    ) {
      throw new Error(
        "The current shipping rates could not be verified. Try again or arrange shipping with the merchant before paying."
      )
    }
  } catch (error) {
    if (input.mode === "direct_payment") throw error

    // Order-first is the safe fallback for incomplete or unavailable 30406
    // evidence. Keep the fresh 30402 terms, but clear every prepared shipping
    // field so the order cannot claim a stale coordinate, destination, or cost.
    return {
      status: "ok",
      items: prepareCartFulfillment(refreshedRawItems, []).items,
      listingReadProducts: input.refreshedProducts,
      fulfillmentResolvedProducts: resolvedProducts,
      shippingOptionEvidence: {
        status: "unavailable_order_first",
        options: [],
      },
    }
  }
  const prepared = prepareCartFulfillment(
    refreshedRawItems,
    shippingOptions,
    input.destination,
    input.rateInput ?? null
  )

  if (
    getCartCommerceFingerprint(prepared.items) !==
    getCartCommerceFingerprint(withCurrentFutureEvidence(input.reviewedItems))
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

  return {
    status: "ok",
    items: prepared.items,
    listingReadProducts: input.refreshedProducts,
    fulfillmentResolvedProducts: resolvedProducts,
    shippingOptionEvidence:
      shippingCoordinates.length === 0
        ? { status: "not_required", options: [] }
        : { status: "verified", options: shippingOptions },
  }
}
