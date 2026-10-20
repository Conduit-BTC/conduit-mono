import { db, type ConduitDB } from "@conduit/core/db"
import {
  parseEventMarketFreePurchaseDelivery as parse,
  type EventMarketFreePurchaseDelivery,
} from "@conduit/core/protocol/event-market-free-purchase-delivery-record"
export type { EventMarketFreePurchaseDelivery } from "@conduit/core/protocol/event-market-free-purchase-delivery-record"
import {
  preparePrivateMessageRecipientWrap,
  retryPrivateMessageWraps,
  type NostrKeySigner,
} from "@conduit/core"
import {
  buildEventMarketFreePurchaseRumor,
  restoreEventMarketFreePurchase,
  type EventMarketFreePurchasePayload,
} from "@conduit/core/protocol/event-market-free-purchase"
import {
  createGuestEventMarketFreePurchaseSigner,
  type GuestOrderSigningIdentity,
} from "./guest-order-identity"
import { withCheckoutSparkStorageLock } from "./checkout-spark-storage"
import { BuyerOrderPublishError } from "./order-publish"

export const EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY =
  "conduit:event-market-free-purchase-outbox:v1"
type StorageLike = Pick<Storage, "getItem" | "setItem">
type RetryOptions = Pick<
  Parameters<typeof retryPrivateMessageWraps>[0],
  "resolveInboxRelays" | "publishFn"
>
/** Persist a bounded opaque cart partition reference, not its encoded contents. */
export async function createFreePurchaseScope(
  purchaseId: string
): Promise<string> {
  if (!purchaseId || !globalThis.crypto?.subtle)
    throw new Error("The free pickup purchase cannot be safely identified.")
  const bytes = new TextEncoder().encode(
    JSON.stringify(["conduit:event-free-purchase-scope:v1", purchaseId])
  )
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("")
}

function storageOrThrow(storage?: StorageLike): StorageLike {
  if (storage) return storage
  try {
    if (typeof window !== "undefined") return window.localStorage
  } catch {
    // Durability is required, rather than a process-only fallback.
  }
  throw new Error("Free pickup delivery storage is unavailable.")
}

export function listEventMarketFreePurchaseDeliveries(
  storage?: StorageLike
): EventMarketFreePurchaseDelivery[] {
  const raw = storageOrThrow(storage).getItem(
    EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY
  )
  if (raw === null) return []
  if (raw.length > 4 * 1024 * 1024)
    throw new Error("Saved free pickup delivery exceeds its storage bound.")
  const values: unknown = JSON.parse(raw)
  if (!Array.isArray(values) || values.length > 64)
    throw new Error("Saved free pickup delivery is malformed.")
  const rows = values.map(parse)
  if (
    new Set(rows.map((row) => row.handoffId)).size !== rows.length ||
    new Set(rows.map((row) => row.orderId)).size !== rows.length
  )
    throw new Error("Saved free pickup deliveries conflict.")
  return rows
}

/** Read legacy packets alongside the packet committed with its original order.
 * No second durability write is needed before either recipient can be sent.
 */
export async function loadEventMarketFreePurchaseDeliveries(
  input: {
    storage?: StorageLike
    database?: ConduitDB
    merchantPubkey?: string
  } = {}
): Promise<EventMarketFreePurchaseDelivery[]> {
  const database = input.database ?? db
  const rows = listEventMarketFreePurchaseDeliveries(input.storage)
  const orders = input.merchantPubkey
    ? await database.orderLifecycles
        .where("merchantPubkey")
        .equals(input.merchantPubkey)
        .toArray()
    : await database.orderLifecycles.toArray()
  for (const order of orders) {
    if (!order.eventMarketFreePurchaseDelivery) continue
    const packet = parse(order.eventMarketFreePurchaseDelivery)
    if (
      !order.orderRelayDelivery ||
      packet.orderId !== order.orderId ||
      packet.senderPubkey !== order.buyerPubkey ||
      packet.merchantPubkey !== order.merchantPubkey ||
      packet.buyerIdentityKind !== order.buyerIdentityKind ||
      order.totalSats !== 0 ||
      (packet.merchantDelivered && order.orderDeliveryStatus !== "sent")
    )
      throw new Error(
        "Saved free pickup delivery lost its original order binding."
      )
    const existing = rows.find(
      (row) =>
        row.orderId === packet.orderId || row.handoffId === packet.handoffId
    )
    if (existing) {
      if (!samePacket(existing, packet))
        throw new Error("Saved free pickup deliveries conflict.")
      existing.merchantDelivered ||= packet.merchantDelivered
      existing.acknowledged ||= packet.acknowledged
    } else rows.push(packet)
  }
  return rows
}

function samePacket(
  left: EventMarketFreePurchaseDelivery,
  right: EventMarketFreePurchaseDelivery
) {
  const immutable = (row: EventMarketFreePurchaseDelivery) =>
    JSON.stringify({
      ...parse(row),
      merchantDelivered: false,
      acknowledged: false,
    })
  return immutable(left) === immutable(right)
}

