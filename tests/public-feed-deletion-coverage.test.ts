import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  getPublicKey,
  matchFilter,
  type Filter,
} from "nostr-tools"
import { config } from "../packages/core/src/config"
import { ConduitDB, db } from "../packages/core/src/db"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  getCachedMerchantStorefront,
  getMarketplaceProductsProgressive,
  getMerchantStorefront,
  getProductDetail,
  isCommerceReadIncomplete,
  type CommerceQueryMeta,
} from "../packages/core/src/protocol/commerce"
import { __resetRelayHealth } from "../packages/core/src/protocol/relay-health"
import {
  closePublicRelayConnections,
  type PublicRelayReadSocket,
} from "../packages/core/src/protocol/relay-reader"

const testDb = new ConduitDB(`feed-deletion-coverage-${crypto.randomUUID()}`, {
  indexedDB,
  IDBKeyRange,
})
const originalProducts = db.products
const originalTombstones = db.productTombstones
const originalConfig = { ...config }
const originalSocket = globalThis.WebSocket
const originalFetch = globalThis.fetch
const key = new Uint8Array(32).fill(31)
const author = getPublicKey(key)
const coordinate = (name: string) => `30402:${author}:${name}`
const feed = [
  "wss://one.deletion-feed-fixture.net",
  "wss://two.deletion-feed-fixture.net",
]
const hints = Array.from(
  { length: 105 },
  (_, index) => `wss://old-${index}.deletion-source-fixture.net`
)
function listing(name: string) {
  return finalizeEvent(
    {
      kind: 30402,
      created_at: 10,
      content: "",
      tags: [
        ["d", name],
        ["title", name],
        ["price", "10", "SATS"],
        ["type", "simple", "digital"],
        ["image", "https://images.deletion-feed-fixture.net/synthetic.png"],
      ],
    },
    key
  )
}
const active = listing("active")
const removed = listing("removed")
const deletion = finalizeEvent(
  {
    kind: 5,
    created_at: 20,
    content: "",
    tags: [["a", coordinate("removed")]],
  },
  key
)
type FailureMode = "healthy" | "one" | "all"
let failureMode: FailureMode = "healthy"
let listingsUnavailable = false
let skipDeletionReads = 0
let unexpectedNetwork = 0
let relayListLookups = 0
let restoreTransaction: () => void
const attempted = new Set<string>()
const listingCompleted = new Set<string>()
const deletionFailed = new Set<string>()
const deletionReadCounts = new Map<string, number>()
const deletionCompletedCounts = new Map<string, number>()

class FixtureSocket implements PublicRelayReadSocket {
  readyState = 0
  onopen: PublicRelayReadSocket["onopen"] = null
  onmessage: PublicRelayReadSocket["onmessage"] = null
  onerror: PublicRelayReadSocket["onerror"] = null
  onclose: PublicRelayReadSocket["onclose"] = null
  constructor(readonly url: string) {
    attempted.add(url)
    if (!feed.includes(url)) {
      unexpectedNetwork++
      throw new Error("Unexpected offline feed destination")
    }
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.(new Event("open"))
    })
  }
  send(payload: string) {
    const [type, subscription, ...filters] = JSON.parse(payload) as [
      string,
      string,
      ...Filter[],
    ]
    if (type !== "REQ") return
    const deletionRead = filters.some((filter) => filter.kinds?.includes(5))
    const deletionReadCount = deletionRead
      ? (deletionReadCounts.get(this.url) ?? 0) + 1
      : 0
    if (deletionRead) deletionReadCounts.set(this.url, deletionReadCount)
    const fails =
      (listingsUnavailable &&
        filters.some((filter) => filter.kinds?.includes(30402))) ||
      (deletionRead &&
        deletionReadCount > skipDeletionReads &&
        (failureMode === "all" ||
          (failureMode === "one" && this.url === feed[1])))
    queueMicrotask(() => {
      if (this.readyState !== 1) return
      if (fails) {
        if (deletionRead) deletionFailed.add(this.url)
        this.onmessage?.(
          new MessageEvent("message", {
            data: JSON.stringify([
              "CLOSED",
              subscription,
              "error: synthetic deletion read unavailable",
            ]),
          })
        )
        return
      }
      for (const event of [active, removed]) {
        if (!filters.some((filter) => matchFilter(filter, event))) continue
        this.onmessage?.(
          new MessageEvent("message", {
            data: JSON.stringify(["EVENT", subscription, event]),
          })
        )
      }
      if (filters.some((filter) => filter.kinds?.includes(30402))) {
        listingCompleted.add(this.url)
      }
      if (deletionRead) {
        deletionCompletedCounts.set(
          this.url,
          (deletionCompletedCounts.get(this.url) ?? 0) + 1
        )
      }
      this.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify(["EOSE", subscription]),
        })
      )
    })
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.(new Event("close"))
  }
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
  closePublicRelayConnections()
  __resetRelayHealth()
  __resetCommerceTestOverrides()
  attempted.clear()
  listingCompleted.clear()
  deletionFailed.clear()
  deletionReadCounts.clear()
  deletionCompletedCounts.clear()
  failureMode = "healthy"
  listingsUnavailable = false
  skipDeletionReads = 0
  unexpectedNetwork = 0
  relayListLookups = 0
  await testDb.products.clear()
  await testDb.productTombstones.clear()
  Object.assign(config, {
    e2eRelayIsolationEnabled: false,
    appCommerceRelayUrls: feed,
    commerceDiscoveryRelayUrls: feed,
    appReadRelayUrls: feed,
    appBackplaneRelayUrls: feed.slice(0, 1),
    defaultRelays: feed,
    corePublicFallbackRelayUrls: feed,
  })
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket
  globalThis.fetch = (async () => {
    unexpectedNetwork++
    throw new Error("Real fetch forbidden in deletion coverage fixture")
  }) as typeof fetch
  __setCommerceTestOverrides({
    getRelayLists: async () => {
      relayListLookups++
      return new Map()
    },
  })
  await cacheSignedProductListingEvent(active, { sourceRelayUrls: hints })
  await cacheSignedProductListingEvent(removed, { sourceRelayUrls: hints })
  await cacheSignedProductDeletionEvent(deletion)
})
afterEach(() => {
  closePublicRelayConnections()
  __resetRelayHealth()
  __resetCommerceTestOverrides()
  Object.assign(config, originalConfig)
  globalThis.WebSocket = originalSocket
  globalThis.fetch = originalFetch
  expect(unexpectedNetwork).toBe(0)
})
afterAll(async () => {
  restoreTransaction()
  db.products = originalProducts
  db.productTombstones = originalTombstones
  await testDb.delete()
})

