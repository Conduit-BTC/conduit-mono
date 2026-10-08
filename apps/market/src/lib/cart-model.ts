import {
  getPriceSats,
  getProductImageCandidates,
  getShippingCostSats,
  hasExactLiveProductAvailabilityEvidence,
  normalizeProductCoordinate,
  orderItemFulfillmentSchema,
  parseAddressableCoordinate,
  resolveCartShippingCost,
  type CommerceQueryMeta,
  type ProductAvailabilityDiagnostic,
  type ProductAvailabilityIssue,
  type ProductZapMessagePolicy,
  type PricingRateInput,
  type Product,
  type ProductSpecification,
  type OrderEventMarketPickupFulfillmentSchema,
  type ShippingPolicyQuote,
  type SourcePriceQuote,
  type VerifiedNostrEvent,
  isVerifiedNostrEvent,
  shippingPolicyQuoteSchema,
} from "@conduit/core"

export const CART_STORAGE_VERSION = 2

export type CartItem = {
  /** Local line incarnation. Present on canonical carts, never sent in orders. */
  cartLineId?: string
  productId: string
  /** Variable parent coordinate when productId identifies a variation child. */
  familyProductId?: string
  /** Human-readable selection snapshot preserved in signed-event order. */
  selectedSpecifications?: ProductSpecification[]
  merchantPubkey: string
  merchantAddedAt?: number
  title: string
  price: number
  currency: string
  priceSats?: number
  sourcePrice?: {
    amount: number
    currency: string
    normalizedCurrency: string
  }
  image?: string
  tags?: string[]
  /** Whether the product requires physical shipping. Defaults to "physical". */
  format?: "physical" | "digital"
  /**
   * Fulfillment is snapshotted when the buyer adds an item. Older persisted
   * carts omit this field and continue to resolve from `format` as shipment or
   * digital delivery.
   */
  /** Cart-only navigation context; never serialized into an order. */
  eventMarketContext?: { marketCoordinate: string; calendarCoordinate: string }
  fulfillment?: CartItemFulfillment
  /** Per-item shipping cost in sats. Omitted means shipping is coordinated manually. */
  shippingCostSats?: number
  shippingWeightGrams?: number
  shippingWeightAllowanceGrams?: number
  shippingHandling?: SourcePriceQuote
  shippingPolicyQuote?: ShippingPolicyQuote
  /** Shipping allocated to this entire line, independent of quantity. */
  shippingAllocatedCostSats?: number
  sourceShippingCost?: {
    amount: number
    currency: string
    normalizedCurrency: string
  }
  shippingOptionId?: string
  shippingOptionDTag?: string
  shippingOptionLaunchUnsupported?: boolean
  shippingCountries?: string[]
  shippingCountryRules?: Array<{
    code: string
    name: string
    restrictTo: string[]
    exclude: string[]
  }>
  /** Signed product event timestamp used by the fixed-shipping staleness guard. */
  productUpdatedAt?: number
  /** Signed kind-30402 event id paired with productUpdatedAt for NIP-01 ordering. */
  productEventId?: string
  signedProductEvent?: VerifiedNostrEvent
  /** True only after exact canonical kind-30406 resolution. */
  canonicalShippingResolved?: boolean
  publicZapEnabled?: boolean
  zapMessagePolicy?: ProductZapMessagePolicy
  publicZapPolicyKnown?: boolean
  /** Last known stock value from legacy GammaMarkets-compatible tags. Zero means the item is sold out. */
  stock?: number
  quantity: number
}

/** Shared protocol snapshot; Market only persists and displays this shape. */
export type CartEventMarketPickupFulfillment =
  OrderEventMarketPickupFulfillmentSchema

export type CartItemFulfillment =
  { type: "digital" } | { type: "shipping" } | CartEventMarketPickupFulfillment

export type CartFulfillmentLane =
  "empty" | "digital" | "shipping" | "pickup" | "mixed_shipping_pickup"

export type CartState = {
  items: CartItem[]
}

export type CartItemIdentity = Pick<
  CartItem,
  "merchantPubkey" | "productId"
> & {
  cartLineId?: string
}

export type CartItemInput = Omit<
  CartItem,
  "cartLineId" | "merchantAddedAt" | "quantity"
>

export type ParsedPersistedCart = {
  state: CartState
  shouldPersist: boolean
  writable: boolean
}

export type MerchantCartGroup = {
  merchantPubkey: string
  items: CartItem[]
  totalItems: number
  merchantAddedAt: number
}

export type CartPurchaseItem = CartItem

export type CartPurchaseGroup = Omit<MerchantCartGroup, "items"> & {
  id: string
  kind: "delivery" | "pickup"
  items: CartPurchaseItem[]
}

export type CartTotals = {
  count: number
  subtotal: number
}

export type CartCostSummary = {
  count: number
  itemSubtotalSats: number
  shippingTotalSats: number
  totalSats: number
  itemPricesAvailable: boolean
  shippingReadyForZap: boolean
}

export type CartPublicZapPolicy = {
  publicZapsAllowed: boolean
  effectiveZapMessagePolicy: ProductZapMessagePolicy
  disabledProductIds: string[]
  missingPolicyProductIds: string[]
}

export type CartProductAvailability = {
  productId: string
  merchantPubkey: string
  status: "available" | "sold_out" | "insufficient_stock" | "untracked"
  stock?: number
  productUpdatedAt?: number
  productEventId?: string
  refreshed: boolean
}

export type CartItemStockEvidence = Pick<
  CartItem,
  "stock" | "productUpdatedAt" | "productEventId"
>

type CartAvailabilityReadMeta = Pick<
  CommerceQueryMeta,
  "source" | "stale" | "degraded"
>

