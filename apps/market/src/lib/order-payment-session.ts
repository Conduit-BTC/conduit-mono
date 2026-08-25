const ORDER_PAYMENT_CLAIM_STORAGE_PREFIX = "conduit:order-payment-claim:"

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">

function getSessionStorage(): SessionStorageLike | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function getOrderPaymentClaimStorageKey(orderId: string): string {
  return `${ORDER_PAYMENT_CLAIM_STORAGE_PREFIX}${orderId}`
}

export function rememberOrderPaymentClaim(
  orderId: string,
  paymentClaimId: string,
  storage: SessionStorageLike | null = getSessionStorage()
): boolean {
  if (!storage || !orderId || !paymentClaimId) return false
  try {
    storage.setItem(getOrderPaymentClaimStorageKey(orderId), paymentClaimId)
    return true
  } catch {
    return false
  }
}

export function readOrderPaymentClaim(
  orderId: string,
  storage: SessionStorageLike | null = getSessionStorage()
): string | null {
  if (!storage || !orderId) return null
  try {
    const paymentClaimId = storage.getItem(
      getOrderPaymentClaimStorageKey(orderId)
    )
    return paymentClaimId?.length ? paymentClaimId : null
  } catch {
    return null
  }
}

export function clearOrderPaymentClaim(
  orderId: string,
  paymentClaimId: string,
  storage: SessionStorageLike | null = getSessionStorage()
): boolean {
  if (!storage || !orderId || !paymentClaimId) return false
  try {
    const key = getOrderPaymentClaimStorageKey(orderId)
    if (storage.getItem(key) !== paymentClaimId) return false
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}
