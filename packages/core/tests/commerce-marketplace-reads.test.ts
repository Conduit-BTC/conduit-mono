import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { finalizeEvent, getPublicKey, type Filter } from "nostr-tools"
import { config } from "../src/config"
import { ConduitDB, db } from "../src/db"
import { NostrSignerError } from "../src/protocol/nostr-event-signer"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  getCachedMarketplaceProducts,
  getMarketplaceProducts,
  getMarketplaceProductsProgressive,
  getProductsByIds,
  hasExactLiveProductAvailabilityEvidence,
  type CommerceProductRecord,
  type MarketplaceProductsQuery,
} from "../src/protocol/commerce"

type ListingEvent = ReturnType<typeof listing>
type Snapshot = Awaited<ReturnType<typeof getMarketplaceProducts>>

const testDb = new ConduitDB(`marketplace-reads-${crypto.randomUUID()}`, {
  indexedDB,
  IDBKeyRange,
})
const originalProducts = db.products
const originalTombstones = db.productTombstones
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const authorKey = new Uint8Array(32).fill(21)
const otherKey = new Uint8Array(32).fill(22)
const author = getPublicKey(authorKey)
const clock = () => 123_456
const coordinate = (name: string, pubkey = author) => `30402:${pubkey}:${name}`
const searchRelay = config.searchIndexRelayUrls[0]!
let restoreTransaction: () => void
let networkAttempts = 0

function listing(
  name: string,
  price = 10,
  createdAt = 10,
  extraTags: string[][] = [],
  key = authorKey
) {
  const tags = [
    ["d", name],
    ["title", name],
    ["price", String(price), "SATS"],
    ["type", "simple", "digital"],
    ["image", "https://images.unsplash.com/product.png"],
    ["t", "Featured"],
  ]
  return finalizeEvent(
    {
      kind: 30402,
      created_at: createdAt,
      content: "",
      tags: [
        ...tags.filter(
          (tag) => !extraTags.some((extra) => extra[0] === tag[0])
        ),
        ...extraTags,
      ],
    },
    key
  )
}

function parentListing(name: string, createdAt = 10, extra: string[][] = []) {
  return listing(name, 10, createdAt, [
    ["type", "variable", "digital"],
    ...extra,
  ])
}

function variationListing(
  name: string,
  parent: string,
  color: string,
  price = 8,
  createdAt = 11
) {
  return listing(name, price, createdAt, [
    ["type", "variation", "digital"],
    ["a", coordinate(parent)],
    ["spec", "Color", color],
  ])
}

