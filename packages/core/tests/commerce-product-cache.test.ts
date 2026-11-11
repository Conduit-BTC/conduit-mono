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
import { admitPublicEvent } from "../src/protocol/verified-public-event"
import {
  ConduitDB,
  db,
  type CachedProduct,
  type CachedProductTombstone,
} from "../src/db"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  cacheSignedProductListingEvent,
  cacheSignedProductDeletionEvent,
  getLocalProductDeletionSnapshot,
  subscribeLocalProductRevisionChanges,
} from "../src/protocol/commerce"
import {
  __setProductCacheTestOverrides,
  getCachedProductRecords,
  getCachedExactProductRecords,
  retainObservedProductDeletions,
} from "../src/protocol/commerce-product-cache"

const testDb = new ConduitDB(`product-cache-${crypto.randomUUID()}`, {
  indexedDB,
  IDBKeyRange,
})
const originalProducts = db.products
const originalTombstones = db.productTombstones
let restoreTransaction: () => void
const fixtureKey = new Uint8Array(32).fill(1)
const author = getPublicKey(fixtureKey)
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
let networkAttempts = 0
const clock = () => 123_456
const coordinate = (name: string) => `30402:${author}:${name}`

function listing(name: string, createdAt = 10, extraTags: string[][] = []) {
  const defaultTags = [
    ["d", name],
    ["title", name],
    ["price", "10", "SATS"],
    ["type", "simple", "digital"],
    ["image", "https://images.unsplash.com/product.png"],
  ]
  return finalizeEvent(
    {
      kind: 30402,
      created_at: createdAt,
      content: "",
      tags: [
        ...defaultTags.filter(
          (tag) => !extraTags.some((extra) => extra[0] === tag[0])
        ),
        ...extraTags,
      ],
    },
    fixtureKey
  )
}

