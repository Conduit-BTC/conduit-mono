import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  buildEventMarketPickupDraft,
  getEventMarket,
  getEventMarketSupersededEvidence,
  getLocalEventMarketEvidenceSnapshot,
  resolveEventMarketEvidence,
  subscribeLocalEventMarketEvidenceChanges,
  type CachedEventMarketEvidence,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const secret = generateSecretKey()
const otherSecret = generateSecretKey()
const organizer = getPublicKey(secret)
const collection = `30405:${organizer}:catalog`
const calendar = `31923:${organizer}:calendar`
const pickup = `30406:${organizer}:pickup`
const product = `30402:${organizer}:product`
const now = 1_800_000_001_000

function signed(
  draft: { kind: number; tags: string[][]; content?: string },
  created_at = 100,
  key = secret
) {
  return finalizeEvent(
    { ...draft, content: draft.content ?? "", created_at },
    key
  )
}
const graph = [
  signed(
    buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: "calendar",
      title: "Market",
      start: 1_800_000_000,
      end: 1_800_003_600,
    })
  ),
  signed(
    buildEventMarketPickupDraft({
      dTag: "pickup",
      title: "Pickup",
      price: 0,
      currency: "SATS",
      countries: ["US"],
      location: "Public hall",
    })
  ),
  signed(
    buildEventMarketCollectionDraft({
      dTag: "catalog",
      title: "Catalog",
      eventCoordinate: calendar,
      pickupCoordinate: pickup,
      productCoordinates: [product],
    })
  ),
  signed({
    kind: 30402,
    tags: [
      ["d", "product"],
      ["title", "Product"],
      ["price", "100", "SATS"],
      ["a", collection],
      ["shipping_option", pickup],
    ],
  }),
]
function resolution(events = graph) {
  return resolveEventMarketEvidence({
    reference: collection,
    events,
    productRequestEvents: events.filter((event) => event.kind === 30402),
    nowMs: now,
  })
}
function row(event: SignedPublicNostrEvent): CachedEventMarketEvidence {
  return {
    id: event.id,
    organizerPubkey: organizer,
    kind: event.kind,
    signedEvent: event,
    sourceRelayUrls: [],
    cachedAt: now,
  }
}
const empty = { graph: false, productCoordinates: [], pickupCoordinates: [] }
afterEach(() => __resetEventMarketTestOverrides())

describe("retained event market dependencies", () => {
  it("starts from active signed pickup evidence", () => {
    expect(resolution().state).toBe("active")
    expect(resolution().acceptedProductCoordinates).toEqual([product])
    expect(getEventMarketSupersededEvidence(resolution(), graph)).toEqual(empty)
  })

  for (const [index, expected] of [
    [0, { ...empty, graph: true }],
    [1, { ...empty, pickupCoordinates: [pickup] }],
    [2, { ...empty, graph: true }],
    [3, { ...empty, productCoordinates: [product] }],
  ] as const) {
    it(`revokes only the affected dependency for kind ${graph[index]!.kind}`, () => {
      const newer = signed(graph[index]!, 200)
      expect(getEventMarketSupersededEvidence(resolution(), [newer])).toEqual(
        expected
      )
      expect(
        getEventMarketSupersededEvidence(
          resolution(
            graph.map((event, offset) => (offset === index ? newer : event))
          ),
          [newer]
        )
      ).toEqual(empty)
    })
    for (const target of ["a", "e"] as const) {
      it(`honors authored ${target} deletion for kind ${graph[index]!.kind}`, () => {
        const event = graph[index]!
        const coordinate = `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")![1]}`
        const tags = [[target, target === "a" ? coordinate : event.id]]
        expect(
          getEventMarketSupersededEvidence(resolution(), [
            signed({ kind: 5, tags }, 200),
          ])
        ).toEqual(expected)
        expect(
          getEventMarketSupersededEvidence(resolution(), [
            signed({ kind: 5, tags }, 200, otherSecret),
          ])
        ).toEqual(empty)
      })
    }
  }

  it("ignores older, forged, unrelated, and already deleted newer evidence", () => {
    const newer = signed(graph[2]!, 200)
    const deleted = signed({ kind: 5, tags: [["e", newer.id]] }, 201)
    expect(
      getEventMarketSupersededEvidence(resolution(), [
        signed(graph[2]!, 99),
        { ...newer, sig: "0".repeat(128) },
        signed({ ...graph[2]!, tags: [["d", "unrelated"]] }, 300),
        newer,
        deleted,
      ])
    ).toEqual(empty)
    expect(
      getEventMarketSupersededEvidence(resolution(), [
        signed({ kind: 5, tags: [["a", collection]] }, 99),
      ])
    ).toEqual(empty)
  })

  it("keeps a surviving intermediate revision after deletion of the newest", () => {
    const middle = signed(graph[2]!, 200)
    const newest = signed(graph[2]!, 300)
    const deletion = signed({ kind: 5, tags: [["e", newest.id]] }, 400)
    expect(
      getEventMarketSupersededEvidence(resolution(), [middle, newest, deletion])
        .graph
    ).toBe(true)
  })

  it("uses the NIP-01 event ID tiebreak", () => {
    const revisions = [
      signed({ ...graph[2]!, content: "one" }),
      signed({ ...graph[2]!, content: "two" }),
    ].sort((left, right) => left.id.localeCompare(right.id))
    const older = resolution(
      graph.map((event) => (event.kind === 30405 ? revisions[1]! : event))
    )
    expect(getEventMarketSupersededEvidence(older, [revisions[0]!]).graph).toBe(
      true
    )
    const current = resolution(
      graph.map((event) => (event.kind === 30405 ? revisions[0]! : event))
    )
    expect(
      getEventMarketSupersededEvidence(current, [revisions[1]!]).graph
    ).toBe(false)
  })

  it("accepts a newer exact product read without granting it authority itself", () => {
    const newer = signed(graph[3]!, 200)
    expect(
      getEventMarketSupersededEvidence(resolution(), [newer]).productCoordinates
    ).toEqual([product])
    expect(
      getEventMarketSupersededEvidence(
        resolution(),
        [newer],
        [{ addressId: product, eventId: newer.id, eventCreatedAt: 200 }]
      )
    ).toEqual(empty)
    expect(
      getEventMarketSupersededEvidence(
        resolution(),
        [newer],
        [{ addressId: product, eventId: graph[3]!.id, eventCreatedAt: 100 }]
      ).productCoordinates
    ).toEqual([product])
  })
})

