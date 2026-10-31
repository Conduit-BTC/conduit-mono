import Dexie, { liveQuery } from "dexie"
import { z } from "zod"
import { db, type ConduitDB } from "../db"
import { parseAddressableCoordinate } from "./event-market"
import { EVENT_KINDS } from "./kinds"
import {
  eventGuestReceiptSchema,
  type EventGuestReceipt,
} from "./event-guest-checkout"

export const EVENT_PICKUP_RECEIPT_RETENTION_AFTER_END_MS = 24 * 60 * 60 * 1_000

export type EventPickupReceiptBuyerScope =
  { kind: "guest" } | { kind: "signed_in"; pubkey: string }

export interface SaveEventPickupReceiptInput {
  receipt: EventGuestReceipt
  buyerScope: EventPickupReceiptBuyerScope
  /** The selected signed occurrence, not the event's later edited calendar. */
  occurrenceCoordinate: string
  /** Unix epoch milliseconds for that selected occurrence's end. */
  occurrenceEnd: number
}

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const rowSchema = z.strictObject({
  schemaVersion: z.literal(1),
  orderId: z.uuid(),
  merchantPubkey: z.string().regex(/^[0-9a-f]{64}$/),
  owner: z.string().regex(/^(guest|account:[0-9a-f]{64})$/),
  occurrenceCoordinate: z.string().min(1).max(1024),
  occurrenceEnd: timestamp,
  createdAt: timestamp,
  expiresAt: timestamp,
  receipt: eventGuestReceiptSchema.nullable(),
})

export type EventPickupReceiptStorageRow = z.infer<typeof rowSchema>
export type SavedEventPickupReceipt = EventPickupReceiptStorageRow & {
  receipt: EventGuestReceipt
}

export class EventPickupReceiptStorageError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "unavailable"
      | "conflict"
      | "expired"
      | "deleted"
      | "scope_changed"
  ) {
    super(
      code === "scope_changed"
        ? "Private pickup receipt session changed."
        : code === "expired"
          ? "This private pickup receipt has expired on this device."
          : code === "deleted"
            ? "This private pickup receipt was deleted from this device."
            : code === "conflict"
              ? "The saved private pickup receipt does not match this order."
              : code === "invalid"
                ? "The private pickup receipt is invalid."
                : "Private pickup receipt storage is unavailable."
    )
    this.name = "EventPickupReceiptStorageError"
  }
}

function owner(scope: EventPickupReceiptBuyerScope): string {
  if (scope?.kind === "guest") return "guest"
  if (scope?.kind === "signed_in" && /^[0-9a-f]{64}$/.test(scope.pubkey))
    return `account:${scope.pubkey}`
  throw new EventPickupReceiptStorageError("invalid")
}

function readRow(value: unknown): EventPickupReceiptStorageRow {
  const parsed = rowSchema.safeParse(value)
  if (!parsed.success) throw new EventPickupReceiptStorageError("invalid")
  const row = parsed.data
  const coordinate = parseAddressableCoordinate(row.occurrenceCoordinate, [
    EVENT_KINDS.CALENDAR_DATE,
    EVENT_KINDS.CALENDAR_TIME,
  ])
  if (
    coordinate?.coordinate !== row.occurrenceCoordinate ||
    row.expiresAt !==
      row.occurrenceEnd + EVENT_PICKUP_RECEIPT_RETENTION_AFTER_END_MS ||
    row.createdAt >= row.expiresAt ||
    (row.receipt &&
      (row.receipt.orderId !== row.orderId ||
        row.receipt.merchantPubkey !== row.merchantPubkey))
  )
    throw new EventPickupReceiptStorageError("invalid")
  return row
}

/**
 * A receipt is a private possession capability, not a signer or paid-state record.
 * This owner never restores guest signing, submits a payment or redeems stock.
 */
