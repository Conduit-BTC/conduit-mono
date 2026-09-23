import {
  GUEST_ORDER_LOCAL_RETENTION_MS,
  type OrderLifecycle,
} from "@conduit/core"

const CHECKOUT_ORDER_ATTEMPTS_STORAGE_KEY = "conduit:checkout-order-attempts:v1"

type CheckoutOrderAttempt = {
  expiresAt: number
}

type CheckoutOrderAttemptRegistry = Record<string, CheckoutOrderAttempt>

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">

type OrderAttemptLine = {
  productId: string
  familyProductId?: string
  selectedSpecifications?: Array<{ key: string; value: string }>
  quantity: number
  shippingOptionId?: string
  shippingOptionDTag?: string
}

let inMemoryCheckoutOrderAttempts: CheckoutOrderAttemptRegistry = {}

function normalizedOrderAttemptLines(
  items: readonly OrderAttemptLine[]
): string[] {
  return items
    .map((item) =>
      JSON.stringify({
        productId: item.productId,
        familyProductId: item.familyProductId ?? null,
        selectedSpecifications: [...(item.selectedSpecifications ?? [])].sort(
          (left, right) =>
            `${left.key}\u0000${left.value}`.localeCompare(
              `${right.key}\u0000${right.value}`
            )
        ),
        quantity: item.quantity,
        shippingOptionId: item.shippingOptionId ?? null,
        shippingOptionDTag: item.shippingOptionDTag ?? null,
      })
    )
    .sort()
}

export function doesCartMatchOrderAttempt(
  cartItems: readonly OrderAttemptLine[],
  orderItems: readonly OrderAttemptLine[]
): boolean {
  const cart = normalizedOrderAttemptLines(cartItems)
  const order = normalizedOrderAttemptLines(orderItems)
  return (
    cart.length === order.length && cart.every((line, i) => line === order[i])
  )
}

export function requiresCheckoutOrderRecovery(input: {
  checkoutRecoveryPending?: boolean
  hasAttemptLocator: boolean
  hasGuestKey: boolean
}): boolean {
  return (
    input.checkoutRecoveryPending === true &&
    (input.hasAttemptLocator || input.hasGuestKey)
  )
}

export function hasCheckoutPaymentProgress(input: {
  paymentStatus: string
  invoiceStatus: string
}): boolean {
  return !(
    input.paymentStatus === "not_started" &&
    input.invoiceStatus === "not_requested"
  )
}

export function requiresAcceptedOrderPaymentContinuation(input: {
  orderDeliveryStatus: string
  checkoutRecoveryPending?: boolean
  checkoutMode: string
  paymentStatus: string
  invoiceStatus: string
}): boolean {
  return (
    input.orderDeliveryStatus === "sent" &&
    input.checkoutRecoveryPending === true &&
    input.checkoutMode !== "pay_later" &&
    !hasCheckoutPaymentProgress(input)
  )
}

export async function findCheckoutOrderRecovery(
  input: {
    purchase?: {
      merchantPubkey: string
      items: readonly OrderAttemptLine[]
    }
    accountPubkey: string | null
    nowMs: number
  },
  source: {
    listAttemptIds: (nowMs: number) => string[]
    listGuestIds: (nowMs: number) => string[]
    getGuestPubkey: (orderId: string, nowMs: number) => string | null
    getOrder: (orderId: string) => Promise<OrderLifecycle | undefined>
    listBuyerOrders: (buyerPubkey: string) => Promise<OrderLifecycle[]>
  }
): Promise<{ order: OrderLifecycle; ownsOrder: boolean } | null> {
  const attemptIds = new Set(source.listAttemptIds(input.nowMs))
  const guestIds = new Set(source.listGuestIds(input.nowMs))
  const guestPubkeys = new Map(
    [...guestIds].map((orderId) => [
      orderId,
      source.getGuestPubkey(orderId, input.nowMs),
    ])
  )
  const located = await Promise.all(
    [...new Set([...attemptIds, ...guestIds])].map((orderId) =>
      source.getOrder(orderId)
    )
  )

  const select = (
    orders: readonly (OrderLifecycle | undefined)[],
    includeBuyerIndex: boolean
  ): { order: OrderLifecycle; ownsOrder: boolean } | null => {
    const candidates = orders
      .filter((order): order is OrderLifecycle => {
        if (!order?.orderRelayDelivery) return false
        if (order.orderRelayDelivery.expiresAt <= input.nowMs) return false
        const ownedGuestOrder =
          !input.accountPubkey &&
          guestPubkeys.get(order.orderId) === order.buyerPubkey &&
          order.buyerIdentityKind === "guest_ephemeral"
        const unfinishedAcceptedGuestOrder =
          !input.purchase &&
          ownedGuestOrder &&
          order.orderDeliveryStatus === "sent" &&
          order.phase !== "cancelled" &&
          order.phase !== "completed" &&
          (order.paymentStatus !== "paid" ||
            order.proofDeliveryStatus !== "sent")
        if (
          order.checkoutRecoveryPending !== true &&
          !unfinishedAcceptedGuestOrder
        ) {
          return false
        }
        if (
          input.purchase &&
          (order.merchantPubkey !== input.purchase.merchantPubkey ||
            !doesCartMatchOrderAttempt(input.purchase.items, order.items))
        ) {
          return false
        }
        return (
          attemptIds.has(order.orderId) ||
          guestIds.has(order.orderId) ||
          (includeBuyerIndex && order.buyerPubkey === input.accountPubkey)
        )
      })
      .map((order) => ({
        order,
        ownsOrder: input.accountPubkey
          ? order.buyerPubkey === input.accountPubkey
          : guestPubkeys.get(order.orderId) === order.buyerPubkey,
      }))
      .filter((candidate) => input.purchase || candidate.ownsOrder)
      .sort((left, right) => right.order.updatedAt - left.order.updatedAt)
    return candidates[0] ?? null
  }

  const found = select(located, false)
  if (found || !input.accountPubkey) return found
  const buyerOrders = await source.listBuyerOrders(input.accountPubkey)
  return select([...located, ...buyerOrders], true)
}

