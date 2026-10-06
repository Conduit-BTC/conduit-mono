import { attachEventSourceRelayUrl } from "../packages/core/src/protocol/relay-reader"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { matchFilter, type Filter } from "nostr-tools"
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  applyE2eRelayIsolation,
  cacheSignedProductDeletionEvent,
  config,
  getMarketplaceBrowsePage,
  getMarketplaceCatalogMetadata,
  type CachedProduct,
  type CachedProductTombstone,
} from "@conduit/core"

const timestamp = 1700000000
const keys = Array.from({ length: 32 }, (_, index) =>
  new Uint8Array(32).fill(index + 1)
)
const authors = keys.map(getPublicKey)
function product(
  index: number,
  id: number,
  createdAt = timestamp - id,
  tags = ["art"],
  extra: string[][] = []
) {
  return finalizeEvent(
    {
      kind: 30402,
      created_at: createdAt,
      content: "Fixture",
      tags: [
        ["d", `product-${id}`],
        ["title", `Product ${index} ${id}`],
        ["price", String(id + 1), "SATS"],
        ["type", "simple", "digital"],
        ["stock", "10"],
        ["image", "https://blossom.conduit.market/fixture.png"],
        ...tags.map((tag) => ["t", tag]),
        ...extra,
      ],
    },
    keys[index]
  )
}
let events: Event[]
let requests: Filter[]
let rows: CachedProduct[]
let tombstones: CachedProductTombstone[]
const originalConfig = structuredClone(config)
beforeEach(() => {
  __resetCommerceTestOverrides()
  Object.assign(config, applyE2eRelayIsolation(config, ["ws://127.0.0.1:7777"]))
  events = authors.flatMap((_, index) =>
    Array.from({ length: 24 }, (_, id) => product(index, id))
  )
  requests = []
  rows = []
  tombstones = []
  __setCommerceTestOverrides({
    now: () => timestamp * 1000,
    getCachedProducts: async (_, selected) =>
      rows.filter((row) => !selected || selected.includes(row.pubkey)),
    putCachedProducts: async (incoming) => {
      for (const row of incoming)
        rows = [...rows.filter((prior) => prior.id !== row.id), row]
    },
    getCachedProductTombstones: async () => tombstones,
    putCachedProductTombstones: async (incoming) => {
      tombstones.push(...incoming)
    },
    fetchPublicEvents: async (filter) => {
      requests.push(filter)
      return events
        .filter((event) => matchFilter(filter, event))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .slice(0, filter.limit) as never
    },
  })
})
afterEach(() => {
  __resetCommerceTestOverrides()
  Object.assign(config, originalConfig)
})