describe("local event market evidence observer", () => {
  it("shares a scoped observer and preserves evidence across late empty delivery", () => {
    let deliver: (rows: CachedEventMarketEvidence[]) => void = () => {}
    let subscriptions = 0
    let unsubscribes = 0
    __setEventMarketTestOverrides({
      observeCachedEvidence: (key, observer) => {
        expect(key).toBe(organizer)
        subscriptions++
        deliver = observer.next
        return {
          unsubscribe: () => {
            unsubscribes++
          },
        }
      },
    })
    const stopFirst = subscribeLocalEventMarketEvidenceChanges(
      organizer,
      () => {}
    )
    const stopSecond = subscribeLocalEventMarketEvidenceChanges(
      organizer,
      () => {}
    )
    expect(subscriptions).toBe(1)
    const newer = signed(graph[2]!, 200)
    deliver([row(newer)])
    deliver([])
    expect(
      getLocalEventMarketEvidenceSnapshot(organizer).events.map(
        (event) => event.id
      )
    ).toEqual([newer.id])
    expect(
      getEventMarketSupersededEvidence(
        resolution(),
        getLocalEventMarketEvidenceSnapshot(organizer).events
      ).graph
    ).toBe(true)
    stopFirst()
    expect(unsubscribes).toBe(0)
    stopSecond()
    expect(unsubscribes).toBe(1)
  })

  it("retains a stronger writer observation before failure and after remount", async () => {
    const newer = signed(graph[2]!, 200)
    let deliver: (rows: CachedEventMarketEvidence[]) => void = () => {}
    let observedBeforeWrite = false
    __setEventMarketTestOverrides({
      observeCachedEvidence: (_key, observer) => {
        deliver = observer.next
        return { unsubscribe() {} }
      },
      loadCachedEvidence: async () => [],
      getRelayLists: async () =>
        new Map([
          [
            organizer,
            {
              pubkey: organizer,
              readRelayUrls: [],
              writeRelayUrls: ["wss://event.example"],
              eventCreatedAt: 1,
              cachedAt: now,
            },
          ],
        ]),
      fetchEventsFanoutDetailed: async () => ({
        events: graph.map(
          (event) =>
            new NDKEvent(undefined, event.kind === 30405 ? newer : event)
        ),
        relays: [
          {
            relayUrl: "wss://event.example",
            status: "success",
            eventCount: graph.length,
          },
        ],
        eventsVerified: true,
      }),
      persistCachedEvidence: async () => {
        observedBeforeWrite = getEventMarketSupersededEvidence(
          resolution(),
          getLocalEventMarketEvidenceSnapshot(organizer).events
        ).graph
        throw new Error("Storage unavailable")
      },
    })
    const stop = subscribeLocalEventMarketEvidenceChanges(organizer, () => {})
    deliver(graph.map(row))
    await expect(
      getEventMarket({ reference: collection, nowMs: now })
    ).rejects.toThrow("Storage unavailable")
    expect(observedBeforeWrite).toBe(true)
    deliver(graph.map(row))
    expect(
      getEventMarketSupersededEvidence(
        resolution(),
        getLocalEventMarketEvidenceSnapshot(organizer).events
      ).graph
    ).toBe(true)
    stop()
    const stopAgain = subscribeLocalEventMarketEvidenceChanges(
      organizer,
      () => {}
    )
    deliver([])
    expect(
      getEventMarketSupersededEvidence(
        resolution(),
        getLocalEventMarketEvidenceSnapshot(organizer).events
      ).graph
    ).toBe(true)
    stopAgain()
  })
})
