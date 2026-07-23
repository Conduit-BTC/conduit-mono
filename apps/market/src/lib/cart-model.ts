import {
  getPriceSats,
  getShippingCostSats,
  resolveCartShippingCost,
  type CommerceQueryMeta,
  type Product,
  type ProductZapMessagePolicy,
  type PricingRateInput,
} from "@conduit/core"

export const CART_STORAGE_VERSION = 2

export type CartItem = {
  productId: string
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
  /** Last known GammaMarkets stock value. Zero means the item is sold out. */
  stock?: number
  quantity: number
}

export type CartState = {
  items: CartItem[]
}

export type CartItemIdentity = Pick<CartItem, "merchantPubkey" | "productId">

export type CartItemInput = Omit<CartItem, "merchantAddedAt" | "quantity">

export type PersistedCartState = {
  version: typeof CART_STORAGE_VERSION
  items: CartItem[]
}

export type ParsedPersistedCart = {
  state: CartState
  shouldPersist: boolean
  supported: boolean
  writable: boolean
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
  merchantPubkey: string
  status: "available" | "sold_out" | "insufficient_stock" | "untracked"
  stock?: number
  refreshed: boolean
}

type CartAvailabilityReadMeta = Pick<
  CommerceQueryMeta,
  "source" | "stale" | "degraded"
>

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
  availabilityByItemKey: ReadonlyMap<string, CartProductAvailability>
): string | null {
  const unavailableItems: Array<{
    item: CartItem
    availability: CartProductAvailability
  }> = []

  for (const item of items) {
    const availability = availabilityByItemKey.get(getCartItemKey(item))
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

export function isCartAvailabilityReadFresh(
  availability: CartProductAvailability[],
  meta: CartAvailabilityReadMeta | undefined
): boolean {
  return (
    availability.length > 0 &&
    !!meta &&
    meta.source !== "local_cache" &&
    !meta.stale &&
    !meta.degraded &&
    availability.every((entry) => entry.refreshed)
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

function coordinateMatchesMerchant(
  productId: string,
  merchantPubkey: string
): boolean {
  if (!productId.startsWith("30402:")) return true
  const [, coordinatePubkey, ...identifier] = productId.split(":")
  return coordinatePubkey === merchantPubkey && identifier.join(":").length > 0
}

function parseCartItem(value: unknown): CartItem | null {
  if (!isRecord(value)) return null
  const productId = nonemptyString(value.productId)
  const merchantPubkey = nonemptyString(value.merchantPubkey)
  const title = nonemptyString(value.title)
  const currency = nonemptyString(value.currency)
  const price = finiteNonnegativeNumber(value.price)
  const quantityValue = finiteNonnegativeNumber(value.quantity)
  if (
    !productId ||
    !merchantPubkey ||
    !title ||
    !currency ||
    price === undefined ||
    quantityValue === undefined ||
    quantityValue <= 0 ||
    !coordinateMatchesMerchant(productId, merchantPubkey)
  ) {
    return null
  }

  const quantity = Math.max(1, Math.floor(quantityValue))
  const merchantAddedAt = finiteNonnegativeNumber(value.merchantAddedAt)
  const priceSats = finiteNonnegativeNumber(value.priceSats)
  const shippingCostSats = finiteNonnegativeNumber(value.shippingCostSats)
  const stock = finiteNonnegativeNumber(value.stock)
  const format =
    value.format === "digital" || value.format === "physical"
      ? value.format
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
    ...(priceSats !== undefined ? { priceSats } : {}),
    ...(parseSourcePrice(value.sourcePrice)
      ? { sourcePrice: parseSourcePrice(value.sourcePrice) }
      : {}),
    ...(nonemptyString(value.image) ? { image: String(value.image) } : {}),
    ...(optionalStringArray(value.tags)
      ? { tags: optionalStringArray(value.tags) }
      : {}),
    ...(format ? { format } : {}),
    ...(shippingCostSats !== undefined ? { shippingCostSats } : {}),
    ...(parseSourcePrice(value.sourceShippingCost)
      ? { sourceShippingCost: parseSourcePrice(value.sourceShippingCost) }
      : {}),
    ...(nonemptyString(value.shippingOptionId)
      ? { shippingOptionId: String(value.shippingOptionId) }
      : {}),
    ...(nonemptyString(value.shippingOptionDTag)
      ? { shippingOptionDTag: String(value.shippingOptionDTag) }
      : {}),
    ...(optionalStringArray(value.shippingCountries)
      ? { shippingCountries: optionalStringArray(value.shippingCountries) }
      : {}),
    ...(parseShippingRules(value.shippingCountryRules)
      ? { shippingCountryRules: parseShippingRules(value.shippingCountryRules) }
      : {}),
    ...(typeof value.publicZapEnabled === "boolean"
      ? { publicZapEnabled: value.publicZapEnabled }
      : {}),
    ...(zapMessagePolicy ? { zapMessagePolicy } : {}),
    ...(typeof value.publicZapPolicyKnown === "boolean"
      ? { publicZapPolicyKnown: value.publicZapPolicyKnown }
      : {}),
    ...(stock !== undefined ? { stock } : {}),
  }
}

export function getCartItemKey(identity: CartItemIdentity): string {
  return JSON.stringify([identity.merchantPubkey, identity.productId])
}

export function getCartItemIdentity(item: CartItemIdentity): CartItemIdentity {
  return {
    merchantPubkey: item.merchantPubkey,
    productId: item.productId,
  }
}

export function isSameCartItem(
  item: CartItemIdentity,
  identity: CartItemIdentity
): boolean {
  return (
    item.merchantPubkey === identity.merchantPubkey &&
    item.productId === identity.productId
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

export function cartItemInputFromProduct(product: Product): CartItemInput {
  return {
    productId: product.id,
    merchantPubkey: product.pubkey,
    title: product.title,
    price: product.price,
    currency: product.currency,
    priceSats: product.priceSats,
    sourcePrice: product.sourcePrice,
    sourceShippingCost: product.sourceShippingCost,
    image: product.images[0]?.url,
    tags: product.tags,
    format: product.format,
    shippingCostSats: product.shippingCostSats,
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

export function parsePersistedCart(value: unknown): ParsedPersistedCart {
  if (
    isRecord(value) &&
    "version" in value &&
    value.version !== CART_STORAGE_VERSION
  ) {
    return {
      state: { items: [] },
      shouldPersist: false,
      supported: false,
      writable: false,
    }
  }
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return {
      state: { items: [] },
      shouldPersist: false,
      supported: false,
      writable: true,
    }
  }

  const parsedItems = value.items
    .map(parseCartItem)
    .filter((item): item is CartItem => item !== null)
  const deduplicated = new Map<string, CartItem>()
  for (const parsedItem of parsedItems) {
    const key = getCartItemKey(parsedItem)
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

  return {
    state: { items: Array.from(deduplicated.values()) },
    shouldPersist: value.version !== CART_STORAGE_VERSION,
    supported: true,
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
  item: CartItemInput & { merchantAddedAt?: number },
  quantity = 1
): CartItem[] {
  if (item.stock === 0) return items

  const q = Math.max(1, Math.floor(quantity))
  const existing = selectCartItem(items, item)
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
      isSameCartItem(current, item)
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
