export const CHECKOUT_SPARK_SETTLED_PREPARATION_STORAGE_KEY =
  "conduit:checkout-spark-settled-preparations:v3"
const MAX_STORED = 64
const HEX_64 = /^[0-9a-f]{64}$/

export type CheckoutSparkSettledPreparationStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>

export interface StoredCheckoutSparkSettledPreparation {
  schemaVersion: 3
  checkoutId: string
  planDigest: string
  /** SHA-256 of the exact cart batches that started this checkout. */
  purchaseClaimDigest?: string
  recoveryHandoffId: string | null
  fundingInvoiceExposedAt: number | null
  fundingSubmissionState: "not_started" | "provisional"
  /** Possible external payment; immutable once its invoice can leave the app. */
  externalFundingExposedAt?: number
  savedAt: number
}

export function getCheckoutSparkSettledPreparationBrowserStorage(): CheckoutSparkSettledPreparationStorage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function requireCheckoutSparkSettledPreparationStorage(
  storage: CheckoutSparkSettledPreparationStorage | null
): CheckoutSparkSettledPreparationStorage {
  if (!storage) {
    throw new Error(
      "Durable settled checkout preparation storage is unavailable."
    )
  }
  return storage
}

export function parseStoredCheckoutSparkSettledPreparation(
  value: unknown
): StoredCheckoutSparkSettledPreparation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored settled checkout preparation is invalid.")
  }
  const item = value as Partial<StoredCheckoutSparkSettledPreparation>
  if (
    item.schemaVersion !== 3 ||
    typeof item.checkoutId !== "string" ||
    !item.checkoutId ||
    item.checkoutId.trim() !== item.checkoutId ||
    item.checkoutId.length > 512 ||
    typeof item.planDigest !== "string" ||
    !HEX_64.test(item.planDigest) ||
    (item.purchaseClaimDigest !== undefined &&
      (typeof item.purchaseClaimDigest !== "string" ||
        !HEX_64.test(item.purchaseClaimDigest))) ||
    (item.recoveryHandoffId !== null &&
      (typeof item.recoveryHandoffId !== "string" ||
        !item.recoveryHandoffId ||
        item.recoveryHandoffId.length > 256)) ||
    (item.fundingInvoiceExposedAt !== null &&
      (!Number.isSafeInteger(item.fundingInvoiceExposedAt) ||
        item.fundingInvoiceExposedAt! < 0 ||
        item.recoveryHandoffId === null)) ||
    (item.fundingSubmissionState !== "not_started" &&
      item.fundingSubmissionState !== "provisional") ||
    (item.externalFundingExposedAt !== undefined &&
      (!Number.isSafeInteger(item.externalFundingExposedAt) ||
        item.fundingSubmissionState !== "provisional" ||
        item.fundingInvoiceExposedAt === null ||
        item.externalFundingExposedAt < item.fundingInvoiceExposedAt! ||
        item.externalFundingExposedAt > item.savedAt!)) ||
    !Number.isSafeInteger(item.savedAt) ||
    item.savedAt! < 0
  ) {
    throw new Error("Stored settled checkout preparation is invalid.")
  }
  return item as StoredCheckoutSparkSettledPreparation
}

export function readStoredCheckoutSparkSettledPreparations(
  storage: CheckoutSparkSettledPreparationStorage | null
): StoredCheckoutSparkSettledPreparation[] {
  const raw = requireCheckoutSparkSettledPreparationStorage(storage).getItem(
    CHECKOUT_SPARK_SETTLED_PREPARATION_STORAGE_KEY
  )
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Stored settled checkout preparations are invalid.")
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_STORED) {
    throw new Error("Stored settled checkout preparations are invalid.")
  }
  const items = parsed.map(parseStoredCheckoutSparkSettledPreparation)
  if (new Set(items.map((item) => item.checkoutId)).size !== items.length) {
    throw new Error("Stored settled checkout preparations are duplicated.")
  }
  return items
}

export function writeStoredCheckoutSparkSettledPreparations(
  items: readonly StoredCheckoutSparkSettledPreparation[],
  storage: CheckoutSparkSettledPreparationStorage | null
): void {
  if (items.length > MAX_STORED) {
    throw new Error("Stored settled checkout preparation limit reached.")
  }
  requireCheckoutSparkSettledPreparationStorage(storage).setItem(
    CHECKOUT_SPARK_SETTLED_PREPARATION_STORAGE_KEY,
    JSON.stringify(items)
  )
}

export function getCheckoutSparkSettledPreparation(
  checkoutId: string,
  storage: CheckoutSparkSettledPreparationStorage | null = getCheckoutSparkSettledPreparationBrowserStorage()
): StoredCheckoutSparkSettledPreparation | null {
  return (
    readStoredCheckoutSparkSettledPreparations(storage).find(
      (item) => item.checkoutId === checkoutId
    ) ?? null
  )
}

export function listCheckoutSparkSettledPreparations(
  storage: CheckoutSparkSettledPreparationStorage | null = getCheckoutSparkSettledPreparationBrowserStorage()
): StoredCheckoutSparkSettledPreparation[] {
  return readStoredCheckoutSparkSettledPreparations(storage)
}
