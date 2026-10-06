import { describe, expect, it } from "bun:test"
import { matchFilter, type Filter } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAssignmentDraft,
  buildEventMarketOrderRumorTags,
  createEventMarketPickupSnapshot,
  readEventMarketProduct,
  readEventMarketCatalog,
  readEventMarketAssignment,
  readEventMarketRoster,
  verifyEventMarketOrderEvidence,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

function source(events: readonly SignedPublicNostrEvent[]) {
  return {
    plan: async () => ({
      relayUrls: ["wss://current.example"],
      candidateRelayUrls: ["wss://current.example"],
      maxRelayAttempts: 1,
      ownerSelectedRelayUrls: [],
      appRelayUrls: ["wss://current.example"],
      personalRelayUrls: [],
      independentRelayUrls: [],
      relayListState: "missing" as const,
      relayHintTruncated: false,
    }),
    fetch: async (filter: Filter) => ({
      events: events.filter((event) => matchFilter(filter, event)),
      relays: [
        { relayUrl: "wss://current.example", status: "success" as const },
      ],
    }),
    load: async () => [] as SignedPublicNostrEvent[],
    retain: async () => undefined,
  }
}

describe("occurrence assignment buyer admission", () => {
  it("requires the exact merchant assignment despite a historical product market hint", async () => {
    const fixture = createEventMarketOrderFixture({
      mode: "merchant_present",
      newAssignment: true,
    })
    const deps = source(fixture.events)
    const marketRead = await readEventMarketRoster(
      {
        reference: fixture.fulfillment.market.coordinate,
      },
      deps
    )
    const selectedOccurrenceCoordinate = fixture.fulfillment.calendar.coordinate
    const assigned = await readEventMarketProduct(
      {
        marketRead,
        productCoordinate: fixture.fulfillment.product.coordinate,
        selectedOccurrenceCoordinate,
      },
      deps
    )
    expect(assigned.actionable).toBe(true)
    const snapshot = createEventMarketPickupSnapshot({
      marketRead,
      productRead: assigned,
      selectedOccurrenceCoordinate,
    })
    expect(snapshot.occurrenceAssignment?.eventId).toBe(
      fixture.fulfillment.occurrenceAssignment?.eventId
    )

    const absent = await readEventMarketProduct(
      {
        marketRead,
        productCoordinate: fixture.fulfillment.product.coordinate,
        selectedOccurrenceCoordinate,
      },
      source(fixture.events.filter((event) => event.kind !== 30410))
    )
    expect(absent.actionable).toBe(false)
    expect(absent.resolution.state).toBe("unassigned")
  })

  it("carries exact signed assignment evidence in the encrypted order tags", () => {
    const fixture = createEventMarketOrderFixture({
      mode: "merchant_present",
      newAssignment: true,
    })
    const tags = buildEventMarketOrderRumorTags(fixture.order)
    const assignment = fixture.fulfillment.occurrenceAssignment!
    expect(tags).toContainEqual([
      "event_assignment",
      fixture.fulfillment.product.coordinate,
      assignment.coordinate,
      assignment.eventId,
    ])
    expect(
      tags.filter(
        (tag) => tag[0] === "evidence" && tag[1] === assignment.eventId
      )
    ).toHaveLength(1)
    expect(
      verifyEventMarketOrderEvidence({
        order: fixture.order,
        events: fixture.events,
      }).status
    ).toBe("verified")
  })

  it("discovers assignment candidates and reads the product without republishing it", async () => {
    const fixture = createEventMarketOrderFixture({
      mode: "merchant_present",
      newAssignment: true,
    })
    const queries: Filter[] = []
    const deps = source(fixture.events)
    const originalFetch = deps.fetch
    deps.fetch = async (filter) => {
      queries.push(filter)
      return originalFetch(filter)
    }
    const result = await readEventMarketCatalog(
      {
        reference: fixture.fulfillment.market.coordinate,
        selectedOccurrenceCoordinate: fixture.fulfillment.calendar.coordinate,
      },
      deps
    )
    expect(result.products.map((entry) => entry.productCoordinate)).toEqual([
      fixture.fulfillment.product.coordinate,
    ])
    expect(queries).toContainEqual(
      expect.objectContaining({
        kinds: [30410],
        "#a": [fixture.fulfillment.market.coordinate],
      })
    )
    expect(
      queries.some(
        (filter) => filter.kinds?.includes(30402) && Array.isArray(filter["#d"])
      )
    ).toBe(true)
  })

  it("does not admit an update with missing or foreign parent evidence", async () => {
    const organizer = getPublicKey(generateSecretKey())
    const merchantSecret = generateSecretKey()
    const merchant = getPublicKey(merchantSecret)
    const tuple = {
      marketCoordinate: `30409:${organizer}:market`,
      occurrenceCoordinate: `31923:${organizer}:day`,
      productCoordinate: `30402:${merchant}:soap`,
    }
    const draft = (previousEventId?: string) =>
      buildEventMarketAssignmentDraft({
        ...tuple,
        merchantPubkey: merchant,
        state: "active",
        inventory: { mode: "tracked", quantity: 3 },
        fulfillmentMethods: ["pickup"],
        previousEventId,
      })
    const initial = finalizeEvent(
      { ...draft(), created_at: 100 },
      merchantSecret
    )
    const update = finalizeEvent(
      { ...draft(initial.id), created_at: 101 },
      merchantSecret
    )
    const read = (events: SignedPublicNostrEvent[]) =>
      readEventMarketAssignment({ ...tuple }, source(events))
    expect((await read([update])).state).toBe("incomplete")
    expect((await read([initial, update])).state).toBe("active")
    const foreign = finalizeEvent(
      {
        ...buildEventMarketAssignmentDraft({
          ...tuple,
          productCoordinate: `30402:${merchant}:other`,
          merchantPubkey: merchant,
          state: "active",
          inventory: { mode: "tracked", quantity: 3 },
          fulfillmentMethods: ["pickup"],
        }),
        created_at: 100,
      },
      merchantSecret
    )
    const wrongParent = finalizeEvent(
      { ...draft(foreign.id), created_at: 102 },
      merchantSecret
    )
    expect((await read([foreign, wrongParent])).state).toBe("malformed")
  })
})