export type CartAvailabilityReadDecision =
  | {
      status: "verified_at_read"
      coverage: "complete" | "partial"
    }
  | {
      status: "unverified"
      reason: ProductAvailabilityIssue | "query_failed" | "evidence_mismatch"
      diagnostics: readonly ProductAvailabilityDiagnostic[]
    }

export type ProductAddAvailability = {
  remainingStock?: number
  canAdd: boolean
  canIncrement: boolean
}

export function getProductAddAvailability(
  stock: number | undefined,
  cartQuantity: number,
  requestedQuantity: number
): ProductAddAvailability {
  if (typeof stock !== "number") {
    return {
      remainingStock: undefined,
      canAdd: true,
      canIncrement: true,
    }
  }

  const remainingStock = Math.max(0, stock - Math.max(0, cartQuantity))
  return {
    remainingStock,
    canAdd: remainingStock > 0 && requestedQuantity <= remainingStock,
    canIncrement: requestedQuantity < remainingStock,
  }
}

export function createCartItemFromProduct(
  product: Product,
  fulfillment?: CartItemFulfillment
): Omit<CartItem, "quantity"> {
  const canonicalShippingResolved = product.canonicalShippingResolved === true
  const resolvedFulfillment =
    fulfillment ??
    (product.format === "digital"
      ? ({ type: "digital" } as const)
      : ({ type: "shipping" } as const))
  const eventMarketPickup = resolvedFulfillment.type === "event_market_pickup"
  return {
    productId: product.id,
    selectedSpecifications:
      (product.specifications?.length ?? 0) > 0
        ? [...product.specifications]
        : undefined,
    merchantPubkey: product.pubkey,
    title: product.title,
    price: product.price,
    currency: product.currency,
    priceSats: product.priceSats,
    sourcePrice: product.sourcePrice,
    image: getProductImageCandidates(product)[0]?.url,
    tags: product.tags,
    format: product.format,
    fulfillment: resolvedFulfillment,
    ...(resolvedFulfillment.type === "event_market_pickup"
      ? {
          eventMarketContext: {
            marketCoordinate: resolvedFulfillment.market.coordinate,
            calendarCoordinate: resolvedFulfillment.calendar.coordinate,
          },
        }
      : {}),
    shippingCostSats: eventMarketPickup ? 0 : product.shippingCostSats,
    sourceShippingCost: eventMarketPickup
      ? undefined
      : product.sourceShippingCost,
    shippingOptionId: eventMarketPickup ? undefined : product.shippingOptionId,
    shippingOptionDTag: eventMarketPickup
      ? undefined
      : product.shippingOptionDTag,
    shippingOptionLaunchUnsupported: eventMarketPickup
      ? undefined
      : product.shippingOptionLaunchUnsupported,
    shippingCountries: eventMarketPickup ? [] : product.shippingCountries,
    shippingCountryRules: eventMarketPickup ? [] : product.shippingCountryRules,
    productUpdatedAt:
      resolvedFulfillment.type === "event_market_pickup"
        ? resolvedFulfillment.product.createdAt
        : product.updatedAt,
    productEventId:
      resolvedFulfillment.type === "event_market_pickup"
        ? resolvedFulfillment.product.eventId
        : product.sourceEventId,
    canonicalShippingResolved: eventMarketPickup
      ? false
      : canonicalShippingResolved,
    shippingWeightGrams: product.shippingWeightGrams,
    shippingWeightAllowanceGrams: product.shippingWeightAllowanceGrams,
    shippingHandling: product.shippingHandling
      ? { ...product.shippingHandling }
      : undefined,
    signedProductEvent: product.signedProductEvent,
    publicZapEnabled: product.publicZapEnabled,
    zapMessagePolicy: product.zapMessagePolicy,
    publicZapPolicyKnown: product.publicZapPolicyKnown,
    stock: product.stock,
  }
}

export function getCartItemFulfillmentType(
  item: Pick<CartItem, "format" | "fulfillment">
): CartItemFulfillment["type"] {
  if (item.fulfillment?.type === "event_market_pickup")
    return "event_market_pickup"
  if (item.format === "digital" || item.fulfillment?.type === "digital") {
    return "digital"
  }
  return "shipping"
}

export function isPickupCartItem(
  item: Pick<CartItem, "format" | "fulfillment">
): item is Pick<CartItem, "format" | "fulfillment"> & {
  fulfillment: CartEventMarketPickupFulfillment
} {
  return item.fulfillment?.type === "event_market_pickup"
}

export function getCartFulfillmentLane(
  items: Array<Pick<CartItem, "format" | "fulfillment">>
): CartFulfillmentLane {
  if (items.length === 0) return "empty"

  let hasShipping = false
  let hasPickup = false
  for (const item of items) {
    const type = getCartItemFulfillmentType(item)
    if (type === "shipping") hasShipping = true
    if (type === "event_market_pickup") hasPickup = true
  }

  if (hasShipping && hasPickup) return "mixed_shipping_pickup"
  if (hasPickup) return "pickup"
  if (hasShipping) return "shipping"
  return "digital"
}

export function getMixedFulfillmentBlockingMessage(
  items: Array<Pick<CartItem, "format" | "fulfillment">>
): string | null {
  if (getCartFulfillmentLane(items) === "mixed_shipping_pickup") {
    return "Shipping and event pickup cannot be combined in one merchant order yet. Place them as separate orders."
  }

  const marketItems = items.filter(
    (item) => item.fulfillment?.type === "event_market_pickup"
  )
  const firstMarket = marketItems[0]?.fulfillment
  if (
    firstMarket?.type === "event_market_pickup" &&
    marketItems.some(
      (item) =>
        item.fulfillment?.type !== "event_market_pickup" ||
        item.fulfillment.market.coordinate !== firstMarket.market.coordinate ||
        item.fulfillment.calendar.coordinate !==
          firstMarket.calendar.coordinate ||
        item.fulfillment.merchantPubkey !== firstMarket.merchantPubkey
    )
  ) {
    return "These items belong to different Event Markets. Place them as separate orders."
  }

  if (
    firstMarket?.type === "event_market_pickup" &&
    marketItems.some((item) => {
      const current = item.fulfillment
      return (
        current?.type !== "event_market_pickup" ||
        current.calendar.eventId !== firstMarket.calendar.eventId ||
        current.grant.eventId !== firstMarket.grant.eventId ||
        current.mode !== firstMarket.mode ||
        current.assignment !== firstMarket.assignment
      )
    })
  )
    return "Review these items against the same current signed Event Market terms before checkout."

  return null
}

