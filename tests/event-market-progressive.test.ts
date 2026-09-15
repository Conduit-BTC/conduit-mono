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
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/ndk"

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

  it("emits an exact fast merchant acceptance while an unrelated merchant frontier is held", async () => {
    install()
    const fastSecret = generateSecretKey()
    const slowSecret = generateSecretKey()
    const fastPubkey = getPublicKey(fastSecret)
    const fastPickupCoordinate = `30406:${fastPubkey}:fast-pickup`
    const fastPickup = finalizeEvent(
      {
        ...buildEventMarketPickupDraft({
          dTag: "fast-pickup",
          title: "Fast merchant booth",
          price: 0,
          currency: "SATS",
          countries: ["US"],
          location: "Fast booth",
        }),
        created_at: 101,
      },
      fastSecret
    )
    const fast = finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 101,
        content: "",
        tags: [
          ["d", "fast-product"],
          ["title", "Fast product"],
          ["price", "10", "SATS"],
          ["a", collection],
          ["shipping_option", fastPickupCoordinate],
        ],
      },
      fastSecret
    )
    const slow = finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 101,
        content: "",
        tags: [
          ["d", "slow-product"],
          ["title", "Slow product"],
          ["price", "20", "SATS"],
          ["a", collection],
          ["shipping_option", pickup],
        ],
      },
      slowSecret
    )
    const organizerRecords = graph()
    organizerRecords[2] = sign(
      buildEventMarketCollectionDraft({
        dTag: "market",
        title: "Market catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [
          `30402:${fast.pubkey}:fast-product`,
          `30402:${slow.pubkey}:slow-product`,
        ],
      }),
      102
    )
    const slowStarted = deferred()
    const releaseSlow = deferred()
    let fastPickupReads = 0
    __setEventMarketTestOverrides({
      fetchEventsFanoutDetailed: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT_COLLECTION)) {
          return result(organizerRecords)
        }
        if (filter.kinds?.includes(EVENT_KINDS.SHIPPING_OPTION)) {
          if (filter.authors?.includes(fast.pubkey)) {
            fastPickupReads++
            return result([fastPickup])
          }
          return result([organizerRecords[1]!])
        }
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          if (filter["#a"]) return result([fast, slow])
          if (filter.authors?.includes(slow.pubkey)) {
            slowStarted.resolve()
            await releaseSlow.promise
            return result([slow])
          }
          if (filter.authors?.includes(fast.pubkey)) return result([fast])
        }
        return result([])
      },
    })
    const progress: EventMarketResolution[] = []
    let finished = false
    const pending = getEventMarket({
      reference: collection,
      nowMs,
      onProgress: (snapshot) => progress.push(snapshot),
    }).then((resolution) => {
      finished = true
      return resolution
    })
    await slowStarted.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    const whileSlowIsHeld = progress.find((snapshot) =>
      snapshot.acceptedProductCoordinates.includes(
        `30402:${fast.pubkey}:fast-product`
      )
    )
    expect(finished).toBe(false)
    expect(whileSlowIsHeld?.state).toBe("partial")
    expect(whileSlowIsHeld?.acceptedProductCoordinates).toEqual([
      `30402:${fast.pubkey}:fast-product`,
    ])
    expect(whileSlowIsHeld?.organizerOnlyProductCoordinates).toEqual([
      `30402:${slow.pubkey}:slow-product`,
    ])
    expect(
      whileSlowIsHeld?.pickups.find(
        (candidate) => candidate.coordinate === fastPickupCoordinate
      )?.evidenceState
    ).toBe("live")
    expect(whileSlowIsHeld?.acceptedProductEvidence[0]).toMatchObject({
      fulfillmentStatus: "resolved",
      pickupCoordinate: fastPickupCoordinate,
      handoffMode: "merchant_handoff",
    })

    releaseSlow.resolve()
    expect((await pending).acceptedProductCoordinates.sort()).toEqual(
      [
        `30402:${fast.pubkey}:fast-product`,
        `30402:${slow.pubkey}:slow-product`,
      ].sort()
    )
    expect(fastPickupReads).toBe(1)
  })

  it("authorizes an organizer-listed merchant while broad request discovery is held", async () => {
    install()
    const merchantSecret = generateSecretKey()
    const merchantPubkey = getPublicKey(merchantSecret)
    const merchantPickupCoordinate = `30406:${merchantPubkey}:merchant-pickup`
    const merchantPickup = finalizeEvent(
      {
        ...buildEventMarketPickupDraft({
          dTag: "merchant-pickup",
          title: "Merchant booth",
          price: 0,
          currency: "SATS",
          countries: ["US"],
          location: "Merchant booth",
        }),
        created_at: 101,
      },
      merchantSecret
    )
    const product = finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 101,
        content: "",
        tags: [
          ["d", "listed-product"],
          ["title", "Listed product"],
          ["price", "10", "SATS"],
          ["a", collection],
          ["shipping_option", merchantPickupCoordinate],
        ],
      },
      merchantSecret
    )
    const pendingSecret = generateSecretKey()
    const pendingPubkey = getPublicKey(pendingSecret)
    const pendingProduct = finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 101,
        content: "",
        tags: [
          ["d", "pending-product"],
          ["title", "Pending product"],
          ["price", "20", "SATS"],
          ["a", collection],
        ],
      },
      pendingSecret
    )
    const organizerRecords = graph()
    organizerRecords[2] = sign(
      buildEventMarketCollectionDraft({
        dTag: "market",
        title: "Market catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [`30402:${merchantPubkey}:listed-product`],
      }),
      102
    )
    const candidateStarted = deferred()
    const releaseCandidate = deferred()
    const authorized = deferred<EventMarketResolution>()
    let listedExactReads = 0
    let pendingExactReads = 0
    __setEventMarketTestOverrides({
      fetchEventsFanoutDetailed: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT_COLLECTION)) {
          return result(organizerRecords)
        }
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          if (filter["#a"]) {
            candidateStarted.resolve()
            await releaseCandidate.promise
            return result([product, pendingProduct])
          }
          if (filter.authors?.includes(merchantPubkey)) {
            listedExactReads++
            return result([product])
          }
          if (filter.authors?.includes(pendingPubkey)) {
            pendingExactReads++
            return result([pendingProduct])
          }
        }
        if (filter.kinds?.includes(EVENT_KINDS.SHIPPING_OPTION)) {
          return filter.authors?.includes(merchantPubkey)
            ? result([merchantPickup])
            : result([organizerRecords[1]!])
        }
        return result([])
      },
    })
    let finished = false
    const pending = getEventMarket({
      reference: collection,
      nowMs,
      onProgress: (snapshot) => {
        if (
          snapshot.acceptedProductCoordinates.includes(
            `30402:${merchantPubkey}:listed-product`
          )
        ) {
          authorized.resolve(snapshot)
        }
      },
    }).then((resolution) => {
      finished = true
      return resolution
    })

    try {
      await candidateStarted.promise
      const snapshot = await Promise.race([
        authorized.promise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("organizer product did not progress")),
            2_000
          )
        ),
      ])
      expect(finished).toBe(false)
      expect(snapshot.state).toBe("partial")
      expect(snapshot.acceptedProductCoordinates).toEqual([
        `30402:${merchantPubkey}:listed-product`,
      ])
      expect(snapshot.acceptedProductEvidence[0]).toMatchObject({
        fulfillmentStatus: "resolved",
        pickupCoordinate: merchantPickupCoordinate,
        handoffMode: "merchant_handoff",
      })
      expect(listedExactReads).toBe(1)
      expect(pendingExactReads).toBe(0)
    } finally {
      releaseCandidate.resolve()
    }

    const final = await pending
    expect(final.acceptedProductCoordinates).toEqual([
      `30402:${merchantPubkey}:listed-product`,
    ])
    expect(final.participationRequests).toHaveLength(1)
    expect(final.participationRequests[0]?.productCoordinate).toBe(
      `30402:${pendingPubkey}:pending-product`
    )
    expect(listedExactReads).toBe(1)
    expect(pendingExactReads).toBe(1)
  })

  it("reconciles a broad newer organizer-listed product from its observed relay after the early hint-capped frontier", async () => {
    install()
    const merchantSecret = generateSecretKey()
    const merchantPubkey = getPublicKey(merchantSecret)
    const productCoordinate = `30402:${merchantPubkey}:listed-product`
    const merchantHints = Array.from(
      { length: 8 },
      (_, index) => `wss://relay.ditto.pub/merchant-hint-${index}`
    )
    const olderProduct = finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 101,
        content: "",
        tags: [
          ["d", "listed-product"],
          ["title", "Older listed product"],
          ["price", "10", "SATS"],
          ["a", collection],
        ],
      },
      merchantSecret
    )
    const newerProduct = finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 102,
        content: "",
        tags: [
          ["d", "listed-product"],
          ["title", "Newer listed product"],
          ["price", "10", "SATS"],
          ["a", collection],
        ],
      },
      merchantSecret
    )
    const organizerRecords = graph()
    organizerRecords[2] = sign(
      buildEventMarketCollectionDraft({
        dTag: "market",
        title: "Market catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [productCoordinate],
      }),
      103
    )
    const earlyExactRead = deferred()
    const broadRead = deferred()
    const releaseBroadRead = deferred()
    let earlyExactReads = 0
    let reconciledExactReads = 0
    const resultFromRelay = (
      events: SignedPublicNostrEvent[],
      sourceRelayUrl: string
    ): FetchEventsFanoutResult => ({
      events: events.map((event) => {
        const ndkEvent = new NDKEvent(undefined, event)
        attachEventSourceRelayUrl(ndkEvent, sourceRelayUrl)
        return ndkEvent
      }),
      relays: [
        {
          relayUrl: sourceRelayUrl,
          status: "success",
          eventCount: events.length,
        },
      ],
      eventsVerified: true,
    })
    __setEventMarketTestOverrides({
      getRelayLists: async (authors) =>
        new Map(
          authors.map((pubkey) => [
            pubkey,
            {
              pubkey,
              readRelayUrls:
                pubkey === merchantPubkey ? merchantHints : [relay],
              writeRelayUrls:
                pubkey === merchantPubkey ? merchantHints : [relay],
              eventCreatedAt: 100,
              cachedAt: nowMs,
            },
          ])
        ),
      fetchEventsFanoutDetailed: async (filter, options) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT_COLLECTION)) {
          return result(organizerRecords)
        }
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          if (filter["#a"]?.includes(collection)) {
            broadRead.resolve()
            await releaseBroadRead.promise
            return resultFromRelay([newerProduct], relay)
          }
          if (filter.authors?.includes(merchantPubkey)) {
            if (options?.relayUrls.includes(relay)) {
              reconciledExactReads += 1
              return resultFromRelay([newerProduct], relay)
            }
            earlyExactReads += 1
            earlyExactRead.resolve()
            return resultFromRelay([olderProduct], merchantHints[0]!)
          }
        }
        if (filter.kinds?.includes(EVENT_KINDS.SHIPPING_OPTION)) {
          return result([organizerRecords[1]!])
        }
        return result([])
      },
    })

    const progress: EventMarketResolution[] = []
    const pending = getEventMarket({
      reference: collection,
      nowMs,
      onProgress: (snapshot) => progress.push(snapshot),
    })
    await Promise.all([earlyExactRead.promise, broadRead.promise])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(earlyExactReads).toBe(1)
    expect(
      progress.some((snapshot) =>
        snapshot.acceptedProductEvidence.some(
          (evidence) => evidence.eventId === olderProduct.id
        )
      )
    ).toBe(true)

    releaseBroadRead.resolve()
    const final = await pending

    expect(final.acceptedProductCoordinates).toEqual([productCoordinate])
    expect(final.acceptedProductEvidence).toMatchObject([
      { eventId: newerProduct.id },
    ])
    expect(reconciledExactReads).toBe(1)
  })

  it("checks completed merchant pickups concurrently and reuses each settled read", async () => {
    install()
    const blockedSecret = generateSecretKey()
    const freeSecret = generateSecretKey()
    const blockedPubkey = getPublicKey(blockedSecret)
    const freePubkey = getPublicKey(freeSecret)
    const makePickup = (secret: Uint8Array, dTag: string, title: string) =>
      finalizeEvent(
        {
          ...buildEventMarketPickupDraft({
            dTag,
            title,
            price: 0,
            currency: "SATS",
            countries: ["US"],
            location: `${title} location`,
          }),
          created_at: 101,
        },
        secret
      )
    const makeProduct = (
      secret: Uint8Array,
      dTag: string,
      pickupCoordinate: string
    ) =>
      finalizeEvent(
        {
          kind: EVENT_KINDS.PRODUCT,
          created_at: 101,
          content: "",
          tags: [
            ["d", dTag],
            ["title", dTag],
            ["price", "10", "SATS"],
            ["a", collection],
            ["shipping_option", pickupCoordinate],
          ],
        },
        secret
      )
    const blockedPickup = makePickup(
      blockedSecret,
      "blocked-pickup",
      "Blocked booth"
    )
    const freePickup = makePickup(freeSecret, "free-pickup", "Free booth")
    const blockedProduct = makeProduct(
      blockedSecret,
      "blocked-product",
      `30406:${blockedPubkey}:blocked-pickup`
    )
    const freeProduct = makeProduct(
      freeSecret,
      "free-product",
      `30406:${freePubkey}:free-pickup`
    )
    const organizerRecords = graph()
    organizerRecords[2] = sign(
      buildEventMarketCollectionDraft({
        dTag: "market",
        title: "Market catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [
          `30402:${blockedPubkey}:blocked-product`,
          `30402:${freePubkey}:free-product`,
        ],
      }),
      102
    )
    const blockedPickupStarted = deferred()
    const freePickupStarted = deferred()
    const organizerPickupStarted = deferred()
    const releaseBlockedPickup = deferred()
    const releaseOrganizerPickup = deferred()
    let activeMerchantPickupReads = 0
    let maxMerchantPickupReads = 0
    let blockedPickupReads = 0
    let freePickupReads = 0
    __setEventMarketTestOverrides({
      fetchEventsFanoutDetailed: async (filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT_COLLECTION)) {
          return result(organizerRecords)
        }
        if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          if (filter["#a"]) return result([blockedProduct, freeProduct])
          if (filter.authors?.includes(blockedPubkey)) {
            return result([blockedProduct])
          }
          if (filter.authors?.includes(freePubkey)) {
            await blockedPickupStarted.promise
            return result([freeProduct])
          }
        }
        if (filter.kinds?.includes(EVENT_KINDS.SHIPPING_OPTION)) {
          if (filter.authors?.includes(blockedPubkey)) {
            blockedPickupReads++
            activeMerchantPickupReads++
            maxMerchantPickupReads = Math.max(
              maxMerchantPickupReads,
              activeMerchantPickupReads
            )
            blockedPickupStarted.resolve()
            await releaseBlockedPickup.promise
            activeMerchantPickupReads--
            return result([blockedPickup])
          }
          if (filter.authors?.includes(freePubkey)) {
            freePickupReads++
            activeMerchantPickupReads++
            maxMerchantPickupReads = Math.max(
              maxMerchantPickupReads,
              activeMerchantPickupReads
            )
            freePickupStarted.resolve()
            activeMerchantPickupReads--
            return result([freePickup])
          }
          organizerPickupStarted.resolve()
          await releaseOrganizerPickup.promise
          return result([organizerRecords[1]!])
        }
        return result([])
      },
    })
    const progress: EventMarketResolution[] = []
    const pending = getEventMarket({
      reference: collection,
      nowMs,
      onProgress: (snapshot) => progress.push(snapshot),
    })
    try {
      await organizerPickupStarted.promise
      await blockedPickupStarted.promise
      const freeStartedBeforeRelease = await Promise.race([
        freePickupStarted.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
      ])
      expect(freeStartedBeforeRelease).toBe(true)
      expect(maxMerchantPickupReads).toBe(2)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(
        progress.some((snapshot) =>
          snapshot.acceptedProductCoordinates.includes(
            `30402:${freePubkey}:free-product`
          )
        )
      ).toBe(true)
    } finally {
      releaseBlockedPickup.resolve()
      releaseOrganizerPickup.resolve()
    }
    expect((await pending).acceptedProductCoordinates.sort()).toEqual(
      [
        `30402:${blockedPubkey}:blocked-product`,
        `30402:${freePubkey}:free-product`,
      ].sort()
    )
    expect(blockedPickupReads).toBe(1)
    expect(freePickupReads).toBe(1)
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
