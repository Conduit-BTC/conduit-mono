import {
  GUEST_ORDER_LOCAL_RETENTION_MS,
  type ShopperShippingPreset,
} from "@conduit/core"
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
  ownerPubkey: string | null
}

export type CheckoutShippingDraftOwnership = {
  hasValidDraft: boolean
  ownerPubkey: string | null
}

export type CheckoutShippingDraftOwnershipAction =
  "claim" | "clear" | "defer" | "restore" | "seed"

let checkoutShippingExpiryTimer: number | null = null

function getSessionStorage(): SessionStorageLike | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function isActiveSessionStorage(storage: SessionStorageLike | null): boolean {
  return typeof window !== "undefined" && storage === getSessionStorage()
}

function cancelCheckoutShippingExpiryTimer(
  storage: SessionStorageLike | null
): void {
  if (
    !isActiveSessionStorage(storage) ||
    checkoutShippingExpiryTimer === null
  ) {
    return
  }
  window.clearTimeout(checkoutShippingExpiryTimer)
  checkoutShippingExpiryTimer = null
}

function removeCheckoutShippingStorage(
  storage: SessionStorageLike | null
): void {
  cancelCheckoutShippingExpiryTimer(storage)
  try {
    storage?.removeItem(CHECKOUT_SHIPPING_STORAGE_KEY)
  } catch {
    // ignore
  }
}

function scheduleCheckoutShippingExpiry(
  storage: SessionStorageLike | null,
  expiresAt: number
): void {
  if (!isActiveSessionStorage(storage)) return
  cancelCheckoutShippingExpiryTimer(storage)
  checkoutShippingExpiryTimer = window.setTimeout(
    () => {
      checkoutShippingExpiryTimer = null
      pruneExpiredCheckoutShippingSession(storage)
    },
    Math.max(0, expiresAt - Date.now())
  )
}

function parseStoredCheckoutShipping(
  raw: string,
  nowMs: number
): StoredCheckoutShipping | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCheckoutShipping>
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !parsed.value ||
      typeof parsed.value !== "object" ||
      Array.isArray(parsed.value) ||
      !("ownerPubkey" in parsed) ||
      (parsed.ownerPubkey !== null && typeof parsed.ownerPubkey !== "string") ||
      !Number.isFinite(parsed.updatedAt) ||
      (parsed.updatedAt ?? 0) <= 0 ||
      (parsed.updatedAt ?? 0) > nowMs ||
      nowMs - (parsed.updatedAt ?? 0) >= GUEST_ORDER_LOCAL_RETENTION_MS
    ) {
      return null
    }
    return parsed as StoredCheckoutShipping
  } catch {
    return null
  }
}

function readStoredCheckoutShipping(
  storage: SessionStorageLike | null,
  nowMs: number,
  ownerPubkey?: string | null
): StoredCheckoutShipping | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(CHECKOUT_SHIPPING_STORAGE_KEY)
    if (!raw) return null
    const stored = parseStoredCheckoutShipping(raw, nowMs)
    if (!stored) {
      removeCheckoutShippingStorage(storage)
      return null
    }
    if (ownerPubkey !== undefined && stored.ownerPubkey !== ownerPubkey) {
      return null
    }
    scheduleCheckoutShippingExpiry(
      storage,
      stored.updatedAt + GUEST_ORDER_LOCAL_RETENTION_MS
    )
    return stored
  } catch {
    removeCheckoutShippingStorage(storage)
    return null
  }
}

/**
 * Inspects only draft validity and ownership before any address or contact value
 * is read. Invalid local data retains the existing bounded cleanup behavior.
 */
export function inspectCheckoutShippingDraftOwnership(
  storage: SessionStorageLike | null = getSessionStorage(),
  nowMs = Date.now()
): CheckoutShippingDraftOwnership {
  if (!storage) return { hasValidDraft: false, ownerPubkey: null }
  try {
    const raw = storage.getItem(CHECKOUT_SHIPPING_STORAGE_KEY)
    if (!raw) return { hasValidDraft: false, ownerPubkey: null }
    const stored = parseStoredCheckoutShipping(raw, nowMs)
    if (!stored) {
      removeCheckoutShippingStorage(storage)
      return { hasValidDraft: false, ownerPubkey: null }
    }
    return { hasValidDraft: true, ownerPubkey: stored.ownerPubkey }
  } catch {
    return { hasValidDraft: false, ownerPubkey: null }
  }
}

/**
 * Selects a storage action without receiving checkout address or contact data.
 * Pending restoration deliberately defers even ownership inspection decisions.
 */
export function getCheckoutShippingDraftOwnershipAction(input: {
  identityPubkey: string | null
  isRestorePending: boolean
  ownership: CheckoutShippingDraftOwnership
}): CheckoutShippingDraftOwnershipAction {
  if (input.isRestorePending) return "defer"
  if (!input.ownership.hasValidDraft) return "seed"

  if (input.identityPubkey) {
    if (input.ownership.ownerPubkey === input.identityPubkey) return "restore"
    return input.ownership.ownerPubkey === null ? "claim" : "clear"
  }

  return input.ownership.ownerPubkey === null ? "restore" : "clear"
}