export function isSameCartFulfillment(
  left: Pick<CartItem, "format" | "fulfillment">,
  right: Pick<CartItem, "format" | "fulfillment">
): boolean {
  const leftType = getCartItemFulfillmentType(left)
  const rightType = getCartItemFulfillmentType(right)
  if (leftType !== rightType) return false
  if (leftType === "event_market_pickup") {
    return (
      left.fulfillment?.type === "event_market_pickup" &&
      right.fulfillment?.type === "event_market_pickup" &&
      left.fulfillment.market.coordinate ===
        right.fulfillment.market.coordinate &&
      left.fulfillment.calendar.coordinate ===
        right.fulfillment.calendar.coordinate &&
      left.fulfillment.merchantPubkey === right.fulfillment.merchantPubkey &&
      left.fulfillment.payeePubkey === right.fulfillment.payeePubkey
    )
  }
  return true
}

export function getCartProductAvailability(
  items: CartItem[],
  refreshedProducts: Product[]
): CartProductAvailability[] {
  const productsByItemKey = new Map(
    refreshedProducts.map((product) => [
      getCartItemKey({
        merchantPubkey: product.pubkey,
        productId: product.id,
      }),
      product,
    ])
  )

  return items.map((item) => {
    const refreshedProduct = productsByItemKey.get(getCartItemKey(item))
    const stock = refreshedProduct ? refreshedProduct.stock : item.stock

    return {
      productId: item.productId,
      merchantPubkey: item.merchantPubkey,
      status:
        stock === 0
          ? "sold_out"
          : typeof stock === "number" && item.quantity > stock
            ? "insufficient_stock"
            : typeof stock === "number"
              ? "available"
              : "untracked",
      stock,
      ...(refreshedProduct
        ? {
            productUpdatedAt: refreshedProduct.updatedAt,
            ...(refreshedProduct.sourceEventId
              ? { productEventId: refreshedProduct.sourceEventId }
              : {}),
          }
        : {}),
      refreshed: !!refreshedProduct,
    }
  })
}

export function isCartProductAvailabilityBlocking(
  availability: Pick<CartProductAvailability, "status"> | undefined
): boolean {
  return (
    availability?.status === "sold_out" ||
    availability?.status === "insufficient_stock"
  )
}

export function getCartAvailabilityBlockingMessage(
  items: CartItem[],
  availabilityByProductId: ReadonlyMap<string, CartProductAvailability>
): string | null {
  const unavailableItems: Array<{
    item: CartItem
    availability: CartProductAvailability
  }> = []

  for (const item of items) {
    const availability = availabilityByProductId.get(item.productId)
    if (availability && isCartProductAvailabilityBlocking(availability)) {
      unavailableItems.push({ item, availability })
    }
  }

  if (unavailableItems.length === 0) return null

  if (unavailableItems.length === 1) {
    const { item, availability } = unavailableItems[0]!
    if (availability.status === "sold_out") {
      return `${item.title} is sold out. Remove it from your cart before sending the order.`
    }

    return `${item.title} has only ${availability.stock ?? 0} available, but your cart contains ${item.quantity}. Reduce the quantity before sending the order.`
  }

  const soldOutCount = unavailableItems.filter(
    ({ availability }) => availability.status === "sold_out"
  ).length
  if (soldOutCount === unavailableItems.length) {
    return `${soldOutCount} items are sold out. Remove them from your cart before sending the order.`
  }
  if (soldOutCount === 0) {
    return `${unavailableItems.length} cart quantities exceed current stock. Reduce them before sending the order.`
  }

  return "Some items are sold out or exceed current stock. Update your cart before sending the order."
}

const AVAILABILITY_ISSUE_PRIORITY: readonly ProductAvailabilityIssue[] = [
  "invalid_product_reference",
  "product_missing",
  "listing_filtered",
  "lookup_unavailable",
  "lookup_partial",
  "cached_only",
  "pending",
]

function describeAvailabilityIssue(
  issue: ProductAvailabilityIssue,
  titles: string[]
): string {
  const single = titles.length === 1
  const subject = single ? titles[0]! : `${titles.length} items`
  switch (issue) {
    case "invalid_product_reference":
      return `${subject} ${single ? "has" : "have"} an invalid product reference. Remove ${single ? "it" : "them"} from your cart and add ${single ? "it" : "them"} again.`
    case "product_missing":
      return `${subject} could not be found on the configured relays. The listing may have been removed.`
    case "listing_filtered":
      return `${subject} ${single ? "is" : "are"} not publicly listed right now.`
    case "lookup_unavailable":
      return "Product availability could not be checked because no relay responded. Check your connection and try again."
    case "lookup_partial":
      return `Some relays did not respond, so availability for ${subject} could not be confirmed. Try again.`
    case "pending":
      return `Availability for ${subject} is still being checked.`
    case "cached_only":
      return `${subject} ${single ? "was" : "were"} confirmed only from a local snapshot. Try again to verify current availability.`
  }
}

