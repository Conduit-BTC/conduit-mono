import { useCallback, useMemo, useSyncExternalStore } from "react"
import {
  getTelemetryCountBucket,
  listOrderCartRetirements,
  markOrderCartRetirementApplied,
  normalizePublicMediaUrl,
  recordBrowserTelemetryEvent,
  type OrderCartRetirement,
} from "@conduit/core"
import {
  addCartItem,
  applyOrderCartRetirement,
  clearMerchantCart,
  getCartTotals,
  hasExactDurableCheckoutCart,
  parsePersistedCart,
  removeCartItem,
  selectCartItem,
  serializeCartState,
  setCartItemQuantity,
  type CartItem,
  type CartItemIdentity,
  type CartItemInput,
  type CartState,
} from "../lib/cart-model"

export type { CartItem, CartItemIdentity, CartItemInput }

export const CART_STORAGE_KEY = "conduit:cart"
export const CART_MUTATION_LOCK_NAME = "conduit:cart:mutation"

type Listener = () => void
type CartClearOptions = {
  emitTelemetry?: boolean
}
type PendingCartTransform = {
  id: number
  apply: (current: CartState) => CartState
}
type ReconcilePendingOrderCartRetirementsOptions = {
  /** Deterministic browser-test seam invoked while the cross-tab lock is held. */
  afterStorageRead?: () => Promise<void>
}
const listeners = new Set<Listener>()

let state: CartState = { items: [] }
let initialized = false
let storageWritable = true
let needsCanonicalWrite = false
let storageListenerCount = 0
let cartMutationQueue: Promise<void> = Promise.resolve()
let nextCartTransformId = 1
let pendingCartTransforms: PendingCartTransform[] = []

function sanitizeCartItemImage<T extends { image?: string }>(item: T): T {
  return {
    ...item,
    image: normalizePublicMediaUrl(item.image) ?? undefined,
  }
}

function notify(): void {
  listeners.forEach((l) => l())
}

function getCartLockManager(): LockManager | null {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.locks?.request !== "function"
  ) {
    return null
  }
  return navigator.locks
}

async function withCartMutationAuthority<T>(
  operation: () => Promise<T>
): Promise<T> {
  const lockManager = getCartLockManager()
  if (!lockManager) return await operation()
  return await lockManager.request(
    CART_MUTATION_LOCK_NAME,
    { mode: "exclusive" },
    operation
  )
}

function enqueueCartStorageOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const run = cartMutationQueue.then(
    async () => await withCartMutationAuthority(operation),
    async () => await withCartMutationAuthority(operation)
  )
  cartMutationQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function loadFromStorage(): void {
  if (initialized) return
  initialized = true

  if (typeof window === "undefined") return
  storageWritable = getCartLockManager() !== null
  needsCanonicalWrite = false
  state = { items: [] }
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY)
    if (!raw) return
    const result = parsePersistedCart(JSON.parse(raw))
    state = {
      items: result.state.items.map(sanitizeCartItemImage),
      appliedOrderRetirements: result.state.appliedOrderRetirements,
    }
    storageWritable = result.writable && getCartLockManager() !== null
    // Canonical migration writes run through the same cross-tab authority as
    // user mutations and lifecycle retirement.
    needsCanonicalWrite = result.shouldPersist
  } catch {
    // ignore
  }
}

function reloadFromStorage(): void {
  initialized = false
  loadFromStorage()
}

function readSnapshot(): CartState {
  loadFromStorage()
  return state
}

function persistState(next: CartState): boolean {
  state = {
    ...next,
    appliedOrderRetirements:
      next.appliedOrderRetirements ?? state.appliedOrderRetirements,
  }
  let persisted = false
  if (typeof window !== "undefined" && storageWritable) {
    try {
      localStorage.setItem(
        CART_STORAGE_KEY,
        JSON.stringify(serializeCartState(state))
      )
      persisted = true
    } catch {
      // Keep the composed in-memory view and its pending transforms so a later
      // successful write can rebase every intent on the newest durable cart.
    }
  }
  notify()
  return persisted
}

function appendCartTransform(
  apply: PendingCartTransform["apply"]
): PendingCartTransform {
  const transform = { id: nextCartTransformId++, apply }
  pendingCartTransforms.push(transform)
  return transform
}

function commitCartTransformsThrough(throughId: number): boolean {
  const batch = pendingCartTransforms.filter(
    (transform) => transform.id <= throughId
  )
  let next = state
  for (const transform of batch) {
    next = transform.apply(next)
  }

  const needsWrite = next !== state || needsCanonicalWrite
  const persisted = needsWrite ? persistState(next) : true
  if (!needsWrite) notify()
  if (persisted) {
    pendingCartTransforms = pendingCartTransforms.filter(
      (transform) => transform.id > throughId
    )
    needsCanonicalWrite = false
  }
  return persisted
}

async function commitCartMutation(
  mutate: (current: CartState) => CartState
): Promise<boolean> {
  const transform = appendCartTransform(mutate)
  return await enqueueCartStorageOperation(async () => {
    reloadFromStorage()
    return commitCartTransformsThrough(transform.id)
  })
}

