import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  __setCommerceTestOverrides,
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  buildEventMarketPickupDraft,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  getCachedProductsByIds,
  resolveEventMarketEvidence,
  type CachedProduct,
  type CachedEventMarketEvidence,
  type CachedProductTombstone,
} from "@conduit/core"
import { eventCatalogQueryOptions } from "../src/lib/event-catalog-query"
import {
  projectRawEventCatalog,
  type RawEventCatalog,
} from "../src/lib/event-market-adapter"

async function settleObserver() {
  // Query observer notifications and local persistence observation are queued.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const scope = {
  relayScope: "local-deletion-regression",
  authenticatedPubkey: null,
  authGeneration: 0,
}

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetEventMarketTestOverrides()
})

async function fixture() {
  const nowMs = Date.now()
  const createdAt = Math.floor(nowMs / 1000) - 1000
  const organizerKey = generateSecretKey()
  const merchantKey = generateSecretKey()
  const organizer = getPublicKey(organizerKey)
  const merchant = getPublicKey(merchantKey)
  const collection = `30405:${organizer}:market`
  const calendar = `31923:${organizer}:calendar`
  const pickup = `30406:${organizer}:pickup`
  const products = ["coffee", "tea"].map((name) => `30402:${merchant}:${name}`)
  const sign = (draft: { kind: number; content: string; tags: string[][] }) =>
    finalizeEvent({ ...draft, created_at: createdAt }, organizerKey)
  const graph = [
    sign(
      buildEventMarketCalendarDraft({
        kind: 31923,
        dTag: "calendar",
        title: "Public market",
        start: createdAt,
        end: createdAt + 86400,
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
        productCoordinates: products,
      })
    ),
  ]
  const listings = ["coffee", "tea"].map((name) =>
    finalizeEvent(
      {
        kind: 30402,
        content: `Public ${name} description`,
        created_at: createdAt,
        tags: [
          ["d", name],
          ["title", name],
          ["price", "1000", "SATS"],
          ["type", "simple", "physical"],
          ["visibility", "public"],
          ["stock", "5"],
          ["image", "https://cdn.conduit.market/conduit-test/product.png"],
          ["a", collection],
          ["shipping_option", pickup],
        ],
      },
      merchantKey
    )
  )
  let cachedProducts: CachedProduct[] = []
  let tombstones: CachedProductTombstone[] = []
  let relayReads = 0
  __setCommerceTestOverrides({
    now: () => nowMs,
    getRelayLists: async () => new Map(),
    fetchEventsFanout: async () => {
      relayReads++
      return []
    },
    getCachedProducts: async (merchantPubkey, authors) =>
      cachedProducts.filter(
        (row) =>
          (!merchantPubkey || row.pubkey === merchantPubkey) &&
          (!authors || authors.includes(row.pubkey))
      ),
    putCachedProducts: async (rows) => {
      for (const row of rows)
        cachedProducts = [
          ...cachedProducts.filter((old) => old.id !== row.id),
          row,
        ]
    },
    getCachedProductTombstones: async (merchantPubkey, authors) =>
      tombstones.filter(
        (row) =>
          (!merchantPubkey || row.pubkey === merchantPubkey) &&
          (!authors || authors.includes(row.pubkey))
      ),
    putCachedProductTombstones: async (rows) => {
      for (const row of rows)
        tombstones = [...tombstones.filter((old) => old.id !== row.id), row]
    },
  })
  for (const listing of listings)
    await cacheSignedProductListingEvent(new NDKEvent(undefined, listing))
  const batch = await getCachedProductsByIds(products, {
    includeStale: true,
    includeMarketHidden: true,
  })
  expect(batch.data).toHaveLength(2)
  const raw: RawEventCatalog = {
    reference: collection,
    resolution: resolveEventMarketEvidence({
      reference: collection,
      events: graph,
      productRequestEvents: listings,
      nowMs,
    }),
    result: {
      ...batch,
      diagnostics: products.map((productId) => ({
        productId,
        addressId: productId,
        issue: null,
        coverage: { listing: "complete", deletion: "complete" },
      })),
    },
    complete: true,
    resolutionComplete: true,
  }
  expect(projectRawEventCatalog(raw).products).toHaveLength(2)
  return {
    collection,
    products,
    raw,
    organizer,
    reviseGraph(kind: number) {
      const original =
        kind === 30402
          ? listings[0]!
          : graph.find((event) => event.kind === kind)!
      const tags =
        kind === 30402
          ? original.tags.filter(
              (tag) => tag[0] !== "a" && tag[0] !== "shipping_option"
            )
          : original.tags
      return finalizeEvent(
        { kind, content: original.content, tags, created_at: createdAt + 1 },
        kind === 30402 ? merchantKey : organizerKey
      )
    },
    relayReads: () => relayReads,
    async reviseCoffee(mode: string, version = 1) {
      const original = listings[0]!
      const tags = original.tags.filter((tag) =>
        mode === "withdrawal"
          ? !["a", "shipping_option"].includes(tag[0]!)
          : tag[0] !== mode
      )
      if (mode === "stock") tags.push(["stock", "0"])
      if (mode === "price") tags.push(["price", "2000", "SATS"])
      if (mode === "type") tags.push(["type", "variable", "physical"])
      await cacheSignedProductListingEvent(
        new NDKEvent(
          undefined,
          finalizeEvent(
            {
              kind: 30402,
              content: original.content,
              tags,
              created_at: createdAt + version,
            },
            merchantKey
          )
        )
      )
      return getCachedProductsByIds(products, {
        includeStale: true,
        includeMarketHidden: true,
      })
    },
    async deleteCoffee() {
      await cacheSignedProductDeletionEvent(
        new NDKEvent(
          undefined,
          finalizeEvent(
            {
              kind: 5,
              content: "",
              created_at: createdAt + 1,
              tags: [
                ["a", products[0]!],
                ["k", "30402"],
              ],
            },
            merchantKey
          )
        )
      )
      expect(tombstones).toHaveLength(1)
      const cached = await getCachedProductsByIds(products, {
        includeStale: true,
        includeMarketHidden: true,
      })
      expect(cached.data.map((record) => record.addressId)).toEqual([
        products[1]!,
      ])
    },
  }
}

