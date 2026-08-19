import {
  getPriceSats,
  getProductImageCandidates,
  getShippingCostSats,
  hasExactLiveProductAvailabilityEvidence,
  resolveCartShippingCost,
  type CommerceQueryMeta,
  type ProductAvailabilityDiagnostic,
  type ProductAvailabilityIssue,
  type ProductZapMessagePolicy,
  type PricingRateInput,
  type Product,
  type ProductSpecification,
} from "@conduit/core"

export type CartItem = {
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
  /** Per-item shipping cost in sats. Omitted means shipping is coordinated manually. */
  shippingCostSats?: number
  sourceShippingCost?: {
    amount: number
    currency: string
    normalizedCurrency: string
  }
  shippingOptionId?: string
  shippingOptionDTag?: string
  shippingCountries?: string[]
  shippingCountryRules?: Array<{
    code: string
    name: string
    restrictTo: string[]
    exclude: string[]
  }>
  publicZapEnabled?: boolean
  zapMessagePolicy?: ProductZapMessagePolicy
  publicZapPolicyKnown?: boolean
  /** Last known stock value from legacy GammaMarkets-compatible tags. Zero means the item is sold out. */
  stock?: number
  quantity: number
}

export type CartState = {
  items: CartItem[]
}

export type MerchantCartGroup = {
  merchantPubkey: string
  items: CartItem[]
  totalItems: number
  merchantAddedAt: number
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
  canZapOut: boolean
}

export type CartPublicZapPolicy = {
  publicZapsAllowed: boolean
  effectiveZapMessagePolicy: ProductZapMessagePolicy
  disabledProductIds: string[]
  missingPolicyProductIds: string[]
}

export type CartProductAvailability = {
  productId: string
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
  product: Product
): Omit<CartItem, "quantity"> {
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
    shippingCostSats: product.shippingCostSats,
    sourceShippingCost: product.sourceShippingCost,
    shippingOptionId: product.shippingOptionId,
    shippingOptionDTag: product.shippingOptionDTag,
    shippingCountries: product.shippingCountries,
    shippingCountryRules: product.shippingCountryRules,
    publicZapEnabled: product.publicZapEnabled,
    zapMessagePolicy: product.zapMessagePolicy,
    publicZapPolicyKnown: product.publicZapPolicyKnown,
    stock: product.stock,
  }
}

export function getCartProductAvailability(
  items: CartItem[],
  refreshedProducts: Product[]
): CartProductAvailability[] {
  const productsById = new Map(
    refreshedProducts.map((product) => [product.id, product])
  )

  return items.map((item) => {
    const refreshedProduct = productsById.get(item.productId)
    const stock = refreshedProduct ? refreshedProduct.stock : item.stock

    return {
      productId: item.productId,
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
      !!item.shippingOptionId ||
      (item.shippingCountryRules?.length ?? 0) > 0

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

    const price = getPriceSats(item, rateInput)
    if (price) {
      itemSubtotalSats += price.sats * item.quantity
    } else {
      itemPricesAvailable = false
    }
    if (item.format === "digital") continue

    const hasShippingSnapshot = (item.shippingCountryRules?.length ?? 0) > 0
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
    canZapOut: itemPricesAvailable && shippingReadyForZap,
  }
}

export function addCartItem(
  items: CartItem[],
  item: Omit<CartItem, "quantity">,
  quantity = 1
): CartItem[] {
  if (item.stock === 0) return items

  const q = Math.max(1, Math.floor(quantity))
  const existing = items.find((current) => current.productId === item.productId)
  const merchantAddedAt =
    getMerchantAddedAt(items, item.merchantPubkey) ??
    item.merchantAddedAt ??
    nextMerchantAddedAt(items)

  if (existing) {
    return items.map((current) =>
      current.productId === item.productId
        ? {
            ...current,
            ...item,
            merchantAddedAt: current.merchantAddedAt ?? merchantAddedAt,
            quantity: current.quantity + q,
          }
        : current
    )
  }

  return [...items, { ...item, merchantAddedAt, quantity: q }]
}

export function setCartItemQuantity(
  items: CartItem[],
  productId: string,
  quantity: number
): CartItem[] {
  const q = Math.max(1, Math.floor(quantity))
  return items.map((item) =>
    item.productId === productId ? { ...item, quantity: q } : item
  )
}

export function removeCartItem(
  items: CartItem[],
  productId: string
): CartItem[] {
  return items.filter((item) => item.productId !== productId)
}

export function clearMerchantCart(
  items: CartItem[],
  merchantPubkey: string
): CartItem[] {
  return items.filter((item) => item.merchantPubkey !== merchantPubkey)
}
