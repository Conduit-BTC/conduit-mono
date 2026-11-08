import { useCallback, useMemo, useSyncExternalStore } from "react"

import {
  getCartTotals,
  type CartItem,
  type CartItemIdentity,
  type CartItemInput,
  type CartItemStockEvidence,
} from "../lib/cart-model"
import {
  LEGACY_CART_STORAGE_KEY,
  addCartRepositoryItem,
  captureCartPurchase,
  changeCartRepositoryFulfillment,
  clearCartRepository,
  clearCartRepositoryPurchase,
  consumeCartPurchase,
  decrementCartRepositoryItem,
  getCartRepositorySnapshot,
  incrementCartRepositoryItem,
  installCheckoutIntentPurchase,
  refreshAndIncrementCartRepositoryItem,
  removeCartRepositoryItem,
  subscribeToCartRepository,
  type CartPurchaseClaim,
} from "../lib/cart-repository"

export type { CartItem, CartItemIdentity, CartItemInput, CartPurchaseClaim }

/** @deprecated Read only as the one-time version-2 migration source. */
export const CART_STORAGE_KEY = LEGACY_CART_STORAGE_KEY

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

    return true
  }, [])

  const incrementItem = useCallback(
    async (
      identity: CartItemIdentity,
      quantity = 1,
      currentStockEvidence?: CartItemStockEvidence
    ) => {
      const requested = Math.max(1, Math.floor(quantity))
      const result = await incrementCartRepositoryItem(
        identity,
        requested,
        currentStockEvidence
      )
      if (!result.changed) return
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

      return true
    },
    []
  )

  const decrementItem = useCallback((identity: CartItemIdentity) => {
    return decrementCartRepositoryItem(identity)
  }, [])

  const removeItem = useCallback(async (identity: CartItemIdentity) => {
    await removeCartRepositoryItem(identity)
  }, [])

  const clear = useCallback(async () => {
    await clearCartRepository()
  }, [])

  const clearPurchase = useCallback(async (purchaseId: string) => {
    await clearCartRepositoryPurchase(purchaseId)
  }, [])

  const totals = useMemo(() => getCartTotals(snap.items), [snap.items])

  return {
    items: snap.items,
    totals,
    hydrated: snap.hydrated,
    persistenceMode: snap.persistenceMode,
    mutationSequence: snap.mutationSequence,
    revision: snap.revision,
    changeFulfillment: changeCartRepositoryFulfillment,
    addItem,
    incrementItem,
    refreshAndIncrementItem,
    decrementItem,
    removeItem,
    clear,
    clearPurchase,
    capturePurchase: captureCartPurchase,
    consumePurchase: consumeCartPurchase,
    installCheckoutIntentPurchase,
  }
}