export function getCartAvailabilityReadDecision(input: {
  productIds: readonly string[]
  availability: readonly CartProductAvailability[]
  meta: CartAvailabilityReadMeta | undefined
  diagnostics: readonly ProductAvailabilityDiagnostic[]
  querySucceeded: boolean
}): CartAvailabilityReadDecision {
  if (!input.querySucceeded) {
    return {
      status: "unverified",
      reason: "query_failed",
      diagnostics: input.diagnostics,
    }
  }

  const requestedProductIds = Array.from(new Set(input.productIds))
  const requestedProductIdSet = new Set(requestedProductIds)
  const diagnosticsByProductId = new Map(
    input.diagnostics.map((diagnostic) => [diagnostic.productId, diagnostic])
  )
  const availabilityByProductId = new Map(
    input.availability.map((entry) => [entry.productId, entry])
  )
  const exactEvidenceShape =
    requestedProductIds.length > 0 &&
    input.diagnostics.length === requestedProductIds.length &&
    diagnosticsByProductId.size === requestedProductIds.length &&
    input.availability.length === requestedProductIds.length &&
    availabilityByProductId.size === requestedProductIds.length &&
    input.diagnostics.every((diagnostic) =>
      requestedProductIdSet.has(diagnostic.productId)
    ) &&
    input.availability.every((entry) =>
      requestedProductIdSet.has(entry.productId)
    )

  if (!exactEvidenceShape) {
    return {
      status: "unverified",
      reason: "evidence_mismatch",
      diagnostics: input.diagnostics,
    }
  }

  const issue = AVAILABILITY_ISSUE_PRIORITY.find((candidate) =>
    input.diagnostics.some((diagnostic) => diagnostic.issue === candidate)
  )
  if (issue) {
    return {
      status: "unverified",
      reason: issue,
      diagnostics: input.diagnostics,
    }
  }

  const hasExactLiveEvidence = input.diagnostics.every((diagnostic) =>
    hasExactLiveProductAvailabilityEvidence(diagnostic, diagnostic.productId)
  )
  const hasRefreshedAvailability = input.availability.every(
    (entry) => entry.refreshed
  )
  if (
    input.meta?.source !== "commerce" ||
    !hasExactLiveEvidence ||
    !hasRefreshedAvailability
  ) {
    return {
      status: "unverified",
      reason: "evidence_mismatch",
      diagnostics: input.diagnostics,
    }
  }

  const partialCoverage = input.diagnostics.some(
    (diagnostic) =>
      diagnostic.coverage?.listing !== "complete" ||
      diagnostic.coverage.deletion !== "complete"
  )

  return {
    status: "verified_at_read",
    coverage: partialCoverage ? "partial" : "complete",
  }
}

/**
 * Map a typed checkout read decision to a blocking message. The cart is never
 * cleared by these states; the buyer retries or edits the cart.
 */
export function getCartAvailabilityVerificationMessage(
  items: CartItem[],
  decision: CartAvailabilityReadDecision
): string | null {
  if (decision.status === "verified_at_read") return null
  if (decision.reason === "query_failed") {
    return "Product availability could not be checked. Check your connection and try again."
  }
  if (decision.reason === "evidence_mismatch") {
    return "Current product availability could not be verified. Check your connection and try again."
  }

  const titleByProductId = new Map(
    items.map((item) => [item.productId, item.title])
  )
  const titles: string[] = []
  for (const entry of decision.diagnostics) {
    if (entry.issue !== decision.reason) continue
    titles.push(titleByProductId.get(entry.productId) ?? "A product in cart")
  }
  return describeAvailabilityIssue(decision.reason, titles)
}

export function isCartAvailabilityReadComplete(
  decision: CartAvailabilityReadDecision
): boolean {
  return (
    decision.status === "verified_at_read" && decision.coverage === "complete"
  )
}

export function getCartItemStockForAvailability(
  item: Pick<CartItem, "stock">,
  availability: Pick<CartProductAvailability, "stock" | "refreshed"> | undefined
): number | undefined {
  return availability?.refreshed ? availability.stock : item.stock
}

export function getCartItemStockEvidenceForAvailability(
  availability:
    | Pick<
        CartProductAvailability,
        "stock" | "productUpdatedAt" | "productEventId" | "refreshed"
      >
    | undefined
): CartItemStockEvidence | undefined {
  if (!availability?.refreshed) return undefined
  return {
    stock: availability.stock,
    productUpdatedAt: availability.productUpdatedAt,
    ...(availability.productEventId
      ? { productEventId: availability.productEventId }
      : {}),
  }
}

const ZAP_MESSAGE_POLICY_RANK: Record<ProductZapMessagePolicy, number> = {
  generic_only: 0,
  custom: 1,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function normalizedEventId(value: unknown): string | undefined {
  const eventId = nonemptyString(value)?.toLowerCase()
  return eventId && /^[0-9a-f]{64}$/.test(eventId) ? eventId : undefined
}

function finiteNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  )
  return strings.length === value.length ? strings : undefined
}

function parseSourcePrice(value: unknown): CartItem["sourcePrice"] {
  if (!isRecord(value)) return undefined
  const amount = finiteNonnegativeNumber(value.amount)
  const currency = nonemptyString(value.currency)
  const normalizedCurrency = nonemptyString(value.normalizedCurrency)
  if (amount === undefined || !currency || !normalizedCurrency) return undefined
  return { amount, currency, normalizedCurrency }
}

function parseShippingRules(value: unknown): CartItem["shippingCountryRules"] {
  if (!Array.isArray(value)) return undefined
  const rules: NonNullable<CartItem["shippingCountryRules"]> = []
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined
    const code = nonemptyString(candidate.code)
    const name = nonemptyString(candidate.name)
    const restrictTo = optionalStringArray(candidate.restrictTo)
    const exclude = optionalStringArray(candidate.exclude)
    if (!code || !name || !restrictTo || !exclude) return undefined
    rules.push({ code, name, restrictTo, exclude })
  }
  return rules
}

