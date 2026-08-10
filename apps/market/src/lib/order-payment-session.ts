const ORDER_PAYMENT_CLAIMS_STORAGE_KEY = "conduit:order-payment-claims"

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">

type StoredOrderPaymentClaims = Record<string, string>

function getSessionStorage(): SessionStorageLike | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function readClaims(
  storage: SessionStorageLike | null
): StoredOrderPaymentClaims {
  if (!storage) return {}
  try {
    const raw = storage.getItem(ORDER_PAYMENT_CLAIMS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([orderId, claimId]) =>
          orderId.length > 0 &&
          typeof claimId === "string" &&
          claimId.length > 0
      )
    )
  } catch {
    return {}
  }
}

function writeClaims(
  claims: StoredOrderPaymentClaims,
  storage: SessionStorageLike | null
): boolean {
  if (!storage) return false
  try {
    if (Object.keys(claims).length === 0) {
      storage.removeItem(ORDER_PAYMENT_CLAIMS_STORAGE_KEY)
    } else {
      storage.setItem(ORDER_PAYMENT_CLAIMS_STORAGE_KEY, JSON.stringify(claims))
    }
    return true
  } catch {
    return false
  }
}

export function rememberOrderPaymentClaim(
  orderId: string,
  paymentClaimId: string,
  storage: SessionStorageLike | null = getSessionStorage()
): boolean {
  if (!orderId || !paymentClaimId) return false
  return writeClaims(
    { ...readClaims(storage), [orderId]: paymentClaimId },
    storage
  )
}

export function readOrderPaymentClaim(
  orderId: string,
  storage: SessionStorageLike | null = getSessionStorage()
): string | null {
  return readClaims(storage)[orderId] ?? null
}

export function clearOrderPaymentClaim(
  orderId: string,
  paymentClaimId: string,
  storage: SessionStorageLike | null = getSessionStorage()
): boolean {
  const claims = readClaims(storage)
  if (claims[orderId] !== paymentClaimId) return false
  delete claims[orderId]
  return writeClaims(claims, storage)
}