async function persistProgress(
  row: EventMarketFreePurchaseDelivery,
  input: {
    storage?: StorageLike
    database?: ConduitDB
  }
): Promise<EventMarketFreePurchaseDelivery> {
  const database = input.database ?? db
  const storage = storageOrThrow(input.storage)
  const committed = await database.transaction(
    "rw",
    database.orderLifecycles,
    async () => {
      const order = await database.orderLifecycles.get(row.orderId)
      if (!order?.eventMarketFreePurchaseDelivery) return null
      const previous = parse(order.eventMarketFreePurchaseDelivery)
      if (
        !samePacket(previous, row) ||
        (row.merchantDelivered && order.orderDeliveryStatus !== "sent")
      )
        throw new Error(
          "Free pickup progress does not match the original order."
        )
      const next = parse({
        ...previous,
        merchantDelivered: previous.merchantDelivered || row.merchantDelivered,
        acknowledged: previous.acknowledged || row.acknowledged,
      })
      await database.orderLifecycles.update(row.orderId, {
        eventMarketFreePurchaseDelivery: next,
      })
      return next
    }
  )
  // Existing pre-upgrade attempts keep their original storage and exact bytes.
  const legacy = listEventMarketFreePurchaseDeliveries(storage)
  const index = legacy.findIndex(
    (candidate) => candidate.handoffId === row.handoffId
  )
  if (index >= 0) {
    if (!samePacket(legacy[index]!, row))
      throw new Error("Saved free pickup delivery changed.")
    legacy[index] = committed ?? row
    save(legacy, storage)
  } else if (!committed)
    throw new Error("Saved free pickup delivery is unavailable.")
  return committed ?? row
}

function save(rows: EventMarketFreePurchaseDelivery[], storage: StorageLike) {
  // Never evict an unfinished handover to make room for another order.
  const bounded = [...rows]
  while (bounded.length > 64) {
    const completed = bounded.findIndex((row) => row.acknowledged)
    if (completed === -1)
      throw new Error(
        "Finish a saved free pickup delivery before another order."
      )
    bounded.splice(completed, 1)
  }
  const serialized = JSON.stringify(bounded.map(parse))
  if (serialized.length > 4 * 1024 * 1024)
    throw new Error("Free pickup delivery storage is full.")
  storage.setItem(EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY, serialized)
  if (storage.getItem(EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY) !== serialized)
    throw new Error("Free pickup delivery was not durably saved.")
}

function assertCurrent(shouldContinue: () => boolean) {
  if (!shouldContinue()) throw new Error("The buyer session changed.")
}

/** Prepare one organizer-only seal. Checkout defers persistence so both recipient
 * records commit together in the original order transaction before any send.
 * The saved record contains ciphertext and delivery references, never an order,
 * contact information, wallet, invoice, or the plaintext free-purchase payload.
 */
export async function prepareEventMarketFreePurchaseDelivery(input: {
  payload: EventMarketFreePurchasePayload
  purchaseId: string
  purchaseClaimDigest: string
  identity:
    | GuestOrderSigningIdentity
    | { kind?: "signed_in"; pubkey: string; signer?: NostrKeySigner }
  shouldContinue: () => boolean
  storage?: StorageLike
  now?: () => number
  /** Checkout commits this packet with the original Merchant wrap in IndexedDB. */
  deferPersistence?: boolean
  database?: ConduitDB
}): Promise<EventMarketFreePurchaseDelivery> {
  const payload = restoreEventMarketFreePurchase(input.payload)
  const storage = storageOrThrow(input.storage)
  assertCurrent(input.shouldContinue)
  if (input.identity.pubkey !== payload.senderPubkey)
    throw new Error("Free pickup sender changed.")
  const signer =
    input.identity.kind === "guest_ephemeral"
      ? createGuestEventMarketFreePurchaseSigner(input.identity, {
          payload,
          now: input.now,
        })
      : input.identity.signer
  if (!signer) throw new Error("The buyer signer is unavailable.")
  const rumor = buildEventMarketFreePurchaseRumor(payload)
  const prepared = await preparePrivateMessageRecipientWrap({
    rumor,
    senderPubkey: payload.senderPubkey,
    recipientPubkey: payload.organizerPubkey,
    signer,
    shouldContinue: input.shouldContinue,
  })
  const row = parse({
    schemaVersion: 1,
    handoffId: payload.handoffId,
    rumorId: rumor.id,
    orderId: payload.orderId,
    purchaseScope: await createFreePurchaseScope(input.purchaseId),
    purchaseClaimDigest: input.purchaseClaimDigest,
    senderPubkey: payload.senderPubkey,
    merchantPubkey: payload.merchantPubkey,
    organizerPubkey: payload.organizerPubkey,
    buyerIdentityKind: input.identity.kind ?? "signed_in",
    createdAt: payload.createdAt,
    wrappedToRecipient: prepared.wrappedToRecipient,
    merchantDelivered: false,
    acknowledged: false,
  })
  return withCheckoutSparkStorageLock(
    EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY,
    async () => {
      assertCurrent(input.shouldContinue)
      const rows = await loadEventMarketFreePurchaseDeliveries({
        ...input,
        storage,
      })
      const existing = rows.find(
        (candidate) => candidate.handoffId === row.handoffId
      )
      if (existing) {
        if (
          existing.orderId !== row.orderId ||
          existing.rumorId !== row.rumorId ||
          existing.purchaseScope !== row.purchaseScope ||
          existing.purchaseClaimDigest !== row.purchaseClaimDigest
        )
          throw new Error("Free pickup delivery changed.")
        return existing
      }
      if (
        rows.some(
          (candidate) =>
            candidate.orderId === row.orderId ||
            candidate.purchaseClaimDigest === row.purchaseClaimDigest
        )
      )
        throw new Error(
          "Continue the existing free pickup order; do not create another."
        )
      if (input.deferPersistence) {
        const pending = rows.filter((candidate) => !candidate.acknowledged)
        if (
          pending.length >= 64 ||
          JSON.stringify([...pending, row]).length > 4 * 1024 * 1024
        )
          throw new Error(
            "Finish a saved free pickup delivery before another order."
          )
      } else save([...rows, row], storage)
      return row
    }
  )
}