function parseSpecifications(
  value: unknown
): CartItem["selectedSpecifications"] {
  if (!Array.isArray(value)) return undefined
  const specifications: NonNullable<CartItem["selectedSpecifications"]> = []
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined
    const key = nonemptyString(candidate.key)
    const specificationValue = nonemptyString(candidate.value)
    if (!key || !specificationValue) return undefined
    specifications.push({ key, value: specificationValue })
  }
  return specifications
}

function parseCartItem(value: unknown): CartItem | null {
  if (!isRecord(value)) return null
  const storedProductId = nonemptyString(value.productId)
  const merchantPubkey = nonemptyString(value.merchantPubkey)
  const title = nonemptyString(value.title)
  const currency = nonemptyString(value.currency)
  const price = finiteNonnegativeNumber(value.price)
  const quantityValue = finiteNonnegativeNumber(value.quantity)
  if (
    !storedProductId ||
    !merchantPubkey ||
    !title ||
    !currency ||
    price === undefined ||
    quantityValue === undefined ||
    quantityValue <= 0
  ) {
    return null
  }
  const productId = normalizeProductCoordinate(storedProductId, merchantPubkey)
  if (!productId) return null

  const quantity = Math.max(1, Math.floor(quantityValue))
  const merchantAddedAt = finiteNonnegativeNumber(value.merchantAddedAt)
  const priceSats = finiteNonnegativeNumber(value.priceSats)
  const shippingCostSats = finiteNonnegativeNumber(value.shippingCostSats)
  const shippingWeightGrams = finiteNonnegativeNumber(value.shippingWeightGrams)
  const shippingWeightAllowanceGrams = finiteNonnegativeNumber(
    value.shippingWeightAllowanceGrams
  )
  const shippingHandling = parseSourcePrice(value.shippingHandling)
  const parsedPolicyQuote = shippingPolicyQuoteSchema.safeParse(
    value.shippingPolicyQuote
  )
  const productUpdatedAt = finiteNonnegativeNumber(value.productUpdatedAt)
  const productEventId = normalizedEventId(value.productEventId)
  // Storage hydration admits exact signed bytes before this synchronous parser.
  const signedProductEvent = isVerifiedNostrEvent(value.signedProductEvent)
    ? value.signedProductEvent
    : undefined
  const stock = finiteNonnegativeNumber(value.stock)
  const selectedSpecifications = parseSpecifications(
    value.selectedSpecifications
  )
  const sourcePrice = parseSourcePrice(value.sourcePrice)
  const sourceShippingCost = parseSourcePrice(value.sourceShippingCost)
  const tags = optionalStringArray(value.tags)
  const shippingCountries = optionalStringArray(value.shippingCountries)
  const shippingCountryRules = parseShippingRules(value.shippingCountryRules)
  const format =
    value.format === "digital" || value.format === "physical"
      ? value.format
      : undefined
  let fulfillment: CartItemFulfillment | undefined
  if (value.fulfillment !== undefined) {
    const fulfillmentResult = orderItemFulfillmentSchema.safeParse(
      value.fulfillment
    )
    if (!fulfillmentResult.success) return null
    // Historical signed orders retain this snapshot in Core, but an unpaid
    // persisted cart cannot restart the retired collection-based pickup lane.
    if (fulfillmentResult.data.type === "pickup") return null
    fulfillment = fulfillmentResult.data
  }
  const marketContext = isRecord(value.eventMarketContext)
    ? value.eventMarketContext
    : null
  const marketCoordinate =
    marketContext && typeof marketContext.marketCoordinate === "string"
      ? parseAddressableCoordinate(marketContext.marketCoordinate, [30409])
          ?.coordinate
      : undefined
  const calendarCoordinate =
    marketContext && typeof marketContext.calendarCoordinate === "string"
      ? parseAddressableCoordinate(
          marketContext.calendarCoordinate,
          [31922, 31923]
        )?.coordinate
      : undefined
  const zapMessagePolicy = normalizeCartZapMessagePolicy(value.zapMessagePolicy)

  return {
    productId,
    merchantPubkey,
    title,
    price,
    currency,
    quantity,
    ...(merchantAddedAt !== undefined ? { merchantAddedAt } : {}),
    ...(nonemptyString(value.familyProductId)
      ? { familyProductId: String(value.familyProductId) }
      : {}),
    ...(selectedSpecifications ? { selectedSpecifications } : {}),
    ...(priceSats !== undefined ? { priceSats } : {}),
    ...(sourcePrice ? { sourcePrice } : {}),
    ...(nonemptyString(value.image) ? { image: String(value.image) } : {}),
    ...(tags ? { tags } : {}),
    ...(format ? { format } : {}),
    ...(fulfillment ? { fulfillment } : {}),
    ...(marketCoordinate && calendarCoordinate
      ? { eventMarketContext: { marketCoordinate, calendarCoordinate } }
      : {}),
    ...(shippingWeightGrams !== undefined &&
    Number.isSafeInteger(shippingWeightGrams) &&
    shippingWeightGrams > 0
      ? { shippingWeightGrams }
      : {}),
    ...(shippingWeightAllowanceGrams !== undefined &&
    Number.isSafeInteger(shippingWeightAllowanceGrams)
      ? { shippingWeightAllowanceGrams }
      : {}),
    ...(shippingHandling ? { shippingHandling } : {}),
    ...(parsedPolicyQuote.success
      ? { shippingPolicyQuote: parsedPolicyQuote.data }
      : {}),
    ...(shippingCostSats !== undefined ? { shippingCostSats } : {}),
    ...(stock !== undefined ? { stock } : {}),
    ...(sourceShippingCost ? { sourceShippingCost } : {}),
    ...(nonemptyString(value.shippingOptionId)
      ? { shippingOptionId: String(value.shippingOptionId) }
      : {}),
    ...(nonemptyString(value.shippingOptionDTag)
      ? { shippingOptionDTag: String(value.shippingOptionDTag) }
      : {}),
    ...(typeof value.shippingOptionLaunchUnsupported === "boolean"
      ? {
          shippingOptionLaunchUnsupported:
            value.shippingOptionLaunchUnsupported,
        }
      : {}),
    ...(shippingCountries ? { shippingCountries } : {}),
    ...(shippingCountryRules ? { shippingCountryRules } : {}),
    ...(productUpdatedAt !== undefined ? { productUpdatedAt } : {}),
    ...(productEventId ? { productEventId } : {}),
    ...(signedProductEvent ? { signedProductEvent } : {}),
    ...(typeof value.canonicalShippingResolved === "boolean"
      ? { canonicalShippingResolved: value.canonicalShippingResolved }
      : {}),
    ...(typeof value.publicZapEnabled === "boolean"
      ? { publicZapEnabled: value.publicZapEnabled }
      : {}),
    ...(zapMessagePolicy ? { zapMessagePolicy } : {}),
    ...(typeof value.publicZapPolicyKnown === "boolean"
      ? { publicZapPolicyKnown: value.publicZapPolicyKnown }
      : {}),
  }
}