function getLocalStorage(): StorageLike | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function isCheckoutOrderAttempt(value: unknown): value is CheckoutOrderAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return (
    Number.isFinite((value as Partial<CheckoutOrderAttempt>).expiresAt) &&
    ((value as Partial<CheckoutOrderAttempt>).expiresAt ?? 0) > 0
  )
}

function readRegistry(
  storage: StorageLike | null = getLocalStorage()
): CheckoutOrderAttemptRegistry {
  if (!storage) return { ...inMemoryCheckoutOrderAttempts }
  try {
    const raw = storage.getItem(CHECKOUT_ORDER_ATTEMPTS_STORAGE_KEY)
    if (!raw) {
      inMemoryCheckoutOrderAttempts = {}
      return {}
    }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      storage.removeItem(CHECKOUT_ORDER_ATTEMPTS_STORAGE_KEY)
      inMemoryCheckoutOrderAttempts = {}
      return {}
    }
    const persisted = Object.fromEntries(
      Object.entries(parsed).filter(
        ([orderId, value]) =>
          orderId.length > 0 && isCheckoutOrderAttempt(value)
      )
    )
    if (Object.keys(persisted).length !== Object.keys(parsed).length) {
      if (Object.keys(persisted).length === 0) {
        storage.removeItem(CHECKOUT_ORDER_ATTEMPTS_STORAGE_KEY)
      } else {
        storage.setItem(
          CHECKOUT_ORDER_ATTEMPTS_STORAGE_KEY,
          JSON.stringify(persisted)
        )
      }
    }
    inMemoryCheckoutOrderAttempts = { ...persisted }
    return { ...persisted }
  } catch {
    return { ...inMemoryCheckoutOrderAttempts }
  }
}

function writeRegistry(
  registry: CheckoutOrderAttemptRegistry,
  storage: StorageLike | null = getLocalStorage()
): void {
  inMemoryCheckoutOrderAttempts = { ...registry }
  try {
    if (Object.keys(registry).length === 0) {
      storage?.removeItem(CHECKOUT_ORDER_ATTEMPTS_STORAGE_KEY)
    } else {
      storage?.setItem(
        CHECKOUT_ORDER_ATTEMPTS_STORAGE_KEY,
        JSON.stringify(registry)
      )
    }
  } catch {
    // IndexedDB recovery remains the fallback when localStorage is unavailable.
  }
}

export function rememberCheckoutOrderAttempt(
  orderId: string,
  expiresAt = Date.now() + GUEST_ORDER_LOCAL_RETENTION_MS,
  storage: StorageLike | null = getLocalStorage()
): void {
  const normalizedOrderId = orderId.trim()
  if (!normalizedOrderId || !Number.isFinite(expiresAt)) return
  const registry = readRegistry(storage)
  registry[normalizedOrderId] = { expiresAt }
  writeRegistry(registry, storage)
}

export function listCheckoutOrderAttemptIds(
  storage: StorageLike | null = getLocalStorage(),
  nowMs = Date.now()
): string[] {
  const registry = readRegistry(storage)
  let changed = false
  for (const [orderId, attempt] of Object.entries(registry)) {
    if (attempt.expiresAt > nowMs) continue
    delete registry[orderId]
    changed = true
  }
  if (changed) writeRegistry(registry, storage)
  return Object.keys(registry)
}

export function forgetCheckoutOrderAttempt(
  orderId: string,
  storage: StorageLike | null = getLocalStorage()
): void {
  const registry = readRegistry(storage)
  if (!registry[orderId]) return
  delete registry[orderId]
  writeRegistry(registry, storage)
}
