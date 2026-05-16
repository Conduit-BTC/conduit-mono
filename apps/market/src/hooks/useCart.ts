import { useCallback, useMemo, useSyncExternalStore } from "react"

export type CartItem = {
  productId: string
  merchantPubkey: string
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
  quantity: number
}

type CartState = {
  items: CartItem[]
}

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
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(next))
    notify()
  } catch {
    // localStorage can fail (quota, privacy mode). Keep behavior non-blocking for MVP.
  }
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
      const existing = curr.items.find((i) => i.productId === item.productId)
      const nextItems = existing
        ? curr.items.map((i) =>
            i.productId === item.productId
              ? { ...i, quantity: i.quantity + quantity }
              : i
          )
        : [...curr.items, { ...item, quantity }]
      writeState({ items: nextItems })
    },
    []
  )

  const setQuantity = useCallback((productId: string, quantity: number) => {
    const q = Math.max(1, Math.floor(quantity))
    const curr = readSnapshot()
    writeState({
      items: curr.items.map((i) =>
        i.productId === productId ? { ...i, quantity: q } : i
      ),
    })
  }, [])

  const removeItem = useCallback((productId: string) => {
    const curr = readSnapshot()
    writeState({ items: curr.items.filter((i) => i.productId !== productId) })
  }, [])

  const clear = useCallback(() => {
    writeState({ items: [] })
  }, [])

  const clearMerchant = useCallback((merchantPubkey: string) => {
    const curr = readSnapshot()
    writeState({
      items: curr.items.filter((i) => i.merchantPubkey !== merchantPubkey),
    })
  }, [])

  const totals = useMemo(() => {
    return snap.items.reduce(
      (acc, i) => {
        acc.count += i.quantity
        acc.subtotal += (i.priceSats ?? i.price) * i.quantity
        return acc
      },
      { count: 0, subtotal: 0 }
    )
  }, [snap.items])

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