export function initializeCheckoutShippingSession(
  preset: ShopperShippingPreset | null,
  identityPubkey: string | null,
  storage: SessionStorageLike | null = getSessionStorage(),
  nowMs = Date.now()
): { value: ShippingFormState; hasActiveDraft: boolean } {
  const action = getCheckoutShippingDraftOwnershipAction({
    identityPubkey,
    isRestorePending: false,
    ownership: inspectCheckoutShippingDraftOwnership(storage, nowMs),
  })

  if (action === "clear") {
    clearCheckoutShippingSession(storage)
  } else if (action === "claim" && identityPubkey) {
    claimGuestCheckoutShippingSession(identityPubkey, storage, nowMs)
  }

  if (action === "restore" || action === "claim") {
    return readCheckoutShippingInitialization(
      preset,
      storage,
      nowMs,
      identityPubkey
    )
  }

  return {
    value: preset
      ? getShippingFormFromPreset(preset)
      : DEFAULT_CHECKOUT_SHIPPING,
    hasActiveDraft: false,
  }
}

export function pruneExpiredCheckoutShippingSession(
  storage: SessionStorageLike | null = getSessionStorage(),
  nowMs = Date.now()
): boolean {
  if (!storage) return false
  try {
    if (storage.getItem(CHECKOUT_SHIPPING_STORAGE_KEY) === null) return false
  } catch {
    return false
  }
  return readStoredCheckoutShipping(storage, nowMs) === null
}

export function readCheckoutShippingInitialization(
  preset: ShopperShippingPreset | null,
  storage: SessionStorageLike | null = getSessionStorage(),
  nowMs = Date.now(),
  ownerPubkey: string | null = null
): { value: ShippingFormState; hasActiveDraft: boolean } {
  const stored = readStoredCheckoutShipping(storage, nowMs, ownerPubkey)
  if (stored) {
    return {
      value: { ...DEFAULT_CHECKOUT_SHIPPING, ...stored.value },
      hasActiveDraft: true,
    }
  }
  return {
    value: preset
      ? getShippingFormFromPreset(preset)
      : DEFAULT_CHECKOUT_SHIPPING,
    hasActiveDraft: false,
  }
}

export function getShippingFormFromPreset(
  preset: ShopperShippingPreset
): ShippingFormState {
  const names = preset.recipientName.trim().split(/\s+/u)
  const lastName = names.length > 1 ? (names.pop() ?? "") : ""
  return {
    ...DEFAULT_CHECKOUT_SHIPPING,
    firstName: names.join(" "),
    lastName,
    name: preset.recipientName,
    street: preset.addressLine1,
    line2: preset.addressLine2 ?? "",
    city: preset.city,
    state: preset.stateOrRegion ?? "",
    postalCode: preset.postalCode,
    country: preset.country,
    email: preset.email ?? "",
    phone: preset.phone ?? "",
  }
}

export function getIdentityBoundShippingPreset(
  identityPubkey: string | null,
  presetOwnerPubkey: string | null,
  preset: ShopperShippingPreset | null
): ShopperShippingPreset | null {
  return identityPubkey && identityPubkey === presetOwnerPubkey ? preset : null
}

export function claimGuestCheckoutShippingSession(
  ownerPubkey: string,
  storage: SessionStorageLike | null = getSessionStorage(),
  nowMs = Date.now()
): boolean {
  if (!ownerPubkey) return false
  const stored = readStoredCheckoutShipping(storage, nowMs)
  if (!stored || stored.ownerPubkey !== null) return false

  try {
    storage?.setItem(
      CHECKOUT_SHIPPING_STORAGE_KEY,
      JSON.stringify({ ...stored, ownerPubkey })
    )
    scheduleCheckoutShippingExpiry(
      storage,
      stored.updatedAt + GUEST_ORDER_LOCAL_RETENTION_MS
    )
    return true
  } catch {
    return false
  }
}

export function writeCheckoutShippingSession(
  value: ShippingFormState,
  storage: SessionStorageLike | null = getSessionStorage(),
  nowMs = Date.now(),
  ownerPubkey: string | null = null
): void {
  if (!storage) return
  try {
    const stored: StoredCheckoutShipping = {
      value,
      updatedAt: nowMs,
      ownerPubkey,
    }
    storage.setItem(CHECKOUT_SHIPPING_STORAGE_KEY, JSON.stringify(stored))
    scheduleCheckoutShippingExpiry(
      storage,
      nowMs + GUEST_ORDER_LOCAL_RETENTION_MS
    )
  } catch {
    // ignore
  }
}

export function clearCheckoutShippingSession(
  storage: SessionStorageLike | null = getSessionStorage()
): void {
  removeCheckoutShippingStorage(storage)
}