export function createEventPickupReceiptRepository(
  options: {
    database?: ConduitDB
    now?: () => number
    assertCurrent?: () => void
  } = {}
) {
  const database = options.database ?? db
  const table = database.eventPickupReceipts
  const now = options.now ?? Date.now
  const assertCurrent = () => {
    try {
      options.assertCurrent?.()
    } catch {
      throw new EventPickupReceiptStorageError("scope_changed")
    }
  }
  const currentTime = () => {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0)
      throw new EventPickupReceiptStorageError("invalid")
    return value
  }
  async function access<T>(operation: () => Promise<T>): Promise<T> {
    try {
      assertCurrent()
      const result = await Dexie.ignoreTransaction(operation)
      assertCurrent()
      return result
    } catch (error) {
      if (error instanceof EventPickupReceiptStorageError) throw error
      throw new EventPickupReceiptStorageError("unavailable")
    }
  }
  async function pruneExpired(): Promise<number> {
    return access(async () => {
      const deadline = currentTime()
      const removed = await database.transaction("rw", table, async () => {
        const keys = await table
          .where("expiresAt")
          .belowOrEqual(deadline)
          .primaryKeys()
        await table.bulkDelete(keys)
        return keys
      })
      const readback = await table.bulkGet(removed)
      if (readback.some((row) => row !== undefined))
        throw new EventPickupReceiptStorageError("unavailable")
      return removed.length
    })
  }
  async function readSaved(orderId: string, expectedOwner: string) {
    const saved = await table.get(orderId)
    if (!saved) return null
    const row = readRow(saved)
    return row.owner === expectedOwner &&
      row.expiresAt > currentTime() &&
      row.receipt
      ? (row as SavedEventPickupReceipt)
      : null
  }
  async function readList(expectedOwner: string) {
    return (await table.where("owner").equals(expectedOwner).toArray())
      .map(readRow)
      .filter(
        (row): row is SavedEventPickupReceipt =>
          row.receipt !== null && row.expiresAt > currentTime()
      )
      .sort((left, right) => right.createdAt - left.createdAt)
  }
  return {
    async save(
      input: SaveEventPickupReceiptInput
    ): Promise<SavedEventPickupReceipt> {
      return access(async () => {
        const savedAt = currentTime()
        const expiresAt =
          input.occurrenceEnd + EVENT_PICKUP_RECEIPT_RETENTION_AFTER_END_MS
        if (Number.isSafeInteger(expiresAt) && expiresAt <= savedAt)
          throw new EventPickupReceiptStorageError("expired")
        const row = readRow({
          schemaVersion: 1,
          orderId: input.receipt.orderId,
          merchantPubkey: input.receipt.merchantPubkey,
          owner: owner(input.buyerScope),
          occurrenceCoordinate: input.occurrenceCoordinate,
          occurrenceEnd: input.occurrenceEnd,
          createdAt: savedAt,
          expiresAt,
          receipt: input.receipt,
        }) as SavedEventPickupReceipt
        const retained = await database.transaction("rw", table, async () => {
          const saved = await table.get(row.orderId)
          assertCurrent()
          if (saved) {
            const previous = readRow(saved)
            if (!previous.receipt)
              throw new EventPickupReceiptStorageError("deleted")
            if (
              JSON.stringify({ ...row, createdAt: previous.createdAt }) !==
              JSON.stringify(previous)
            )
              throw new EventPickupReceiptStorageError("conflict")
            return previous as SavedEventPickupReceipt
          }
          await table.put(row)
          return row
        })
        const readback = await table.get(row.orderId)
        if (
          !readback ||
          JSON.stringify(readRow(readback)) !== JSON.stringify(retained)
        )
          throw new EventPickupReceiptStorageError("unavailable")
        if (retained.expiresAt <= currentTime())
          throw new EventPickupReceiptStorageError("expired")
        return retained
      })
    },
    async load(
      orderId: string,
      buyerScope: EventPickupReceiptBuyerScope
    ): Promise<SavedEventPickupReceipt | null> {
      return access(async () => {
        const expectedOwner = owner(buyerScope)
        await pruneExpired()
        return readSaved(orderId, expectedOwner)
      })
    },
    async list(
      buyerScope: EventPickupReceiptBuyerScope
    ): Promise<SavedEventPickupReceipt[]> {
      return access(async () => {
        const expectedOwner = owner(buyerScope)
        await pruneExpired()
        return readList(expectedOwner)
      })
    },
    observe(
      input: { buyerScope: EventPickupReceiptBuyerScope; orderId?: string },
      changed: (rows: SavedEventPickupReceipt[]) => void,
      failed: () => void
    ): () => void {
      let active = true
      let liveEmitted = false
      let subscription: { unsubscribe(): void } | undefined
      const read = () =>
        access(async () => {
          const expectedOwner = owner(input.buyerScope)
          if (input.orderId) {
            const saved = await readSaved(input.orderId, expectedOwner)
            return saved ? [saved] : []
          }
          return readList(expectedOwner)
        })
      const receive = (rows: SavedEventPickupReceipt[]) => {
        if (active) changed(rows)
      }
      const fail = () => {
        if (active) failed()
      }
      // Cleanup is deliberately outside the readonly liveQuery scope. Changes
      // and cross-tab Delete are observed through pure, owner-fenced reads.
      void pruneExpired().then(() => {
        if (!active) return
        subscription = liveQuery(read).subscribe({
          next: (rows) => {
            liveEmitted = true
            receive(rows)
          },
          error: () => {
            liveEmitted = true
            fail()
          },
        })
        // Without browser IndexedDB, liveQuery can stay silent. An explicit
        // read must settle readiness or surface storage failure. Never let its
        // late snapshot overwrite a newer observation after Delete.
        void read().then(
          (rows) => {
            if (!liveEmitted) receive(rows)
          },
          () => {
            if (!liveEmitted) fail()
          }
        )
      }, fail)
      return () => {
        active = false
        subscription?.unsubscribe()
      }
    },
    pruneExpired,
    async remove(
      orderId: string,
      buyerScope: EventPickupReceiptBuyerScope
    ): Promise<void> {
      return access(async () => {
        const expectedOwner = owner(buyerScope)
        const removed = await database.transaction("rw", table, async () => {
          const saved = await table.get(orderId)
          assertCurrent()
          if (!saved) return null
          const row = readRow(saved)
          if (row.owner !== expectedOwner)
            throw new EventPickupReceiptStorageError("conflict")
          // Keep only the immutable, non-secret binding until expiry so an
          // already-open checkout cannot re-save a deleted pickup capability.
          const tombstone = { ...row, receipt: null }
          await table.put(tombstone)
          return tombstone
        })
        if (removed) {
          const readback = await table.get(orderId)
          if (
            !readback ||
            JSON.stringify(readRow(readback)) !== JSON.stringify(removed)
          )
            throw new EventPickupReceiptStorageError("unavailable")
        }
      })
    },
  }
}
