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
import { finalizeEvent, getPublicKey, nip19, type Filter } from "nostr-tools"
import { ConduitDB, db } from "../src/db"
import { NostrSignerError } from "../src/protocol/nostr-event-signer"
import { attachEventSourceRelayUrl } from "../src/protocol/relay-reader"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  getCachedProductDetail,
  getCachedProductsByIds,
  getMerchantStorefront,
  getProductDetail,
} from "../src/protocol/commerce"

const testDb = new ConduitDB(`product-detail-reads-${crypto.randomUUID()}`, {
  indexedDB,
  IDBKeyRange,
})
const originalProducts = db.products
const originalTombstones = db.productTombstones
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const fixtureKey = new Uint8Array(32).fill(6)
const otherKey = new Uint8Array(32).fill(7)
const merchant = getPublicKey(fixtureKey)
const otherMerchant = getPublicKey(otherKey)
const clock = () => 123_456
const coordinate = (name: string, pubkey = merchant) =>
  `30402:${pubkey}:${name}`
const naddr = (name: string) =>
  nip19.naddrEncode({
    kind: 30402,
    pubkey: merchant,
    identifier: name,
    relays: ["wss://hint.fixture.test"],
  })
let restoreTransaction: () => void
let networkAttempts = 0

function listing(
  name: string,
  price = 10,
  createdAt = 10,
  extraTags: string[][] = [],
  key = fixtureKey
) {
  const tags = [
    ["d", name],
    ["title", name],
    ["price", String(price), "SATS"],
    ["type", "simple", "digital"],
    ["image", "https://images.unsplash.com/product.png"],
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

function deletion(name: string, eventId?: string) {
  return finalizeEvent(
    {
      kind: 5,
      created_at: 30,
      content: "",
      tags: [eventId ? ["e", eventId] : ["a", coordinate(name)]],
    },
    fixtureKey
  )
}

function fixtureFetch(events: readonly ReturnType<typeof listing>[]) {
  return async (filter: Filter) => {
    if (!filter.kinds?.includes(30402)) return []
    return events.filter(
      (event) =>
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
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeAll(async () => {
  await testDb.open()
  db.products = testDb.products
  db.productTombstones = testDb.productTombstones
  const transaction = spyOn(db, "transaction").mockImplementation(
    testDb.transaction.bind(testDb)
  )
  restoreTransaction = () => transaction.mockRestore()
})

beforeEach(async () => {
  __resetCommerceTestOverrides()
  await testDb.products.clear()
  await testDb.productTombstones.clear()
  networkAttempts = 0
  globalThis.fetch = (async () => {
    networkAttempts++
    throw new Error("External fetch forbidden in product-detail fixtures")
  }) as typeof fetch
  globalThis.WebSocket = class {
    constructor() {
      networkAttempts++
      throw new Error("External WebSocket forbidden in product-detail fixtures")
    }
  } as unknown as typeof WebSocket
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
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  expect(networkAttempts).toBe(0)
})

afterAll(async () => {
  restoreTransaction()
  db.products = originalProducts
  db.productTombstones = originalTombstones
  await testDb.delete()
})

describe("commerce product-detail reads", () => {
  it("resolves signed coordinates and naddr hints through the public facade", async () => {
    const event = listing("coordinate")
    const productReads: Filter[] = []
    const fetchFixture = fixtureFetch([event])
    __setCommerceTestOverrides({
      fetchPublicEvents: async (filter) => {
        if (filter.kinds?.includes(30402)) productReads.push(filter)
        return fetchFixture(filter)
      },
    })
    for (const productId of [
      coordinate("coordinate"),
      encodeURIComponent(coordinate("coordinate")),
      naddr("coordinate"),
    ]) {
      const result = await getProductDetail({ productId })
      expect(result.data?.eventId).toBe(event.id)
      expect(result.data?.product.signedProductEvent?.id).toBe(event.id)
      expect(result.meta).toMatchObject({
        source: "commerce",
        stale: false,
        degraded: false,
        capped: false,
        fetchedAt: clock(),
      })
      expect((await getCachedProductDetail({ productId })).data?.eventId).toBe(
        event.id
      )
    }
    expect(productReads).toHaveLength(3)
    expect(
      productReads.every(
        (filter) =>
          filter.authors?.[0] === merchant &&
          filter["#d"]?.[0] === "coordinate" &&
          filter.limit === 10
      )
    ).toBe(true)
  })

  it("uses an event-ID filter and preserves event-ID cached lookup", async () => {
    const event = listing("event-id")
    const productReads: Filter[] = []
    const fetchFixture = fixtureFetch([event])
    __setCommerceTestOverrides({
      fetchPublicEvents: async (filter) => {
        if (filter.kinds?.includes(30402)) productReads.push(filter)
        return fetchFixture(filter)
      },
    })
    const result = await getProductDetail({ productId: event.id })
    expect(productReads).toEqual([{ kinds: [30402], ids: [event.id] }])
    expect(result.data?.addressId).toBe(coordinate("event-id"))
    expect(result.meta).toMatchObject({
      source: "public",
      stale: false,
      degraded: false,
    })
    expect(
      (await getCachedProductDetail({ productId: event.id })).data?.eventId
    ).toBe(event.id)
    const missing = await getProductDetail({ productId: "%invalid" })
    expect(missing.data).toBeNull()
    expect(missing.meta).toMatchObject({ source: "public", stale: false })
    expect(productReads).toHaveLength(1)
  })

  it("selects the complete signed family for a variation coordinate and cached event ID", async () => {
    const parent = listing("parent", 10, 10, [["type", "variable", "digital"]])
    const red = listing("red", 7, 11, [
      ["type", "variation", "digital"],
      ["a", coordinate("parent")],
      ["spec", "Color", "Red"],
    ])
    const blue = listing("blue", 12, 12, [
      ["type", "variation", "digital"],
      ["a", coordinate("parent")],
      ["spec", "Color", "Blue"],
    ])
    __setCommerceTestOverrides({
      fetchPublicEvents: fixtureFetch([parent, red, blue]),
    })
    for (const productId of [coordinate("red"), naddr("red")]) {
      const result = await getProductDetail({ productId })
      expect(result.data?.addressId).toBe(coordinate("parent"))
      expect(result.data?.family?.children.map((child) => child.dTag)).toEqual([
        "blue",
        "red",
      ])
      expect(result.meta).toMatchObject({ stale: false, degraded: false })
      expect(result.data?.family?.readEvidence).toMatchObject({
        fetchedAt: clock(),
        stale: false,
        degraded: false,
      })
    }
    const cached = await getCachedProductDetail({ productId: naddr("red") })
    expect(cached.data?.addressId).toBe(coordinate("parent"))
    expect(cached.data?.family?.priceSummary.minimum?.eventId).toBe(red.id)
    expect(cached.data?.family?.readEvidence).toMatchObject({
      stale: true,
      degraded: true,
    })
    expect(
      (await getCachedProductDetail({ productId: red.id })).data?.addressId
    ).toBe(coordinate("parent"))
  })

  it("does not treat the same signed variation returned by direct and group reads as two choices", async () => {
    const parent = listing("event-parent", 10, 10, [
      ["type", "variable", "digital"],
    ])
    const red = listing("event-red", 7, 11, [
      ["type", "variation", "digital"],
      ["a", coordinate("event-parent")],
      ["spec", "Color", "Red"],
    ])
    const blue = listing("event-blue", 12, 12, [
      ["type", "variation", "digital"],
      ["a", coordinate("event-parent")],
      ["spec", "Color", "Blue"],
    ])
    const productReads: Filter[] = []
    const fetchFixture = fixtureFetch([parent, red, blue])
    __setCommerceTestOverrides({
      fetchPublicEvents: async (filter) => {
        if (filter.kinds?.includes(30402)) productReads.push(filter)
        return (await fetchFixture(filter)).map((event) => {
          const observation = structuredClone(event)
          attachEventSourceRelayUrl(
            observation,
            filter.ids
              ? "wss://direct.fixture.test"
              : "wss://group.fixture.test"
          )
          return observation
        })
      },
    })
    const result = await getProductDetail({ productId: red.id })
    expect(productReads.some((filter) => filter.ids?.[0] === red.id)).toBe(true)
    expect(
      productReads.some((filter) => filter["#d"]?.[0] === "event-parent")
    ).toBe(true)
    expect(
      productReads.some(
        (filter) => filter["#a"]?.[0] === coordinate("event-parent")
      )
    ).toBe(true)
    expect(result.data?.addressId).toBe(coordinate("event-parent"))
    expect(
      result.data?.family?.children.map((child) => child.eventId).sort()
    ).toEqual([red.id, blue.id].sort())
    expect(
      result.data?.family?.children
        .find((child) => child.eventId === red.id)
        ?.sourceRelayUrls?.slice()
        .sort()
    ).toEqual(["wss://direct.fixture.test", "wss://group.fixture.test"])
    expect(
      (await db.products.get(coordinate("event-red")))?.sourceRelayUrls
        ?.slice()
        .sort()
    ).toEqual(["wss://direct.fixture.test", "wss://group.fixture.test"])
    expect(result.meta).toMatchObject({
      source: "public",
      stale: false,
      degraded: false,
    })
  })

  it("continues to reject distinct signed variations sharing one specification tuple", async () => {
    const parent = listing("duplicate-parent", 10, 10, [
      ["type", "variable", "digital"],
    ])
    const red = listing("duplicate-red", 7, 11, [
      ["type", "variation", "digital"],
      ["a", coordinate("duplicate-parent")],
      ["spec", "Color", "Red"],
    ])
    const otherRed = listing("other-red", 9, 12, [
      ["type", "variation", "digital"],
      ["a", coordinate("duplicate-parent")],
      ["spec", "Color", "Red"],
    ])
    const blue = listing("unique-blue", 12, 13, [
      ["type", "variation", "digital"],
      ["a", coordinate("duplicate-parent")],
      ["spec", "Color", "Blue"],
    ])
    __setCommerceTestOverrides({
      fetchPublicEvents: fixtureFetch([parent, red, otherRed, blue]),
    })
    expect(red.id).not.toBe(otherRed.id)
    const result = await getProductDetail({
      productId: coordinate("duplicate-parent"),
    })
    expect(result.data?.family?.children.map((child) => child.eventId)).toEqual(
      [blue.id]
    )
    for (const productId of [red.id, otherRed.id]) {
      expect((await getProductDetail({ productId })).data).toBeNull()
    }
  })

  it("does not resurrect a public revision withdrawn by a newer hidden revision", async () => {
    const old = listing("withdrawn")
    const hidden = listing("withdrawn", 20, 11, [["visibility", "hidden"]])
    await cacheSignedProductListingEvent(old)
    await cacheSignedProductListingEvent(hidden)
    __setCommerceTestOverrides({ fetchPublicEvents: fixtureFetch([old]) })
    expect(
      (await getProductDetail({ productId: coordinate("withdrawn") })).data
    ).toBeNull()
    expect(
      (await getCachedProductDetail({ productId: old.id })).data
    ).toBeNull()
    expect(
      (await getCachedProductsByIds([coordinate("withdrawn")])).data
    ).toEqual([])
    for (const read of [
      getProductDetail({
        productId: coordinate("withdrawn"),
        includeMarketHidden: true,
      }),
      getCachedProductDetail({
        productId: coordinate("withdrawn"),
        includeMarketHidden: true,
      }),
    ]) {
      expect((await read).data?.eventId).toBe(hidden.id)
    }
    const management = await getCachedProductsByIds([coordinate("withdrawn")], {
      includeMarketHidden: true,
    })
    expect(management.data.map((record) => record.eventId)).toEqual([hidden.id])
  })

  it("batches cached coordinates once by author and deduplicates aliases without broad unsupported reads", async () => {
    const first = listing("first")
    const second = listing("second", 10, 10, [], otherKey)
    await cacheSignedProductListingEvent(first)
    await cacheSignedProductListingEvent(second)
    const rows = await db.products.toArray()
    const reads: Array<{
      merchantPubkey?: string
      authors?: readonly string[]
    }> = []
    __setCommerceTestOverrides({
      getCachedProducts: async (merchantPubkey, authors) => {
        reads.push({ merchantPubkey, authors })
        return rows.filter((row) => authors?.includes(row.pubkey))
      },
    })
    const result = await getCachedProductsByIds([
      coordinate("first"),
      naddr("first"),
      coordinate("second", otherMerchant),
      second.id,
      "%invalid",
      `0:${merchant}:profile`,
    ])
    expect(reads).toEqual([
      { merchantPubkey: undefined, authors: [merchant, otherMerchant] },
    ])
    expect(result.data.map((record) => record.eventId)).toEqual([
      first.id,
      second.id,
    ])
    expect(result.meta).toMatchObject({
      source: "local_cache",
      stale: true,
      degraded: true,
    })
    const unsupported = await getCachedProductsByIds([
      first.id,
      "%invalid",
      `0:${merchant}:profile`,
    ])
    expect(unsupported.data).toEqual([])
    expect(reads).toHaveLength(1)
  })

  it("retains stale cached evidence by default and honors explicit freshness exclusion", async () => {
    const event = listing("stale")
    await cacheSignedProductListingEvent(event)
    __setCommerceTestOverrides({ now: () => clock() + 24 * 60 * 60_000 })
    const cached = await getCachedProductDetail({
      productId: coordinate("stale"),
    })
    expect(cached.data?.eventId).toBe(event.id)
    expect(cached.meta).toMatchObject({
      source: "local_cache",
      stale: true,
      degraded: true,
    })
    expect(
      (
        await getCachedProductDetail(
          { productId: coordinate("stale") },
          { includeStale: false }
        )
      ).data
    ).toBeNull()
    expect(
      (
        await getCachedProductsByIds([coordinate("stale")], {
          includeStale: false,
        })
      ).data
    ).toEqual([])
  })

  it("uses the controlled clock at the cached variation-family TTL boundary", async () => {
    const parent = listing("ttl-parent", 10, 10, [
      ["type", "variable", "digital"],
    ])
    const child = listing("ttl-child", 8, 11, [
      ["type", "variation", "digital"],
      ["a", coordinate("ttl-parent")],
      ["spec", "Color", "Red"],
    ])
    for (const event of [parent, child])
      await cacheSignedProductListingEvent(event)
    let instant = clock() + 24 * 60 * 60_000 - 1
    __setCommerceTestOverrides({ now: () => instant })
    const beforeExpiry = await getCachedProductDetail(
      { productId: coordinate("ttl-child") },
      { includeStale: false }
    )
    expect(beforeExpiry.data?.addressId).toBe(coordinate("ttl-parent"))
    expect(beforeExpiry.data?.family?.children[0]?.eventId).toBe(child.id)
    instant++
    expect(
      (
        await getCachedProductDetail(
          { productId: coordinate("ttl-child") },
          { includeStale: false }
        )
      ).data
    ).toBeNull()
    const retained = await getCachedProductDetail({
      productId: coordinate("ttl-child"),
    })
    expect(retained.data?.family?.readEvidence).toMatchObject({
      fetchedAt: instant,
      stale: true,
      degraded: true,
    })
  })

  it("retains the stronger cached revision and honors signed coordinate and event deletions", async () => {
    const old = listing("revision")
    const current = listing("revision", 5, 12)
    await cacheSignedProductListingEvent(current)
    __setCommerceTestOverrides({ fetchPublicEvents: fixtureFetch([old]) })
    const retained = await getProductDetail({
      productId: coordinate("revision"),
    })
    expect(retained.data?.eventId).toBe(current.id)
    expect(retained.meta).toMatchObject({
      source: "commerce",
      stale: true,
      degraded: true,
    })
    await cacheSignedProductDeletionEvent(deletion("revision"))
    expect(
      (await getProductDetail({ productId: coordinate("revision") })).data
    ).toBeNull()
    const exact = listing("event-deleted")
    await cacheSignedProductListingEvent(exact)
    await cacheSignedProductDeletionEvent(deletion("event-deleted", exact.id))
    __setCommerceTestOverrides({ fetchPublicEvents: fixtureFetch([exact]) })
    expect((await getProductDetail({ productId: exact.id })).data).toBeNull()
    expect(
      (
        await getCachedProductsByIds([
          coordinate("revision"),
          coordinate("event-deleted"),
        ])
      ).data
    ).toEqual([])
  })

  it("does not return a signed product deleted while its direct relay read is pending", async () => {
    const event = listing("pending-deletion")
    await cacheSignedProductListingEvent(event)
    const entered = deferred()
    const release = deferred()
    __setCommerceTestOverrides({
      fetchPublicEvents: async (filter) => {
        if (!filter.kinds?.includes(30402)) return []
        entered.resolve()
        await release.promise
        return [event]
      },
    })
    const read = getProductDetail({ productId: coordinate("pending-deletion") })
    await entered.promise
    await cacheSignedProductDeletionEvent(deletion("pending-deletion"))
    release.resolve()
    expect((await read).data).toBeNull()
    expect(
      (await getCachedProductDetail({ productId: event.id })).data
    ).toBeNull()
  })

  it("falls back to matching cached detail on relay failure but preserves a genuine miss error", async () => {
    const event = listing("fallback")
    await cacheSignedProductListingEvent(event)
    const failure = new Error("Controlled product-detail relay failure")
    __setCommerceTestOverrides({
      fetchPublicEvents: async () => {
        throw failure
      },
    })
    for (const productId of [coordinate("fallback"), event.id]) {
      const result = await getProductDetail({ productId })
      expect(result.data?.eventId).toBe(event.id)
      expect(result.meta).toMatchObject({
        source: "local_cache",
        stale: true,
        degraded: true,
      })
    }
    await expect(
      getProductDetail({ productId: coordinate("missing") })
    ).rejects.toBe(failure)
  })

  it("preserves storefront fallback metadata while refreshing its fetchedAt", async () => {
    const event = listing("storefront-fallback")
    const directFilters: boolean[] = []
    let instant = clock()
    __setCommerceTestOverrides({
      now: () => instant,
      fetchPublicEvents: async (filter) => {
        if (!filter.kinds?.includes(30402)) return []
        directFilters.push(!!filter["#d"])
        return filter["#d"] ? [] : [event]
      },
    })
    const storefront = await getMerchantStorefront({ merchantPubkey: merchant })
    await db.products.clear()
    instant += 100
    const result = await getProductDetail({
      productId: coordinate("storefront-fallback"),
    })
    expect(directFilters).toEqual([false, true, false])
    expect(result.data?.eventId).toBe(event.id)
    expect(result.meta.productReadCoverage).toBe("complete")
    expect(result.meta.fetchedAt).toBe(instant)
    expect({ ...result.meta, fetchedAt: storefront.meta.fetchedAt }).toEqual(
      storefront.meta
    )
  })

  it("marks partial and saturated direct relay reads as stale instead of complete", async () => {
    for (const capped of [false, true]) {
      const events = capped
        ? Array.from({ length: 10 }, (_, index) =>
            listing("diagnostics", 10, 10 + index)
          )
        : [listing("diagnostics")]
      __setCommerceTestOverrides({
        fetchPublicEvents: undefined,
        fetchPublicEventsWithDiagnostics: async (filter) => ({
          events: filter.kinds?.includes(30402) ? events : [],
          attemptedRelayUrls: [
            "wss://one.fixture.test",
            "wss://two.fixture.test",
          ],
          successfulRelayUrls: ["wss://one.fixture.test"],
          failedRelayUrls: capped ? [] : ["wss://two.fixture.test"],
          cappedRelayUrls: [],
        }),
      })
      const result = await getProductDetail({
        productId: coordinate("diagnostics"),
      })
      expect(result.data?.eventId).toBe(events.at(-1)?.id)
      expect(result.meta).toMatchObject({
        source: "commerce",
        stale: true,
        degraded: true,
        capped,
      })
    }
  })

  it("retains a cached sibling while marking incomplete live family coverage stale", async () => {
    const parent = listing("partial-parent", 10, 10, [
      ["type", "variable", "digital"],
    ])
    const visible = listing("live-child", 8, 11, [
      ["type", "variation", "digital"],
      ["a", coordinate("partial-parent")],
      ["spec", "Color", "Red"],
    ])
    const cached = listing("cached-child", 12, 12, [
      ["type", "variation", "digital"],
      ["a", coordinate("partial-parent")],
      ["spec", "Color", "Blue"],
    ])
    for (const event of [parent, visible, cached])
      await cacheSignedProductListingEvent(event)
    __setCommerceTestOverrides({
      fetchPublicEvents: fixtureFetch([parent, visible]),
    })
    const result = await getProductDetail({
      productId: coordinate("partial-parent"),
    })
    expect(
      result.data?.family?.children.map((child) => child.eventId).sort()
    ).toEqual([visible.id, cached.id].sort())
    expect(result.meta).toMatchObject({
      source: "commerce",
      stale: true,
      degraded: true,
      capped: false,
    })
    expect(result.data?.family?.readEvidence).toMatchObject({
      stale: true,
      degraded: true,
    })
  })

  for (const scenario of [
    "missing-parent",
    "older-parent",
    "older-child",
  ] as const) {
    it(`keeps family evidence stale when live coverage has ${scenario}`, async () => {
      const parentTags = [["type", "variable", "digital"]]
      const childTags = [
        ["type", "variation", "digital"],
        ["a", coordinate("coverage-parent")],
        ["spec", "Color", "Red"],
      ]
      const liveParent = listing("coverage-parent", 10, 10, parentTags)
      const liveChild = listing("coverage-child", 8, 11, childTags)
      const selectedParent =
        scenario === "older-parent"
          ? listing("coverage-parent", 10, 20, parentTags)
          : liveParent
      const selectedChild =
        scenario === "older-child"
          ? listing("coverage-child", 8, 21, childTags)
          : liveChild
      for (const event of [selectedParent, selectedChild])
        await cacheSignedProductListingEvent(event)
      __setCommerceTestOverrides({
        fetchPublicEvents: fixtureFetch(
          scenario === "missing-parent" ? [liveChild] : [liveParent, liveChild]
        ),
      })
      const result = await getProductDetail({
        productId: coordinate(
          scenario === "older-child" ? "coverage-parent" : "coverage-child"
        ),
      })
      expect(result.data?.eventId).toBe(selectedParent.id)
      expect(
        result.data?.family?.children.map((child) => child.eventId)
      ).toEqual([selectedChild.id])
      expect(result.meta).toMatchObject({ stale: true, degraded: true })
      expect(result.data?.family?.readEvidence).toMatchObject({
        stale: true,
        degraded: true,
      })
    })
  }

  it("propagates transport cancellation after account authority is revoked instead of returning cache", async () => {
    const event = listing("authority")
    await cacheSignedProductListingEvent(event)
    const entered = deferred()
    const release = deferred()
    let active = true
    __setCommerceTestOverrides({
      fetchPublicEvents: async (filter) => {
        if (!filter.kinds?.includes(30402)) return []
        entered.resolve()
        await release.promise
        throw new NostrSignerError("authority_changed")
      },
    })
    const read = getProductDetail({
      productId: coordinate("authority"),
      shouldContinue: () => active,
    })
    await entered.promise
    active = false
    release.resolve()
    await expect(read).rejects.toMatchObject({ code: "authority_changed" })
  })
})
