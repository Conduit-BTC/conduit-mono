import { useCallback, useMemo, useSyncExternalStore } from "react"
import {
  getTelemetryCountBucket,
  recordBrowserTelemetryEvent,
} from "@conduit/core"
import {
  getCartTotals,
  selectCartItem,
  type CartItem,
  type CartItemIdentity,
  type CartItemInput,
} from "../lib/cart-model"
import {
  LEGACY_CART_STORAGE_KEY,
  addCartRepositoryItem,
  captureCartPurchase,
  clearCartRepository,
  clearCartRepositoryPurchase,
  consumeCartPurchase,
  decrementCartRepositoryItem,
  getCartRepositorySnapshot,
  incrementCartRepositoryItem,
  refreshAndIncrementCartRepositoryItem,
  removeCartRepositoryItem,
  subscribeToCartRepository,
  type CartPurchaseClaim,
} from "../lib/cart-repository"

export type { CartItem, CartItemIdentity, CartItemInput, CartPurchaseClaim }

/** @deprecated Read only as the one-time version-2 migration source. */
export const CART_STORAGE_KEY = LEGACY_CART_STORAGE_KEY

type CartClearOptions = {
  emitTelemetry?: boolean
}

function getCartTelemetryCount(items: CartItem[]): number {
  return items.reduce((total, item) => total + item.quantity, 0)
}

function getCartTelemetryProductType(items: CartItem[]): string {
  const formats = new Set(items.map((item) => item.format ?? "physical"))

  if (formats.size === 0) return "unknown"
  if (formats.size > 1) return "mixed"
  return formats.values().next().value ?? "unknown"
}

function getRemovedCartItems(
  before: readonly CartItem[],
  after: readonly CartItem[]
): CartItem[] {
  const afterQuantities = new Map(
    after.map((item) => [
      item.cartLineId ?? JSON.stringify([item.merchantPubkey, item.productId]),
      item.quantity,
    ])
  )
  return before.flatMap((item) => {
    const key =
      item.cartLineId ?? JSON.stringify([item.merchantPubkey, item.productId])
    const removed = item.quantity - (afterQuantities.get(key) ?? 0)
    return removed > 0 ? [{ ...item, quantity: removed }] : []
  })
}

export function useCart() {
  const snap = useSyncExternalStore(
    subscribeToCartRepository,
    getCartRepositorySnapshot,
    getCartRepositorySnapshot
  )

  const addItem = useCallback(async (item: CartItemInput, quantity = 1) => {
    if (item.stock === 0) return false
    const result = await addCartRepositoryItem(item, quantity)
    if (!result.changed) return false
    recordBrowserTelemetryEvent({
      app: "market",
      eventName: "cart_add",
      properties: {
        action: "add",
        count_bucket: getTelemetryCountBucket(quantity),
        product_type: item.format ?? "physical",
        status: "success",
        surface: "cart",
      },
    })
    return true
  }, [])

  const incrementItem = useCallback(
    async (identity: CartItemIdentity, quantity = 1, currentStock?: number) => {
      const requested = Math.max(1, Math.floor(quantity))
      const result = await incrementCartRepositoryItem(
        identity,
        requested,
        currentStock
      )
      if (!result.changed) return
      const item = selectCartItem(result.after, identity)
      recordBrowserTelemetryEvent({
        app: "market",
        eventName: "cart_add",
        properties: {
          action: "add",
          count_bucket: getTelemetryCountBucket(requested),
          product_type: item?.format ?? "physical",
          status: "success",
          surface: "cart",
        },
      })
    },
    []
  )

  const refreshAndIncrementItem = useCallback(
    async (identity: CartItemIdentity, item: CartItemInput, quantity = 1) => {
      const requested = Math.max(1, Math.floor(quantity))
      const result = await refreshAndIncrementCartRepositoryItem(
        identity,
        item,
        requested
      )
      if (!result.changed) return false
      const refreshed = selectCartItem(result.after, identity)
      recordBrowserTelemetryEvent({
        app: "market",
        eventName: "cart_add",
        properties: {
          action: "add",
          count_bucket: getTelemetryCountBucket(requested),
          product_type: refreshed?.format ?? "physical",
          status: "success",
          surface: "cart",
        },
      })
      return true
    },
    []
  )

  const decrementItem = useCallback((identity: CartItemIdentity) => {
    return decrementCartRepositoryItem(identity)
  }, [])

  const removeItem = useCallback(async (identity: CartItemIdentity) => {
    const result = await removeCartRepositoryItem(identity)
    const removedItems = getRemovedCartItems(result.before, result.after)
    if (!result.changed || removedItems.length === 0) return
    recordBrowserTelemetryEvent({
      app: "market",
      eventName: "cart_remove",
      properties: {
        action: "remove",
        count_bucket: getTelemetryCountBucket(
          getCartTelemetryCount(removedItems)
        ),
        product_type: getCartTelemetryProductType(removedItems),
        status: "success",
        surface: "cart",
      },
    })
  }, [])

  const clear = useCallback(async () => {
    const result = await clearCartRepository()
    if (!result.changed) return
    const removedItems = getRemovedCartItems(result.before, result.after)
    recordBrowserTelemetryEvent({
      app: "market",
      eventName: "cart_clear",
      properties: {
        action: "clear_all",
        count_bucket: getTelemetryCountBucket(
          getCartTelemetryCount(removedItems)
        ),
        product_type: getCartTelemetryProductType(removedItems),
        status: "success",
        surface: "cart",
      },
    })
  }, [])

  const clearPurchase = useCallback(
    async (purchaseId: string, options: CartClearOptions = {}) => {
      const result = await clearCartRepositoryPurchase(purchaseId)
      if (!result.changed || options.emitTelemetry === false) return
      const removedItems = getRemovedCartItems(result.before, result.after)
      recordBrowserTelemetryEvent({
        app: "market",
        eventName: "cart_clear",
        properties: {
          action: "clear_purchase",
          count_bucket: getTelemetryCountBucket(
            getCartTelemetryCount(removedItems)
          ),
          product_type: getCartTelemetryProductType(removedItems),
          status: "success",
          surface: "cart",
        },
      })
    },
    []
  )

  const totals = useMemo(() => getCartTotals(snap.items), [snap.items])

  return {
    items: snap.items,
    totals,
    hydrated: snap.hydrated,
    persistenceMode: snap.persistenceMode,
    addItem,
    incrementItem,
    refreshAndIncrementItem,
    decrementItem,
    removeItem,
    clear,
    clearPurchase,
    capturePurchase: captureCartPurchase,
    consumePurchase: consumeCartPurchase,
  }
}
