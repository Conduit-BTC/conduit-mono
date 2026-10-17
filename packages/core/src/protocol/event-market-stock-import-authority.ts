import type {
  EventMarketOrganizerStockPool,
  MerchantInventoryAcceptedOrder,
} from "../db"
import {
  parseEventMarketStockAuthorityRumor,
  type EventMarketStockGrant,
  type EventMarketStockAcceptance,
} from "./event-market-stock-authority"
import type { PrivateMessageRumor } from "./private-message-primitives"
import type { SignedPublicNostrEvent } from "./signed-event"

/** NIP01 event bytes are independent of JavaScript object property order. */
export function sameOrganizerStockRumor(
  a: PrivateMessageRumor,
  b: PrivateMessageRumor
): boolean {
  const bytes = (event: PrivateMessageRumor) =>
    JSON.stringify([
      event.kind,
      event.pubkey,
      event.created_at,
      event.tags,
      event.content,
      event.id,
    ])
  return bytes(a) === bytes(b)
}

/** Validate the durable pool, never infer authority from a relay summary. */
export function validateMerchantOrganizerStockPool(
  pool: EventMarketOrganizerStockPool,
  merchantPubkey: string
): EventMarketStockGrant {
  const grant = parseEventMarketStockAuthorityRumor(pool.grantRumor)
  const count = (value: number) =>
    Number.isInteger(value) && value >= 0 && value <= pool.quantity
  if (
    grant.type !== "grant" ||
    pool.accountPubkey !== merchantPubkey ||
    pool.merchantPubkey !== merchantPubkey ||
    grant.merchantPubkey !== merchantPubkey ||
    pool.id !== `${merchantPubkey}:${pool.poolId}` ||
    pool.poolId !== pool.grantRumor.id ||
    pool.organizerPubkey !== grant.organizerPubkey ||
    pool.writerId !== grant.writerId ||
    pool.quantity !== grant.quantity ||
    pool.productCoordinate !== grant.productCoordinate ||
    pool.assignmentCoordinate !== grant.assignmentCoordinate ||
    !count(pool.acceptedQuantity) ||
    !count(pool.acceptedSequence) ||
    !count(pool.importedQuantity) ||
    !count(pool.importedSequence) ||
    pool.importedQuantity > pool.acceptedQuantity ||
    pool.importedSequence > pool.acceptedSequence ||
    pool.acceptedSequence > pool.acceptedQuantity ||
    pool.importedSequence > pool.importedQuantity ||
    (pool.importedSequence === pool.acceptedSequence &&
      (pool.importedQuantity !== pool.acceptedQuantity ||
        pool.lastImportedId !== pool.lastAcceptedId)) ||
    (pool.importedSequence < pool.acceptedSequence &&
      pool.importedQuantity >= pool.acceptedQuantity) ||
    !/^[0-9a-f]{64}$/.test(pool.lastAcceptedId) ||
    !/^[0-9a-f]{64}$/.test(pool.lastImportedId) ||
    (pool.importedSequence === 0 &&
      (pool.importedQuantity !== 0 || pool.lastImportedId !== pool.poolId)) ||
    (pool.acceptedSequence === 0 &&
      (pool.acceptedQuantity !== 0 || pool.lastAcceptedId !== pool.poolId)) ||
    !["prepared", "active", "closing", "closed"].includes(pool.state)
  )
    throw new Error("Merchant stock pool requires reconciliation")
  return grant
}

export interface VerifiedImportEntry {
  readonly rumor: PrivateMessageRumor
  readonly payload: EventMarketStockAcceptance
  readonly envelope: SignedPublicNostrEvent
  readonly grantRumor: PrivateMessageRumor
}
interface VerifiedImportData {
  readonly orderId: string
  readonly merchantPubkey: string
  readonly identityBinding: string
  readonly termsBinding: string
  readonly attribution: NonNullable<
    MerchantInventoryAcceptedOrder["organizerImport"]
  >
  readonly entries: readonly VerifiedImportEntry[]
  readonly checkSession: () => void
}
declare const verifiedImportBrand: unique symbol
export interface VerifiedOrganizerStockImport {
  readonly [verifiedImportBrand]: true
}
const verifiedImports = new WeakMap<
  VerifiedOrganizerStockImport,
  VerifiedImportData
>()

/** @internal Only the authenticated NIP59 import workflow mints this capability. */
export function createVerifiedOrganizerStockImport(
  data: VerifiedImportData
): VerifiedOrganizerStockImport {
  const context = Object.freeze({}) as VerifiedOrganizerStockImport
  verifiedImports.set(context, data)
  return context
}

/** @internal Shared stock owner seam; deliberately not part of the public barrel. */
export function readVerifiedOrganizerStockImport(
  context: VerifiedOrganizerStockImport
): VerifiedImportData {
  const data = verifiedImports.get(context)
  if (!data) throw new Error("Authenticated organizer stock import required")
  data.checkSession()
  return data
}
