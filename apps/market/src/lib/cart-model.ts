import {
  EVENT_KINDS,
  getPriceSats,
  getProductImageCandidates,
  getShippingCostSats,
  hasSamePickupFulfillmentGraph,
  hasExactLiveProductAvailabilityEvidence,
  isFiatCurrencyCode,
  normalizeProductCoordinate,
  orderItemFulfillmentSchema,
  parseAddressableCoordinate,
  resolveOrderPickupHandoffAuthority,
  resolveCartShippingCost,
  type CommerceQueryMeta,
  type ProductAvailabilityDiagnostic,
  type ProductAvailabilityIssue,
  type ProductZapMessagePolicy,
  type PricingRateInput,
  type Product,
  type ProductSpecification,
  type OrderPickupFulfillmentSchema,
  type PickupEvidenceCoordinateSchema,
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
  fulfillment?: CartItemFulfillment
  /**
   * Buyer-selected purchase context. This separates a booth candidate from a
   * remote pickup line, but never authorizes stock, price, payment, or handoff.
   */
  purchaseIntent?: CartPurchaseIntent
  /** Per-item shipping cost in sats. Omitted means shipping is coordinated manually. */
  shippingCostSats?: number
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
  /** True only after exact canonical kind-30406 resolution. */
  canonicalShippingResolved?: boolean
  publicZapEnabled?: boolean
  zapMessagePolicy?: ProductZapMessagePolicy
  publicZapPolicyKnown?: boolean
  /** Last known stock value from legacy GammaMarkets-compatible tags. Zero means the item is sold out. */
  stock?: number
  quantity: number
}

export type CartPurchaseIntent = {
  kind: "merchant_present_candidate"
  merchantPubkey: string
  collectionCoordinate: string
}

export type PickupEvidenceCoordinate = PickupEvidenceCoordinateSchema

/** Shared protocol snapshot; Market only persists and displays this shape. */
export type CartPickupFulfillment = OrderPickupFulfillmentSchema

export type CartItemFulfillment =
  { type: "digital" } | { type: "shipping" } | CartPickupFulfillment

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

export type PersistedCartState = {
  version: typeof CART_STORAGE_VERSION
  items: CartItem[]
}

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

export type CartPurchaseGroup = MerchantCartGroup & {
  id: string
  kind: "delivery" | "pickup"
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
  refreshed: boolean
}

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
  const pickup =
    resolvedFulfillment.type === "pickup" ? resolvedFulfillment : null
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
    shippingCostSats: pickup?.costSats ?? product.shippingCostSats,
    sourceShippingCost: pickup?.sourceCost ?? product.sourceShippingCost,
    shippingOptionId: pickup?.option.coordinate ?? product.shippingOptionId,
    shippingOptionDTag:
      pickup?.option.coordinate.split(":").slice(2).join(":") ||
      product.shippingOptionDTag,
    shippingOptionLaunchUnsupported: pickup
      ? undefined
      : product.shippingOptionLaunchUnsupported,
    shippingCountries: pickup ? [] : product.shippingCountries,
    shippingCountryRules: pickup ? [] : product.shippingCountryRules,
    productUpdatedAt: product.updatedAt,
    canonicalShippingResolved: pickup ? false : canonicalShippingResolved,
    publicZapEnabled: product.publicZapEnabled,
    zapMessagePolicy: product.zapMessagePolicy,
    publicZapPolicyKnown: product.publicZapPolicyKnown,
    stock: product.stock,
  }
}

export function getCartItemFulfillmentType(
  item: Pick<CartItem, "format" | "fulfillment">
): CartItemFulfillment["type"] {
  if (item.fulfillment?.type === "pickup") return "pickup"
  if (item.format === "digital" || item.fulfillment?.type === "digital") {
    return "digital"
  }
  return "shipping"
}

