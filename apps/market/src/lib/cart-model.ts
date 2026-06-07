import {
  getPriceSats,
  getShippingCostSats,
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
  totalSats: number
  itemPricesAvailable: boolean
  shippingReadyForZap: boolean
  canZapOut: boolean
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
  let shippingReadyForZap = true

  for (const item of items) {
    count += item.quantity

    const price = getPriceSats(item, rateInput)
    if (price) {
      itemSubtotalSats += price.sats * item.quantity
    } else {
      itemPricesAvailable = false
    }

    if (item.format === "digital") continue

    if (
      !item.shippingOptionId ||
      getShippingCostSats(item, rateInput) === null
    ) {
      shippingReadyForZap = false
    }
  }

  return {
    count,
    itemSubtotalSats,
    totalSats: itemSubtotalSats,
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
