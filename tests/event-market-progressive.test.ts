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
  EVENT_KINDS,
  encodeEventMarketNaddr,
  getCachedOrganizerEventMarkets,
  getEventMarket,
  getOrganizerEventMarketsDetailed,
  type OrganizerEventMarketsReadResult,
  type CachedEventMarketEvidence,
  type EventMarketResolution,
  type FetchEventsFanoutResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const collection = `30405:${organizer}:market`
const calendar = `31923:${organizer}:calendar`
const pickup = `30406:${organizer}:pickup`
const relay = "wss://relay.damus.io"
const nowMs = 1_800_000_000_000

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function sign(
  draft: { kind: number; content: string; tags: string[][] },
  created_at = 100
) {
  return finalizeEvent({ ...draft, created_at }, secret)
}

function graph(): SignedPublicNostrEvent[] {
  return [
    sign(
      buildEventMarketCalendarDraft({
        kind: EVENT_KINDS.CALENDAR_TIME,
        dTag: "calendar",
        title: "Public market",
        start: 1_800_000_000,
        end: 1_800_003_600,
      })
    ),
    sign(
      buildEventMarketPickupDraft({
        dTag: "pickup",
        title: "Event pickup",
        price: 0,
        currency: "SATS",
        countries: ["US"],
        location: "Public hall",
      })
    ),
    sign(
      buildEventMarketCollectionDraft({
        dTag: "market",
        title: "Market catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [],
      })
    ),
  ]
}

function rows(events: SignedPublicNostrEvent[]): CachedEventMarketEvidence[] {
  return events.map((event) => ({
    id: event.id,
    kind: event.kind,
    organizerPubkey: organizer,
    signedEvent: event,
    cachedAt: nowMs,
    sourceRelayUrls: [relay],
  }))
}

function result(events: SignedPublicNostrEvent[]): FetchEventsFanoutResult {
  return {
    events: events.map((event) => new NDKEvent(undefined, event)),
    relays: [{ relayUrl: relay, status: "success", eventCount: events.length }],
    eventsVerified: true,
  }
}

function install(cached: SignedPublicNostrEvent[] = []) {
  __setEventMarketTestOverrides({
    loadCachedEvidence: async () => rows(cached),
    persistCachedEvidence: async () => {},
    getRelayLists: async (authors) =>
      new Map(
        authors.map((pubkey) => [
          pubkey,
          {
            pubkey,
            readRelayUrls: [relay],
            writeRelayUrls: [relay],
            eventCreatedAt: 100,
            cachedAt: nowMs,
          },
        ])
      ),
    fetchEventsFanoutDetailed: async () => result([]),
  })
}

afterEach(__resetEventMarketTestOverrides)