export function getCartItemKey(identity: CartItemIdentity): string {
  return JSON.stringify([identity.merchantPubkey, identity.productId])
}

export function isSameCartItem(
  item: CartItemIdentity,
  identity: CartItemIdentity
): boolean {
  return (
    item.merchantPubkey === identity.merchantPubkey &&
    item.productId === identity.productId &&
    (!identity.cartLineId || item.cartLineId === identity.cartLineId)
  )
}

export function selectCartItem(
  items: readonly CartItem[],
  identity: CartItemIdentity
): CartItem | undefined {
  return items.find((item) => isSameCartItem(item, identity))
}

function shippingQuoteTermsFingerprint(
  quote: ShippingPolicyQuote | undefined
): string | null {
  if (!quote) return null
  // Event ids commit to the complete signed body. Schnorr signature randomness
  // and JSON property order cannot change the shopper's reviewed terms.
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (isRecord(value))
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "sig")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonicalize(entry)])
      )
    return value
  }
  return JSON.stringify(canonicalize(quote))
}

export function getCartCommerceFingerprint(items: readonly CartItem[]): string {
  return JSON.stringify(
    items
      .map((item) => ({
        merchantPubkey: item.merchantPubkey,
        productId: item.productId,
        familyProductId: item.familyProductId ?? null,
        selectedSpecifications:
          item.selectedSpecifications?.map((specification) => ({
            key: specification.key,
            value: specification.value,
          })) ?? null,
        quantity: item.quantity,
        price: item.price,
        currency: item.currency,
        priceSats: item.priceSats ?? null,
        sourcePrice: item.sourcePrice ?? null,
        format: item.format ?? "physical",
        fulfillment:
          item.fulfillment?.type === "event_market_pickup"
            ? { ...item.fulfillment }
            : getCartItemFulfillmentType(item),
        shippingWeightGrams: item.shippingWeightGrams ?? null,
        shippingWeightAllowanceGrams: item.shippingWeightAllowanceGrams ?? null,
        shippingHandling: item.shippingHandling ?? null,
        shippingPolicyQuote: shippingQuoteTermsFingerprint(
          item.shippingPolicyQuote
        ),
        shippingCostSats: item.shippingCostSats ?? null,
        sourceShippingCost: item.sourceShippingCost ?? null,
        shippingOptionId: item.shippingOptionId ?? null,
        shippingOptionDTag: item.shippingOptionDTag ?? null,
        shippingCountries: item.shippingCountries ?? null,
        shippingCountryRules: item.shippingCountryRules ?? null,
        publicZapEnabled: item.publicZapEnabled ?? null,
        zapMessagePolicy: item.zapMessagePolicy ?? null,
        publicZapPolicyKnown: item.publicZapPolicyKnown ?? null,
      }))
      .sort((a, b) =>
        `${a.merchantPubkey}:${a.productId}`.localeCompare(
          `${b.merchantPubkey}:${b.productId}`
        )
      )
  )
}

export function rebuildCurrentCartItems(
  items: readonly CartItem[],
  products: readonly Product[],
  currentFulfillmentByProductId?: ReadonlyMap<string, CartItemFulfillment>
): CartItem[] | null {
  const productsByKey = new Map(
    products.map((product) => [
      getCartItemKey({
        merchantPubkey: product.pubkey,
        productId: product.id,
      }),
      product,
    ])
  )
  const currentItems: CartItem[] = []
  for (const item of items) {
    const product = productsByKey.get(getCartItemKey(item))
    if (!product || product.type === "variable") return null
    currentItems.push({
      ...createCartItemFromProduct(
        product,
        currentFulfillmentByProductId?.get(product.id)
      ),
      familyProductId:
        product.type === "variation" ? product.parentProductId : undefined,
      selectedSpecifications:
        product.type === "variation"
          ? product.specifications.map((specification) => ({
              ...specification,
            }))
          : undefined,
      eventMarketContext: item.eventMarketContext,
      quantity: item.quantity,
    })
  }
  return currentItems
}

export function cartItemsMatchCurrentProducts(
  items: readonly CartItem[],
  products: readonly Product[],
  currentFulfillmentByProductId?: ReadonlyMap<string, CartItemFulfillment>
): boolean {
  const currentItems = rebuildCurrentCartItems(
    items,
    products,
    currentFulfillmentByProductId
  )
  return (
    currentItems !== null &&
    getCartCommerceFingerprint(currentItems) ===
      getCartCommerceFingerprint(items)
  )
}

