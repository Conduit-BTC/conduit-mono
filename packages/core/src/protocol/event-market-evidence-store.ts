import Dexie from "dexie"
import { db, type ConduitDB, type CachedEventMarketRosterEvidence } from "../db"
import {
  isEventMarketAddressableRevisionDeleted,
  parseAddressableCoordinate,
} from "./event-market"
import {
  parseEventMarketRosterEvent,
  resolveEventMarketRoster,
} from "./event-market-roster"
import { EVENT_KINDS } from "./kinds"
import { verifySignedEventBatches } from "./relay-reader"
import type { SignedPublicNostrEvent } from "./signed-event"
import {
  sameSignedPublicEvent,
  snapshotSignedPublicEvent,
} from "./verified-public-event"

export type EventMarketEvidenceRetention = "durable" | "discovery"
export const MAX_EVENT_MARKET_RECORDS_PER_COORDINATE = 2_048
export const MAX_EVENT_MARKET_DISCOVERY_RECORDS = 2_048
export const MAX_EVENT_MARKET_DISCOVERY_BYTES = 8 * 1_024 * 1_024
const encoder = new TextEncoder()

function deletionAppliesToScopedEvent(
  coordinate: string,
  event: SignedPublicNostrEvent,
  deletions: readonly SignedPublicNostrEvent[]
): boolean {
  const market = parseAddressableCoordinate(coordinate, [30409])
  if (!market || event.pubkey !== market.authorPubkey) return false
  const d = event.tags.filter((tag) => tag[0] === "d")
  const target =
    d.length === 1
      ? parseAddressableCoordinate(
          `${event.kind}:${event.pubkey}:${d[0]![1]}`,
          [30409, 31922, 31923, 31924]
        )
      : null
  if (!target || (event.kind === 30409 && target.coordinate !== coordinate))
    return false
  return isEventMarketAddressableRevisionDeleted(
    {
      coordinate: target.coordinate,
      eventId: event.id,
      createdAt: event.created_at * 1000,
    },
    deletions
  )
}

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
        ...new Map(
          events.map((event) => [event.id, snapshotSignedPublicEvent(event)])
        ).values(),
      ]
      const deletions =
        retention === "discovery"
          ? await verifySignedEventBatches(
              unique.filter((event) => event.kind === EVENT_KINDS.DELETION)
            )
          : []
      await database.transaction("rw", table, async () => {
        const ids = unique.map((event) => `${coordinate}:${event.id}`)
        const writingIds = new Set(ids)
        const [stored, existing, coordinateRows] = await Promise.all([
          table.bulkGet(ids),
          table.where("marketCoordinate").equals(coordinate).count(),
          deletions.length
            ? table.where("marketCoordinate").equals(coordinate).toArray()
            : Promise.resolve([] as CachedEventMarketRosterEvidence[]),
        ])
        const durableRows = coordinateRows.filter(
          (row) => row.discoveryBytes === undefined
        )
        const durableWitnesses = durableRows.length
          ? await Dexie.waitFor(
              verifySignedEventBatches(
                durableRows.map((row) => row.signedEvent)
              )
            )
          : []
        // A scoped negative of already-durable signed evidence belongs to that
        // custody too. Background discovery cannot create durable coordinates.
        const durableNegativeIds = new Set(
          deletions
            .filter((deletion) =>
              durableWitnesses.some((event) =>
                deletionAppliesToScopedEvent(coordinate, event, [deletion])
              )
            )
            .map((event) => event.id)
        )
        const newRecords = stored.filter((row) => !row).length
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
              !durableNegativeIds.has(event.id) &&
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
        const cached = table.where("discoveryBytes").aboveOrEqual(0)
        const growsCache = newCacheRecords > 0 || addedBytes > 0
        const cachedCount = growsCache ? await cached.count() : 0
        const newDeletions = deletions.filter((event) => {
          const index = unique.findIndex((candidate) =>
            sameSignedPublicEvent(candidate, event)
          )
          return index >= 0 && !stored[index]
        })
        // Positive writes cannot reclaim quota. Preserve the cheap row-limit
        // rejection before scanning byte keys for a full discovery cache.
        if (
          !newDeletions.length &&
          existing + newRecords > MAX_EVENT_MARKET_RECORDS_PER_COORDINATE
        )
          throw new Error("Event Market evidence retention is at capacity.")
        if (
          !newDeletions.length &&
          growsCache &&
          cachedCount + newCacheRecords > MAX_EVENT_MARKET_DISCOVERY_RECORDS
        )
          throw new Error("Event Market discovery cache is at capacity.")
        let bytes = 0
        if (growsCache)
          await cached.clone().eachKey((key) => {
            bytes += key as number
          })
        const evicted = new Map<string, CachedEventMarketRosterEvidence>()
        const atCapacity = () => {
          const removed = [...evicted.values()]
          return (
            existing +
              newRecords -
              removed.filter((row) => row.marketCoordinate === coordinate)
                .length >
              MAX_EVENT_MARKET_RECORDS_PER_COORDINATE ||
            (growsCache &&
              (cachedCount + newCacheRecords - removed.length >
                MAX_EVENT_MARKET_DISCOVERY_RECORDS ||
                bytes +
                  addedBytes -
                  removed.reduce((sum, row) => sum + row.discoveryBytes!, 0) >
                  MAX_EVENT_MARKET_DISCOVERY_BYTES))
          )
        }
        if (atCapacity() && newDeletions.length) {
          const verified = await Dexie.waitFor(
            verifySignedEventBatches([
              ...coordinateRows.map((row) => row.signedEvent),
              ...unique,
            ])
          )
          const applicable = verified.some((event) =>
            deletionAppliesToScopedEvent(coordinate, event, newDeletions)
          )
          if (applicable) {
            const deleted =
              resolveEventMarketRoster({
                coordinate,
                revisions: verified.filter(
                  (event) => event.kind === EVENT_KINDS.EVENT_MARKET
                ),
                deletions: verified.filter(
                  (event) => event.kind === EVENT_KINDS.DELETION
                ),
              }).state === "deleted"
            if (deleted) {
              // Presentation bytes for a deleted market are weaker than its
              // deletion. Keep every roster witness, negative and auth record.
              for (const row of coordinateRows) {
                if (!atCapacity()) break
                if (
                  row.discoveryBytes === undefined ||
                  writingIds.has(row.id) ||
                  ![31922, 31923, 31924].includes(row.signedEvent.kind) ||
                  !verified.some((event) =>
                    sameSignedPublicEvent(event, row.signedEvent)
                  )
                )
                  continue
                const d = row.signedEvent.tags.find(
                  (tag) => tag[0] === "d"
                )?.[1]
                const address = `${row.signedEvent.kind}:${row.signedEvent.pubkey}:${d}`
                if (
                  verified.some(
                    (event) =>
                      event.kind === EVENT_KINDS.DELETION &&
                      event.tags.some(
                        (tag) =>
                          (tag[0] === "e" && tag[1] === row.signedEvent.id) ||
                          (tag[0] === "a" && tag[1] === address)
                      )
                  )
                )
                  continue
                evicted.set(row.id, row)
              }
            }
            if (atCapacity()) {
              const groups = new Map<
                string,
                CachedEventMarketRosterEvidence[]
              >()
              await cached.each((row) => {
                if (row.marketCoordinate !== coordinate)
                  groups.set(row.marketCoordinate, [
                    ...(groups.get(row.marketCoordinate) ?? []),
                    row,
                  ])
              })
              for (const [candidate, group] of groups) {
                if (!atCapacity()) break
                // Only an initial empty public candidate can leave the cache.
                // Preserve all history, conflicts, enrollment, negatives,
                // signed work, and unclassified legacy/durable evidence.
                if (
                  group.filter((row) => row.signedEvent.kind === 30409)
                    .length !== 1 ||
                  group.some(
                    (row) =>
                      ![30409, 31922, 31923, 31924].includes(
                        row.signedEvent.kind
                      )
                  ) ||
                  (await table
                    .where("marketCoordinate")
                    .equals(candidate)
                    .count()) !== group.length
                )
                  continue
                const admitted = await Dexie.waitFor(
                  verifySignedEventBatches(group.map((row) => row.signedEvent))
                )
                if (admitted.length !== group.length) continue
                const header = admitted.find((event) => event.kind === 30409)!
                const market = parseEventMarketRosterEvent(header)
                if (
                  !market ||
                  market.coordinate !== candidate ||
                  market.state !== "open" ||
                  market.previousEventId ||
                  market.merchants.length ||
                  admitted.some(
                    (event) => event.pubkey !== market.organizerPubkey
                  )
                )
                  continue
                for (const row of group) evicted.set(row.id, row)
              }
            }
          }
        }
        if (atCapacity())
          throw new Error("Event Market discovery cache is at capacity.")
        // Admission and replacement share the quota transaction across tabs.
        // Never delete a witness before its dominating signed negative commits.
        if (evicted.size) await table.bulkDelete([...evicted.keys()])
        await table.bulkPut(rows)
      })
    },
  }
}

export const eventMarketEvidenceStore = createEventMarketEvidenceStore(db)
