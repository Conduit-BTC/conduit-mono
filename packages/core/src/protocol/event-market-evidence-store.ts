import { db, type ConduitDB, type CachedEventMarketRosterEvidence } from "../db"
import { EVENT_KINDS } from "./kinds"
import { verifySignedEventBatches } from "./relay-reader"
import type { SignedPublicNostrEvent } from "./signed-event"

export type EventMarketEvidenceRetention = "durable" | "discovery"
export const MAX_EVENT_MARKET_RECORDS_PER_COORDINATE = 2_048
export const MAX_EVENT_MARKET_DISCOVERY_RECORDS = 2_048
export const MAX_EVENT_MARKET_DISCOVERY_BYTES = 8 * 1_024 * 1_024
const encoder = new TextEncoder()

/** One transactional owner for discovery budgets and durable signed custody. */
export function createEventMarketEvidenceStore(database: ConduitDB) {
  const table = database.eventMarketRosterEvidence
  return {
    async load(coordinate: string): Promise<SignedPublicNostrEvent[]> {
      const rows = await table
        .where("marketCoordinate")
        .equals(coordinate)
        .toArray()
      return verifySignedEventBatches(rows.map((row) => row.signedEvent))
    },
    async loadDiscovered(
      authors: readonly string[] | undefined
    ): Promise<SignedPublicNostrEvent[]> {
      const authorSet = authors === undefined ? undefined : new Set(authors)
      const rows = await table
        .filter(
          (row) =>
            row.signedEvent.kind === EVENT_KINDS.EVENT_MARKET &&
            (!authorSet || authorSet.has(row.signedEvent.pubkey))
        )
        .limit(MAX_EVENT_MARKET_DISCOVERY_RECORDS)
        .toArray()
      return verifySignedEventBatches(rows.map((row) => row.signedEvent))
    },
    async retain(
      coordinate: string,
      events: readonly SignedPublicNostrEvent[],
      retention: EventMarketEvidenceRetention = "durable"
    ): Promise<void> {
      if (events.length === 0) return
      const unique = [
        ...new Map(events.map((event) => [event.id, event])).values(),
      ]
      await database.transaction("rw", table, async () => {
        const ids = unique.map((event) => `${coordinate}:${event.id}`)
        const stored = await table.bulkGet(ids)
        const existing = await table
          .where("marketCoordinate")
          .equals(coordinate)
          .count()
        if (
          existing + stored.filter((row) => !row).length >
          MAX_EVENT_MARKET_RECORDS_PER_COORDINATE
        )
          throw new Error("Event Market evidence retention is at capacity.")
        const rows: CachedEventMarketRosterEvidence[] = unique.map(
          (event, index) => {
            const previous = stored[index]
            const row: CachedEventMarketRosterEvidence = {
              id: ids[index]!,
              marketCoordinate: coordinate,
              signedEvent: event,
              cachedAt: Date.now(),
            }
            // Discovery can never demote durable or unclassified legacy evidence.
            if (
              retention === "discovery" &&
              (!previous || previous.discoveryBytes !== undefined)
            ) {
              row.discoveryBytes = 0
              // Include UTF-8 row metadata with headroom for the size field itself.
              row.discoveryBytes =
                encoder.encode(JSON.stringify(row)).byteLength + 16
            }
            return row
          }
        )
        const newCacheRecords = rows.filter(
          (row, index) =>
            row.discoveryBytes !== undefined &&
            stored[index]?.discoveryBytes === undefined
        ).length
        const addedBytes = rows.reduce(
          (total, row, index) =>
            total +
            (row.discoveryBytes ?? 0) -
            (stored[index]?.discoveryBytes ?? 0),
          0
        )
        if (newCacheRecords > 0 || addedBytes > 0) {
          const cached = table.where("discoveryBytes").aboveOrEqual(0)
          if (
            (await cached.count()) + newCacheRecords >
            MAX_EVENT_MARKET_DISCOVERY_RECORDS
          )
            throw new Error("Event Market discovery cache is at capacity.")
          let bytes = 0
          await cached.eachKey((key) => {
            bytes += key as number
          })
          if (bytes + addedBytes > MAX_EVENT_MARKET_DISCOVERY_BYTES)
            throw new Error("Event Market discovery cache is at capacity.")
        }
        // No eviction: quota pressure cannot forget an observed negative or a
        // saved publication/order record. Reads report failed retention separately.
        await table.bulkPut(rows)
      })
    },
  }
}

export const eventMarketEvidenceStore = createEventMarketEvidenceStore(db)
