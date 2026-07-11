import { GUEST_ORDER_LOCAL_RETENTION_MS } from "@conduit/core"
import type { ShippingFormState } from "./checkout-validation"

const CHECKOUT_SHIPPING_STORAGE_KEY = "conduit:checkout-shipping"

export const DEFAULT_CHECKOUT_SHIPPING: ShippingFormState = {
  firstName: "",
  lastName: "",
  street: "",
  line2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "US",
  name: "",
  phone: "",
  email: "",
}

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">

type StoredCheckoutShipping = {
  value: Partial<ShippingFormState>
  updatedAt: number
}

function getSessionStorage(): SessionStorageLike | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function readCheckoutShippingSession(
  storage: SessionStorageLike | null = getSessionStorage(),
  nowMs = Date.now()
): ShippingFormState {
  if (!storage) return DEFAULT_CHECKOUT_SHIPPING
  try {
    const raw = storage.getItem(CHECKOUT_SHIPPING_STORAGE_KEY)
    if (!raw) return DEFAULT_CHECKOUT_SHIPPING
    const parsed = JSON.parse(raw) as Partial<StoredCheckoutShipping>
    if (
      !parsed.value ||
      !Number.isFinite(parsed.updatedAt) ||
      (parsed.updatedAt ?? 0) <= 0 ||
      (parsed.updatedAt ?? 0) > nowMs ||
      nowMs - (parsed.updatedAt ?? 0) >= GUEST_ORDER_LOCAL_RETENTION_MS
    ) {
      storage.removeItem(CHECKOUT_SHIPPING_STORAGE_KEY)
      return DEFAULT_CHECKOUT_SHIPPING
    }
    return { ...DEFAULT_CHECKOUT_SHIPPING, ...parsed.value }
  } catch {
    try {
      storage.removeItem(CHECKOUT_SHIPPING_STORAGE_KEY)
    } catch {
      // ignore
    }
    return DEFAULT_CHECKOUT_SHIPPING
  }
}

export function writeCheckoutShippingSession(
  value: ShippingFormState,
  storage: SessionStorageLike | null = getSessionStorage(),
  nowMs = Date.now()
): void {
  if (!storage) return
  try {
    const stored: StoredCheckoutShipping = { value, updatedAt: nowMs }
    storage.setItem(CHECKOUT_SHIPPING_STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // ignore
  }
}

export function clearCheckoutShippingSession(
  storage: SessionStorageLike | null = getSessionStorage()
): void {
  try {
    storage?.removeItem(CHECKOUT_SHIPPING_STORAGE_KEY)
  } catch {
    // ignore
  }
}
