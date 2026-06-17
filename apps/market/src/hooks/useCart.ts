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
type CartClearOptions = {
  emitTelemetry?: boolean
}
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

function getCartTelemetryCount(items: CartItem[]): number {
  return items.reduce((total, item) => total + item.quantity, 0)
}

function getCartTelemetryProductType(items: CartItem[]): string {
  const formats = new Set(items.map((item) => item.format ?? "unknown"))

  if (formats.size === 0) return "unknown"
  if (formats.size > 1) return "mixed"
  return formats.values().next().value ?? "unknown"
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
          surface: "cart",
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
    const removedItem = curr.items.find((item) => item.productId === productId)
    writeState({ items: removeCartItem(curr.items, productId) })
    if (removedItem) {
      recordBrowserTelemetryEvent({
        app: "market",
        eventName: "cart_remove",
        properties: {
          action: "remove",
          count_bucket: getTelemetryCountBucket(removedItem.quantity),
          product_type: getCartTelemetryProductType([removedItem]),
          status: "success",
          surface: "cart",
        },
      })
    }
  }, [])

  const clear = useCallback(() => {
    const curr = readSnapshot()
    writeState({ items: [] })
    if (curr.items.length > 0) {
      recordBrowserTelemetryEvent({
        app: "market",
        eventName: "cart_clear",
        properties: {
          action: "clear_all",
          count_bucket: getTelemetryCountBucket(
            getCartTelemetryCount(curr.items)
          ),
          product_type: getCartTelemetryProductType(curr.items),
          status: "success",
          surface: "cart",
        },
      })
    }
  }, [])

  const clearMerchant = useCallback(
    (merchantPubkey: string, options: CartClearOptions = {}) => {
      const curr = readSnapshot()
      const merchantItems = curr.items.filter(
        (item) => item.merchantPubkey === merchantPubkey
      )
      writeState({ items: clearMerchantCart(curr.items, merchantPubkey) })
      if (options.emitTelemetry === false || merchantItems.length === 0) return
      recordBrowserTelemetryEvent({
        app: "market",
        eventName: "cart_clear",
        properties: {
          action: "clear_merchant",
          count_bucket: getTelemetryCountBucket(
            getCartTelemetryCount(merchantItems)
          ),
          product_type: getCartTelemetryProductType(merchantItems),
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
    addItem,
    setQuantity,
    removeItem,
    clear,
    clearMerchant,
  }
}