function deletion(name: string, createdAt = 40, key = authorKey) {
  return finalizeEvent(
    {
      kind: 5,
      created_at: createdAt,
      content: "",
      tags: [["a", coordinate(name, getPublicKey(key))]],
    },
    key
  )
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function matches(event: ListingEvent, filter: Filter) {
  return (
    (!filter.authors || filter.authors.includes(event.pubkey)) &&
    (!filter.ids || filter.ids.includes(event.id)) &&
    (!filter["#d"] ||
      event.tags.some(
        (tag) => tag[0] === "d" && filter["#d"]!.includes(tag[1]!)
      )) &&
    (!filter["#a"] ||
      event.tags.some(
        (tag) => tag[0] === "a" && filter["#a"]!.includes(tag[1]!)
      ))
  )
}

/** Signed relay fixture. Search filters return the ranked list verbatim. */
function relayFixture(
  catalog: readonly ListingEvent[],
  options: { ranked?: readonly ListingEvent[]; reads?: Filter[] } = {}
) {
  return async (filter: Filter) => {
    if (!filter.kinds?.includes(30402)) return []
    options.reads?.push(filter)
    if (filter.search) return [...(options.ranked ?? [])]
    return catalog.filter((event) => matches(event, filter))
  }
}

const ids = (records: readonly CommerceProductRecord[]) =>
  records.map((record) => record.dTag)

function recorder() {
  const snapshots: Snapshot[] = []
  return {
    snapshots,
    onProgress: (snapshot: Snapshot) => void snapshots.push(snapshot),
  }
}

function rankedQuery(
  overrides: Partial<MarketplaceProductsQuery> = {}
): MarketplaceProductsQuery {
  return { searchIndex: true, textQuery: "camp", ...overrides }
}

beforeAll(async () => {
  // Guards precede database setup so setup itself cannot reach a network.
  globalThis.fetch = (async () => {
    networkAttempts++
    throw new Error("External fetch forbidden in marketplace fixtures")
  }) as typeof fetch
  globalThis.WebSocket = class {
    constructor() {
      networkAttempts++
      throw new Error("External WebSocket forbidden in marketplace fixtures")
    }
  } as unknown as typeof WebSocket
  await testDb.open()
  db.products = testDb.products
  db.productTombstones = testDb.productTombstones
  const transaction = spyOn(db, "transaction").mockImplementation(
    testDb.transaction.bind(testDb)
  )
  restoreTransaction = () => transaction.mockRestore()
  expect(networkAttempts).toBe(0)
})

beforeEach(async () => {
  __resetCommerceTestOverrides()
  await testDb.products.clear()
  await testDb.productTombstones.clear()
  networkAttempts = 0
  __setCommerceTestOverrides({
    now: clock,
    getRelayLists: async () => new Map(),
    getRelayListsDetailed: async () => ({
      relayLists: new Map(),
      resolutionStates: new Map(),
    }),
    fetchPublicEvents: async () => [],
  })
})

afterEach(() => {
  __resetCommerceTestOverrides()
  expect(networkAttempts).toBe(0)
})

afterAll(async () => {
  restoreTransaction()
  db.products = originalProducts
  db.productTombstones = originalTombstones
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  await testDb.delete()
  expect(db.products).toBe(originalProducts)
  expect(globalThis.fetch).toBe(originalFetch)
  expect(globalThis.WebSocket).toBe(originalWebSocket)
  expect(networkAttempts).toBe(0)
})

describe("marketplace empty author scope", () => {
  it("answers every entry point without transport and without reading cached products", async () => {
    await cacheSignedProductListingEvent(listing("cached"))
    let transport = 0
    const count = async () => {
      transport++
      throw new Error("Empty author scope must not reach transport")
    }
    __setCommerceTestOverrides({
      getRelayLists: count as never,
      getRelayListsDetailed: count as never,
      fetchPublicEvents: count,
      fetchPublicEventsWithDiagnostics: count as never,
      fetchSignedEventsFanoutDetailed: count as never,
      fetchPublicEventsProgressive: count as never,
    })
    const query = { authorPubkeys: [] }

    const plain = await getMarketplaceProducts(query)
    expect(plain.data).toEqual([])
    expect(plain.meta).toMatchObject({ source: "public", stale: false })
    expect(plain.meta.productSearch).toBeUndefined()

    // A ranked search with no authors is still a verified empty answer.
    const ranked = await getMarketplaceProducts({
      ...query,
      ...rankedQuery(),
    })
    expect(ranked.data).toEqual([])
    expect(ranked.meta.productSearch).toEqual({
      coverage: "complete",
      relayUrls: [],
      tagScopeVerified: true,
    })

    const progress: string[] = []
    const progressive = await getMarketplaceProductsProgressive(
      query,
      (_, relayUrl) => progress.push(relayUrl)
    )
    expect(progressive.data).toEqual([])
    expect(progress).toEqual(["none"])

    const cached = await getCachedMarketplaceProducts(query)
    expect(cached.data).toEqual([])
    expect(cached.meta).toMatchObject({ source: "local_cache", stale: true })
    expect(transport).toBe(0)

    // A merchant scope takes precedence over an empty author list.
    expect(
      ids(
        (
          await getCachedMarketplaceProducts({
            merchantPubkey: author,
            authorPubkeys: [],
          })
        ).data
      )
    ).toEqual(["cached"])
  })
})

describe("ranked marketplace search", () => {
  it("keeps lazy ranked hydration configured-only and retains signed revision and deletion vetoes", async () => {
    const configured = new Set(config.appCommerceRelayUrls)
    const hints = Array.from(
      { length: 105 },
      (_, index) => `wss://ranked-${index}.feed-fixture.net`
    )
    const old = listing("scoped-ranked", 10, 10)
    const retained = listing("scoped-ranked", 40, 20)
    const withdrawn = listing("scoped-withdrawn", 15, 10)
    await cacheSignedProductListingEvent(retained, { sourceRelayUrls: hints })
    await cacheSignedProductListingEvent(withdrawn, { sourceRelayUrls: hints })
    await cacheSignedProductDeletionEvent(deletion("scoped-withdrawn"))
    const attempted = new Set<string>()
    const reads: Filter[] = []
    const fetchFixture = relayFixture([old, withdrawn], {
      ranked: [withdrawn, old],
      reads,
    })
    __setCommerceTestOverrides({
      getRelayLists: async () =>
        new Map([
          [
            author,
            {
              pubkey: author,
              readRelayUrls: [],
              writeRelayUrls: hints,
              eventCreatedAt: 1,
              cachedAt: clock(),
            },
          ],
        ]),
      fetchPublicEvents: async (filter, options) => {
        for (const url of options?.relayUrls ?? []) attempted.add(url)
        return fetchFixture(filter)
      },
    })
    const progress = recorder()
    for (let refresh = 0; refresh < 2; refresh++) {
      const result = await getMarketplaceProducts(
        rankedQuery({ onProgress: progress.onProgress })
      )
      expect(result.data.map((record) => record.eventId)).toEqual([retained.id])
      expect(result.meta.stale).toBe(true)
    }
    expect(progress.snapshots.length).toBeGreaterThan(0)
    for (const snapshot of progress.snapshots) {
      expect(snapshot.data.map((record) => record.eventId)).toEqual([
        retained.id,
      ])
    }
    expect(reads.some((filter) => !!filter["#d"])).toBe(true)
    expect(attempted.size).toBeGreaterThan(0)
    expect([...attempted].every((url) => configured.has(url))).toBe(true)
    expect(attempted.size).toBeLessThanOrEqual(configured.size)
  })

  it("keeps relay relevance through author, tag and visibility filters and lifts child hits to their parent family", async () => {
    const parent = parentListing("tent-system", 12, [["title", "Shelter"]])
    const red = variationListing("tent-red", "tent-system", "Red")
    const blue = variationListing("tent-blue", "tent-system", "Blue", 9, 12)
    const zeta = listing("zeta-stove", 5, 20, [["title", "Stove"]])
    const hidden = listing("hidden-lamp", 1, 20, [["visibility", "private"]])
    const untagged = listing("lantern", 1, 20, [["t", "other"]])
    const foreign = listing("foreign-pot", 1, 20, [], otherKey)
    const catalog = [parent, red, blue, zeta, hidden, untagged, foreign]
    const reads: Filter[] = []
    // The relevance order intentionally disagrees with price, recency and title.
    const ranked = [hidden, foreign, red, untagged, zeta]
    __setCommerceTestOverrides({
      fetchPublicEvents: relayFixture(catalog, { ranked, reads }),
    })
    const { snapshots, onProgress } = recorder()
    const result = await getMarketplaceProducts(
      rankedQuery({
        authorPubkeys: [author],
        tags: ["featured"],
        sort: "price_asc",
        onProgress,
      })
    )
    // "camp" appears in no title: relay relevance is not re-filtered locally.
    expect(ids(result.data)).toEqual(["tent-system", "zeta-stove"])
    expect(
      result.data[0]?.family?.children.map((child) => child.dTag).sort()
    ).toEqual(["tent-blue", "tent-red"])
    expect(result.meta).toMatchObject({
      source: "public",
      stale: false,
      degraded: true,
      capped: false,
      productSearch: {
        coverage: "partial",
        tagScopeVerified: false,
        relayUrls: [searchRelay],
      },
    })
    expect(reads.filter((filter) => filter.search)).toHaveLength(1)
    expect(reads[0]).toMatchObject({ search: "camp", limit: 100 })
    // The first paint is derived from signed hits only, before exact family reads.
    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots[0]!.meta).toMatchObject({ stale: true, degraded: true })
    expect(snapshots.at(-1)!.meta.stale).toBe(false)
    expect(ids(snapshots.at(-1)!.data)).toEqual(ids(result.data))

    const limited = await getMarketplaceProducts(
      rankedQuery({ authorPubkeys: [author], tags: ["featured"], limit: 1 })
    )
    expect(ids(limited.data)).toEqual(["tent-system"])

    // Reversing relevance reverses the result: order is the index's, not ours.
    __setCommerceTestOverrides({
      fetchPublicEvents: relayFixture(catalog, {
        ranked: [zeta, untagged, foreign, hidden, red],
      }),
    })
    const reversed = await getMarketplaceProducts(
      rankedQuery({ authorPubkeys: [author], tags: ["featured"] })
    )
    expect(ids(reversed.data)).toEqual(["zeta-stove", "tent-system"])
    const reversedLimited = await getMarketplaceProducts(
      rankedQuery({ authorPubkeys: [author], tags: ["featured"], limit: 1 })
    )
    expect(ids(reversedLimited.data)).toEqual(["zeta-stove"])
  })

  it("orders already-cached hits by relevance in every snapshot, not by cache key order", async () => {
    // IndexedDB yields these in key order (aaa, zzz); the index ranks the reverse.
    const early = listing("aaa-ranked-last", 10, 10)
    const late = listing("zzz-ranked-first", 10, 10)
    for (const event of [early, late])
      await cacheSignedProductListingEvent(event)
    __setCommerceTestOverrides({
      fetchPublicEvents: relayFixture([early, late], { ranked: [late, early] }),
    })
    const { snapshots, onProgress } = recorder()
    const result = await getMarketplaceProducts(rankedQuery({ onProgress }))
    expect(ids(snapshots[0]!.data)).toEqual([
      "zzz-ranked-first",
      "aaa-ranked-last",
    ])
    expect(ids(result.data)).toEqual(["zzz-ranked-first", "aaa-ranked-last"])
    for (const snapshot of snapshots)
      expect(ids(snapshot.data)).toEqual(ids(result.data))
  })

  it("reports complete unscoped search coverage and skips exact reads for an empty ranked response", async () => {
    const reads: Filter[] = []
    __setCommerceTestOverrides({
      fetchPublicEvents: relayFixture([], { ranked: [], reads }),
    })
    const { snapshots, onProgress } = recorder()
    const result = await getMarketplaceProducts(rankedQuery({ onProgress }))
    expect(result.data).toEqual([])
    expect(result.meta).toMatchObject({
      stale: false,
      degraded: false,
      productSearch: { coverage: "complete", tagScopeVerified: true },
    })
    expect(reads).toHaveLength(1)
    expect(snapshots).toHaveLength(1)
  })

  it("marks partial and saturated discovery and refuses an unavailable search index", async () => {
    const hit = listing("partial-hit")
    const relay = (failed: string[], successful: string[]) =>
      __setCommerceTestOverrides({
        fetchPublicEvents: undefined,
        fetchPublicEventsWithDiagnostics: async (filter) => ({
          events: filter.search
            ? [hit]
            : filter.kinds?.includes(30402)
              ? [hit]
              : [],
          attemptedRelayUrls: [...failed, ...successful],
          successfulRelayUrls: successful,
          failedRelayUrls: failed,
          cappedRelayUrls: [],
        }),
      })
    relay(["wss://failed.fixture.test"], [searchRelay])
    const partial = await getMarketplaceProducts(rankedQuery())
    expect(ids(partial.data)).toEqual(["partial-hit"])
    expect(partial.meta).toMatchObject({ degraded: true, capped: false })
    expect(partial.meta.productSearch?.coverage).toBe("partial")

    relay(["wss://failed.fixture.test"], [])
    await expect(getMarketplaceProducts(rankedQuery())).rejects.toThrow(
      "Product search is unavailable"
    )

    const saturated = Array.from({ length: 100 }, (_, index) =>
      listing(`hit-${index}`, 10, 10 + index)
    )
    __setCommerceTestOverrides({
      fetchPublicEventsWithDiagnostics: undefined,
      fetchPublicEvents: relayFixture(saturated, { ranked: saturated }),
    })
    const capped = await getMarketplaceProducts(rankedQuery())
    expect(capped.meta).toMatchObject({ capped: true, degraded: true })
    expect(capped.meta.productSearch?.coverage).toBe("partial")
  })

  it("keeps cached paint non-authoritative: the first paint is stale, no result carries availability diagnostics, and a failed exact refresh returns that stale paint", async () => {
    const hit = listing("cached-paint")
    const failure = new Error("Controlled exact refresh failure")
    __setCommerceTestOverrides({
      fetchPublicEvents: async (filter) => {
        if (filter.search) return [hit]
        if (filter.kinds?.includes(30402)) throw failure
        return []
      },
    })
    const { snapshots, onProgress } = recorder()
    const result = await getMarketplaceProducts(rankedQuery({ onProgress }))
    expect(ids(result.data)).toEqual(["cached-paint"])
    expect(result.meta).toMatchObject({ stale: true, degraded: true })
    for (const snapshot of [...snapshots, result]) {
      expect(snapshot.meta.source).toBe("public")
      expect(snapshot.meta.stale).toBe(true)
      expect("diagnostics" in snapshot).toBe(false)
    }
    // The signed discovery hit stays available to exact readers afterwards.
    expect(
      ids((await getCachedMarketplaceProducts({ merchantPubkey: author })).data)
    ).toEqual(["cached-paint"])
  })
})

