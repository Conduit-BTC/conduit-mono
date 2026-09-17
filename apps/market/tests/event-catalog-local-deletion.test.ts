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
  __setCommerceTestOverrides,
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  buildEventMarketPickupDraft,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  getCachedProductsByIds,
  resolveEventMarketEvidence,
  type CachedProduct,
  type CachedProductTombstone,
} from "@conduit/core"
import { eventCatalogQueryOptions } from "../src/lib/event-catalog-query"
import { getEventCatalogQueryDisplayState } from "../src/lib/event-catalog-query-state"
import {
  projectRawEventCatalog,
  type RawEventCatalog,
} from "../src/lib/event-market-adapter"
import { getEventCatalogCartAction } from "../src/lib/event-market-cart-action"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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
    relayReads: () => relayReads,
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

function expectTeaActionable(
  query: Parameters<typeof getEventCatalogQueryDisplayState>[0],
  tea: string
) {
  const catalog = getEventCatalogQueryDisplayState(query).data!
  expect(catalog.products.map((entry) => entry.product.id)).toEqual([tea])
  expect(catalog.products[0]!.pickupFulfillment).not.toBeNull()
  expect(catalog.unresolvedProductCoordinates).toEqual([])
  expect(
    getEventCatalogCartAction({
      state: catalog.state,
      purchaseReady: catalog.purchaseReady,
      hasPickupFulfillment: !!catalog.products[0]!.pickupFulfillment,
      isChecking: query.isFetching && !catalog.products[0]!.pickupFulfillment,
    }).enabled
  ).toBe(true)
}

describe("event catalog local signed deletions", () => {
  for (const mounted of [false, true]) {
    it(`retracts a persisted deletion ${mounted ? "on the mounted page" : "on warm remount"} without rereading or renewing freshness`, async () => {
      const fixtureData = await fixture()
      const client = new QueryClient()
      let reads = 0
      const options = eventCatalogQueryOptions(
        client,
        fixtureData.collection,
        scope,
        () => true,
        async () => {
          reads++
          return fixtureData.raw
        }
      )
      const observer = new QueryObserver(client, options)
      let stop = observer.subscribe(() => {})
      try {
        await client.fetchQuery(options)
        const before = observer.getCurrentResult()
        expect(projectRawEventCatalog(before.data!).products).toHaveLength(2)
        expect(before.isFetching).toBe(false)
        if (!mounted) stop()
        await fixtureData.deleteCoffee()
        if (!mounted) stop = observer.subscribe(() => {})
        await settleObserver()
        const after = observer.getCurrentResult()
        expectTeaActionable(after, fixtureData.products[1]!)
        expect(after.isFetching).toBe(false)
        expect(after.dataUpdatedAt).toBe(before.dataUpdatedAt)
        expect(reads).toBe(1)
        expect(fixtureData.relayReads()).toBe(0)
      } finally {
        stop()
        client.clear()
      }
    })
  }

  it("keeps signed deletion evidence ahead of delayed progress and completion", async () => {
    const fixtureData = await fixture()
    const client = new QueryClient()
    const pending = deferred<RawEventCatalog>()
    let emit: ((snapshot: RawEventCatalog) => void) | undefined
    let reads = 0
    const options = eventCatalogQueryOptions(
      client,
      fixtureData.collection,
      scope,
      () => true,
      async (_reference, readOptions) => {
        reads++
        if (reads === 1) return fixtureData.raw
        emit = readOptions?.onProgress
        return pending.promise
      }
    )
    await client.fetchQuery(options)
    const observer = new QueryObserver(client, options)
    const stop = observer.subscribe(() => {})
    const refresh = observer.refetch()
    try {
      await fixtureData.deleteCoffee()
      await settleObserver()
      expect(observer.getCurrentResult().data!.result!.data).toHaveLength(1)
      emit?.(fixtureData.raw)
      expectTeaActionable(observer.getCurrentResult(), fixtureData.products[1]!)
      pending.resolve(fixtureData.raw)
      await refresh
      expectTeaActionable(observer.getCurrentResult(), fixtureData.products[1]!)
      expect(reads).toBe(2)
      expect(fixtureData.relayReads()).toBe(0)
    } finally {
      pending.resolve(fixtureData.raw)
      await refresh
      stop()
      client.clear()
    }
  })
})
