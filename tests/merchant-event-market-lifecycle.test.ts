import { afterEach, describe, expect, it } from "bun:test"
import NDK, { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  resolveEventMarketEvidence,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  projectEventMarket,
  organizerEventMarketToForm,
  publishMerchantOrganizerEventMarket,
  publishMerchantOrganizerMembership,
  publishMerchantOrganizerOrderAcceptance,
  reconcileMerchantOrganizerCollectionEvidence,
  retryMerchantOrganizerRecord,
  type MerchantOrganizerRecordDelivery,
} from "../apps/merchant/src/lib/event-market"
import { createEmptyOrganizerEventMarketForm } from "../apps/merchant/src/lib/event-market-form"

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const coordinate = `30405:${organizer}:market`
const calendarCoordinate = `31923:${organizer}:calendar`
const productCoordinate = `30402:${"b".repeat(64)}:bread`
const relay = "wss://relay.example"
const now = Math.floor(Date.now() / 1000)

function sign(kind: number, tags: string[][], createdAt = now - 100) {
  return finalizeEvent(
    { kind, tags, created_at: createdAt, content: "Public description" },
    secret
  )
}
function graph(acceptance?: "open" | "closed", createdAt = now - 100) {
  return [
    sign(31923, [
      ["d", "calendar"],
      ["title", "Market"],
      ["start", String(now - 7200)],
      ["end", String(now - 3600)],
      ["location", "Public Hall"],
      ["D", String(Math.floor((now - 7200) / 86400))],
      ["D", String(Math.floor((now - 3600) / 86400))],
    ]),
    sign(
      30405,
      [
        ["d", "market"],
        ["title", "Market"],
        ["a", calendarCoordinate],
        ["a", productCoordinate],
        ...(acceptance ? [["conduit_event_market", "1", acceptance]] : []),
      ],
      createdAt
    ),
  ]
}
function project(events: SignedPublicNostrEvent[]) {
  return projectEventMarket(
    resolveEventMarketEvidence({
      reference: coordinate,
      events,
      productRequestEvents: events.filter((event) => event.kind === 30402),
      nowMs: Date.now(),
    })
  )!
}
function setup(
  events: SignedPublicNostrEvent[],
  acknowledged = true,
  partial = false
) {
  const published: SignedPublicNostrEvent[] = []
  __setEventMarketTestOverrides({
    getNdk: async () => new NDK(),
    getRelayLists: async () => new Map(),
    loadCachedEvidence: async () => [],
    persistCachedEvidence: async () => undefined,
    fetchEventsFanoutDetailed: async (rawFilter, options) => {
      const filter = rawFilter as NDKFilter
      const matched = events.filter(
        (event) =>
          (!filter.kinds || filter.kinds.includes(event.kind as never)) &&
          (!filter.authors || filter.authors.includes(event.pubkey)) &&
          (!filter["#d"] ||
            event.tags.some(
              (tag) => tag[0] === "d" && filter["#d"]!.includes(tag[1]!)
            ))
      )
      return {
        events: matched.map((event) => new NDKEvent(undefined, event)),
        relays: [
          ...(options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: matched.length,
          })),
          ...(partial
            ? [
                {
                  relayUrl: "wss://unavailable.example",
                  status: "failed" as const,
                  eventCount: 0,
                },
              ]
            : []),
        ],
        eventsVerified: true,
      }
    },
    signDraft: async ({ draft, createdAt }) =>
      sign(draft.kind, draft.tags, createdAt),
    publishWithPlanner: async (event) => {
      published.push(event.rawEvent() as SignedPublicNostrEvent)
      return {
        plan: {
          intent: "author_event",
          primaryRelayUrls: [relay],
          broadcastRelayUrls: [],
          parkedRelayUrls: [],
        },
        attemptedRelayUrls: [relay],
        successfulRelayUrls: acknowledged ? [relay] : [],
        failedRelayUrls: acknowledged ? [] : [relay],
        relayFailureMessages: acknowledged ? {} : { [relay]: "rejected" },
      }
    },
  })
  return published
}
afterEach(() => __resetEventMarketTestOverrides())