describe("event market progressive browsing", () => {
  it("reads cached signed organizer evidence without relay discovery or purchase authorization", async () => {
    install(graph())
    __setEventMarketTestOverrides({
      getRelayLists: async () => {
        throw new Error("cache read started relay discovery")
      },
      fetchEventsFanoutDetailed: async () => {
        throw new Error("cache read started relay I/O")
      },
    })
    const [cached] = await getCachedOrganizerEventMarkets({
      organizerPubkey: organizer,
      nowMs,
    })
    expect(cached.collection?.title).toBe("Market catalog")
    expect(cached.calendar?.title).toBe("Public market")
    expect(cached.state).toBe("stale")
    expect(cached.acceptedProductEvidence).toEqual([])
    expect(cached.participationRequests).toEqual([])
  })

  it("publishes cache before a delayed relay plan completes", async () => {
    install(graph())
    const plan = deferred<Map<string, never>>()
    const preview = deferred<EventMarketResolution>()
    __setEventMarketTestOverrides({ getRelayLists: () => plan.promise })
    const pending = getEventMarket({
      reference: collection,
      nowMs,
      onProgress: preview.resolve,
    })
    const first = await preview.promise
    expect(first.collection?.title).toBe("Market catalog")
    expect(first.state).toBe("stale")
    plan.resolve(new Map())
    await pending
  })

  it("shows a completed relay header before a sibling finishes, then honors its deletion", async () => {
    install()
    const sibling = deferred()
    const header = deferred<EventMarketResolution>()
    const snapshots: EventMarketResolution[] = []
    const events = graph()
    const deletion = sign(
      { kind: 5, content: "", tags: [["a", collection]] },
      200
    )
    __setEventMarketTestOverrides({
      fetchEventsFanoutDetailed: async (filter, options) => {
        if (!filter.kinds?.includes(EVENT_KINDS.PRODUCT_COLLECTION))
          return result([])
        options?.onProgress?.(result(events))
        await sibling.promise
        options?.onProgress?.(result([...events, deletion]))
        return result([...events, deletion])
      },
    })
    let finished = false
    const pending = getEventMarket({
      reference: collection,
      nowMs,
      onProgress: (value) => {
        snapshots.push(value)
        if (value.calendar) header.resolve(value)
      },
    }).then((value) => {
      finished = true
      return value
    })
    const first = await header.promise
    expect(finished).toBe(false)
    expect(first.calendar?.title).toBe("Public market")
    expect(first.state).toBe("stale")
    expect(first.acceptedProductEvidence).toEqual([])
    sibling.resolve()
    expect((await pending).state).toBe("deleted")
    expect(snapshots.at(-1)?.state).toBe("deleted")
    expect(snapshots.at(-1)?.deletion?.deletions[0]?.deletionEventId).toBe(
      deletion.id
    )
  })

  it("does not let a late cache read resurrect an already observed deletion", async () => {
    install()
    const cache = deferred<CachedEventMarketEvidence[]>()
    const deleted = deferred()
    const snapshots: EventMarketResolution[] = []
    const events = graph()
    const deletion = sign(
      { kind: 5, content: "", tags: [["a", collection]] },
      200
    )
    __setEventMarketTestOverrides({
      loadCachedEvidence: () => cache.promise,
      fetchEventsFanoutDetailed: async (filter, options) => {
        if (!filter.kinds?.includes(EVENT_KINDS.PRODUCT_COLLECTION))
          return result([])
        options?.onProgress?.(result([...events, deletion]))
        deleted.resolve()
        return result([...events, deletion])
      },
    })
    const pending = getEventMarket({
      reference: collection,
      nowMs,
      onProgress: (value) => snapshots.push(value),
    })
    await deleted.promise
    cache.resolve(rows(events))
    expect((await pending).state).toBe("deleted")
    expect(snapshots.length).toBeGreaterThan(1)
    expect(snapshots.every((value) => value.state === "deleted")).toBe(true)
  })

  it("replaces the first usable header with a later signed conflicting graph", async () => {
    install()
    const events = graph()
    const conflict = sign(
      {
        kind: 30405,
        content: "",
        tags: [
          ["d", "market"],
          ["title", "Conflicting market"],
          ["a", calendar],
          ["a", `31923:${organizer}:other`],
          ["shipping_option", pickup],
        ],
      },
      200
    )
    const snapshots: EventMarketResolution[] = []
    __setEventMarketTestOverrides({
      fetchEventsFanoutDetailed: async (filter, options) => {
        if (!filter.kinds?.includes(EVENT_KINDS.PRODUCT_COLLECTION))
          return result([])
        options?.onProgress?.(result(events))
        options?.onProgress?.(result([...events, conflict]))
        return result([...events, conflict])
      },
    })
    const final = await getEventMarket({
      reference: collection,
      nowMs,
      onProgress: (value) => snapshots.push(value),
    })
    expect(snapshots[0]?.state).toBe("stale")
    expect(snapshots.at(-1)?.state).toBe("conflicting")
    expect(final.state).toBe("conflicting")
    expect(final.acceptedProductEvidence).toEqual([])
  })

  it("never treats a cached positive merchant request as current acceptance", async () => {
    const productCoordinate = `30402:${organizer}:product`
    const records = graph()
    records[2] = sign(
      buildEventMarketCollectionDraft({
        dTag: "market",
        title: "Market catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [productCoordinate],
      })
    )
    records.push(
      sign({
        kind: 30402,
        content: "",
        tags: [
          ["d", "product"],
          ["title", "Product"],
          ["price", "10", "SATS"],
          ["a", collection],
          ["shipping_option", pickup],
        ],
      })
    )
    install(records)
    const [cached] = await getCachedOrganizerEventMarkets({
      organizerPubkey: organizer,
      nowMs,
    })
    expect(cached.state).toBe("stale")
    expect(cached.organizerProductCoordinates).toEqual([productCoordinate])
    expect(cached.acceptedProductCoordinates).toEqual([])
    expect(cached.acceptedProductEvidence).toEqual([])
  })

  it("starts exact product verification while organizer pickup verification remains pending", async () => {
    install()
    const productCoordinate = `30402:${organizer}:product`
    const events = graph()
    events[2] = sign(
      buildEventMarketCollectionDraft({
        dTag: "market",
        title: "Market catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [productCoordinate],
      })
    )
    const releasePickup = deferred()
    const productFrontier = deferred()
    let pickupPending = false
    __setEventMarketTestOverrides({
      fetchEventsFanoutDetailed: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT_COLLECTION))
          return result(events)
        if (filter.kinds?.includes(EVENT_KINDS.SHIPPING_OPTION)) {
          pickupPending = true
          await releasePickup.promise
          pickupPending = false
          return result([events[1]!])
        }
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT) && filter["#d"])
          productFrontier.resolve()
        return result([])
      },
    })
    const pending = getEventMarket({ reference: collection, nowMs })
    await productFrontier.promise
    expect(pickupPending).toBe(true)
    releasePickup.resolve()
    await pending
  })

  it("recognizes a same-collection naddr claim without treating it as a withdrawal", async () => {
    const productCoordinate = `30402:${organizer}:product`
    const records = graph()
    records[2] = sign(
      buildEventMarketCollectionDraft({
        dTag: "market",
        title: "Market catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [productCoordinate],
      })
    )
    records.push(
      sign({
        kind: EVENT_KINDS.PRODUCT,
        content: "",
        tags: [
          ["d", "product"],
          ["title", "Product"],
          ["price", "10", "SATS"],
          ["a", encodeEventMarketNaddr(collection, [relay])],
          ["shipping_option", pickup],
        ],
      })
    )
    install(records)
    const [cached] = await getCachedOrganizerEventMarkets({
      organizerPubkey: organizer,
      nowMs,
    })
    expect(cached.organizerProductCoordinates).toEqual([productCoordinate])
    expect(cached.browseExcludedProductCoordinates).toEqual([])
    expect(cached.acceptedProductCoordinates).toEqual([])
    const final = await getEventMarket({ reference: collection, nowMs })
    expect(final.browseExcludedProductCoordinates).toEqual([])
    expect(final.acceptedProductCoordinates).toEqual([])
  })

  for (const negative of [
    "withdrawal",
    "coordinate deletion",
    "exact deletion",
  ] as const) {
    it(`preserves retained ${negative} as a browse exclusion through a degraded live read`, async () => {
      const productCoordinate = `30402:${organizer}:product`
      const records = graph()
      records[2] = sign(
        buildEventMarketCollectionDraft({
          dTag: "market",
          title: "Market catalog",
          eventCoordinate: calendar,
          pickupCoordinate: pickup,
          productCoordinates: [productCoordinate],
        })
      )
      const product = sign(
        {
          kind: 30402,
          content: "",
          tags: [
            ["d", "product"],
            ["title", "Product"],
            ["price", "10", "SATS"],
            ["a", collection],
            ["shipping_option", pickup],
          ],
        },
        100
      )
      const evidence =
        negative === "withdrawal"
          ? sign(
              {
                kind: 30402,
                content: "",
                tags: product.tags.filter((tag) => tag[0] !== "a"),
              },
              200
            )
          : sign(
              {
                kind: 5,
                content: "",
                tags:
                  negative === "coordinate deletion"
                    ? [["a", productCoordinate]]
                    : [["e", product.id]],
              },
              200
            )
      install([...records, product, evidence])
      const [cached] = await getCachedOrganizerEventMarkets({
        organizerPubkey: organizer,
        nowMs,
      })
      expect(cached.organizerProductCoordinates).toEqual([productCoordinate])
      expect(cached.browseExcludedProductCoordinates).toEqual([
        productCoordinate,
      ])
      expect(cached.acceptedProductCoordinates).toEqual([])
      const progress: EventMarketResolution[] = []
      const final = await getEventMarket({
        reference: collection,
        nowMs,
        onProgress: (value) => progress.push(value),
      })
      expect(final.browseExcludedProductCoordinates).toEqual([
        productCoordinate,
      ])
      expect(final.acceptedProductCoordinates).toEqual([])
      expect(
        progress.every((value) =>
          value.browseExcludedProductCoordinates?.includes(productCoordinate)
        )
      ).toBe(true)
    })
  }

  it("ignores foreign product tombstones and permits a newer signed request after a retained withdrawal", async () => {
    const productCoordinate = `30402:${organizer}:product`
    const records = graph()
    records[2] = sign(
      buildEventMarketCollectionDraft({
        dTag: "market",
        title: "Market catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [productCoordinate],
      })
    )
    const product = sign(
      {
        kind: 30402,
        content: "",
        tags: [
          ["d", "product"],
          ["title", "Product"],
          ["price", "10", "SATS"],
          ["a", collection],
          ["shipping_option", pickup],
        ],
      },
      300
    )
    const withdrawal = sign(
      {
        kind: 30402,
        content: "",
        tags: product.tags.filter((tag) => tag[0] !== "a"),
      },
      200
    )
    const foreignDeletion = finalizeEvent(
      {
        kind: 5,
        content: "",
        tags: [["a", productCoordinate]],
        created_at: 400,
      },
      generateSecretKey()
    )
    install([...records, withdrawal, foreignDeletion])
    __setEventMarketTestOverrides({
      fetchEventsFanoutDetailed: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT_COLLECTION))
          return result(records)
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT))
          return result([product])
        if (filter.kinds?.includes(EVENT_KINDS.SHIPPING_OPTION))
          return result([records[1]!])
        return result([])
      },
    })
    const final = await getEventMarket({ reference: collection, nowMs })
    expect(final.browseExcludedProductCoordinates).toEqual([])
    expect(final.acceptedProductCoordinates).toEqual([productCoordinate])
    install([...records, product, withdrawal, foreignDeletion])
    const [cached] = await getCachedOrganizerEventMarkets({
      organizerPubkey: organizer,
      nowMs,
    })
    expect(cached.browseExcludedProductCoordinates).toEqual([])
    expect(cached.acceptedProductCoordinates).toEqual([])
  })

  for (const cancellation of ["signal", "authority"] as const) {
    it(`suppresses later progress and rejects after ${cancellation} cancellation`, async () => {
      install()
      const gate = deferred()
      const header = deferred()
      const controller = new AbortController()
      let current = true
      const snapshots: EventMarketResolution[] = []
      __setEventMarketTestOverrides({
        fetchEventsFanoutDetailed: async (filter, options) => {
          if (!filter.kinds?.includes(EVENT_KINDS.PRODUCT_COLLECTION))
            return result([])
          options?.onProgress?.(result(graph()))
          header.resolve()
          await gate.promise
          options?.onProgress?.(result(graph()))
          return result(graph())
        },
      })
      const pending = getEventMarket({
        reference: collection,
        nowMs,
        signal: controller.signal,
        shouldContinue: () => current,
        onProgress: (value) => snapshots.push(value),
      })
      await header.promise
      const count = snapshots.length
      if (cancellation === "signal") controller.abort()
      else current = false
      gate.resolve()
      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      expect(snapshots).toHaveLength(count)
    })
  }
})

