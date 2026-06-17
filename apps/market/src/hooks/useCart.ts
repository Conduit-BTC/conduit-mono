import { useCallback, useMemo, useSyncExternalStore } from "react"
import {
  getTelemetryCountBucket,
  recordBrowserTelemetryEvent,
} from "@conduit/core"
import {
  addCartItem,
  clearMerchantCart,
  getCartTotals,
  removeCartItem,
  setCartItemQuantity,
  type CartItem,
  type CartState,
} from "../lib/cart-model"

export type { CartItem }

const CART_STORAGE_KEY = "conduit:cart"

type Listener = () => void
const listeners = new Set<Listener>()

let state: CartState = { items: [] }
let initialized = false
let storageListenerCount = 0

function notify(): void {
  listeners.forEach((l) => l())
}

function loadFromStorage(): void {
  if (initialized) return
  initialized = true

  if (typeof window === "undefined") return
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<CartState>
    state = {
      items: Array.isArray(parsed.items) ? (parsed.items as CartItem[]) : [],
    }
  } catch {
    // ignore
  }
}

function readSnapshot(): CartState {
  loadFromStorage()
  return state
}

function writeState(next: CartState): void {
  state = next
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // localStorage can fail (quota, privacy mode). Keep behavior non-blocking for MVP.
    }
  }
  notify()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)

  if (typeof window !== "undefined") {
    if (storageListenerCount === 0) {
      window.addEventListener("storage", onStorage)
    }
    storageListenerCount++
  }

  return () => {
    listeners.delete(listener)
    if (typeof window !== "undefined") {
      storageListenerCount = Math.max(0, storageListenerCount - 1)
      if (storageListenerCount === 0) {
        window.removeEventListener("storage", onStorage)
      }
    }
  }
}

function onStorage(e: StorageEvent): void {
  if (e.storageArea !== localStorage) return
  if (e.key !== CART_STORAGE_KEY) return

  // Refresh snapshot and notify subscribers.
  initialized = false
  loadFromStorage()
  notify()
}

export function useCart() {
  const snap = useSyncExternalStore(subscribe, readSnapshot, readSnapshot)

  const addItem = useCallback(
    (item: Omit<CartItem, "quantity">, quantity = 1) => {
      const curr = readSnapshot()
      writeState({ items: addCartItem(curr.items, item, quantity) })
      recordBrowserTelemetryEvent({
        app: "market",
        eventName: "cart_add",
        properties: {
          action: "add",
          count_bucket: getTelemetryCountBucket(quantity),
          product_type: item.format ?? "unknown",
          status: "success",
        },
      })
    },
    []
  )

  const setQuantity = useCallback((productId: string, quantity: number) => {
    const curr = readSnapshot()
    writeState({ items: setCartItemQuantity(curr.items, productId, quantity) })
  }, [])

  const removeItem = useCallback((productId: string) => {
    const curr = readSnapshot()
    writeState({ items: removeCartItem(curr.items, productId) })
  }, [])

  const clear = useCallback(() => {
    writeState({ items: [] })
  }, [])

  const clearMerchant = useCallback((merchantPubkey: string) => {
    const curr = readSnapshot()
    writeState({ items: clearMerchantCart(curr.items, merchantPubkey) })
  }, [])

  const totals = useMemo(() => getCartTotals(snap.items), [snap.items])

  return {
    items: snap.items,
    totals,
    addItem,
    setQuantity,
    removeItem,
    clear,
    clearMerchant,
  }
}
