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
  getEventMarketSupersededEvidence as getEventMarketSupersededEvidenceAtTime,
  getLocalEventMarketEvidenceSnapshot,
  getOrganizerEventMarketsDetailed,
  resolveEventMarketEvidence,
  subscribeLocalEventMarketEvidenceChanges,
  type CachedEventMarketEvidence,
  type EventMarketResolution,
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

function getEventMarketSupersededEvidence(
  market: EventMarketResolution,
  events: readonly SignedPublicNostrEvent[],
  records: readonly {
    addressId: string
    eventId: string
    eventCreatedAt: number
  }[] = [],
  observedAt = now
) {
  return getEventMarketSupersededEvidenceAtTime(
    market,
    events,
    records,
    observedAt
  )
}

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
const cachePressureCollections = Array.from({ length: 8 }, (_, index) =>
  signed(
    buildEventMarketCollectionDraft({
      dTag: `cache-pressure-${index}`,
      title: `Cache pressure ${index}`,
      eventCoordinate: calendar,
    }),
    200 + index
  )
)
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
const empty = {
  graph: false,
  graphRevoked: false,
  productCoordinates: [],
  removedProductCoordinates: [],
  terminalProductCoordinates: [],
  pickupCoordinates: [],
  terminalPickupCoordinates: [],
}
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
        const deletionExpected =
          event.kind === 30405 || event.kind === 31923
            ? { ...expected, graphRevoked: true }
            : event.kind === 30406
              ? { ...expected, terminalPickupCoordinates: [pickup] }
              : event.kind === 30402
                ? { ...expected, terminalProductCoordinates: [product] }
                : expected
        expect(
          getEventMarketSupersededEvidence(resolution(), [
            signed({ kind: 5, tags }, 200),
          ])
        ).toEqual(deletionExpected)
        expect(
          getEventMarketSupersededEvidence(resolution(), [
            signed({ kind: 5, tags }, 200, otherSecret),
          ])
        ).toEqual(empty)
      })
    }
  }

  for (const target of ["a", "e"] as const) {
    it(`keeps a valid pickup replacement recoverable after an older ${target} deletion`, () => {
      const retainedPickup = graph[1]!
      const deletionTarget = target === "a" ? pickup : retainedPickup.id
      const deletion = signed(
        { kind: 5, tags: [[target, deletionTarget]] },
        200
      )
      const replacement = signed(
        buildEventMarketPickupDraft({
          dTag: "pickup",
          title: "Replacement pickup",
          price: 0,
          currency: "SATS",
          countries: ["US"],
          location: "Replacement hall",
        }),
        300
      )

      expect(
        getEventMarketSupersededEvidence(resolution(), [deletion, replacement])
      ).toEqual({
        ...empty,
        pickupCoordinates: [pickup],
      })
    })
  }

  it("does not let a malformed pickup revision erase terminal deletion evidence", () => {
    const deletedPickup = graph[1]!
    const malformedReplacement = signed(
      {
        ...deletedPickup,
        tags: deletedPickup.tags.filter((tag) => tag[0] !== "service"),
      },
      300
    )

    expect(
      getEventMarketSupersededEvidence(resolution(), [
        signed({ kind: 5, tags: [["e", deletedPickup.id]] }, 200),
        malformedReplacement,
      ])
    ).toEqual({
      ...empty,
      pickupCoordinates: [pickup],
      terminalPickupCoordinates: [pickup],
    })
  })

  it("classifies a newer malformed pickup revision as terminal evidence", () => {
    const currentPickup = graph[1]!
    const malformedReplacement = signed(
      {
        ...currentPickup,
        tags: currentPickup.tags.filter((tag) => tag[0] !== "service"),
      },
      300
    )

    expect(
      getEventMarketSupersededEvidence(resolution(), [malformedReplacement])
    ).toEqual({
      ...empty,
      pickupCoordinates: [pickup],
      terminalPickupCoordinates: [pickup],
    })
  })

  it("classifies a newer signed collection closure as a terminal graph revocation", () => {
    const closed = signed(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [product],
        orderAcceptance: "closed",
      }),
      200
    )

    expect(getEventMarketSupersededEvidence(resolution(), [closed])).toEqual({
      ...empty,
      graph: true,
      graphRevoked: true,
    })
  })

  for (const [condition, reference] of [
    ["a second calendar", ["a", `31923:${organizer}:other-calendar`]],
    ["a second pickup", ["shipping_option", `30406:${organizer}:other-pickup`]],
    ["an unsupported reference", ["a", `30407:${organizer}:unsupported`]],
  ] as const) {
    it(`classifies a newer signed collection with ${condition} as a terminal graph revocation`, () => {
      const revised = signed(
        {
          ...graph[2]!,
          tags: [...graph[2]!.tags, [...reference]],
        },
        200
      )

      expect(getEventMarketSupersededEvidence(resolution(), [revised])).toEqual(
        {
          ...empty,
          graph: true,
          graphRevoked: true,
        }
      )
    })
  }

  it("applies legacy calendar end semantics to stronger signed graph evidence", () => {
    const pastCalendarDraft = buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: "calendar",
      title: "Past market",
      start: 1_799_999_000,
      end: 1_800_000_000,
    })
    const pastCalendar = signed(pastCalendarDraft, 200)
    expect(
      getEventMarketSupersededEvidence(resolution(), [pastCalendar], [], now)
    ).toEqual({
      ...empty,
      graph: true,
      graphRevoked: true,
    })

    const futureCalendar = signed(graph[0]!, 200)
    expect(
      getEventMarketSupersededEvidence(resolution(), [futureCalendar], [], now)
    ).toEqual({ ...empty, graph: true })

    const openCollection = signed(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [product],
        orderAcceptance: "open",
      })
    )
    const explicitlyOpen = resolution([
      signed(pastCalendarDraft),
      graph[1]!,
      openCollection,
      graph[3]!,
    ])
    expect(explicitlyOpen.state).toBe("active")
    expect(
      getEventMarketSupersededEvidence(explicitlyOpen, [pastCalendar], [], now)
    ).toEqual({ ...empty, graph: true })

    const legacyCollection = signed(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Catalog metadata revision",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [product],
      }),
      200
    )
    expect(
      getEventMarketSupersededEvidence(
        explicitlyOpen,
        [legacyCollection],
        [],
        now
      )
    ).toEqual({
      ...empty,
      graph: true,
      graphRevoked: true,
    })
  })

  it("keeps a stripped lifecycle declaration terminal before the calendar ends", () => {
    const openCollection = signed(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [product],
        orderAcceptance: "open",
      })
    )
    const explicitlyOpen = resolution([
      graph[0]!,
      graph[1]!,
      openCollection,
      graph[3]!,
    ])
    const strippedCollection = signed(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Stripped lifecycle",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [product],
      }),
      300
    )
    const localOpenCollection = signed(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Local lifecycle predecessor",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [product],
        orderAcceptance: "open",
      }),
      200
    )

    expect(
      getEventMarketSupersededEvidence(explicitlyOpen, [strippedCollection])
    ).toEqual({
      ...empty,
      graph: true,
      graphRevoked: true,
    })
    expect(
      getEventMarketSupersededEvidence(resolution(), [
        localOpenCollection,
        strippedCollection,
      ])
    ).toEqual({
      ...empty,
      graph: true,
      graphRevoked: true,
    })

    const deletedOpenCollection = signed(
      {
        kind: 5,
        tags: [["e", openCollection.id]],
      },
      200
    )
    expect(
      getEventMarketSupersededEvidence(explicitlyOpen, [
        deletedOpenCollection,
        strippedCollection,
      ])
    ).toEqual({
      ...empty,
      graph: true,
    })

    const reopenedCollection = signed(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Reopened after stripped lifecycle",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [product],
        orderAcceptance: "open",
      }),
      400
    )
    expect(
      getEventMarketSupersededEvidence(resolution(), [
        localOpenCollection,
        strippedCollection,
        reopenedCollection,
      ])
    ).toEqual({
      ...empty,
      graph: true,
    })
  })

  it("classifies products omitted by a newer signed collection revision", () => {
    const withoutProduct = signed(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [],
      }),
      200
    )

    expect(
      getEventMarketSupersededEvidence(resolution(), [withoutProduct])
    ).toEqual({
      ...empty,
      graph: true,
      removedProductCoordinates: [product],
    })
  })

  it("scopes a removed organizer pickup to products that depend on it", () => {
    const withoutPickup = signed(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Catalog",
        eventCoordinate: calendar,
        productCoordinates: [product],
      }),
      200
    )

    expect(
      getEventMarketSupersededEvidence(resolution(), [withoutPickup])
    ).toEqual({
      ...empty,
      graph: true,
      terminalPickupCoordinates: [pickup],
    })
  })

  it("classifies an organizer-listed product removed before participation settles", () => {
    const previewResolution: EventMarketResolution = {
      ...resolution(),
      acceptedProductCoordinates: [],
      acceptedProductEvidence: [],
      organizerOnlyProductCoordinates: [product],
      participationRequests: [],
    }
    const withoutProduct = signed(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [],
      }),
      200
    )

    expect(
      getEventMarketSupersededEvidence(previewResolution, [withoutProduct])
    ).toEqual({
      ...empty,
      graph: true,
      removedProductCoordinates: [product],
    })
  })

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

  it("keeps only a valid canonical product revision recoverable", () => {
    const current = graph[3]!
    const replacement = (title: string, tags = current.tags, createdAt = 200) =>
      signed(
        {
          ...current,
          tags: tags.map((tag) =>
            tag[0] === "title" ? ["title", title] : tag
          ),
        },
        createdAt
      )

    const deleted = signed({ kind: 5, tags: [["a", product]] }, 200)
    expect(
      getEventMarketSupersededEvidence(resolution(), [deleted])
    ).toMatchObject({
      productCoordinates: [product],
      terminalProductCoordinates: [product],
    })

    expect(
      getEventMarketSupersededEvidence(resolution(), [
        replacement("x".repeat(201)),
      ])
    ).toMatchObject({
      productCoordinates: [product],
      terminalProductCoordinates: [product],
    })
    expect(
      getEventMarketSupersededEvidence(resolution(), [
        replacement("Conflicting coordinate", [
          ["d", "other-product"],
          ...current.tags,
        ]),
      ])
    ).toMatchObject({
      productCoordinates: [product],
      terminalProductCoordinates: [product],
    })
    expect(
      getEventMarketSupersededEvidence(resolution(), [
        replacement("Updated product"),
      ])
    ).toMatchObject({
      productCoordinates: [product],
      terminalProductCoordinates: [],
    })
    expect(
      getEventMarketSupersededEvidence(resolution(), [
        deleted,
        replacement("Replacement after deletion", current.tags, 300),
      ])
    ).toMatchObject({
      productCoordinates: [product],
      terminalProductCoordinates: [],
    })
  })
})