describe("organizer timeline progressive headers", () => {
  it("reads retained organizer headers without I/O and honors a newer signed unlink", async () => {
    const events = graph()
    install(events)
    __setEventMarketTestOverrides({
      getRelayLists: async () => {
        throw new Error("cache started relay discovery")
      },
      fetchEventsFanoutDetailed: async () => {
        throw new Error("cache started relay I/O")
      },
    })
    const cached = await getCachedOrganizerEventMarkets({
      organizerPubkey: organizer,
      nowMs,
    })
    expect(cached[0]?.calendar?.title).toBe("Public market")
    expect(cached[0]?.state).toBe("stale")
    expect(cached[0]?.acceptedProductEvidence).toEqual([])
    const unlinked = sign(
      {
        kind: 30405,
        content: "",
        tags: [
          ["d", "market"],
          ["title", "Regular collection"],
        ],
      },
      200
    )
    const current = await getCachedOrganizerEventMarkets({
      organizerPubkey: organizer,
      nowMs,
      candidateCollectionEvents: [unlinked],
    })
    expect(current[0]?.calendar).toBeUndefined()
    expect(current[0]?.state).not.toBe("stale")
  })

  it("retains signed deletion authority and discards cache finishing after abort", async () => {
    const deleted = sign(
      { kind: 5, content: "", tags: [["a", collection]] },
      200
    )
    install([...graph(), deleted])
    const cached = await getCachedOrganizerEventMarkets({
      organizerPubkey: organizer,
      nowMs,
    })
    expect(cached[0]?.state).toBe("deleted")
    const held = deferred<CachedEventMarketEvidence[]>()
    __setEventMarketTestOverrides({ loadCachedEvidence: () => held.promise })
    const controller = new AbortController()
    const pending = getCachedOrganizerEventMarkets({
      organizerPubkey: organizer,
      signal: controller.signal,
    })
    controller.abort()
    held.resolve(rows(graph()))
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("emits a browse-only signed header while pickup checks are held", async () => {
    install()
    const pickupStarted = deferred()
    const releasePickup = deferred<FetchEventsFanoutResult>()
    const snapshots: OrganizerEventMarketsReadResult[] = []
    __setEventMarketTestOverrides({
      fetchEventsFanoutDetailed: async (filter) => {
        if (
          filter.kinds?.includes(EVENT_KINDS.SHIPPING_OPTION) &&
          filter["#d"]
        ) {
          pickupStarted.resolve()
          return releasePickup.promise
        }
        return result(graph())
      },
    })
    const read = getOrganizerEventMarketsDetailed({
      organizerPubkey: organizer,
      projection: "discovery",
      nowMs,
      onProgress: (snapshot: OrganizerEventMarketsReadResult) =>
        snapshots.push(snapshot),
    })
    try {
      await pickupStarted.promise
      expect(snapshots.length).toBeGreaterThan(0)
      expect(snapshots[0]?.markets[0]?.calendar?.title).toBe("Public market")
      expect(snapshots[0]?.markets[0]?.acceptedProductEvidence).toEqual([])
      expect(snapshots[0]?.state).toBe("partial")
    } finally {
      releasePickup.resolve(result(graph()))
      await read
    }
  })
})