const cases = (["storefront", "detail", "progressive"] as const).flatMap(
  (journey) =>
    (["healthy", "one", "all"] as const).map((mode) => ({ journey, mode }))
)
test.each(cases)(
  "$journey reports $mode deletion coverage after successful configured listings",
  async ({ journey, mode }) => {
    failureMode = mode
    const snapshots: CommerceQueryMeta[] = []
    const result =
      journey === "storefront"
        ? await getMerchantStorefront({
            merchantPubkey: author,
            readScope: "public_feed",
          })
        : journey === "detail"
          ? await getProductDetail({
              productId: coordinate("active"),
              readScope: "public_feed",
            })
          : await getMarketplaceProductsProgressive(
              { merchantPubkey: author },
              (snapshot) => snapshots.push(snapshot.meta)
            )
    const records = Array.isArray(result.data)
      ? result.data
      : result.data
        ? [result.data]
        : []
    expect(records.map((record) => record.dTag)).toEqual(["active"])
    expect(
      (await getCachedMerchantStorefront({ merchantPubkey: author })).data.some(
        (record) => record.dTag === "removed"
      )
    ).toBe(false)
    expect(listingCompleted).toEqual(new Set(feed))
    expect(deletionFailed).toEqual(
      new Set(mode === "all" ? feed : mode === "one" ? feed.slice(1) : [])
    )
    expect(attempted).toEqual(new Set(feed))
    expect(relayListLookups).toBe(0)
    expect(isCommerceReadIncomplete(result.meta)).toBe(mode !== "healthy")
    if (journey === "progressive") {
      expect(snapshots.length).toBeGreaterThan(0)
      expect(isCommerceReadIncomplete(snapshots.at(-1))).toBe(
        mode !== "healthy"
      )
    }
  }
)

test("progressive total outage presents retained-only products as stale cache evidence", async () => {
  failureMode = "all"
  listingsUnavailable = true
  const snapshots: CommerceQueryMeta[] = []
  const result = await getMarketplaceProductsProgressive(
    { merchantPubkey: author },
    (snapshot) => snapshots.push(snapshot.meta)
  )
  expect(result.data.map((record) => record.dTag)).toEqual(["active"])
  expect(listingCompleted.size).toBe(0)
  expect(attempted).toEqual(new Set(feed))
  expect(result.meta).toMatchObject({
    source: "local_cache",
    stale: true,
    degraded: true,
  })
  expect(snapshots.at(-1)).toMatchObject({
    source: "local_cache",
    stale: true,
    degraded: true,
  })
})

test.each([
  { reference: "coordinate", productId: coordinate("active") },
  { reference: "event ID", productId: active.id },
])(
  "detail composes final-only deletion failure for a $reference reference",
  async ({ productId }) => {
    failureMode = "all"
    // Direct product hydration completes its #e and #a deletion reads first.
    // Only the later detail-wide deletion reconciliation is unavailable.
    skipDeletionReads = 2
    const result = await getProductDetail({
      productId,
      readScope: "public_feed",
    })
    expect(result.data?.dTag).toBe("active")
    expect(listingCompleted).toEqual(new Set(feed))
    expect(deletionCompletedCounts).toEqual(
      new Map(feed.map((url) => [url, 2]))
    )
    expect(deletionFailed).toEqual(new Set(feed))
    expect(attempted).toEqual(new Set(feed))
    expect(isCommerceReadIncomplete(result.meta)).toBe(true)
  }
)

test("an empty configured set retains stale negative-aware cache without opening a socket", async () => {
  Object.assign(config, {
    appCommerceRelayUrls: [],
    commerceDiscoveryRelayUrls: [],
  })
  const storefront = await getMerchantStorefront({
    merchantPubkey: author,
    readScope: "public_feed",
  })
  const detail = await getProductDetail({
    productId: coordinate("active"),
    readScope: "public_feed",
  })
  const progressive = await getMarketplaceProductsProgressive(
    { merchantPubkey: author },
    () => {}
  )
  for (const result of [storefront, detail, progressive]) {
    const records = Array.isArray(result.data)
      ? result.data
      : result.data
        ? [result.data]
        : []
    expect(records.map((record) => record.dTag)).toEqual(["active"])
    expect(result.meta).toMatchObject({
      source: "local_cache",
      stale: true,
      degraded: true,
    })
  }
  expect(attempted.size).toBe(0)
  expect(relayListLookups).toBe(0)
})