describe("merchant event lifecycle", () => {
  it("closes and reopens only the collection while preserving its identity and graph", async () => {
    const events = graph("open")
    events[1] = sign(30405, [
      ...events[1]!.tags,
      ["t", "public-market"],
      ["x-custom", "retained"],
    ])
    const published = setup(events)
    const market = project(events)
    const closed = await publishMerchantOrganizerOrderAcceptance({
      organizerPubkey: organizer,
      market,
      orderAcceptance: "closed",
    })
    expect(published).toHaveLength(1)
    expect(closed.record).toBe("collection")
    expect(closed.signedEvent?.tags).toContainEqual(["x-custom", "retained"])
    expect(
      closed.signedEvent?.tags.filter(
        (tag) => tag[0] !== "conduit_event_market"
      )
    ).toEqual(
      events[1]!.tags.filter((tag) => tag[0] !== "conduit_event_market")
    )
    expect(closed.signedEvent?.tags).toContainEqual([
      "conduit_event_market",
      "1",
      "closed",
    ])
    expect(closed.signedEvent?.tags).toContainEqual(["a", calendarCoordinate])
    expect(closed.signedEvent?.tags).toContainEqual(["a", productCoordinate])
    expect(closed.signedEvent?.tags).toContainEqual(["d", "market"])
    events[1] = closed.signedEvent!
    const reopened = await publishMerchantOrganizerOrderAcceptance({
      organizerPubkey: organizer,
      market: project(events),
      orderAcceptance: "open",
    })
    expect(published).toHaveLength(2)
    expect(published.every((event) => event.kind === 30405)).toBe(true)
    expect(reopened.signedEvent?.tags).toContainEqual([
      "conduit_event_market",
      "1",
      "open",
    ])
  })

  it("uses a newer collection before a lifecycle update without restoring removed products", async () => {
    const stale = project(graph("open"))
    const events = graph("closed", now - 50)
    events[1] = sign(
      30405,
      events[1]!.tags.filter((tag) => tag[1] !== productCoordinate),
      now - 50
    )
    const published = setup(events)
    await publishMerchantOrganizerOrderAcceptance({
      organizerPubkey: organizer,
      market: stale,
      orderAcceptance: "open",
    })
    expect(published[0]?.tags).not.toContainEqual(["a", productCoordinate])
  })

  it("retains a failed status signature for exact retry without claiming publication success", async () => {
    const events = graph("open")
    const published = setup(events, false)
    let retained: MerchantOrganizerRecordDelivery | undefined
    await expect(
      publishMerchantOrganizerOrderAcceptance({
        organizerPubkey: organizer,
        market: project(events),
        orderAcceptance: "closed",
        onSignedEvent: (record) => {
          retained = record
        },
      })
    ).rejects.toThrow()
    expect(retained?.acknowledgedCount).toBe(0)
    expect(retained?.signedEvent?.id).toBe(published[0]?.id)
    const retried = setup(events)
    __setEventMarketTestOverrides({
      signDraft: async () => {
        throw new Error("Retry must not sign")
      },
    })
    await retryMerchantOrganizerRecord({
      organizerPubkey: organizer,
      record: retained!,
    })
    expect(retried[0]?.id).toBe(retained?.signedEvent?.id)
  })

  it("prevents stale ordinary edits from overriding a newer closure", async () => {
    const stale = project(graph("open"))
    const published = setup(graph("closed", now - 50))
    await expect(
      publishMerchantOrganizerEventMarket({
        organizerPubkey: organizer,
        existing: stale,
        form: createEmptyOrganizerEventMarketForm(),
      })
    ).rejects.toThrow("changed while editing")
    expect(published).toHaveLength(0)
  })

  it("keeps a retained closure authoritative and a retained reopen browse-only", () => {
    const events = graph("open")
    const market = project(events)
    const retained = {
      record: "collection" as const,
      acknowledgedCount: 1,
      rejectedCount: 0,
      timedOutCount: 0,
      signedEvent: graph("closed", now - 50)[1]!,
    }
    const closed = reconcileMerchantOrganizerCollectionEvidence(
      market,
      retained
    )
    expect(closed.state).toBe("ended")
    expect(closed.orderAcceptance).toBe("closed")
    const reopened = reconcileMerchantOrganizerCollectionEvidence(closed, {
      ...retained,
      signedEvent: graph("open", now - 25)[1]!,
    })
    expect(reopened.state).toBe("stale")
    expect(reopened.source.state).toBe("stale")
  })

  it("creates explicit open events and preserves legacy status during ordinary edits", async () => {
    const events = graph()
    const published = setup(events)
    const legacy = project(events)
    const form = {
      ...organizerEventMarketToForm(legacy),
      summary: "Public event",
      imageUrl: "https://images.example/market.jpg",
    }
    await publishMerchantOrganizerEventMarket({
      organizerPubkey: organizer,
      existing: legacy,
      form,
    })
    const legacyCollection = published.find((event) => event.kind === 30405)!
    expect(
      legacyCollection.tags.some((tag) => tag[0] === "conduit_event_market")
    ).toBe(false)
    published.length = 0
    await publishMerchantOrganizerEventMarket({
      organizerPubkey: organizer,
      form: {
        ...form,
        start: new Date((now + 86400) * 1000).toISOString().slice(0, 16),
        end: new Date((now + 90000) * 1000).toISOString().slice(0, 16),
        timezone: "UTC",
      },
    })
    expect(
      published.find((event) => event.kind === 30405)?.tags
    ).toContainEqual(["conduit_event_market", "1", "open"])
  })

  for (const partial of [false, true]) {
    it(`keeps consecutive acceptances available from ACKed collections absent relay readback with partial=${partial}`, async () => {
      const events = graph("open")
      const pickupCoordinate = `30406:${organizer}:desk`
      events.push(
        sign(30406, [
          ["d", "desk"],
          ["title", "Desk"],
          ["service", "pickup"],
          ["price", "0", "SAT"],
          ["country", "US"],
          ["location", "Public Hall"],
        ])
      )
      events[1] = sign(30405, [
        ...events[1]!.tags.filter((tag) => tag[1] !== productCoordinate),
        ["shipping_option", pickupCoordinate],
      ])
      const merchantSecret = generateSecretKey()
      const merchant = getPublicKey(merchantSecret)
      for (const name of ["first", "second"]) {
        events.push(
          finalizeEvent(
            {
              kind: 30402,
              created_at: now - 10,
              content: "",
              tags: [
                ["d", name],
                ["title", name],
                ["type", "simple", "physical"],
                ["price", "25", "SAT"],
                ["a", coordinate],
                ["shipping_option", pickupCoordinate],
              ],
            },
            merchantSecret
          )
        )
      }
      const published = setup(events, true, partial)
      const market = project(events)
      const firstItem = market.participation.find(
        (item) => item.productCoordinate === `30402:${merchant}:first`
      )!
      const secondItem = market.participation.find(
        (item) => item.productCoordinate === `30402:${merchant}:second`
      )!
      const first = await publishMerchantOrganizerMembership({
        organizerPubkey: organizer,
        market,
        item: firstItem,
        action: "accept",
      })
      // The simulated relay continues serving the original collection even after ACK.
      const projected = reconcileMerchantOrganizerCollectionEvidence(
        market,
        first
      )
      expect(projected.state).toBe("active")
      await publishMerchantOrganizerMembership({
        organizerPubkey: organizer,
        market: projected,
        item: secondItem,
        action: "accept",
        retainedCollection: first,
      })
      expect(published[1]?.tags).toContainEqual([
        "a",
        firstItem.productCoordinate,
      ])
      expect(published[1]?.tags).toContainEqual([
        "a",
        secondItem.productCoordinate,
      ])
      await expect(
        publishMerchantOrganizerMembership({
          organizerPubkey: organizer,
          market,
          item: secondItem,
          action: "accept",
          retainedCollection: { ...first, acknowledgedCount: 0 },
        })
      ).rejects.toThrow("exact delivery retry")
      expect(published).toHaveLength(2)
    })
  }

  it("allows removal from a closed catalog without reopening it", async () => {
    const events = graph("closed")
    const published = setup(events)
    await publishMerchantOrganizerMembership({
      organizerPubkey: organizer,
      market: project(events),
      item: { productCoordinate, status: "organizer_only" },
      action: "remove",
    })
    expect(published[0]?.tags).toContainEqual([
      "conduit_event_market",
      "1",
      "closed",
    ])
    expect(published[0]?.tags).not.toContainEqual(["a", productCoordinate])
  })
})