describe("local event market evidence observer", () => {
  it("keeps over-cap evidence when active-order pins are unavailable", async () => {
    let persistenceCalls = 0
    const liveEvents = [...graph, ...cachePressureCollections]
    __setEventMarketTestOverrides({
      maxCachedEvidencePerOrganizer: 6,
      loadCachedEvidence: async () => [],
      getActiveOrderCollectionEvidencePins: async () => ({
        status: "unavailable",
      }),
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
        events: liveEvents.map((event) => new NDKEvent(undefined, event)),
        relays: [
          {
            relayUrl: "wss://event.example",
            status: "success",
            eventCount: liveEvents.length,
          },
        ],
        eventsVerified: true,
      }),
      persistCachedEvidence: async () => {
        persistenceCalls++
      },
    })

    expect(
      (
        await getEventMarket({
          reference: collection,
          nowMs: now,
        })
      ).state
    ).toBe("active")
    const retained = getLocalEventMarketEvidenceSnapshot(organizer).events
    expect(persistenceCalls).toBe(0)
    expect(retained.length).toBeGreaterThan(6)
    expect(retained.some((event) => event.id === graph[2]!.id)).toBe(true)
  }, 15_000)

  it("rechecks active-order pins at the persistence boundary", async () => {
    let pinReads = 0
    let originalObservedBeforeWrite = false
    const liveEvents = [...graph, ...cachePressureCollections]
    __setEventMarketTestOverrides({
      maxCachedEvidencePerOrganizer: 6,
      loadCachedEvidence: async () => [],
      getActiveOrderCollectionEvidencePins: async () => {
        pinReads++
        return {
          status: "ready",
          eventIds: pinReads === 1 ? [] : [graph[2]!.id],
        }
      },
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
        events: liveEvents.map((event) => new NDKEvent(undefined, event)),
        relays: [
          {
            relayUrl: "wss://event.example",
            status: "success",
            eventCount: liveEvents.length,
          },
        ],
        eventsVerified: true,
      }),
      persistCachedEvidence: async ({ events }) => {
        if (!events.some((event) => event.id === graph[2]!.id)) return
        originalObservedBeforeWrite = getLocalEventMarketEvidenceSnapshot(
          organizer
        ).events.some((event) => event.id === graph[2]!.id)
      },
    })

    await getEventMarket({
      reference: collection,
      nowMs: now,
    })
    expect(pinReads).toBeGreaterThanOrEqual(2)
    expect(originalObservedBeforeWrite).toBe(true)
  }, 15_000)

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

  it("preserves a later failed write across an older concurrent completion", async () => {
    const original = graph[2]!
    const closed = signed(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [product],
        orderAcceptance: "closed",
      }),
      200
    )
    let pinReads = 0
    let signalFirstPersistencePin!: () => void
    let releaseFirstPersistencePin!: (snapshot: {
      status: "ready"
      eventIds: string[]
    }) => void
    const firstPersistencePinStarted = new Promise<void>((resolve) => {
      signalFirstPersistencePin = resolve
    })
    const firstPersistencePin = new Promise<{
      status: "ready"
      eventIds: string[]
    }>((resolve) => {
      releaseFirstPersistencePin = resolve
    })
    __setEventMarketTestOverrides({
      loadCachedEvidence: async () => [],
      getActiveOrderCollectionEvidencePins: async () => {
        pinReads++
        if (pinReads === 2) {
          signalFirstPersistencePin()
          return firstPersistencePin
        }
        return { status: "ready", eventIds: [] }
      },
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
      fetchEventsFanoutDetailed: async (_filter, options) => ({
        events: [],
        relays: (options.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
          eventCount: 0,
        })),
        eventsVerified: true,
      }),
      persistCachedEvidence: async ({ events }) => {
        if (!events.some((event) => event.id === closed.id)) return
        throw new Error("Later storage unavailable")
      },
    })
    const read = (candidate: SignedPublicNostrEvent) =>
      getOrganizerEventMarketsDetailed({
        organizerPubkey: organizer,
        candidateCollectionEvents: [candidate],
        candidateCollectionLiveEventIds: new Set([candidate.id]),
        projection: "discovery",
        nowMs: now,
      })

    const firstRead = read(original)
    await firstPersistencePinStarted
    try {
      await expect(read(closed)).rejects.toThrow("Later storage unavailable")
    } finally {
      releaseFirstPersistencePin({ status: "ready", eventIds: [] })
    }
    await firstRead

    const retained = getLocalEventMarketEvidenceSnapshot(organizer).events
    expect(retained.some((event) => event.id === closed.id)).toBe(true)
    expect(getEventMarketSupersededEvidence(resolution(), retained).graph).toBe(
      true
    )
  })
})