function deletion(name: string, createdAt: number) {
  return finalizeEvent(
    {
      kind: 5,
      created_at: createdAt,
      content: "",
      tags: [["a", coordinate(name)]],
    },
    fixtureKey
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeAll(async () => {
  globalThis.fetch = (async () => {
    networkAttempts++
    throw new Error("External fetch forbidden in product-cache tests")
  }) as typeof fetch
  globalThis.WebSocket = class {
    constructor() {
      networkAttempts++
      throw new Error("External WebSocket forbidden in product-cache tests")
    }
  } as unknown as typeof WebSocket
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
  __setCommerceTestOverrides({ now: clock })
})
afterEach(() => {
  expect(networkAttempts).toBe(0)
  __resetCommerceTestOverrides()
})
afterAll(async () => {
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  restoreTransaction()
  db.products = originalProducts
  db.productTombstones = originalTombstones
  await testDb.delete()
})

describe("commerce product cache owner", () => {
  it("round-trips signed listings through Dexie and preserves merged facade overrides", async () => {
    const event = listing("roundtrip")
    await cacheSignedProductListingEvent(event)
    // A later non-cache override must not discard the cache's previous clock.
    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: false,
    })
    const [record] = await getCachedProductRecords(author)
    const stored = await db.products.get(coordinate("roundtrip"))
    expect(record?.eventId).toBe(event.id)
    expect(record?.product.title).toBe("roundtrip")
    expect(record?.product.signedProductEvent?.id).toBe(event.id)
    expect(stored?.cachedAt).toBe(clock())
    const stale = { ...stored!, cachedAt: 0 }
    __setCommerceTestOverrides({
      getCachedProducts: async () => [stale],
      now: () => 24 * 60 * 60_000,
    })
    expect(await getCachedProductRecords(author)).toEqual([])
    expect(
      (await getCachedProductRecords(author, { includeStale: true }))[0]
        ?.eventId
    ).toBe(event.id)
    // Direct owner fixtures follow the same incremental override convention.
    __setProductCacheTestOverrides({
      getCachedProducts: async () => [stale],
      now: clock,
    })
    __setProductCacheTestOverrides({ now: () => 24 * 60 * 60_000 })
    expect(await getCachedProductRecords(author)).toEqual([])
  })

  it("retains the stronger stored revision while merging delivery provenance", async () => {
    const newest = listing("revision", 12)
    const older = listing("revision", 11)
    await cacheSignedProductListingEvent(newest, {
      sourceRelayUrls: ["wss://one.conduit.market"],
    })
    await cacheSignedProductListingEvent(older, {
      sourceRelayUrls: ["wss://two.conduit.market"],
    })
    const [record] = await getCachedProductRecords(author)
    expect(record?.eventId).toBe(newest.id)
    expect(record?.sourceRelayUrls).toEqual([
      "wss://one.conduit.market",
      "wss://two.conduit.market",
    ])
    expect((await db.products.get(coordinate("revision")))?.eventId).toBe(
      newest.id
    )
  })

  it("retains failed-save revision observations and stops delivery after unsubscribe", async () => {
    const event = listing("failed-save")
    let saved: CachedProduct[] = []
    let unavailable = true
    __setCommerceTestOverrides({
      getCachedProducts: async () => saved,
      putCachedProducts: async (rows) => {
        if (unavailable) throw new Error("Controlled local persistence failure")
        saved = rows
      },
    })
    const ready = deferred<void>()
    const observations: Array<{ status: string; eventIds: string[] }> = []
    const stop = subscribeLocalProductRevisionChanges(
      [coordinate("failed-save")],
      (snapshot) => {
        observations.push({
          status: snapshot.status,
          eventIds: snapshot.records.map((record) => record.eventId),
        })
        if (snapshot.status === "ready") ready.resolve()
      }
    )
    await ready.promise
    await expect(cacheSignedProductListingEvent(event)).rejects.toThrow(
      "Controlled local persistence failure"
    )
    expect(observations.at(-1)?.eventIds).toEqual([event.id])
    unavailable = false
    await cacheSignedProductListingEvent(event)
    expect(saved[0]?.eventId).toBe(event.id)
    stop()
    const count = observations.length
    await cacheSignedProductListingEvent(listing("failed-save", 11))
    expect(observations).toHaveLength(count)
  })

  it("keeps locally observed deletions effective while persistence fails, then flushes them", async () => {
    await cacheSignedProductListingEvent(listing("deleted"))
    __setCommerceTestOverrides({
      putCachedProductTombstones: async () => {
        throw new Error("Controlled tombstone persistence failure")
      },
    })
    await expect(
      cacheSignedProductDeletionEvent(deletion("deleted", 11))
    ).rejects.toThrow("Controlled tombstone persistence failure")
    expect(await getCachedProductRecords(author)).toEqual([])
    expect(getLocalProductDeletionSnapshot().evidence).toHaveLength(1)
    expect(await db.productTombstones.count()).toBe(0)
    __setCommerceTestOverrides({ putCachedProductTombstones: undefined })
    await retainObservedProductDeletions([], [author])
    expect(await db.productTombstones.count()).toBe(1)
    expect(await getCachedProductRecords(author)).toEqual([])
  })

  it("does not clear a newer tombstone observed while an earlier write is pending", async () => {
    await cacheSignedProductListingEvent(listing("concurrent"))
    const earlier = await admitPublicEvent(deletion("concurrent", 11))
    const newer = await admitPublicEvent(deletion("concurrent", 12))
    if (earlier.status !== "verified" || newer.status !== "verified") {
      throw new Error("Ordinary signed deletion fixtures must be admitted")
    }
    const entered = deferred<void>()
    const release = deferred<void>()
    let writes = 0
    __setCommerceTestOverrides({
      putCachedProductTombstones: async (rows) => {
        if (++writes === 1) {
          entered.resolve()
          await release.promise
          await db.productTombstones.bulkPut(rows)
        } else throw new Error("Controlled newer-write failure")
      },
    })
    const first = cacheSignedProductDeletionEvent(earlier.event)
    await entered.promise
    await expect(cacheSignedProductDeletionEvent(newer.event)).rejects.toThrow(
      "Controlled newer-write failure"
    )
    release.resolve()
    await first
    __setCommerceTestOverrides({ putCachedProductTombstones: undefined })
    await retainObservedProductDeletions([], [author])
    const stored: CachedProductTombstone | undefined =
      await db.productTombstones.get(`a:${coordinate("concurrent")}`)
    expect(stored?.deletionEventId).toBe(newer.event.id)
    expect(getLocalProductDeletionSnapshot().evidence[0]?.deletionEventId).toBe(
      newer.event.id
    )
  })

  it("reads only exact targets and their same-author family context", async () => {
    await cacheSignedProductListingEvent(
      listing("parent", 10, [["type", "variable", "digital"]])
    )
    await cacheSignedProductListingEvent(
      listing("child", 10, [
        ["type", "variation", "digital"],
        ["a", coordinate("parent")],
        ["spec", "Color", "Red"],
      ])
    )
    await cacheSignedProductListingEvent(listing("unrelated"))
    const scan = spyOn(db.products, "toArray").mockImplementation(async () => {
      throw new Error("Exact reads must not scan the whole product table")
    })
    try {
      const records = await getCachedExactProductRecords([coordinate("parent")])
      expect(records.map((record) => record.addressId).sort()).toEqual(
        [coordinate("parent"), coordinate("child")].sort()
      )
      expect(
        records.every(
          (record) => record.product.signedProductEvent?.id === record.eventId
        )
      ).toBe(true)
    } finally {
      scan.mockRestore()
    }
  })
})

describe("exact cached signed admission", () => {
  it("rebuilds projected terms and frontiers from the selected signed bytes", async () => {
    const event = listing("signed-frontier", 12)
    await cacheSignedProductListingEvent(event)
    await db.products.update(coordinate("signed-frontier"), {
      title: "Untrusted projection",
      price: 999,
      eventId: "f".repeat(64),
      eventCreatedAt: 999,
    })
    const [record] = await getCachedExactProductRecords([
      coordinate("signed-frontier"),
    ])
    expect(record?.eventId).toBe(event.id)
    expect(record?.eventCreatedAt).toBe(12)
    expect(record?.product.title).toBe("signed-frontier")
    expect(record?.product.price).toBe(10)
    expect(record?.product.signedProductEvent?.id).toBe(event.id)
  })

  it("rejects invalid signatures and signed bytes belonging to another coordinate", async () => {
    const event = listing("bound-row")
    const wrongCoordinate = listing("different-row")
    for (const replacement of [
      { ...event, sig: "0".repeat(128) },
      wrongCoordinate,
    ]) {
      await cacheSignedProductListingEvent(event)
      await db.products.update(coordinate("bound-row"), {
        signedProductEvent: replacement,
      })
      expect(
        await getCachedExactProductRecords([coordinate("bound-row")])
      ).toEqual([])
      await db.products.clear()
    }
  })
})