describe("ranked marketplace search under concurrent local evidence", () => {
  function pendingExactRefresh(
    catalog: readonly ListingEvent[],
    ranked: readonly ListingEvent[]
  ) {
    const entered = deferred()
    const release = deferred()
    const search = relayFixture(catalog, { ranked })
    __setCommerceTestOverrides({
      fetchPublicEvents: async (filter) => {
        if (filter.kinds?.includes(30402) && !filter.search) {
          entered.resolve()
          await release.promise
        }
        return search(filter)
      },
    })
    return { entered, release }
  }

  it("retracts a painted product deleted by a signed event while the exact refresh is pending", async () => {
    const retracted = listing("retracted-hit", 10, 10)
    const kept = listing("kept-hit", 10, 11)
    const { entered, release } = pendingExactRefresh(
      [retracted, kept],
      [retracted, kept]
    )
    const { snapshots, onProgress } = recorder()
    const read = getMarketplaceProducts(rankedQuery({ onProgress }))
    await entered.promise
    expect(ids(snapshots[0]!.data)).toEqual(["retracted-hit", "kept-hit"])
    await cacheSignedProductDeletionEvent(deletion("retracted-hit"))
    release.resolve()
    const result = await read
    expect(ids(result.data)).toEqual(["kept-hit"])
    expect(ids(snapshots.at(-1)!.data)).toEqual(["kept-hit"])
    expect(
      ids((await getCachedMarketplaceProducts({ merchantPubkey: author })).data)
    ).toEqual(["kept-hit"])
  })

  it("replaces an older ranked hit with the newer signed revision the exact refresh observes", async () => {
    const older = listing("revised-hit", 10, 10)
    const newer = listing("revised-hit", 4, 12)
    // The index is stale: it ranks the old revision while relays hold the new one.
    const { entered, release } = pendingExactRefresh([newer], [older])
    const { snapshots, onProgress } = recorder()
    const read = getMarketplaceProducts(rankedQuery({ onProgress }))
    await entered.promise
    expect(snapshots[0]!.data.map((record) => record.eventId)).toEqual([
      older.id,
    ])
    release.resolve()
    const result = await read
    expect(result.data.map((record) => record.eventId)).toEqual([newer.id])
    expect(snapshots.at(-1)!.data.map((record) => record.eventId)).toEqual([
      newer.id,
    ])
    expect(
      (await getCachedMarketplaceProducts({ merchantPubkey: author })).data.map(
        (record) => record.eventId
      )
    ).toEqual([newer.id])
  })

  it("keeps verified ranked hits for the exact refresh when the cache seed write fails", async () => {
    const older = listing("seed-hit", 10, 10)
    const newer = listing("seed-hit", 4, 12)
    let writes = 0
    let live: readonly ListingEvent[] = []
    const search = relayFixture([older], { ranked: [older] })
    __setCommerceTestOverrides({
      putCachedProducts: async () => {
        writes++
        throw new Error("Controlled product cache write failure")
      },
      fetchPublicEvents: async (filter) =>
        filter.search ? search(filter) : relayFixture(live)(filter),
    })
    // Exact relays have nothing: the signed discovery hit alone must survive.
    const unconfirmed = await getMarketplaceProducts(rankedQuery())
    expect(unconfirmed.data.map((record) => record.eventId)).toEqual([older.id])
    expect(unconfirmed.meta.productSearch?.coverage).toBe("complete")
    expect(writes).toBeGreaterThan(0)
    // Nothing persisted, but a live exact revision still supersedes the seed.
    expect(await testDb.products.count()).toBe(0)
    live = [newer]
    const refreshed = await getMarketplaceProducts(rankedQuery())
    expect(refreshed.data.map((record) => record.eventId)).toEqual([newer.id])
  })

  it("suppresses callbacks and preserves authority_changed when the account changes during search", async () => {
    const entered = deferred()
    const release = deferred()
    let active = true
    __setCommerceTestOverrides({
      fetchPublicEvents: async (filter) => {
        if (!filter.search) return []
        entered.resolve()
        await release.promise
        return [listing("late-hit")]
      },
    })
    const { snapshots, onProgress } = recorder()
    const read = getMarketplaceProducts(
      rankedQuery({ onProgress, shouldContinue: () => active })
    )
    await entered.promise
    active = false
    release.resolve()
    await expect(read).rejects.toMatchObject({ code: "authority_changed" })
    expect(snapshots).toEqual([])
  })

  it("stops after the first paint when authority is revoked inside the callback", async () => {
    const hit = listing("revoked-after-paint")
    const reads: Filter[] = []
    __setCommerceTestOverrides({
      fetchPublicEvents: relayFixture([hit], { ranked: [hit], reads }),
    })
    let active = true
    const snapshots: Snapshot[] = []
    await expect(
      getMarketplaceProducts(
        rankedQuery({
          shouldContinue: () => active,
          onProgress: (snapshot) => {
            snapshots.push(snapshot)
            active = false
          },
        })
      )
    ).rejects.toMatchObject({ code: "authority_changed" })
    expect(snapshots).toHaveLength(1)
    expect(reads.filter((filter) => !filter.search)).toEqual([])
    expect(await testDb.products.count()).toBe(0)
  })

  it("rejects with the abort reason and emits nothing more once the signal aborts during the exact refresh", async () => {
    const hit = listing("aborted-hit")
    const { entered, release } = pendingExactRefresh([hit], [hit])
    const controller = new AbortController()
    const { snapshots, onProgress } = recorder()
    const read = getMarketplaceProducts(
      rankedQuery({ onProgress, signal: controller.signal })
    )
    await entered.promise
    const painted = snapshots.length
    expect(painted).toBeGreaterThan(0)
    controller.abort()
    release.resolve()
    await expect(read).rejects.toMatchObject({ name: "AbortError" })
    expect(snapshots).toHaveLength(painted)
  })
})