describe("bounded marketplace pages", () => {
  it("reads a diverse bounded first selection and continues across merchants without recency restrictions", async () => {
    const first = await getMarketplaceBrowsePage({
      mode: "discover",
      authorPubkeys: authors,
    })
    expect(first.data.length).toBe(48)
    expect(
      new Set(first.data.map((record) => record.product.pubkey)).size
    ).toBe(12)
    const candidates = requests.filter((filter) =>
      filter.kinds?.includes(30402)
    )
    expect(candidates).toHaveLength(12)
    expect(
      candidates.every(
        (filter) =>
          filter.limit === 8 &&
          filter.authors?.length === 1 &&
          filter.since === undefined
      )
    ).toBe(true)
    const next = await getMarketplaceBrowsePage({
      mode: "discover",
      authorPubkeys: authors,
      pageCursor: first.nextCursor,
    })
    expect(
      next.data.some((record) =>
        first.data.some((prior) => prior.addressId === record.addressId)
      )
    ).toBe(false)
    expect(first.meta.capped).toBe(true)
  })
  it("category scope reaches an old product from an author outside Discover and preserves full selector metadata", async () => {
    const old = product(31, 90, timestamp - 365 * 86400, ["rare"])
    events.push(old)
    await getMarketplaceBrowsePage({ mode: "discover", authorPubkeys: authors })
    const scoped = await getMarketplaceBrowsePage({
      mode: "recent",
      authorPubkeys: authors,
      tags: ["rare"],
    })
    expect(scoped.data.map((record) => record.eventId)).toEqual([old.id])
    const filter = requests.findLast((filter) =>
      filter["#t"]?.includes("rare")
    )!
    expect(filter.authors).toHaveLength(32)
    expect(filter.since).toBeUndefined()
    const metadata = await getMarketplaceCatalogMetadata(authors)
    expect(Object.keys(metadata.merchants)).toHaveLength(32)
    expect(metadata.categories.rare).toBe(1)
  })
  it("uses revision activity for recent browsing and includes old listings only when explicitly requested", async () => {
    events = [product(0, 0), product(1, 1, timestamp - 60 * 86400)]
    const recent = await getMarketplaceBrowsePage({
      mode: "recent",
      authorPubkeys: authors,
    })
    expect(recent.data).toHaveLength(1)
    expect(
      (
        await getMarketplaceBrowsePage({
          mode: "discover",
          authorPubkeys: authors,
        })
      ).data
    ).toHaveLength(2)
    const older = await getMarketplaceBrowsePage({
      mode: "recent",
      includeOlder: true,
      authorPubkeys: authors,
    })
    expect(older.data).toHaveLength(2)
  })
  it("retains stronger cached revisions and known signed deletions after relay omission", async () => {
    events = [product(0, 0, timestamp - 100)]
    await getMarketplaceBrowsePage({ mode: "all", authorPubkeys: [authors[0]] })
    const revised = product(0, 0, timestamp)
    events = [revised]
    await getMarketplaceBrowsePage({ mode: "all", authorPubkeys: [authors[0]] })
    events = [product(0, 0, timestamp - 100)]
    expect(
      (
        await getMarketplaceBrowsePage({
          mode: "all",
          authorPubkeys: [authors[0]],
        })
      ).data[0]?.eventId
    ).toBe(revised.id)
    await cacheSignedProductDeletionEvent(
      finalizeEvent(
        {
          kind: 5,
          created_at: timestamp + 1,
          content: "",
          tags: [["a", `30402:${authors[0]}:product-0`]],
        },
        keys[0]
      )
    )
    expect(
      (
        await getMarketplaceBrowsePage({
          mode: "all",
          authorPubkeys: [authors[0]],
        })
      ).data
    ).toHaveLength(0)
  })
  it("prepares signed variation families through the shared exact reader", async () => {
    const root = product(
      0,
      80,
      timestamp,
      ["art"],
      [["spec", "Size", "S", "M"]]
    )
    const child = product(
      0,
      81,
      timestamp,
      ["art"],
      [
        ["a", `30402:${authors[0]}:product-80`],
        ["spec", "Size", "S"],
      ]
    )
    events = [root, child].map((event, index) =>
      finalizeEvent(
        {
          kind: event.kind,
          created_at: event.created_at,
          content: event.content,
          tags: event.tags.map((tag) =>
            tag[0] === "type"
              ? ["type", index === 0 ? "variable" : "variation", "digital"]
              : tag
          ),
        },
        keys[0]
      )
    )
    const page = await getMarketplaceBrowsePage({
      mode: "discover",
      authorPubkeys: [authors[0]],
    })
    expect(page.data).toHaveLength(1)
    expect(page.data[0]?.family?.children).toHaveLength(1)
    expect(page.data[0]?.family?.children[0]?.product.parentProductId).toBe(
      `30402:${authors[0]}:product-80`
    )
  })
  it("caps sparse multi-merchant selections at 96 while keeping every read merchant represented", async () => {
    events = authors.flatMap((_, index) =>
      Array.from({ length: 6 }, (_, id) => product(index, id))
    )
    const page = await getMarketplaceBrowsePage({
      mode: "discover",
      authorPubkeys: authors,
    })
    expect(page.data).toHaveLength(96)
    expect(new Set(page.data.map((row) => row.product.pubkey)).size).toBe(24)
    expect(
      requests.filter((filter) => filter.kinds?.includes(30402))
    ).toHaveLength(24)
  })
  it("continues beyond deleted candidates using the signed publication window", async () => {
    events = Array.from({ length: 100 }, (_, id) => product(0, id))
    await cacheSignedProductDeletionEvent(
      finalizeEvent(
        {
          kind: 5,
          created_at: timestamp + 1,
          content: "",
          tags: Array.from({ length: 90 }, (_, id) => [
            "a",
            `30402:${authors[0]}:product-${id}`,
          ]),
        },
        keys[0]
      )
    )
    const first = await getMarketplaceBrowsePage({
      mode: "all",
      authorPubkeys: [authors[0]],
    })
    expect(first.data).toHaveLength(6)
    expect(first.candidateCount).toBe(96)
    expect(first.nextCursor?.until).toBe(timestamp - 95)
    const next = await getMarketplaceBrowsePage({
      mode: "all",
      authorPubkeys: [authors[0]],
      pageCursor: first.nextCursor,
    })
    expect(
      next.data.some(
        (row) => row.addressId === `30402:${authors[0]}:product-99`
      )
    ).toBe(true)
  })
  it("does not skip a dense relay's window when another relay returns much older listings", async () => {
    const dense = Array.from({ length: 200 }, (_, id) => product(0, id))
    const sparse = Array.from({ length: 96 }, (_, id) =>
      product(1, id, timestamp - 1000 - id)
    )
    __setCommerceTestOverrides({
      fetchSignedEventsFanoutDetailed: async (filter) => {
        if (!filter.kinds?.includes(30402))
          return {
            events: [],
            relays: [
              {
                relayUrl: "wss://dense.example",
                status: "success",
                eventCount: 0,
              },
            ],
          } as never
        const batches = [dense, sparse].map((rows, index) => {
          const relayUrl =
            index === 0 ? "wss://dense.example" : "wss://sparse.example"
          const selected = rows
            .filter((event) => matchFilter(filter, event))
            .slice(0, filter.limit)
          for (const event of selected)
            attachEventSourceRelayUrl(event as never, relayUrl)
          return { selected, relayUrl }
        })
        return {
          events: batches.flatMap((batch) => batch.selected),
          relays: batches.map((batch) => ({
            relayUrl: batch.relayUrl,
            status: "success",
            eventCount: batch.selected.length,
          })),
        } as never
      },
    })
    const first = await getMarketplaceBrowsePage({
      mode: "all",
      authorPubkeys: authors,
    })
    expect(first.nextCursor?.until).toBe(timestamp - 95)
    const next = await getMarketplaceBrowsePage({
      mode: "all",
      authorPubkeys: authors,
      pageCursor: first.nextCursor,
    })
    expect(
      next.data.some(
        (row) => row.addressId === `30402:${authors[0]}:product-96`
      )
    ).toBe(true)
    expect(next.nextCursor?.until).toBe(timestamp - 190)
  })
  it("does not silently skip saturated timestamp ties", async () => {
    events = Array.from({ length: 400 }, (_, id) => product(0, id, timestamp))
    let page = await getMarketplaceBrowsePage({
      mode: "all",
      authorPubkeys: [authors[0]],
    })
    for (let round = 0; round < 5 && page.nextCursor; round++)
      page = await getMarketplaceBrowsePage({
        mode: "all",
        authorPubkeys: [authors[0]],
        pageCursor: page.nextCursor,
      })
    expect(page.boundaryBlocked).toBe(true)
    expect(page.nextCursor).toBeUndefined()
    expect(
      requests
        .filter((filter) => filter.kinds?.includes(30402))
        .every(
          (filter) => filter.until === undefined || filter.until === timestamp
        )
    ).toBe(true)
  })
  it("cancels before reading when account authority changes", async () => {
    await expect(
      getMarketplaceBrowsePage({
        mode: "discover",
        authorPubkeys: authors,
        shouldContinue: () => false,
      })
    ).rejects.toThrow("authority_changed")
    expect(requests).toHaveLength(0)
    const controller = new AbortController()
    controller.abort()
    await expect(
      getMarketplaceBrowsePage({
        mode: "all",
        authorPubkeys: authors,
        signal: controller.signal,
      })
    ).rejects.toThrow()
    expect(requests).toHaveLength(0)
  })
})