describe("event catalog local signed revisions", () => {
  for (const mounted of [true, false]) {
    for (const mode of ["withdrawal", "stock", "price", "type"]) {
      it(`${mode} mounted=${mounted}`, async () => {
        const f = await fixture()
        const client = new QueryClient()
        let reads = 0
        const options = eventCatalogQueryOptions(
          client,
          f.collection,
          scope,
          () => true,
          async () => {
            reads++
            return f.raw
          }
        )
        const observer = new QueryObserver(client, options)
        let stop = observer.subscribe(() => {})
        try {
          await client.fetchQuery(options)
          const before = observer.getCurrentResult()
          if (!mounted) stop()
          const fresh = await f.reviseCoffee(mode)
          if (!mounted) stop = observer.subscribe(() => {})
          await settleObserver()
          const after = observer.getCurrentResult()
          const current = fresh.data.find(
            (record) => record.addressId === f.products[0]
          )!
          const projected = projectRawEventCatalog(after.data!)
          const updated = projected.products.find(
            (entry) => entry.product.id === f.products[0]
          )
          const tea = projected.products.find(
            (entry) => entry.product.id === f.products[1]
          )!
          expect(reads).toBe(1)
          expect(f.relayReads()).toBe(0)
          expect(after.dataUpdatedAt).toBe(before.dataUpdatedAt)
          expect(tea.pickupFulfillment).not.toBeNull()
          if (mode === "withdrawal" || mode === "type") {
            expect(updated?.pickupFulfillment ?? null).toBeNull()
            if (mode === "withdrawal") expect(updated).toBeUndefined()
          } else {
            expect(updated!.product.createdAt).toBe(current.product.createdAt)
            expect(updated!.product.stock).toBe(current.product.stock)
            expect(updated!.product.price).toBe(current.product.price)
            expect(updated!.pickupFulfillment).toBeNull()
          }
        } finally {
          stop()
          client.clear()
        }
      })
    }
  }
})