export async function markFreePurchaseMerchantDelivered(input: {
  handoffId: string
  shouldContinue: () => boolean
  storage?: StorageLike
  database?: ConduitDB
}): Promise<EventMarketFreePurchaseDelivery> {
  const storage = storageOrThrow(input.storage)
  return withCheckoutSparkStorageLock(
    EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY,
    async () => {
      assertCurrent(input.shouldContinue)
      const rows = await loadEventMarketFreePurchaseDeliveries({
        ...input,
        storage,
      })
      const row = rows.find(
        (candidate) => candidate.handoffId === input.handoffId
      )
      if (!row) throw new Error("Saved free pickup delivery is unavailable.")
      row.merchantDelivered = true
      return persistProgress(row, { ...input, storage })
    }
  )
}

/** Only the original publication owner's positive no-submission result permits
 * discarding a prepared organizer wrap. Missing local history alone never does.
 */
export async function discardUnsubmittedFreePurchaseDelivery(input: {
  handoffId: string
  originalOrderFailure: BuyerOrderPublishError
  storage?: StorageLike
}): Promise<void> {
  if (
    !(input.originalOrderFailure instanceof BuyerOrderPublishError) ||
    input.originalOrderFailure.phase !== "not_staged"
  )
    throw new Error("Original order non-submission is not established.")
  const storage = storageOrThrow(input.storage)
  await withCheckoutSparkStorageLock(
    EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY,
    () => {
      const rows = listEventMarketFreePurchaseDeliveries(storage)
      const row = rows.find(
        (candidate) => candidate.handoffId === input.handoffId
      )
      if (!row) return
      if (row.merchantDelivered || row.acknowledged)
        throw new Error("The saved free pickup delivery cannot be discarded.")
      save(
        rows.filter((candidate) => candidate.handoffId !== row.handoffId),
        storage
      )
    }
  )
}

/** Retries the same already-signed ciphertext; no guest key, inbox or re-signing.
 * This ACK proves relay acceptance only, never a stock reservation or handout.
 */
export async function retryStoredEventMarketFreePurchaseDelivery(
  input: {
    handoffId: string
    shouldContinue: () => boolean
    storage?: StorageLike
    database?: ConduitDB
  } & RetryOptions
): Promise<EventMarketFreePurchaseDelivery> {
  const storage = storageOrThrow(input.storage)
  assertCurrent(input.shouldContinue)
  const row = (
    await loadEventMarketFreePurchaseDeliveries({ ...input, storage })
  ).find((candidate) => candidate.handoffId === input.handoffId)
  if (!row) throw new Error("Saved free pickup delivery is unavailable.")
  if (!row.merchantDelivered)
    throw new Error(
      "Finish the original Merchant order delivery first; do not create another order."
    )
  if (row.acknowledged) return row
  const result = await retryPrivateMessageWraps({
    rumorId: row.rumorId,
    senderPubkey: row.senderPubkey,
    recipientPubkey: row.organizerPubkey,
    wrappedToRecipient: row.wrappedToRecipient,
    shouldContinue: input.shouldContinue,
    resolveInboxRelays: input.resolveInboxRelays,
    publishFn: input.publishFn,
  })
  if (!result.recipientDelivery?.successfulRelayUrls.length)
    throw new Error(
      "The saved pickup request is waiting for an organizer relay. Retry this order, not a new order."
    )
  return withCheckoutSparkStorageLock(
    EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY,
    async () => {
      const rows = await loadEventMarketFreePurchaseDeliveries({
        ...input,
        storage,
      })
      const stored = rows.find(
        (candidate) => candidate.handoffId === row.handoffId
      )
      if (!stored || stored.wrappedToRecipient.id !== row.wrappedToRecipient.id)
        throw new Error(
          "Saved free pickup delivery changed after relay acceptance."
        )
      // Persist positive acceptance even if the session changed after the send.
      stored.acknowledged = true
      return persistProgress(stored, { ...input, storage })
    }
  )
}