function scheduleCartMutation(mutate: (current: CartState) => CartState): void {
  void commitCartMutation(mutate).catch(() => {
    storageWritable = false
    notify()
  })
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

  // Hide the unverified snapshot until lifecycle retirements are reconciled.
  initialized = false
  state = { items: [] }
  notify()
  void reconcilePendingOrderCartRetirements()
}

async function markRetirementsApplied(orderIds: readonly string[]) {
  await Promise.all(
    orderIds.map((orderId) => markOrderCartRetirementApplied(orderId))
  )
}

/**
 * Apply lifecycle-backed cart retirement before checkout can observe storage.
 * IndexedDB read failure hides the cart for this session instead of exposing a
 * stale submitted order as a new cart.
 */
export async function reconcilePendingOrderCartRetirements(
  options: ReconcilePendingOrderCartRetirementsOptions = {}
): Promise<boolean> {
  let lifecycles: Awaited<ReturnType<typeof listOrderCartRetirements>>
  try {
    lifecycles = await listOrderCartRetirements()
  } catch {
    state = { items: [] }
    storageWritable = false
    notify()
    return false
  }

  let persisted: boolean
  const retirementTransform = appendCartTransform((current) => {
    let next = current
    for (const lifecycle of lifecycles) {
      if (!lifecycle.cartRetirement) continue
      next = applyOrderCartRetirement(next, {
        orderId: lifecycle.orderId,
        merchantPubkey: lifecycle.merchantPubkey,
        retirement: lifecycle.cartRetirement,
      })
    }
    return next
  })
  try {
    persisted = await enqueueCartStorageOperation(async () => {
      // Web Locks serializes the fresh read, retirement transform, and durable
      // commit against every cart mutation in every same-origin tab.
      reloadFromStorage()
      await options.afterStorageRead?.()
      return commitCartTransformsThrough(retirementTransform.id)
    })
  } catch {
    storageWritable = false
    notify()
    return false
  }
  if (!persisted) return false
  try {
    await markRetirementsApplied(
      lifecycles.map((lifecycle) => lifecycle.orderId)
    )
  } catch {
    // Applied order IDs remain durable in the same cart write, so a later
    // reconciliation can safely retry only this lifecycle acknowledgement.
    return false
  }
  return true
}

function readDurableCartState(): CartState | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY)
    if (!raw) return { items: [], appliedOrderRetirements: [] }
    const parsed = parsePersistedCart(JSON.parse(raw))
    return parsed.writable ? parsed.state : null
  } catch {
    return null
  }
}

export async function assertDurableCheckoutCartItems(
  reviewedItems: readonly CartItem[]
): Promise<void> {
  if (pendingCartTransforms.length > 0 || needsCanonicalWrite) {
    throw new Error(
      "The cart could not be saved on this device. Review it after storage recovers before placing the order."
    )
  }
  if (!(await reconcilePendingOrderCartRetirements())) {
    throw new Error(
      "The cart could not be reconciled with saved orders. Try again before placing the order."
    )
  }
  const durable = readDurableCartState()
  if (!durable || !hasExactDurableCheckoutCart(durable.items, reviewedItems)) {
    throw new Error(
      "The cart changed in another tab or could not be saved. Review the current cart before placing the order."
    )
  }
}

export function useCart() {
  const snap = useSyncExternalStore(subscribe, readSnapshot, readSnapshot)

  const addItem = useCallback((item: CartItemInput, quantity = 1) => {
    if (item.stock === 0) return

    scheduleCartMutation((current) => ({
      ...current,
      items: addCartItem(current.items, sanitizeCartItemImage(item), quantity),
    }))
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
  }, [])

  const setQuantity = useCallback(
    (identity: CartItemIdentity, quantity: number) => {
      scheduleCartMutation((current) => ({
        ...current,
        items: setCartItemQuantity(current.items, identity, quantity),
      }))
    },
    []
  )

  const removeItem = useCallback((identity: CartItemIdentity) => {
    const curr = readSnapshot()
    const removedItem = selectCartItem(curr.items, identity)
    scheduleCartMutation((current) => ({
      ...current,
      items: removeCartItem(current.items, identity),
    }))
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
    scheduleCartMutation((current) => ({ ...current, items: [] }))
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
      scheduleCartMutation((current) => ({
        ...current,
        items: clearMerchantCart(current.items, merchantPubkey),
      }))
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

  const retireOrder = useCallback(
    async (input: {
      orderId: string
      merchantPubkey: string
      retirement: OrderCartRetirement
    }): Promise<boolean> => {
      if (
        input.orderId.length === 0 ||
        input.merchantPubkey.length === 0 ||
        input.retirement.items.length === 0
      ) {
        return false
      }
      // The lifecycle journal is authoritative. Re-read shared storage and
      // apply every retained journal so a stale tab cannot overwrite newer cart
      // lines or resurrect an already submitted generation.
      return await reconcilePendingOrderCartRetirements()
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
    retireOrder,
    assertDurableCheckoutItems: assertDurableCheckoutCartItems,
  }
}