describe("catalog coherence across evidence sources", () => {
  for (const mounted of [true, false]) {
    for (const kind of [30402, 30405, 30406, 31923]) {
      it(`revokes affected authority from separate graph storage kind=${kind} mounted=${mounted}`, async () => {
        const f = await fixture()
        let deliver!: (rows: CachedEventMarketEvidence[]) => void
        __setEventMarketTestOverrides({
          observeCachedEvidence: (_organizer, observer) => {
            deliver = observer.next
            observer.next([])
            return { unsubscribe() {} }
          },
        })
        const client = new QueryClient()
        let reads = 0
        const options = eventCatalogQueryOptions(
          client,
          f.collection,
          scope,
          () => true,
          async () => {
            reads++
            return f.raw
          }
        )
        const observer = new QueryObserver(client, options)
        let stop = observer.subscribe(() => {})
        try {
          await client.fetchQuery(options)
          const before = observer.getCurrentResult()
          expect(
            projectRawEventCatalog(before.data!).products.every(
              (entry) => !!entry.pickupFulfillment
            )
          ).toBe(true)
          if (!mounted) stop()
          const signedEvent = f.reviseGraph(kind)
          deliver([
            {
              id: signedEvent.id,
              organizerPubkey: f.organizer,
              kind,
              signedEvent,
              sourceRelayUrls: [],
              cachedAt: Date.now(),
            },
          ])
          if (!mounted) stop = observer.subscribe(() => {})
          await settleObserver()
          const after = observer.getCurrentResult()
          const catalog = projectRawEventCatalog(after.data!)
          expect(
            catalog.products.find((entry) => entry.product.id === f.products[0])
              ?.pickupFulfillment ?? null
          ).toBeNull()
          if (kind === 30402)
            expect(
              catalog.products.find(
                (entry) => entry.product.id === f.products[1]
              )!.pickupFulfillment
            ).not.toBeNull()
          expect(after.dataUpdatedAt).toBe(before.dataUpdatedAt)
          // A delayed older network snapshot must observe the same guard.
          client.setQueryData(options.queryKey, f.raw)
          expect(
            projectRawEventCatalog(
              observer.getCurrentResult().data!
            ).products.find((entry) => entry.product.id === f.products[0])
              ?.pickupFulfillment ?? null
          ).toBeNull()
          expect(reads).toBe(1)
          expect(f.relayReads()).toBe(0)
        } finally {
          stop()
          client.clear()
        }
      })
    }
  }

  it("reconciles late progress and completion, then permits a freshly verified newer revision", async () => {
    const f = await fixture()
    const client = new QueryClient()
    let finish!: (raw: RawEventCatalog) => void
    let emit: ((raw: RawEventCatalog) => void) | undefined
    let reads = 0
    let latest = f.raw
    const options = eventCatalogQueryOptions(
      client,
      f.collection,
      scope,
      () => true,
      async (_reference, readOptions) => {
        if (++reads !== 2) return latest
        emit = readOptions?.onProgress
        return new Promise<RawEventCatalog>((resolve) => {
          finish = resolve
        })
      }
    )
    const observer = new QueryObserver(client, options)
    const stop = observer.subscribe(() => {})
    try {
      await client.fetchQuery(options)
      const refresh = observer.refetch()
      await f.reviseCoffee("withdrawal")
      const assertWithdrawn = () =>
        expect(
          projectRawEventCatalog(
            observer.getCurrentResult().data!
          ).products.map((entry) => entry.product.id)
        ).toEqual([f.products[1]!])
      assertWithdrawn()
      emit?.(f.raw)
      assertWithdrawn()
      finish(f.raw)
      await refresh
      assertWithdrawn()
      const restored = await f.reviseCoffee("price", 2)
      latest = {
        ...f.raw,
        result: { ...restored, diagnostics: f.raw.result!.diagnostics },
      }
      await observer.refetch()
      const coffee = projectRawEventCatalog(
        observer.getCurrentResult().data!
      ).products.find((entry) => entry.product.id === f.products[0])!
      expect(coffee.product.price).toBe(2000)
      expect(coffee.pickupFulfillment).not.toBeNull()
      expect(reads).toBe(3)
    } finally {
      stop()
      client.clear()
    }
  })
})

it("waits for its existing local observation before exposing completed authority", async () => {
  const f = await fixture()
  let finish!: (rows: CachedProduct[]) => void
  const pending = new Promise<CachedProduct[]>((resolve) => {
    finish = resolve
  })
  let localReads = 0
  __setCommerceTestOverrides({
    getCachedProducts: async () => {
      localReads++
      return pending
    },
  })
  const client = new QueryClient()
  const options = eventCatalogQueryOptions(
    client,
    f.collection,
    scope,
    () => true,
    async () => f.raw
  )
  let completed = false
  const reading = client.fetchQuery(options).then((raw) => {
    completed = true
    return raw
  })
  try {
    await settleObserver()
    expect(completed).toBe(false)
    expect(localReads).toBe(1)
    finish([])
    const raw = await reading
    expect(
      projectRawEventCatalog(raw).products.every(
        (entry) => !!entry.pickupFulfillment
      )
    ).toBe(true)
    expect(localReads).toBe(1)
  } finally {
    finish([])
    await reading
    client.clear()
  }
})

it("does not reopen local observations when a removed query's loader completes late", async () => {
  const f = await fixture()
  let starts = 0
  __setEventMarketTestOverrides({
    observeCachedEvidence: (_organizer, observer) => {
      starts++
      observer.next([])
      return { unsubscribe() {} }
    },
  })
  let finish!: (raw: RawEventCatalog) => void
  const client = new QueryClient()
  const options = eventCatalogQueryOptions(
    client,
    f.collection,
    scope,
    () => true,
    async () =>
      new Promise<RawEventCatalog>((resolve) => {
        finish = resolve
      })
  )
  const reading = client.fetchQuery(options).catch(() => undefined)
  client.removeQueries({ queryKey: options.queryKey })
  finish(f.raw)
  await reading
  await settleObserver()
  expect(client.getQueryCache().getAll()).toHaveLength(0)
  expect(starts).toBe(0)
  client.clear()
})
