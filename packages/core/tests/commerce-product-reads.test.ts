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
import { finalizeEvent, getPublicKey } from "nostr-tools"
import { ConduitDB, db } from "../src/db"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  getCachedMerchantStorefront,
  getMerchantStorefront,
} from "../src/protocol/commerce"

const testDb = new ConduitDB(`product-reads-${crypto.randomUUID()}`, {
  indexedDB,
  IDBKeyRange,
})
const originalProducts = db.products
const originalTombstones = db.productTombstones
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const fixtureKey = new Uint8Array(32).fill(3)
const merchant = getPublicKey(fixtureKey)
const clock = () => 123_456
const coordinate = (name: string) => `30402:${merchant}:${name}`
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

function deletion(name: string) {
  return finalizeEvent(
    {
      kind: 5,
      created_at: 20,
      content: "",
      tags: [["a", coordinate(name)]],
    },
    fixtureKey
  )
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
    throw new Error("External fetch forbidden in storefront fixtures")
  }) as typeof fetch
  globalThis.WebSocket = class {
    constructor() {
      networkAttempts++
      throw new Error("External WebSocket forbidden in storefront fixtures")
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

describe("merchant storefront product reads", () => {
  it("filters cached merchant visibility, text and tags before sorting and limiting", async () => {
    for (const event of [
      listing("shirt-middle", 20, 11),
      listing("shirt-low", 5, 10),
      listing("shirt-high", 40, 12),
      listing("shirt-hidden", 1, 15, [["visibility", "private"]]),
      listing("shirt-unrenderable", 2, 14, [["image", ""]]),
      listing("shirt-other-tag", 3, 13, [["t", "other"]]),
      listing("mug", 1, 16),
      listing("shirt-other-author", 1, 17, [], new Uint8Array(32).fill(4)),
    ])
      await cacheSignedProductListingEvent(event)

    const query = {
      merchantPubkey: merchant,
      textQuery: "SHIRT",
      tag: "featured",
    }
    const ascending = await getCachedMerchantStorefront({
      ...query,
      sort: "price_asc",
      limit: 2,
    })
    expect(ascending.data.map((record) => record.dTag)).toEqual([
      "shirt-low",
      "shirt-middle",
    ])
    expect(ascending.meta).toMatchObject({
      source: "local_cache",
      stale: true,
      degraded: true,
      fetchedAt: clock(),
    })
    for (const sort of ["price_desc", "newest", "updated_at_desc"] as const) {
      const result = await getCachedMerchantStorefront({
        ...query,
        sort,
        limit: 1,
      })
      expect(result.data[0]?.dTag).toBe("shirt-high")
    }
  })

  it("groups public families but retains hidden and individual variations for management", async () => {
    for (const event of [
      listing("parent", 10, 10, [["type", "variable", "digital"]]),
      listing("child", 6, 11, [
        ["type", "variation", "digital"],
        ["a", coordinate("parent")],
        ["spec", "Color", "Red"],
      ]),
      listing("hidden", 2, 12, [["visibility", "private"]]),
    ])
      await cacheSignedProductListingEvent(event)

    const publicRead = await getCachedMerchantStorefront({
      merchantPubkey: merchant,
    })
    expect(publicRead.data.map((record) => record.dTag)).toEqual(["parent"])
    expect(publicRead.data[0]?.family?.children[0]?.dTag).toBe("child")
    expect(publicRead.data[0]?.family?.readEvidence).toMatchObject({
      stale: true,
      degraded: true,
      fetchedAt: clock(),
    })
    const management = await getCachedMerchantStorefront({
      merchantPubkey: merchant,
      includeMarketHidden: true,
      sort: "price_asc",
    })
    expect(management.data.map((record) => record.dTag)).toEqual([
      "hidden",
      "child",
      "parent",
    ])
    expect(management.data.every((record) => record.family === undefined)).toBe(
      true
    )
  })

  it("merges signed live revisions with cached products while exposing partial coverage", async () => {
    await cacheSignedProductListingEvent(listing("retained", 20))
    await cacheSignedProductListingEvent(listing("updated", 30))
    const revision = listing("updated", 5, 11)
    __setCommerceTestOverrides({
      fetchPublicEvents: undefined,
      fetchPublicEventsWithDiagnostics: async (filter) => ({
        events: filter.kinds?.includes(30402) ? [revision] : [],
        attemptedRelayUrls: [
          "wss://one.fixture.test",
          "wss://two.fixture.test",
        ],
        successfulRelayUrls: ["wss://one.fixture.test"],
        failedRelayUrls: ["wss://two.fixture.test"],
        cappedRelayUrls: [],
      }),
    })
    const result = await getMerchantStorefront({
      merchantPubkey: merchant,
      sort: "price_asc",
      deletionFallbackWhenEmpty: false,
    })
    expect(result.data.map((record) => record.dTag)).toEqual([
      "updated",
      "retained",
    ])
    expect(result.data[0]?.eventId).toBe(revision.id)
    expect(result.meta).toMatchObject({
      source: "commerce",
      productReadCoverage: "partial",
      degraded: true,
      capped: false,
    })
  })

  it("retracts a cached and live product deleted while the relay read is pending", async () => {
    const event = listing("retracted")
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
    const read = getMerchantStorefront({ merchantPubkey: merchant })
    await entered.promise
    await cacheSignedProductDeletionEvent(deletion("retracted"))
    release.resolve()
    const result = await read
    expect(result.data).toEqual([])
    expect(
      (await getCachedMerchantStorefront({ merchantPubkey: merchant })).data
    ).toEqual([])
  })

  it("rechecks signed deletions observed while the merged cache write is pending", async () => {
    await cacheSignedProductListingEvent(listing("deleted-during-cache-write"))
    const revision = listing("deleted-during-cache-write", 15, 11)
    const entered = deferred()
    const release = deferred()
    __setCommerceTestOverrides({
      fetchPublicEvents: async (filter) =>
        filter.kinds?.includes(30402) ? [revision] : [],
      putCachedProducts: async (rows) => {
        // The live read and its first deletion frontier have already resolved.
        entered.resolve()
        await release.promise
        await db.products.bulkPut(rows)
      },
    })
    const read = getMerchantStorefront({ merchantPubkey: merchant })
    await entered.promise
    await cacheSignedProductDeletionEvent(
      deletion("deleted-during-cache-write")
    )
    release.resolve()
    const result = await read
    expect(result.data).toEqual([])
    expect(result.meta.productReadCoverage).toBe("complete")
    expect(
      (await getCachedMerchantStorefront({ merchantPubkey: merchant })).data
    ).toEqual([])
  })

  it("resolves an empty degraded fallback when a new deletion accompanies relay failure", async () => {
    await cacheSignedProductListingEvent(listing("deleted-during-failure"))
    const entered = deferred()
    const release = deferred()
    __setCommerceTestOverrides({
      fetchPublicEvents: async () => {
        entered.resolve()
        await release.promise
        throw new Error("Controlled relay failure")
      },
    })
    const read = getMerchantStorefront({ merchantPubkey: merchant })
    await entered.promise
    await cacheSignedProductDeletionEvent(deletion("deleted-during-failure"))
    release.resolve()
    const result = await read
    expect(result.data).toEqual([])
    expect(result.meta).toMatchObject({
      source: "local_cache",
      stale: true,
      degraded: true,
    })
  })

  it("preserves a genuine relay error without cache or new deletion evidence", async () => {
    const failure = new Error("Controlled relay failure without a fallback")
    __setCommerceTestOverrides({
      fetchPublicEvents: async () => {
        throw failure
      },
    })
    await expect(
      getMerchantStorefront({ merchantPubkey: merchant })
    ).rejects.toBe(failure)
  })

  it("does not return cached data after shouldContinue revokes a pending read", async () => {
    await cacheSignedProductListingEvent(listing("cached-before-cancellation"))
    const entered = deferred()
    const release = deferred()
    let active = true
    __setCommerceTestOverrides({
      fetchPublicEvents: async (filter) => {
        if (!filter.kinds?.includes(30402)) return []
        entered.resolve()
        await release.promise
        return []
      },
    })
    const read = getMerchantStorefront({
      merchantPubkey: merchant,
      shouldContinue: () => active,
    })
    await entered.promise
    active = false
    release.resolve()
    await expect(read).rejects.toMatchObject({ code: "authority_changed" })
  })
})