describe("catalog marketplace reads", () => {
  it("keeps plain and progressive catalog refreshes configured-only when peers fail", async () => {
    const configured = config.appCommerceRelayUrls
    const hints = Array.from(
      { length: 105 },
      (_, index) => `wss://catalog-${index}.feed-fixture.net`
    )
    const old = listing("scoped-catalog", 10, 10)
    const retained = listing("scoped-catalog", 40, 20)
    await cacheSignedProductListingEvent(retained, { sourceRelayUrls: hints })
    const attempted = new Set<string>()
    let relayListLookups = 0
    const capture = (options?: { relayUrls?: string[] }) => {
      for (const url of options?.relayUrls ?? []) attempted.add(url)
    }
    __setCommerceTestOverrides({
      getRelayLists: async () => {
        relayListLookups++
        return new Map()
      },
      fetchPublicEvents: undefined,
      fetchPublicEventsWithDiagnostics: async (filter, options) => {
        capture(options)
        return {
          events: filter.kinds?.includes(30402) ? [old] : [],
          attemptedRelayUrls: options?.relayUrls ?? [],
          successfulRelayUrls: configured.slice(0, 1),
          failedRelayUrls: configured.slice(1),
          cappedRelayUrls: [],
        }
      },
      fetchPublicEventsProgressive: async (_filter, options, onProgress) => {
        capture(options)
        for (const [index, relayUrl] of (options?.relayUrls ?? []).entries()) {
          await onProgress({
            relayUrl,
            events: index === 0 ? [old] : [],
            mergedEvents: [old],
            status: index === 0 ? "success" : "failed",
          })
        }
        return [old]
      },
    })
    const query = {
      authorPubkeys: [
        author,
        ...Array.from({ length: 20 }, (_, index) =>
          (index + 1).toString(16).padStart(64, "0")
        ),
      ],
    }
    for (let refresh = 0; refresh < 2; refresh++) {
      const plain = await getMarketplaceProducts(query)
      const progressive = await getMarketplaceProductsProgressive(
        query,
        () => {}
      )
      for (const result of [plain, progressive]) {
        expect(result.data.map((record) => record.eventId)).toEqual([
          retained.id,
        ])
        expect(result.meta.degraded).toBe(true)
      }
    }
    expect(relayListLookups).toBe(0)
    expect(attempted).toEqual(new Set(configured))
  })

  it("filters merged signed cache and live revisions before sorting and limiting, and reports partial transport", async () => {
    for (const event of [
      listing("shirt-retained", 20, 10),
      listing("shirt-updated", 30, 10),
      listing("shirt-hidden", 1, 15, [["visibility", "private"]]),
      listing("shirt-other-tag", 2, 14, [["t", "other"]]),
      listing("mug", 1, 16),
    ])
      await cacheSignedProductListingEvent(event)
    const revision = listing("shirt-updated", 5, 11)
    const fresh = listing("shirt-fresh", 12, 12)
    const foreign = listing("shirt-foreign", 1, 13, [], otherKey)
    const live = relayFixture([revision, fresh, foreign])
    __setCommerceTestOverrides({
      fetchPublicEvents: undefined,
      fetchPublicEventsWithDiagnostics: async (filter) => ({
        events: await live(filter),
        attemptedRelayUrls: [
          "wss://one.fixture.test",
          "wss://two.fixture.test",
        ],
        successfulRelayUrls: ["wss://one.fixture.test"],
        failedRelayUrls: ["wss://two.fixture.test"],
        cappedRelayUrls: [],
      }),
    })
    const query = {
      authorPubkeys: [author],
      textQuery: "SHIRT",
      tags: ["featured"],
      sort: "price_asc" as const,
    }
    const result = await getMarketplaceProducts({ ...query, limit: 2 })
    expect(ids(result.data)).toEqual(["shirt-updated", "shirt-fresh"])
    expect(result.data[0]?.eventId).toBe(revision.id)
    expect(result.meta).toMatchObject({
      source: "public",
      degraded: true,
      capped: false,
    })
    expect(ids((await getMarketplaceProducts(query)).data)).toEqual([
      "shirt-updated",
      "shirt-fresh",
      "shirt-retained",
    ])
    // The merged frontier, not only the visible page, is persisted.
    expect(
      ids((await getCachedMarketplaceProducts({ merchantPubkey: author })).data)
    ).toContain("shirt-fresh")
  })

  it("marks a saturated raw read capped and degraded while still honoring the display limit", async () => {
    const events = Array.from({ length: 100 }, (_, index) =>
      listing(`bulk-${index}`, 10 + index, 10 + index)
    )
    __setCommerceTestOverrides({ fetchPublicEvents: relayFixture(events) })
    const result = await getMarketplaceProducts({ limit: 3, sort: "newest" })
    expect(ids(result.data)).toEqual(["bulk-99", "bulk-98", "bulk-97"])
    expect(result.meta).toMatchObject({ capped: true, degraded: true })
    const unsaturated = await getMarketplaceProducts({ limit: 200 })
    expect(unsaturated.data).toHaveLength(100)
    expect(unsaturated.meta).toMatchObject({ capped: false, degraded: false })
  })

  it("falls back to filtered cache on a genuine relay failure but preserves the error without a cache and rethrows authority loss", async () => {
    const failure = new Error("Controlled catalog relay failure")
    __setCommerceTestOverrides({
      fetchPublicEvents: async () => {
        throw failure
      },
    })
    await expect(
      getMarketplaceProducts({ merchantPubkey: author })
    ).rejects.toBe(failure)
    for (const event of [
      listing("fallback-cheap", 1, 10),
      listing("fallback-pricey", 9, 11),
      listing("fallback-hidden", 0, 12, [["visibility", "private"]]),
      listing("fallback-foreign", 0, 12, [], otherKey),
    ])
      await cacheSignedProductListingEvent(event)
    const fallback = await getMarketplaceProducts({
      authorPubkeys: [author],
      sort: "price_desc",
      limit: 1,
    })
    expect(ids(fallback.data)).toEqual(["fallback-pricey"])
    expect(fallback.meta).toMatchObject({
      source: "local_cache",
      stale: true,
      degraded: true,
    })

    // Authority loss and abort are never converted into cached success, even
    // though cached rows exist and the transport outcome would allow fallback.
    for (const transportFails of [false, true]) {
      const entered = deferred()
      const release = deferred()
      let active = true
      __setCommerceTestOverrides({
        fetchPublicEvents: async () => {
          entered.resolve()
          await release.promise
          if (transportFails) throw failure
          return []
        },
      })
      const revoked = getMarketplaceProducts({
        merchantPubkey: author,
        shouldContinue: () => active,
      })
      await entered.promise
      active = false
      release.resolve()
      await (transportFails
        ? expect(revoked).rejects.toBe(failure)
        : expect(revoked).rejects.toMatchObject({ code: "authority_changed" }))
    }

    const controller = new AbortController()
    controller.abort()
    await expect(
      getMarketplaceProducts({
        merchantPubkey: author,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
  })

  it("retracts a cached and live product deleted while the relay read is pending", async () => {
    const event = listing("deleted-while-reading")
    const kept = listing("kept-while-reading", 10, 11)
    await cacheSignedProductListingEvent(event)
    const entered = deferred()
    const release = deferred()
    __setCommerceTestOverrides({
      fetchPublicEvents: async (filter) => {
        if (!filter.kinds?.includes(30402)) return []
        entered.resolve()
        await release.promise
        return [event, kept]
      },
    })
    const read = getMarketplaceProducts({ merchantPubkey: author })
    await entered.promise
    await cacheSignedProductDeletionEvent(deletion("deleted-while-reading"))
    release.resolve()
    expect(ids((await read).data)).toEqual(["kept-while-reading"])
    expect(
      ids((await getCachedMarketplaceProducts({ merchantPubkey: author })).data)
    ).toEqual(["kept-while-reading"])
  })

  it("rechecks the deletion frontier after the merged cache write and keeps newer live revisions over cached ones", async () => {
    await cacheSignedProductListingEvent(
      listing("deleted-during-write", 30, 10)
    )
    await cacheSignedProductListingEvent(listing("stale-price", 30, 10))
    const revision = listing("deleted-during-write", 15, 11)
    const newer = listing("stale-price", 3, 12)
    const entered = deferred()
    const release = deferred()
    __setCommerceTestOverrides({
      fetchPublicEvents: relayFixture([revision, newer]),
      putCachedProducts: async (rows) => {
        entered.resolve()
        await release.promise
        await db.products.bulkPut(rows)
      },
    })
    const read = getMarketplaceProducts({ merchantPubkey: author })
    await entered.promise
    await cacheSignedProductDeletionEvent(deletion("deleted-during-write"))
    release.resolve()
    const result = await read
    expect(ids(result.data)).toEqual(["stale-price"])
    expect(result.data[0]?.eventId).toBe(newer.id)
  })
})

describe("cached marketplace reads", () => {
  it("serves filtered local evidence that is always stale, never carries availability diagnostics, and makes no transport attempt", async () => {
    const parent = parentListing("pack", 10)
    const child = variationListing("pack-red", "pack", "Red")
    for (const event of [
      parent,
      child,
      listing("pack-hidden", 1, 12, [["visibility", "private"]]),
      listing("pack-pricey", 50, 13),
      listing("pack-foreign", 1, 14, [], otherKey),
      listing("pack-untagged", 1, 15, [["t", "other"]]),
    ])
      await cacheSignedProductListingEvent(event)
    let transport = 0
    const guard = async () => {
      transport++
      throw new Error("Cached reads must not reach transport")
    }
    __setCommerceTestOverrides({
      fetchPublicEvents: guard,
      fetchPublicEventsWithDiagnostics: guard as never,
      fetchSignedEventsFanoutDetailed: guard as never,
      fetchPublicEventsProgressive: guard as never,
    })
    const result = await getCachedMarketplaceProducts({
      authorPubkeys: [author],
      textQuery: "PACK",
      tags: ["featured"],
      sort: "price_desc",
    })
    expect(ids(result.data)).toEqual(["pack-pricey", "pack"])
    expect(result.meta).toMatchObject({
      source: "local_cache",
      stale: true,
      degraded: true,
      fetchedAt: clock(),
    })
    expect("diagnostics" in result).toBe(false)
    expect(result.data[1]?.family?.children[0]?.dTag).toBe("pack-red")
    expect(result.data[1]?.family?.readEvidence).toMatchObject({
      source: "local_cache",
      stale: true,
      degraded: true,
    })
    expect(
      ids(
        (
          await getCachedMarketplaceProducts({
            authorPubkeys: [author],
            textQuery: "pack",
            tags: ["featured"],
            sort: "price_desc",
            limit: 1,
          })
        ).data
      )
    ).toEqual(["pack-pricey"])
    expect(transport).toBe(0)
  })

  it("honors explicit freshness exclusion at the TTL boundary while retaining stale evidence by default", async () => {
    await cacheSignedProductListingEvent(listing("ttl-hit"))
    const day = 24 * 60 * 60_000
    let instant = clock() + day - 1
    __setCommerceTestOverrides({ now: () => instant })
    expect(
      ids(
        (await getCachedMarketplaceProducts({}, { includeStale: false })).data
      )
    ).toEqual(["ttl-hit"])
    instant++
    const excluded = await getCachedMarketplaceProducts(
      {},
      { includeStale: false }
    )
    expect(excluded.data).toEqual([])
    expect(excluded.meta).toMatchObject({ stale: true, degraded: false })
    const retained = await getCachedMarketplaceProducts({})
    expect(ids(retained.data)).toEqual(["ttl-hit"])
    expect(retained.meta).toMatchObject({ stale: true, degraded: true })
  })
})

describe("progressive marketplace reads", () => {
  type Batch = {
    events: ListingEvent[]
    relayUrl: string
    status?: "success" | "failed"
  }

  /** Real progressive transport seam; the events-only seam would collapse it to one batch. */
  function progressiveRelay(
    batches: readonly Batch[],
    returned?: ListingEvent[]
  ) {
    __setCommerceTestOverrides({
      fetchPublicEvents: undefined,
      // Deletion discovery rides the diagnostics seam and finds nothing remote.
      fetchPublicEventsWithDiagnostics: async (_filter, options) => ({
        events: [],
        attemptedRelayUrls: options?.relayUrls ?? [],
        successfulRelayUrls: options?.relayUrls ?? [],
        failedRelayUrls: [],
        cappedRelayUrls: [],
      }),
      fetchPublicEventsProgressive: async (_filter, _options, onProgress) => {
        const merged: ListingEvent[] = []
        for (const batch of batches) {
          merged.push(...batch.events)
          await onProgress({
            events: batch.events,
            mergedEvents: [...merged],
            relayUrl: batch.relayUrl,
            status: batch.status ?? "success",
          })
        }
        return returned ?? merged
      },
    })
  }

  function progressiveRecorder(log: string[] = []) {
    const snapshots: Array<{ relayUrl: string; snapshot: Snapshot }> = []
    return {
      log,
      snapshots,
      onProgress: (snapshot: Snapshot, relayUrl: string) => {
        snapshots.push({ relayUrl, snapshot })
        log.push(`progress:${relayUrl}:${ids(snapshot.data).join(",")}`)
      },
    }
  }

  /** Persist through IndexedDB while logging each write and optionally gating it. */
  function loggedWrites(
    log: string[],
    behavior: (
      call: number,
      rows: { id: string }[]
    ) => Promise<void> | void = () => {}
  ) {
    let calls = 0
    __setCommerceTestOverrides({
      putCachedProducts: async (rows) => {
        const call = ++calls
        log.push(`write:${rows.map((row) => row.id.split(":")[2]).join(",")}`)
        await behavior(call, rows)
        await db.products.bulkPut(rows)
      },
    })
  }

  it("persists each batch before publishing it, serializes writes, skips unchanged records and reconciles a final frontier", async () => {
    const first = listing("alpha", 10, 10)
    const second = listing("beta", 20, 11)
    await cacheSignedProductListingEvent(listing("cached-only", 5, 9))
    const log: string[] = []
    const gate = deferred()
    const entered = deferred()
    __setCommerceTestOverrides({})
    // Seed the cache before gating writes so the fixture write is the first gated one.
    loggedWrites(log, async (call) => {
      if (call !== 1) return
      entered.resolve()
      await gate.promise
    })
    progressiveRelay([
      { events: [first], relayUrl: "wss://r1.fixture.test" },
      { events: [first, second], relayUrl: "wss://r2.fixture.test" },
    ])
    const { snapshots, onProgress } = progressiveRecorder(log)
    const read = getMarketplaceProductsProgressive(
      { merchantPubkey: author, sort: "price_asc" },
      onProgress
    )
    await entered.promise
    // Paint waits for the batch to be durable.
    expect(log).toEqual(["write:alpha"])
    expect(snapshots).toEqual([])
    gate.resolve()
    const result = await read
    expect(log).toEqual([
      "write:alpha",
      "progress:wss://r1.fixture.test:cached-only,alpha",
      // The second batch re-delivers alpha unchanged; only beta is written.
      "write:beta",
      "progress:wss://r2.fixture.test:cached-only,alpha,beta",
      // The final frontier is retried in full and precedes the last callback.
      "write:cached-only,alpha,beta",
      "progress:deletion-frontier:cached-only,alpha,beta",
    ])
    for (const { relayUrl, snapshot } of snapshots.slice(0, 2)) {
      expect(relayUrl).not.toBe("deletion-frontier")
      expect(snapshot.meta).toMatchObject({ stale: false, degraded: true })
    }
    expect(snapshots.at(-1)!.snapshot.meta).toMatchObject({
      degraded: false,
      capped: false,
    })
    expect(ids(result.data)).toEqual(ids(snapshots.at(-1)!.snapshot.data))
    expect(result.meta.degraded).toBe(false)
  })

  it("replaces an older revision with a newer one from a later batch and retains the newest in cache", async () => {
    const older = listing("revised", 10, 10)
    const newer = listing("revised", 3, 12)
    progressiveRelay([
      { events: [older], relayUrl: "wss://r1.fixture.test" },
      { events: [newer], relayUrl: "wss://r2.fixture.test" },
    ])
    const { snapshots, onProgress } = progressiveRecorder()
    const result = await getMarketplaceProductsProgressive(
      { merchantPubkey: author },
      onProgress
    )
    expect(snapshots.map(({ snapshot }) => snapshot.data[0]?.eventId)).toEqual([
      older.id,
      newer.id,
      newer.id,
    ])
    expect(result.data.map((record) => record.eventId)).toEqual([newer.id])
    expect(
      (await getCachedMarketplaceProducts({ merchantPubkey: author })).data.map(
        (record) => record.eventId
      )
    ).toEqual([newer.id])
  })

  it("retracts a painted batch when a signed deletion lands during its persistence", async () => {
    const doomed = listing("doomed", 10, 10)
    const kept = listing("kept", 10, 11)
    const log: string[] = []
    const entered = deferred()
    const release = deferred()
    loggedWrites(log, async (call) => {
      if (call !== 1) return
      entered.resolve()
      await release.promise
    })
    progressiveRelay([
      { events: [doomed, kept], relayUrl: "wss://r1.fixture.test" },
    ])
    const { snapshots, onProgress } = progressiveRecorder(log)
    const read = getMarketplaceProductsProgressive(
      { merchantPubkey: author },
      onProgress
    )
    await entered.promise
    await cacheSignedProductDeletionEvent(deletion("doomed"))
    release.resolve()
    const result = await read
    expect(snapshots.map(({ snapshot }) => ids(snapshot.data))).toEqual([
      ["kept"],
      ["kept"],
    ])
    expect(ids(result.data)).toEqual(["kept"])
    expect(
      ids((await getCachedMarketplaceProducts({ merchantPubkey: author })).data)
    ).toEqual(["kept"])
  })

  it("keeps publishing after an interim write failure, retries the full frontier and clears the degraded write mark", async () => {
    const first = listing("interim-a", 10, 10)
    const second = listing("interim-b", 10, 11)
    const log: string[] = []
    loggedWrites(log, (call) => {
      if (call === 1) throw new Error("Controlled interim cache failure")
    })
    progressiveRelay([
      { events: [first], relayUrl: "wss://r1.fixture.test" },
      { events: [second], relayUrl: "wss://r2.fixture.test" },
    ])
    const { snapshots, onProgress } = progressiveRecorder(log)
    const result = await getMarketplaceProductsProgressive(
      { merchantPubkey: author },
      onProgress
    )
    expect(log).toEqual([
      "write:interim-a",
      "progress:wss://r1.fixture.test:interim-a",
      "write:interim-b",
      "progress:wss://r2.fixture.test:interim-b,interim-a",
      "write:interim-a,interim-b",
      "progress:deletion-frontier:interim-b,interim-a",
    ])
    expect(snapshots[0]!.snapshot.meta.degraded).toBe(true)
    expect(ids(result.data)).toEqual(["interim-b", "interim-a"])
    expect(await testDb.products.count()).toBe(2)
  })

  it("delivers the final deletion frontier before rethrowing a failed final write", async () => {
    const first = listing("final-a", 10, 10)
    const second = listing("final-b", 10, 11)
    const failure = new Error("Controlled final cache failure")
    const log: string[] = []
    const entered = deferred()
    const release = deferred()
    loggedWrites(log, async (_call, rows) => {
      if (rows.length < 2) return
      // Only the full-frontier write is gated and failed.
      entered.resolve()
      await release.promise
      throw failure
    })
    progressiveRelay([
      { events: [first], relayUrl: "wss://r1.fixture.test" },
      { events: [second], relayUrl: "wss://r2.fixture.test" },
    ])
    const { snapshots, onProgress } = progressiveRecorder(log)
    const read = getMarketplaceProductsProgressive(
      { merchantPubkey: author },
      onProgress
    )
    const outcome = read.then(
      () => "resolved",
      (error: unknown) => {
        log.push("rejected")
        return error
      }
    )
    await entered.promise
    expect(snapshots.map(({ relayUrl }) => relayUrl)).toEqual([
      "wss://r1.fixture.test",
      "wss://r2.fixture.test",
    ])
    // A signed deletion lands while the final write is failing.
    await cacheSignedProductDeletionEvent(deletion("final-b"))
    release.resolve()
    expect(await outcome).toBe(failure)
    expect(log.slice(-3)).toEqual([
      "write:final-a,final-b",
      "progress:deletion-frontier:final-a",
      "rejected",
    ])
    expect(snapshots.at(-1)!.relayUrl).toBe("deletion-frontier")
  })

  it("keeps interim snapshots degraded and reports failed relays and saturation in the final metadata", async () => {
    const failedRelay = listing("failed-relay")
    progressiveRelay([
      { events: [failedRelay], relayUrl: "wss://r1.fixture.test" },
      { events: [], relayUrl: "wss://r2.fixture.test", status: "failed" },
    ])
    const degradedRecorder = progressiveRecorder()
    const degraded = await getMarketplaceProductsProgressive(
      { merchantPubkey: author },
      degradedRecorder.onProgress
    )
    expect(degraded.meta).toMatchObject({ degraded: true, capped: false })
    expect(ids(degraded.data)).toEqual(["failed-relay"])

    const bulk = Array.from({ length: 100 }, (_, index) =>
      listing(`bulk-${index}`, 10, 10 + index)
    )
    progressiveRelay([{ events: bulk, relayUrl: "wss://r1.fixture.test" }])
    const saturated = await getMarketplaceProductsProgressive(
      { merchantPubkey: author, limit: 2, sort: "newest" },
      () => {}
    )
    expect(ids(saturated.data)).toEqual(["bulk-99", "bulk-98"])
    expect(saturated.meta).toMatchObject({ degraded: true, capped: true })
  })

  it("suppresses later writes and callbacks when authority is revoked or the signal aborts during a pending write", async () => {
    for (const mode of ["authority", "abort"] as const) {
      await testDb.products.clear()
      const entered = deferred()
      const release = deferred()
      const log: string[] = []
      loggedWrites(log, async (call) => {
        if (call !== 1) return
        entered.resolve()
        await release.promise
      })
      progressiveRelay([
        { events: [listing(`${mode}-a`)], relayUrl: "wss://r1.fixture.test" },
        { events: [listing(`${mode}-b`)], relayUrl: "wss://r2.fixture.test" },
      ])
      let active = true
      const controller = new AbortController()
      const { snapshots, onProgress } = progressiveRecorder(log)
      const read = getMarketplaceProductsProgressive(
        {
          merchantPubkey: author,
          shouldContinue: () => active,
          signal: controller.signal,
        },
        onProgress
      )
      await entered.promise
      if (mode === "authority") active = false
      else controller.abort()
      release.resolve()
      await expect(read).rejects.toMatchObject(
        mode === "authority"
          ? { code: "authority_changed" }
          : { name: "AbortError" }
      )
      expect(snapshots).toEqual([])
      expect(log).toEqual([`write:${mode}-a`])
    }
  })

  it("preserves an authority_changed cache failure instead of degrading it", async () => {
    const entered = deferred()
    const release = deferred()
    const log: string[] = []
    loggedWrites(log, async () => {
      entered.resolve()
      await release.promise
      throw new NostrSignerError("authority_changed")
    })
    progressiveRelay([
      {
        events: [listing("authority-write")],
        relayUrl: "wss://r1.fixture.test",
      },
    ])
    const { snapshots, onProgress } = progressiveRecorder(log)
    const read = getMarketplaceProductsProgressive(
      { merchantPubkey: author },
      onProgress
    )
    await entered.promise
    release.resolve()
    await expect(read).rejects.toMatchObject({ code: "authority_changed" })
    expect(snapshots).toEqual([])
  })
})

describe("signed exact-cache revision frontiers", () => {
  it("keeps newer cached terms over an older exact relay revision without live authority", async () => {
    const old = listing("exact-frontier", 10, 10)
    const current = listing("exact-frontier", 4, 12)
    await cacheSignedProductListingEvent(current)
    __setCommerceTestOverrides({ fetchPublicEvents: relayFixture([old]) })
    const result = await getProductsByIds([coordinate("exact-frontier")])
    expect(result.data.map((record) => record.eventId)).toEqual([current.id])
    expect(result.data[0]?.product.price).toBe(4)
    expect(result.meta).toMatchObject({ source: "local_cache", stale: true })
    expect(
      hasExactLiveProductAvailabilityEvidence(
        result.diagnostics[0],
        coordinate("exact-frontier")
      )
    ).toBe(false)
  })

  it("keeps newer cached terms in every ranked snapshot when the index and refresh lag", async () => {
    const old = listing("ranked-frontier", 10, 10)
    const current = listing("ranked-frontier", 4, 12)
    await cacheSignedProductListingEvent(current)
    __setCommerceTestOverrides({
      fetchPublicEvents: relayFixture([old], { ranked: [old] }),
    })
    const progress = recorder()
    const result = await getMarketplaceProducts(
      rankedQuery({ onProgress: progress.onProgress })
    )
    expect(result.data.map((record) => record.eventId)).toEqual([current.id])
    expect(result.data[0]?.product.price).toBe(4)
    expect(result.meta.stale).toBe(true)
    expect(progress.snapshots.length).toBeGreaterThan(0)
    for (const snapshot of progress.snapshots) {
      expect(snapshot.data.map((record) => record.eventId)).toEqual([
        current.id,
      ])
      expect(snapshot.meta.stale).toBe(true)
    }
  })
})
