import {
  orderSchema,
  snapshotCheckoutSparkPlanSourceEvents,
  type OrderSchema,
  type OrderLifecycle,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const STORAGE_KEY = "conduit:checkout-spark-settled-continuations:v1"
const RETENTION_MS = 24 * 60 * 60_000
const MAX_STORED = 16
export type CheckoutSparkSettledContinuationStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>
type ContinuationStorage = CheckoutSparkSettledContinuationStorage

/** Same-tab original private draft only. No wallet credential or buyer inbox. */
export interface CheckoutSparkSettledContinuation {
  schemaVersion: 1
  checkoutId: string
  planDigest: string
  purchaseClaimDigest?: string
  buyerPubkey: string
  identityKind: "signed_in" | "guest_ephemeral"
  createdAt: number
  expiresAt: number
  order: OrderSchema
  sourceEvents: readonly SignedPublicNostrEvent[]
  addressValidity: OrderLifecycle["addressValidity"]
  shippingZoneEligibility: OrderLifecycle["shippingZoneEligibility"]
}

function browserStorage(): ContinuationStorage | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function parse(value: unknown): CheckoutSparkSettledContinuation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The original checkout draft is unreadable.")
  const row = value as CheckoutSparkSettledContinuation
  const order = orderSchema.parse(row.order)
  if (
    row.schemaVersion !== 1 ||
    typeof row.checkoutId !== "string" ||
    !row.checkoutId ||
    !/^[0-9a-f]{64}$/.test(row.planDigest) ||
    !/^[0-9a-f]{64}$/.test(row.buyerPubkey) ||
    (row.purchaseClaimDigest !== undefined &&
      !/^[0-9a-f]{64}$/.test(row.purchaseClaimDigest)) ||
    (row.identityKind !== "signed_in" &&
      row.identityKind !== "guest_ephemeral") ||
    order.buyerPubkey !== row.buyerPubkey ||
    order.buyerIdentityKind !== row.identityKind ||
    !Number.isSafeInteger(row.createdAt) ||
    row.createdAt < 0 ||
    !Number.isSafeInteger(row.expiresAt) ||
    row.expiresAt <= row.createdAt ||
    row.expiresAt > row.createdAt + RETENTION_MS ||
    !["not_required", "valid", "missing", "inconsistent", "unknown"].includes(
      row.addressValidity ?? ""
    ) ||
    !["not_required", "eligible", "ineligible", "unknown"].includes(
      row.shippingZoneEligibility ?? ""
    )
  ) {
    throw new Error("The original checkout draft is unreadable.")
  }
  return {
    schemaVersion: 1,
    checkoutId: row.checkoutId,
    planDigest: row.planDigest,
    ...(row.purchaseClaimDigest === undefined
      ? {}
      : { purchaseClaimDigest: row.purchaseClaimDigest }),
    buyerPubkey: row.buyerPubkey,
    identityKind: row.identityKind,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    order,
    sourceEvents: snapshotCheckoutSparkPlanSourceEvents(row.sourceEvents),
    addressValidity: row.addressValidity,
    shippingZoneEligibility: row.shippingZoneEligibility,
  }
}

function read(
  storage: ContinuationStorage | null
): CheckoutSparkSettledContinuation[] {
  if (!storage)
    throw new Error("Same-tab checkout recovery storage is unavailable.")
  const raw = storage.getItem(STORAGE_KEY)
  if (raw === null) return []
  if (raw.length > 1_000_000)
    throw new Error("The original checkout draft is unreadable.")
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("The original checkout draft is unreadable.")
  }
  if (!Array.isArray(value) || value.length > MAX_STORED)
    throw new Error("The original checkout draft is unreadable.")
  const rows = value.map(parse)
  if (new Set(rows.map((row) => row.checkoutId)).size !== rows.length)
    throw new Error("The original checkout draft is ambiguous.")
  return rows
}

/** Purge expired private drafts even when the guest signer registry is gone. */
export function pruneExpiredCheckoutSparkSettledContinuations(
  now: number,
  storage: ContinuationStorage | null = browserStorage()
): CheckoutSparkSettledContinuation[] {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("The checkout recovery clock is invalid.")
  const rows = read(storage)
  const retained = rows.filter((row) => now < row.expiresAt)
  if (retained.length !== rows.length) {
    storage!.setItem(STORAGE_KEY, JSON.stringify(retained))
    if (read(storage).some((row) => now >= row.expiresAt))
      throw new Error("Expired checkout drafts could not be cleared.")
  }
  return retained
}

export function listCheckoutSparkSettledContinuations(
  buyerPubkey: string,
  now: number,
  storage: ContinuationStorage | null = browserStorage()
): CheckoutSparkSettledContinuation[] {
  if (
    !/^[0-9a-f]{64}$/.test(buyerPubkey) ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    return []
  return pruneExpiredCheckoutSparkSettledContinuations(now, storage).filter(
    (row) => row.buyerPubkey === buyerPubkey && now >= row.createdAt
  )
}

export function saveCheckoutSparkSettledContinuation(
  value: CheckoutSparkSettledContinuation,
  storage: ContinuationStorage | null = browserStorage()
): void {
  const row = parse(value)
  const rows = read(storage)
  const existing = rows.find((item) => item.checkoutId === row.checkoutId)
  if (existing && JSON.stringify(existing) !== JSON.stringify(row))
    throw new Error("The original checkout draft cannot be replaced.")
  if (!existing) rows.push(row)
  if (rows.length > MAX_STORED)
    throw new Error("Same-tab checkout recovery storage is full.")
  storage!.setItem(STORAGE_KEY, JSON.stringify(rows))
  const saved = read(storage).find((item) => item.checkoutId === row.checkoutId)
  if (!saved || JSON.stringify(saved) !== JSON.stringify(row))
    throw new Error("The original checkout draft was not durably saved.")
}

/** Clear PII only after authoritative order ACK or positive pristine cleanup. */
export function clearCheckoutSparkSettledContinuation(
  checkoutId: string,
  planDigest: string,
  storage: ContinuationStorage | null = browserStorage()
): void {
  const rows = read(storage)
  const row = rows.find((item) => item.checkoutId === checkoutId)
  if (row && row.planDigest !== planDigest)
    throw new Error("The original checkout draft changed.")
  storage!.setItem(
    STORAGE_KEY,
    JSON.stringify(rows.filter((item) => item.checkoutId !== checkoutId))
  )
  if (read(storage).some((item) => item.checkoutId === checkoutId))
    throw new Error("The original checkout draft could not be cleared.")
}
