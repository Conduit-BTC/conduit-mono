import { z } from "zod"
import {
  isValidSignedPublicNostrEvent,
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
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const signedWrapSchema = z
  .object({
    id: hash,
    pubkey: hash,
    created_at: z.number().int().safe().nonnegative(),
    kind: z.literal(1059),
    tags: z.array(z.array(z.string().max(4096)).max(8)).max(8),
    content: z.string().max(256 * 1024),
    sig: z.string().regex(/^[0-9a-f]{128}$/),
  })
  .strict()
  .refine(isValidSignedPublicNostrEvent)
const schema = z
  .object({
    schemaVersion: z.literal(1),
    handoffId: hash,
    rumorId: hash,
    orderId: z.string().min(1).max(512),
    purchaseScope: hash,
    purchaseClaimDigest: hash,
    senderPubkey: hash,
    merchantPubkey: hash,
    organizerPubkey: hash,
    buyerIdentityKind: z.enum(["signed_in", "guest_ephemeral"]),
    createdAt: z.number().int().safe().nonnegative(),
    wrappedToRecipient: signedWrapSchema,
    merchantDelivered: z.boolean(),
    acknowledged: z.boolean(),
  })
  .strict()
export type EventMarketFreePurchaseDelivery = z.infer<typeof schema>

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

function parse(value: unknown): EventMarketFreePurchaseDelivery {
  const row = schema.parse(value)
  const recipients = row.wrappedToRecipient.tags.filter((tag) => tag[0] === "p")
  if (
    row.wrappedToRecipient.kind !== 1059 ||
    recipients.length !== 1 ||
    recipients[0]?.length !== 2 ||
    recipients[0]?.[1] !== row.organizerPubkey ||
    row.merchantPubkey === row.organizerPubkey ||
    (row.acknowledged && !row.merchantDelivered)
  )
    throw new Error("Saved free pickup delivery is invalid.")
  return row
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

/** Prepare one organizer-only seal, durably saved before the original order send.
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
    () => {
      assertCurrent(input.shouldContinue)
      const rows = listEventMarketFreePurchaseDeliveries(storage)
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
            !candidate.acknowledged &&
            (candidate.orderId === row.orderId ||
              candidate.purchaseClaimDigest === row.purchaseClaimDigest)
        )
      )
        throw new Error(
          "Continue the existing free pickup order; do not create another."
        )
      save([...rows, row], storage)
      return row
    }
  )
}

export async function markFreePurchaseMerchantDelivered(input: {
  handoffId: string
  shouldContinue: () => boolean
  storage?: StorageLike
}): Promise<EventMarketFreePurchaseDelivery> {
  const storage = storageOrThrow(input.storage)
  return withCheckoutSparkStorageLock(
    EVENT_MARKET_FREE_PURCHASE_STORAGE_KEY,
    () => {
      assertCurrent(input.shouldContinue)
      const rows = listEventMarketFreePurchaseDeliveries(storage)
      const row = rows.find(
        (candidate) => candidate.handoffId === input.handoffId
      )
      if (!row) throw new Error("Saved free pickup delivery is unavailable.")
      row.merchantDelivered = true
      save(rows, storage)
      return row
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
      if (!row || row.merchantDelivered || row.acknowledged)
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
  } & RetryOptions
): Promise<EventMarketFreePurchaseDelivery> {
  const storage = storageOrThrow(input.storage)
  assertCurrent(input.shouldContinue)
  const row = listEventMarketFreePurchaseDeliveries(storage).find(
    (candidate) => candidate.handoffId === input.handoffId
  )
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
    () => {
      const rows = listEventMarketFreePurchaseDeliveries(storage)
      const stored = rows.find(
        (candidate) => candidate.handoffId === row.handoffId
      )
      if (!stored || stored.wrappedToRecipient.id !== row.wrappedToRecipient.id)
        throw new Error(
          "Saved free pickup delivery changed after relay acceptance."
        )
      // Persist positive acceptance even if the session changed after the send.
      stored.acknowledged = true
      save(rows, storage)
      return stored
    }
  )
}