export function parsePersistedCart(value: unknown): ParsedPersistedCart {
  if (
    isRecord(value) &&
    "version" in value &&
    value.version !== CART_STORAGE_VERSION
  ) {
    return {
      state: { items: [] },
      shouldPersist: false,
      writable: false,
    }
  }
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return {
      state: { items: [] },
      shouldPersist: false,
      writable: true,
    }
  }

  const parsedItems = value.items
    .map(parseCartItem)
    .filter((item): item is CartItem => item !== null)
  const deduplicated = new Map<string, CartItem>()
  for (const parsedItem of parsedItems) {
    const key = JSON.stringify([
      getCartItemKey(parsedItem),
      getCartLineFulfillmentId(parsedItem),
    ])
    const current = deduplicated.get(key)
    if (!current) {
      deduplicated.set(key, parsedItem)
      continue
    }
    const merchantAddedAt = [
      current.merchantAddedAt,
      parsedItem.merchantAddedAt,
    ].filter((entry): entry is number => entry !== undefined)
    deduplicated.set(key, {
      ...current,
      ...parsedItem,
      ...(merchantAddedAt.length > 0
        ? { merchantAddedAt: Math.min(...merchantAddedAt) }
        : {}),
      quantity: current.quantity + parsedItem.quantity,
    })
  }

  const hasLegacyProductIds = value.items.some(
    (item) =>
      isRecord(item) &&
      typeof item.productId === "string" &&
      !item.productId.startsWith("30402:")
  )

  return {
    state: { items: Array.from(deduplicated.values()) },
    shouldPersist:
      value.version !== CART_STORAGE_VERSION || hasLegacyProductIds,
    writable: true,
  }
}

function normalizeCartZapMessagePolicy(
  value: unknown
): ProductZapMessagePolicy | null {
  if (value === "custom") return "custom"
  if (
    value === "generic_only" ||
    value === "generic" ||
    value === "product_reference" ||
    value === "product"
  ) {
    return "generic_only"
  }
  return null
}

function getMostRestrictiveZapMessagePolicy(
  current: ProductZapMessagePolicy,
  next: ProductZapMessagePolicy
): ProductZapMessagePolicy {
  return ZAP_MESSAGE_POLICY_RANK[next] < ZAP_MESSAGE_POLICY_RANK[current]
    ? next
    : current
}

export function getCartPublicZapPolicy(items: CartItem[]): CartPublicZapPolicy {
  let effectiveZapMessagePolicy: ProductZapMessagePolicy = "custom"
  const disabledProductIds: string[] = []
  const missingPolicyProductIds: string[] = []

  for (const item of items) {
    if (item.publicZapPolicyKnown !== true) {
      missingPolicyProductIds.push(item.productId)
    }

    if (item.publicZapEnabled === false) {
      disabledProductIds.push(item.productId)
    } else if (item.publicZapEnabled !== true) {
      missingPolicyProductIds.push(item.productId)
    }

    const normalizedZapMessagePolicy = normalizeCartZapMessagePolicy(
      item.zapMessagePolicy
    )
    if (normalizedZapMessagePolicy) {
      effectiveZapMessagePolicy = getMostRestrictiveZapMessagePolicy(
        effectiveZapMessagePolicy,
        normalizedZapMessagePolicy
      )
    } else {
      missingPolicyProductIds.push(item.productId)
      effectiveZapMessagePolicy = getMostRestrictiveZapMessagePolicy(
        effectiveZapMessagePolicy,
        "generic_only"
      )
    }
  }

  return {
    publicZapsAllowed:
      items.length > 0 &&
      disabledProductIds.length === 0 &&
      missingPolicyProductIds.length === 0,
    effectiveZapMessagePolicy:
      items.length === 0 ? "generic_only" : effectiveZapMessagePolicy,
    disabledProductIds: Array.from(new Set(disabledProductIds)),
    missingPolicyProductIds: Array.from(new Set(missingPolicyProductIds)),
  }
}

export function groupCartItems(items: CartItem[]): MerchantCartGroup[] {
  const byMerchant = new Map<
    string,
    {
      items: CartItem[]
      merchantAddedAt: number
      firstSeenIndex: number
    }
  >()
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (!item) continue

    const orderKey = item.merchantAddedAt ?? index
    const current = byMerchant.get(item.merchantPubkey)
    if (current) {
      current.items.push(item)
      current.merchantAddedAt = Math.min(current.merchantAddedAt, orderKey)
    } else {
      byMerchant.set(item.merchantPubkey, {
        items: [item],
        merchantAddedAt: orderKey,
        firstSeenIndex: index,
      })
    }
  }

  return Array.from(byMerchant.entries())
    .map(([merchantPubkey, group]) => ({
      merchantPubkey,
      items: group.items,
      merchantAddedAt: group.merchantAddedAt,
      firstSeenIndex: group.firstSeenIndex,
      totalItems: group.items.reduce((sum, item) => sum + item.quantity, 0),
    }))
    .sort((a, b) => {
      if (b.merchantAddedAt !== a.merchantAddedAt) {
        return b.merchantAddedAt - a.merchantAddedAt
      }
      return b.firstSeenIndex - a.firstSeenIndex
    })
}

/**
 * Exact local line identity. This intentionally remains stricter than order
 * grouping so a future compatibility expansion cannot rebind quantities that
 * were added under a different signed pickup snapshot.
 */