export function isPickupCartItem(
  item: Pick<CartItem, "format" | "fulfillment">
): item is Pick<CartItem, "format" | "fulfillment"> & {
  fulfillment: CartPickupFulfillment
} {
  return item.fulfillment?.type === "pickup"
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
    if (type === "pickup") hasPickup = true
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

  const pickupItems = items.filter(isPickupCartItem)
  const firstPickup = pickupItems[0]?.fulfillment
  if (
    firstPickup &&
    pickupItems.some(
      (item) => !hasSamePickupFulfillmentGraph(firstPickup, item.fulfillment)
    )
  ) {
    return "These items have different pickup handlers or event pickup records. Place them as separate orders."
  }

  return null
}

export function isSameCartFulfillment(
  left: Pick<CartItem, "format" | "fulfillment">,
  right: Pick<CartItem, "format" | "fulfillment">
): boolean {
  const leftType = getCartItemFulfillmentType(left)
  const rightType = getCartItemFulfillmentType(right)
  if (leftType !== rightType) return false
  if (leftType !== "pickup" || rightType !== "pickup") return true

  return (
    left.fulfillment?.type === "pickup" &&
    right.fulfillment?.type === "pickup" &&
    hasSamePickupFulfillmentGraph(left.fulfillment, right.fulfillment)
  )
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

function parseCartPurchaseIntent(
  value: unknown
): CartPurchaseIntent | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const merchantPubkey = nonemptyString(value.merchantPubkey)?.toLowerCase()
  const parsedCollection =
    typeof value.collectionCoordinate === "string"
      ? parseAddressableCoordinate(value.collectionCoordinate, [
          EVENT_KINDS.PRODUCT_COLLECTION,
        ])
      : null
  if (
    value.kind !== "merchant_present_candidate" ||
    !merchantPubkey ||
    !/^[0-9a-f]{64}$/.test(merchantPubkey) ||
    !parsedCollection
  ) {
    return null
  }
  return {
    kind: "merchant_present_candidate",
    merchantPubkey,
    collectionCoordinate: parsedCollection.coordinate,
  }
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
  const productUpdatedAt = finiteNonnegativeNumber(value.productUpdatedAt)
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
  const fulfillmentResult =
    value.fulfillment === undefined
      ? null
      : orderItemFulfillmentSchema.safeParse(value.fulfillment)
  if (fulfillmentResult && !fulfillmentResult.success) return null
  const fulfillment = fulfillmentResult?.data
  const purchaseIntent = parseCartPurchaseIntent(value.purchaseIntent)
  if (purchaseIntent === null) return null
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
    ...(purchaseIntent ? { purchaseIntent } : {}),
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

export function selectCartItemQuantity(
  items: readonly CartItem[],
  identity: CartItemIdentity
): number {
  return selectCartItem(items, identity)?.quantity ?? 0
}

export function selectMerchantCartItems(
  items: readonly CartItem[],
  merchantPubkey: string
): CartItem[] {
  return items.filter((item) => item.merchantPubkey === merchantPubkey)
}

function getCartPickupHandoffFingerprint(fulfillment: CartPickupFulfillment): {
  handoffMode: string
  handlerPubkey: string
} {
  const authority = resolveOrderPickupHandoffAuthority(fulfillment)
  return {
    handoffMode: authority.mode,
    handlerPubkey: authority.handlerPubkey,
  }
}

function getCartPurchaseIntentKey(
  purchaseIntent: CartPurchaseIntent | undefined
): string | null {
  return purchaseIntent
    ? JSON.stringify([
        purchaseIntent.kind,
        purchaseIntent.merchantPubkey.toLowerCase(),
        purchaseIntent.collectionCoordinate,
      ])
    : null
}

export function isSameCartPurchaseIntent(
  left: Pick<CartItem, "purchaseIntent">,
  right: Pick<CartItem, "purchaseIntent">
): boolean {
  return (
    getCartPurchaseIntentKey(left.purchaseIntent) ===
    getCartPurchaseIntentKey(right.purchaseIntent)
  )
}

/**
 * A booth intent remains only a candidate until the merchant signs an exact
 * sale authorization. This helper only proves that the local context still
 * matches an explicit merchant-owned event pickup graph.
 */
export function hasCompatibleMerchantPresentPurchaseIntent(
  item: Pick<CartItem, "merchantPubkey" | "fulfillment" | "purchaseIntent">
): item is typeof item & { purchaseIntent: CartPurchaseIntent } {
  const intent = item.purchaseIntent
  const fulfillment = item.fulfillment
  if (!intent || fulfillment?.type !== "pickup") return false
  const authority = resolveOrderPickupHandoffAuthority(fulfillment)
  return (
    intent.kind === "merchant_present_candidate" &&
    intent.merchantPubkey.toLowerCase() === item.merchantPubkey.toLowerCase() &&
    intent.collectionCoordinate === fulfillment.collection.coordinate &&
    fulfillment.handoffMode === "merchant_handoff" &&
    Boolean(fulfillment.handlerPubkey) &&
    !authority.legacySafeDefault &&
    authority.mode === "merchant_handoff" &&
    authority.handlerPubkey.toLowerCase() === item.merchantPubkey.toLowerCase()
  )
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
          item.fulfillment?.type === "pickup"
            ? {
                type: "pickup",
                organizerPubkey: item.fulfillment.organizerPubkey,
                product: {
                  coordinate: item.fulfillment.product.coordinate,
                  eventId: item.fulfillment.product.eventId,
                  createdAt: item.fulfillment.product.createdAt,
                  merchantPubkey: item.fulfillment.product.merchantPubkey,
                },
                calendar: {
                  coordinate: item.fulfillment.calendar.coordinate,
                  eventId: item.fulfillment.calendar.eventId,
                  createdAt: item.fulfillment.calendar.createdAt,
                },
                collection: {
                  coordinate: item.fulfillment.collection.coordinate,
                  eventId: item.fulfillment.collection.eventId,
                  createdAt: item.fulfillment.collection.createdAt,
                },
                option: {
                  coordinate: item.fulfillment.option.coordinate,
                  eventId: item.fulfillment.option.eventId,
                  createdAt: item.fulfillment.option.createdAt,
                  title: item.fulfillment.option.title,
                  location: item.fulfillment.option.location ?? null,
                  geohash: item.fulfillment.option.geohash ?? null,
                },
                ...getCartPickupHandoffFingerprint(item.fulfillment),
                costSats: item.fulfillment.costSats,
                sourceCost: {
                  amount: item.fulfillment.sourceCost.amount,
                  currency: item.fulfillment.sourceCost.currency,
                  normalizedCurrency:
                    item.fulfillment.sourceCost.normalizedCurrency,
                },
              }
            : getCartItemFulfillmentType(item),
        shippingCostSats: item.shippingCostSats ?? null,
        sourceShippingCost: item.sourceShippingCost ?? null,
        shippingOptionId: item.shippingOptionId ?? null,
        shippingOptionDTag: item.shippingOptionDTag ?? null,
        shippingCountries: item.shippingCountries ?? null,
        shippingCountryRules: item.shippingCountryRules ?? null,
        publicZapEnabled: item.publicZapEnabled ?? null,
        zapMessagePolicy: item.zapMessagePolicy ?? null,
        publicZapPolicyKnown: item.publicZapPolicyKnown ?? null,
        purchaseIntent: item.purchaseIntent ?? null,
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
    const currentFulfillment = currentFulfillmentByProductId?.get(product.id)
    const currentPurchaseContext = {
      merchantPubkey: product.pubkey,
      fulfillment: currentFulfillment,
      purchaseIntent: item.purchaseIntent,
    }
    currentItems.push({
      ...createCartItemFromProduct(product, currentFulfillment),
      ...(hasCompatibleMerchantPresentPurchaseIntent(currentPurchaseContext)
        ? { purchaseIntent: currentPurchaseContext.purchaseIntent }
        : {}),
      familyProductId:
        product.type === "variation" ? product.parentProductId : undefined,
      selectedSpecifications:
        product.type === "variation"
          ? product.specifications.map((specification) => ({
              ...specification,
            }))
          : undefined,
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
  const getCurrentTermsFingerprint = (entries: readonly CartItem[]) =>
    getCartCommerceFingerprint(
      entries.map((item) => {
        if (
          item.fulfillment?.type !== "pickup" ||
          !item.sourceShippingCost ||
          !pickupCostSatsAreQuoteDerived(item.sourceShippingCost)
        ) {
          return item
        }
        // Fiat pickup conversions are refreshed at checkout. Their signed
        // source amount remains authoritative while this cached sats value may
        // legitimately move with the quote.
        return {
          ...item,
          fulfillment: { ...item.fulfillment, costSats: 0 },
          shippingCostSats: undefined,
        }
      })
    )
  return (
    currentItems !== null &&
    getCurrentTermsFingerprint(currentItems) ===
      getCurrentTermsFingerprint(items)
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

export function serializeCartState(state: CartState): PersistedCartState {
  return { version: CART_STORAGE_VERSION, items: state.items }
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

function getMerchantAddedAt(
  items: CartItem[],
  merchantPubkey: string
): number | undefined {
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (!item || item.merchantPubkey !== merchantPubkey) continue
    return item.merchantAddedAt ?? index
  }
  return undefined
}

function nextMerchantAddedAt(items: CartItem[]): number {
  const highestExisting = items.reduce((highest, item, index) => {
    return Math.max(highest, item.merchantAddedAt ?? index)
  }, 0)
  return Math.max(Date.now(), highestExisting + 1)
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

function getPickupPurchaseCompatibilityKey(
  fulfillment: CartPickupFulfillment
): string {
  const authority = resolveOrderPickupHandoffAuthority(fulfillment)
  const coordinateIdentity = (coordinate: string) => {
    const [kind, author, ...identifier] = coordinate.split(":")
    return `${kind}:${author?.toLowerCase()}:${identifier.join(":")}`
  }
  const evidence = (entry: PickupEvidenceCoordinate) => [
    coordinateIdentity(entry.coordinate),
    entry.eventId.toLowerCase(),
    entry.createdAt,
  ]
  return JSON.stringify([
    "pickup",
    fulfillment.organizerPubkey.toLowerCase(),
    evidence(fulfillment.calendar),
    evidence(fulfillment.collection),
    evidence(fulfillment.option),
    authority.mode,
    authority.handlerPubkey,
  ])
}

function getPickupLineFulfillmentKey(
  fulfillment: CartPickupFulfillment
): string {
  return JSON.stringify([
    getPickupPurchaseCompatibilityKey(fulfillment),
    fulfillment.product.coordinate,
    fulfillment.product.eventId.toLowerCase(),
    fulfillment.product.createdAt,
    fulfillment.product.merchantPubkey.toLowerCase(),
    fulfillment.option.title,
    fulfillment.option.location ?? null,
    fulfillment.option.geohash ?? null,
    pickupCostSatsAreQuoteDerived(fulfillment.sourceCost)
      ? null
      : fulfillment.costSats,
    fulfillment.sourceCost.amount,
    fulfillment.sourceCost.currency,
    fulfillment.sourceCost.normalizedCurrency,
  ])
}

function pickupCostSatsAreQuoteDerived(
  sourceCost: CartPickupFulfillment["sourceCost"]
): boolean {
  return (
    sourceCost.amount > 0 && isFiatCurrencyCode(sourceCost.normalizedCurrency)
  )
}

/**
 * Exact local line identity. This intentionally remains stricter than order
 * grouping so a future compatibility expansion cannot rebind quantities that
 * were added under a different signed pickup snapshot.
 */
export function getCartLineFulfillmentId(
  item: Pick<CartItem, "format" | "fulfillment" | "purchaseIntent">
): string {
  const fulfillmentId =
    item.fulfillment?.type === "pickup"
      ? getPickupLineFulfillmentKey(item.fulfillment)
      : getCartItemFulfillmentType(item)
  const purchaseIntentKey = getCartPurchaseIntentKey(item.purchaseIntent)
  return purchaseIntentKey
    ? JSON.stringify([fulfillmentId, purchaseIntentKey])
    : fulfillmentId
}

export function isSameCartLineFulfillment(
  left: Pick<CartItem, "format" | "fulfillment" | "purchaseIntent">,
  right: Pick<CartItem, "format" | "fulfillment" | "purchaseIntent">
): boolean {
  return getCartLineFulfillmentId(left) === getCartLineFulfillmentId(right)
}

export function getCartPurchaseGroupId(
  item: Pick<
    CartItem,
    "merchantPubkey" | "format" | "fulfillment" | "purchaseIntent"
  >
): string {
  const compatibility =
    item.fulfillment?.type === "pickup"
      ? getPickupPurchaseCompatibilityKey(item.fulfillment)
      : "delivery"
  const purchaseIntentKey = getCartPurchaseIntentKey(item.purchaseIntent)
  return purchaseIntentKey
    ? JSON.stringify([item.merchantPubkey, compatibility, purchaseIntentKey])
    : JSON.stringify([item.merchantPubkey, compatibility])
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
    const kind = isPickupCartItem(item) ? "pickup" : "delivery"
    const existing = groups.find(
      (group) =>
        group.merchantPubkey === item.merchantPubkey &&
        group.kind === kind &&
        isSameCartPurchaseIntent(group.items[0]!, item) &&
        (kind === "delivery" || isSameCartFulfillment(group.items[0]!, item))
    )
    if (existing) {
      existing.items.push(item)
      existing.totalItems += item.quantity
      continue
    }

    groups.push({
      id: getCartPurchaseGroupId(item),
      kind,
      merchantPubkey: item.merchantPubkey,
      items: [item],
      totalItems: item.quantity,
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

export function selectCartPurchase(
  items: CartItem[],
  purchaseId: string
): CartPurchaseGroup | undefined {
  return groupCartPurchases(items).find((group) => group.id === purchaseId)
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

export function addCartItem(
  items: CartItem[],
  item: CartItemInput & { merchantAddedAt?: number },
  quantity = 1
): CartItem[] {
  if (item.stock === 0) return items

  const q = Math.max(1, Math.floor(quantity))
  const existing = items.find(
    (current) =>
      isSameCartItem(current, item) && isSameCartLineFulfillment(current, item)
  )
  const merchantAddedAt =
    getMerchantAddedAt(items, item.merchantPubkey) ??
    item.merchantAddedAt ??
    nextMerchantAddedAt(items)

  if (existing) {
    const nextQuantity = currentCartQuantity(existing) + q
    if (typeof item.stock === "number" && nextQuantity > item.stock) {
      return items
    }
    return items.map((current) =>
      current === existing
        ? {
            ...current,
            ...item,
            merchantAddedAt: current.merchantAddedAt ?? merchantAddedAt,
            quantity: current.quantity + q,
          }
        : current
    )
  }

  if (typeof item.stock === "number" && q > item.stock) return items
  return [...items, { ...item, merchantAddedAt, quantity: q }]
}

function currentCartQuantity(item: CartItem): number {
  return Math.max(1, Math.floor(item.quantity))
}

export function setCartItemQuantity(
  items: CartItem[],
  identity: CartItemIdentity,
  quantity: number
): CartItem[] {
  const q = Math.max(1, Math.floor(quantity))
  return items.map((item) =>
    isSameCartItem(item, identity) ? { ...item, quantity: q } : item
  )
}

export function removeCartItem(
  items: CartItem[],
  identity: CartItemIdentity
): CartItem[] {
  return items.filter((item) => !isSameCartItem(item, identity))
}

export function clearMerchantCart(
  items: CartItem[],
  merchantPubkey: string
): CartItem[] {
  return items.filter((item) => item.merchantPubkey !== merchantPubkey)
}
