import {
  getPriceSats,
  getShippingCostSats,
  resolveCartShippingCost,
  type ProductZapMessagePolicy,
  type PricingRateInput,
} from "@conduit/core"

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