export function getCartLineFulfillmentId(
  item: Pick<CartItem, "format" | "fulfillment">
): string {
  if (item.fulfillment?.type === "event_market_pickup") {
    return JSON.stringify([
      "event_market_pickup",
      item.fulfillment.market.coordinate,
      item.fulfillment.calendar.coordinate,
      item.fulfillment.product.coordinate,
      item.fulfillment.product.eventId,
      item.fulfillment.mode,
      item.fulfillment.assignment,
    ])
  }
  return getCartItemFulfillmentType(item)
}

export function isSameCartLineFulfillment(
  left: Pick<CartItem, "format" | "fulfillment">,
  right: Pick<CartItem, "format" | "fulfillment">
): boolean {
  return getCartLineFulfillmentId(left) === getCartLineFulfillmentId(right)
}

export function selectCartLine(
  items: readonly CartItem[],
  candidate: Pick<
    CartItem,
    "merchantPubkey" | "productId" | "format" | "fulfillment"
  >
): CartItem | undefined {
  return items.find(
    (item) =>
      isSameCartItem(item, candidate) &&
      isSameCartLineFulfillment(item, candidate)
  )
}

export function getCartPurchaseGroupId(
  item: Pick<CartItem, "merchantPubkey" | "format" | "fulfillment">
): string {
  const compatibility =
    item.fulfillment?.type === "event_market_pickup"
      ? JSON.stringify([
          "event_market_pickup",
          item.fulfillment.market.coordinate,
          item.fulfillment.calendar.coordinate,
          item.fulfillment.merchantPubkey,
          item.fulfillment.payeePubkey,
        ])
      : "delivery"
  return JSON.stringify([item.merchantPubkey, compatibility])
}

/** Stable, display-only cue for distinguishing otherwise identical choices. */
export function getCartPurchaseReference(purchaseId: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < purchaseId.length; index += 1) {
    hash = Math.imul(hash ^ purchaseId.charCodeAt(index), 16_777_619)
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, "0")
}

/**
 * Purchasable partitions preserve the current exact pickup compatibility
 * contract. PRs that intentionally change pickup equivalence should deepen
 * the shared compatibility helper rather than weakening this grouping layer.
 */
export function groupCartPurchases(items: CartItem[]): CartPurchaseGroup[] {
  const merchantOrder = new Map(
    groupCartItems(items).map((group, index) => [
      group.merchantPubkey,
      { merchantAddedAt: group.merchantAddedAt, index },
    ])
  )
  const groups: Array<CartPurchaseGroup & { firstSeenIndex: number }> = []

  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (!item) continue
    const purchaseItem = item
    const kind = isPickupCartItem(item) ? "pickup" : "delivery"
    const compatibleGroups = groups.filter(
      (group) =>
        group.merchantPubkey === item.merchantPubkey &&
        group.kind === kind &&
        (kind === "delivery" || isSameCartFulfillment(group.items[0]!, item))
    )
    const existing = compatibleGroups[0]
    if (existing) {
      existing.items.push(purchaseItem)
      existing.totalItems += purchaseItem.quantity
      continue
    }

    groups.push({
      id: getCartPurchaseGroupId(item),
      kind,
      merchantPubkey: item.merchantPubkey,
      items: [purchaseItem],
      totalItems: purchaseItem.quantity,
      merchantAddedAt:
        merchantOrder.get(item.merchantPubkey)?.merchantAddedAt ??
        item.merchantAddedAt ??
        index,
      firstSeenIndex: index,
    })
  }

  return groups.sort((left, right) => {
    const leftMerchant = merchantOrder.get(left.merchantPubkey)
    const rightMerchant = merchantOrder.get(right.merchantPubkey)
    if ((leftMerchant?.index ?? 0) !== (rightMerchant?.index ?? 0)) {
      return (leftMerchant?.index ?? 0) - (rightMerchant?.index ?? 0)
    }
    return left.firstSeenIndex - right.firstSeenIndex
  })
}

export function getCartTotals(items: CartItem[]): CartTotals {
  return items.reduce(
    (acc, item) => {
      acc.count += item.quantity
      acc.subtotal += (item.priceSats ?? item.price) * item.quantity
      return acc
    },
    { count: 0, subtotal: 0 }
  )
}

export function getCartCostSummary(
  items: CartItem[],
  rateInput: PricingRateInput = null
): CartCostSummary {
  let count = 0
  let itemSubtotalSats = 0
  let itemPricesAvailable = true
  const shippingResolvableItems = items.map((item) => {
    const hasShippingZone =
      item.format === "digital" ||
      isPickupCartItem(item) ||
      (item.canonicalShippingResolved === true &&
        !!item.shippingOptionId &&
        (item.shippingCountryRules?.length ?? 0) > 0)

    return hasShippingZone
      ? item
      : {
          ...item,
          shippingCostSats: undefined,
          sourceShippingCost: undefined,
        }
  })
  const shippingCost = resolveCartShippingCost(
    shippingResolvableItems,
    rateInput
  )
  let shippingReadyForZap = shippingCost.status !== "manual"

  for (const item of items) {
    count += item.quantity

    const price = getPriceSats(item, rateInput, {
      allowZero: isPickupCartItem(item),
    })
    if (price) {
      itemSubtotalSats += price.sats * item.quantity
    } else {
      itemPricesAvailable = false
    }
    if (item.format === "digital") continue

    const hasShippingSnapshot =
      isPickupCartItem(item) ||
      (item.canonicalShippingResolved === true &&
        !!item.shippingOptionId &&
        (item.shippingCountryRules?.length ?? 0) > 0)
    if (!hasShippingSnapshot || getShippingCostSats(item, rateInput) === null) {
      shippingReadyForZap = false
    }
  }

  return {
    count,
    itemSubtotalSats,
    shippingTotalSats: shippingCost.totalSats,
    totalSats: itemSubtotalSats + shippingCost.totalSats,
    itemPricesAvailable,
    shippingReadyForZap,
  }
}
