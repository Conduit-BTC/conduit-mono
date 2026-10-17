import Dexie from "dexie"
import { db } from "../db"
import {
  parseEventMarketCalendarEvent,
  isEventMarketAddressableRevisionDeleted,
} from "./event-market"
import { loadRetainedSignedEventMarketEvidence } from "./event-market-roster-read"
import { verifySignedEventBatches } from "./relay-reader"
import {
  compareReplaceableEventFrontiers,
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export function isOccurrenceCancelled(event: SignedPublicNostrEvent): boolean {
  const tags = event.tags.filter((tag) => tag[0] === "event_occurrence")
  return (
    tags.length > 1 ||
    tags.some(
      (tag) => tag.length !== 3 || tag[1] !== "1" || tag[2] !== "scheduled"
    )
  )
}
export function newestAddressableEvidence(
  events: SignedPublicNostrEvent[],
  coordinate: string
) {
  return events
    .filter(
      (event) =>
        `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}` ===
          coordinate && isValidSignedPublicNostrEvent(event)
    )
    .sort(
      (a, b) =>
        -compareReplaceableEventFrontiers(
          { createdAt: a.created_at, eventId: a.id },
          { createdAt: b.created_at, eventId: b.id }
        )
    )[0]
}

/** Current dates govern unused allocations; accepted order snapshots stay intact. */
export async function reconcileKnownOccurrenceLifecycle(
  merchantPubkey: string,
  productCoordinate?: string
) {
  const assignments = await db.merchantInventoryAssignments
    .where(productCoordinate ? "productCoordinate" : "merchantPubkey")
    .equals(productCoordinate ?? merchantPubkey)
    .and((assignment) => assignment.merchantPubkey === merchantPubkey)
    .toArray()
  for (const assignment of assignments) {
    await db.transaction(
      "rw",
      db.merchantInventoryAssignments,
      db.eventMarketRosterEvidence,
      async () => {
        const current = await db.merchantInventoryAssignments.get(
          assignment.coordinate
        )
        if (!current || current.terminal) return
        // Serialize the known calendar frontier and the allocation deadline together.
        const evidence = await Dexie.waitFor(
          loadRetainedSignedEventMarketEvidence(current.marketCoordinate)
        )
        const occurrence = newestAddressableEvidence(
          evidence,
          current.occurrenceCoordinate
        )
        if (!occurrence) return
        const hasCancellation = evidence.some(
          (event) =>
            event.kind === occurrence.kind &&
            event.pubkey === occurrence.pubkey &&
            event.tags.some(
              (tag) =>
                tag[0] === "d" &&
                tag[1] ===
                  occurrence.tags.find((candidate) => candidate[0] === "d")?.[1]
            ) &&
            event.tags.filter((tag) => tag[0] === "event_occurrence").length ===
              1 &&
            event.tags.some(
              (tag) =>
                tag.length === 3 &&
                tag[0] === "event_occurrence" &&
                tag[1] === "1" &&
                tag[2] === "cancelled"
            )
        )
        const deleted = isEventMarketAddressableRevisionDeleted(
          {
            coordinate: current.occurrenceCoordinate,
            eventId: occurrence.id,
            createdAt: occurrence.created_at * 1000,
          },
          evidence.filter((event) => event.kind === 5)
        )
        const calendar = parseEventMarketCalendarEvent(
          (await Dexie.waitFor(verifySignedEventBatches([occurrence])))[0]!
        )
        if (
          hasCancellation ||
          deleted ||
          (calendar &&
            !isOccurrenceCancelled(occurrence) &&
            calendar.end !== current.occurrenceEndMs)
        ) {
          current.terminal = hasCancellation || deleted
          if (!current.terminal && calendar)
            current.occurrenceEndMs = calendar.end
          current.revision += 1
          await db.merchantInventoryAssignments.put(current)
        }
      }
    )
  }
}
