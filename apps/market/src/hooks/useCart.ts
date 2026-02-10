import { useCallback, useMemo, useSyncExternalStore } from "react"

export type CartItem = {
  productId: string
  merchantPubkey: string
  title: string
  price: number
  currency: string
  quantity: number
}

type CartState = {
  items: CartItem[]
}

const CART_STORAGE_KEY = "conduit:cart"

type Listener = () => void
const listeners = new Set<Listener>()

function notify(): void {
  listeners.forEach((l) => l())
}

function readState(): CartState {
  if (typeof window === "undefined") return { items: [] }
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY)
    if (!raw) return { items: [] }
    const parsed = JSON.parse(raw) as Partial<CartState>
    return {
      items: Array.isArray(parsed.items) ? (parsed.items as CartItem[]) : [],
    }
  } catch {
    return { items: [] }
  }
}

function writeState(next: CartState): void {
  if (typeof window === "undefined") return
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(next))
  notify()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCart() {
  const state = useSyncExternalStore(subscribe, readState, readState)

  const addItem = useCallback((item: Omit<CartItem, "quantity">, quantity = 1) => {
    const curr = readState()
    const existing = curr.items.find((i) => i.productId === item.productId)
    const nextItems = existing
      ? curr.items.map((i) =>
          i.productId === item.productId ? { ...i, quantity: i.quantity + quantity } : i
        )
      : [...curr.items, { ...item, quantity }]
    writeState({ items: nextItems })
  }, [])

  const setQuantity = useCallback((productId: string, quantity: number) => {
    const q = Math.max(1, Math.floor(quantity))
    const curr = readState()
    writeState({
      items: curr.items.map((i) => (i.productId === productId ? { ...i, quantity: q } : i)),
    })
  }, [])

  const removeItem = useCallback((productId: string) => {
    const curr = readState()
    writeState({ items: curr.items.filter((i) => i.productId !== productId) })
  }, [])

  const clear = useCallback(() => {
    writeState({ items: [] })
  }, [])

  const totals = useMemo(() => {
    const count = state.items.reduce((acc, i) => acc + i.quantity, 0)
    const subtotal = state.items.reduce((acc, i) => acc + i.price * i.quantity, 0)
    return { count, subtotal }
  }, [state.items])

  return {
    items: state.items,
    totals,
    addItem,
    setQuantity,
    removeItem,
    clear,
  }
}

