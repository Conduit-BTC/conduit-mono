import { afterEach, describe, expect, it } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetEventMarketTestOverrides,
  __setCommerceTestOverrides,
  __setEventMarketTestOverrides,
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  buildEventMarketPickupDraft,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  getCachedProductsByIds,
  resolveEventMarketEvidence,
  type CachedProduct,
  type CachedProductTombstone,
  type FetchEventsFanoutResult,
} from "@conduit/core"
import {
  eventCatalogQueryIdentity,
  eventCatalogQueryOptions,
} from "../src/lib/event-catalog-query"
import {
  loadRawEventCatalog,
  projectRawEventCatalog,
  type RawEventCatalog,
} from "../src/lib/event-market-adapter"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const scope = {
  relayScope: "cached-catalog-regression",
  authenticatedPubkey: null,
  authGeneration: 0,
}
const relay = "wss://relay.damus.io"

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetEventMarketTestOverrides()
})

async function fixture(
  negative: "deletion" | "withdrawal" | "none",
  networkOnly: boolean | "missing-first" = false,
  options: {
    holdProductPlan?: boolean
    emptyCache?: boolean
    failedCache?: boolean
  } = {}
) {
  const nowMs = Date.now()
  const createdAt = Math.floor(nowMs / 1000) - 1000
  const organizerKey = generateSecretKey()
  const merchantKey = generateSecretKey()
  const organizer = getPublicKey(organizerKey)
  const merchant = getPublicKey(merchantKey)
  const collection = `30405:${organizer}:market`
  const calendar = `31923:${organizer}:calendar`
  const pickup = `30406:${organizer}:pickup`
  const product = `30402:${merchant}:coffee`
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
        productCoordinates: [product],
      })
    ),
  ]
  const productDraft = {
    kind: 30402,
    content: "Public coffee description",
    created_at: createdAt,
    tags: [
      ["d", "coffee"],
      ["title", "Coffee"],
      ["price", "1000", "SATS"],
      ["type", "simple", "physical"],
      ["visibility", "public"],
      ["stock", "5"],
      ["image", "https://cdn.conduit.market/conduit-test/product.png"],
      ["a", collection],
      ["shipping_option", pickup],
    ],
  }
  const listing = finalizeEvent(productDraft, merchantKey)
  let cachedProducts: CachedProduct[] = []
  let tombstones: CachedProductTombstone[] = []
  let cacheGate: ReturnType<typeof deferred<void>> | undefined
  const cacheStarted = deferred()
  let cacheFailure = false
  const productPlan = deferred<Map<string, never>>()
  let productPlanReads = 0
  let productNetworkReads = 0
  let unscopedAuthorCacheReads = 0
  __setCommerceTestOverrides({
    now: () => nowMs,
    getRelayLists: async () => {
      productPlanReads++
      return options.holdProductPlan ? productPlan.promise : new Map()
    },
    fetchEventsFanout: async (filter) => {
      if (!networkOnly || !filter.kinds?.includes(30402)) return []
      productNetworkReads++
      if (networkOnly === "missing-first" && productNetworkReads === 1)
        return []
      return [new NDKEvent(undefined, listing)]
    },
    getCachedProducts: async (merchantPubkey, authors, selection) => {
      if (authors && !selection) unscopedAuthorCacheReads++
      if (cacheGate) {
        cacheStarted.resolve()
        await cacheGate.promise
      }
      if (cacheFailure) throw new Error("Storage unavailable")
      return cachedProducts.filter(
        (row) =>
          (!merchantPubkey || row.pubkey === merchantPubkey) &&
          (!authors || authors.includes(row.pubkey))
      )
    },
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
  await cacheSignedProductListingEvent(new NDKEvent(undefined, listing))
  const previousBatch = await getCachedProductsByIds([product], {
    includeStale: true,
    includeMarketHidden: true,
  })
  expect(previousBatch.data).toHaveLength(1)
  const previous: RawEventCatalog = {
    reference: collection,
    resolution: resolveEventMarketEvidence({
      reference: collection,
      events: graph,
      productRequestEvents: [listing],
      nowMs,
    }),
    result: {
      ...previousBatch,
      diagnostics: [
        {
          productId: product,
          addressId: product,
          issue: null,
          coverage: { listing: "complete", deletion: "complete" },
        },
      ],
    },
    complete: true,
  }
  expect(projectRawEventCatalog(previous).products).toHaveLength(1)
  const applyNegative = async (kind: "deletion" | "withdrawal") => {
    if (kind === "deletion") {
      await cacheSignedProductDeletionEvent(
        new NDKEvent(
          undefined,
          finalizeEvent(
            {
              kind: 5,
              content: "",
              created_at: createdAt + 1,
              tags: [
                ["a", product],
                ["k", "30402"],
              ],
            },
            merchantKey
          )
        )
      )
    } else {
      await cacheSignedProductListingEvent(
        new NDKEvent(
          undefined,
          finalizeEvent(
            {
              ...productDraft,
              created_at: createdAt + 1,
              tags: productDraft.tags.filter((tag) => tag[0] !== "a"),
            },
            merchantKey
          )
        )
      )
    }
  }
  if (negative !== "none") await applyNegative(negative)
  if (networkOnly || options.emptyCache) cachedProducts = []
  cacheFailure = options.failedCache ?? false
  unscopedAuthorCacheReads = 0
  cacheGate = deferred()
  const plan = deferred<Map<string, never>>()
  const network = deferred<FetchEventsFanoutResult>()
  const networkStarted = deferred()
  let relayProgress: ((result: FetchEventsFanoutResult) => void) | undefined
  __setEventMarketTestOverrides({
    loadCachedEvidence: async () =>
      graph.map((event) => ({
        id: event.id,
        kind: event.kind,
        organizerPubkey: organizer,
        signedEvent: event,
        cachedAt: nowMs,
        sourceRelayUrls: [relay],
      })),
    persistCachedEvidence: async () => {},
    getRelayLists: () => plan.promise,
    fetchEventsFanoutDetailed: async (_filter, options) => {
      relayProgress = options?.onProgress
      networkStarted.resolve()
      return network.promise
    },
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const key = eventCatalogQueryIdentity(collection, scope).queryKey
  if (!networkOnly)
    client.setQueryData(key, previous, { updatedAt: Date.now() - 61_000 })
  const snapshots: RawEventCatalog[] = []
  const graphCompleted = deferred()
  const listeners = new Set<() => void>()
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    const current = client.getQueryData<RawEventCatalog>(key)
    if (
      event.type === "updated" &&
      event.action.type === "success" &&
      current &&
      !current.complete
    ) {
      snapshots.push(current)
      if (current.resolutionComplete) graphCompleted.resolve()
      for (const notify of listeners) notify()
    }
  })
  const waitForSnapshots = (count: number) =>
    snapshots.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const notify = () => {
            if (snapshots.length >= count) {
              listeners.delete(notify)
              resolve()
            }
          }
          listeners.add(notify)
        })
  const loaderSettled = deferred()
  let loaderComplete = false
  let loaderError: unknown
  const loader: typeof loadRawEventCatalog = async (...args) => {
    try {
      return await loadRawEventCatalog(...args)
    } catch (error) {
      loaderError = error
      throw error
    } finally {
      loaderComplete = true
      loaderSettled.resolve()
    }
  }
  const pending = client
    .fetchQuery(
      eventCatalogQueryOptions(client, collection, scope, () => true, loader)
    )
    .catch(() => undefined)
  return {
    snapshots,
    graphCompleted: graphCompleted.promise,
    loaderSettled: loaderSettled.promise,
    loaderComplete: () => loaderComplete,
    loaderError: () => loaderError,
    productPlanReads: () => productPlanReads,
    cancel: () => client.cancelQueries({ queryKey: key }),
    productNetworkReads: () => productNetworkReads,
    unscopedAuthorCacheReads: () => unscopedAuthorCacheReads,
    waitForProduct: () =>
      new Promise<void>((resolve) => {
        const notify = () => {
          const current = snapshots.at(-1)
          if (current && projectRawEventCatalog(current).products.length > 0) {
            listeners.delete(notify)
            resolve()
          }
        }
        listeners.add(notify)
        notify()
      }),
    cacheStarted: cacheStarted.promise,
    waitForSnapshots,
    async completeNetwork(
      failed = false,
      terminal?: "deleted" | "removed-products"
    ) {
      plan.resolve(new Map())
      const finalGraph = [...graph, listing]
      if (terminal) {
        const collectionEvent = graph.find((event) => event.kind === 30405)!
        finalGraph.push(
          finalizeEvent(
            terminal === "deleted"
              ? {
                  kind: 5,
                  content: "",
                  tags: [["a", collection]],
                  created_at: createdAt + 1,
                }
              : {
                  ...collectionEvent,
                  tags: collectionEvent.tags.filter(
                    (tag) => !(tag[0] === "a" && tag[1] === product)
                  ),
                  created_at: createdAt + 1,
                },
            organizerKey
          )
        )
      }
      const events = failed
        ? []
        : finalGraph.map((event) => new NDKEvent(undefined, event))
      network.resolve({
        events,
        relays: [
          {
            relayUrl: relay,
            status: failed ? "failed" : "success",
            eventCount: events.length,
          },
        ],
        eventsVerified: true,
      })
      return pending
    },
    releaseCache: () => {
      cacheGate?.resolve()
      cacheGate = undefined
    },
    async laterFailure() {
      await applyNegative("deletion")
      cacheFailure = true
      plan.resolve(new Map())
      await networkStarted.promise
      relayProgress?.({
        events: graph.map((event) => new NDKEvent(undefined, event)),
        relays: [
          { relayUrl: relay, status: "success", eventCount: graph.length },
        ],
        eventsVerified: true,
      })
    },
    async cleanup() {
      await client.cancelQueries({ queryKey: key })
      cacheGate?.resolve()
      plan.resolve(new Map())
      productPlan.resolve(new Map())
      network.resolve({ events: [], relays: [], eventsVerified: true })
      await pending
      await loaderSettled.promise
      unsubscribe()
      listeners.clear()
      client.clear()
    },
  }
}

describe("event catalog composed cache progress", () => {
  it("reconciles a completed empty early read when final event evidence accepts the product", async () => {
    const run = await fixture("none", "missing-first")
    try {
      await run.cacheStarted
      run.releaseCache()
      // Header, direct batch and final product snapshots all finish while
      // event planning is held. The early product read found nothing.
      await run.waitForSnapshots(3)
      expect(run.productNetworkReads()).toBe(1)
      expect(
        projectRawEventCatalog(run.snapshots.at(-1)!).products
      ).toHaveLength(0)
      const completed = await run.completeNetwork()
      expect(completed?.resolution?.acceptedProductCoordinates).toHaveLength(1)
      expect(run.productNetworkReads()).toBe(2)
      expect(projectRawEventCatalog(completed!).products).toHaveLength(1)
    } finally {
      await run.cleanup()
    }
  })

  it("shows a newly fetched product with empty caches before event relay planning completes", async () => {
    const run = await fixture("none", true)
    try {
      await run.cacheStarted
      // The local coherence observer can start a cache read before the
      // independent organizer reader emits its first browse snapshot.
      await run.waitForSnapshots(1)
      expect(projectRawEventCatalog(run.snapshots[0]!).products).toHaveLength(0)
      run.releaseCache()
      // The event relay plan remains held for this whole assertion. The only
      // way to obtain this card is the overlapping exact network product read.
      await run.waitForProduct()
      const preview = projectRawEventCatalog(run.snapshots.at(-1)!)
      expect(run.productNetworkReads()).toBe(1)
      expect(preview.products).toHaveLength(1)
      expect(preview.purchaseReady).toBe(false)
      expect(preview.products[0]?.pickupFulfillment).toBeNull()
      expect(run.snapshots.at(-1)!.complete).toBe(false)
    } finally {
      await run.cleanup()
    }
  })

  it("retains this read's safe cached cards when final graph verification is unavailable", async () => {
    const run = await fixture("none")
    try {
      await run.cacheStarted
      run.releaseCache()
      await run.waitForProduct()
      const firstFinalSnapshot = run.snapshots.length
      const completed = await run.completeNetwork(true)
      const finalSnapshots = run.snapshots.slice(firstFinalSnapshot)
      expect(finalSnapshots.length).toBeGreaterThan(0)
      for (const snapshot of finalSnapshots) {
        const progress = projectRawEventCatalog(snapshot)
        expect(progress.products).toHaveLength(1)
        expect(progress.products[0]?.pickupFulfillment).toBeNull()
        expect(progress.purchaseReady).toBe(false)
      }
      expect(completed?.complete).toBe(true)
      expect(completed?.resolution?.acceptedProductCoordinates).toHaveLength(0)
      const catalog = projectRawEventCatalog(completed!)
      expect(catalog.state).toBe("stale")
      expect(catalog.products).toHaveLength(1)
      expect(catalog.products[0]?.pickupFulfillment).toBeNull()
      expect(catalog.purchaseReady).toBe(false)
      expect(run.unscopedAuthorCacheReads()).toBe(0)
    } finally {
      await run.cleanup()
    }
  })

  it("shows an intact cached product after its batch check while relay discovery remains held", async () => {
    const run = await fixture("none")
    try {
      await run.cacheStarted
      // The local coherence observer can start a cache read before the
      // independent organizer reader emits its first browse snapshot.
      await run.waitForSnapshots(1)
      expect(projectRawEventCatalog(run.snapshots[0]!).products).toHaveLength(0)
      run.releaseCache()
      await run.waitForSnapshots(2)
      const preview = projectRawEventCatalog(run.snapshots.at(-1)!)
      // The shared exact reader owns cached hydration; no duplicate broad
      // author scan runs beside its scoped target read.
      expect(run.unscopedAuthorCacheReads()).toBe(0)
      expect(preview.products).toHaveLength(1)
      expect(preview.purchaseReady).toBe(false)
      expect(run.snapshots.at(-1)!.complete).toBe(false)
    } finally {
      await run.cleanup()
    }
  })

  it("does not reuse earlier preview records after a stronger deletion when storage fails", async () => {
    const run = await fixture("none")
    try {
      await run.cacheStarted
      run.releaseCache()
      await run.waitForSnapshots(2)
      expect(
        projectRawEventCatalog(run.snapshots.at(-1)!).products
      ).toHaveLength(1)
      const previousCount = run.snapshots.length
      await run.laterFailure()
      await run.waitForSnapshots(previousCount + 1)
      expect(
        projectRawEventCatalog(run.snapshots.at(-1)!).products
      ).toHaveLength(0)
      expect(run.snapshots.at(-1)!.complete).toBe(false)
    } finally {
      await run.cleanup()
    }
  })

  for (const negative of ["deletion", "withdrawal"] as const) {
    it(`does not borrow an old query product before checking the newer cached ${negative}`, async () => {
      const run = await fixture(negative)
      try {
        await run.cacheStarted
        await run.waitForSnapshots(1)
        expect(run.snapshots[0]?.resolution?.collection?.title).toBe(
          "Market catalog"
        )
        expect(projectRawEventCatalog(run.snapshots[0]!).products).toHaveLength(
          0
        )
        run.releaseCache()
        await run.waitForSnapshots(2)
        expect(
          projectRawEventCatalog(run.snapshots.at(-1)!).products
        ).toHaveLength(0)
      } finally {
        await run.cleanup()
      }
    })
  }
})

describe("event cache completion boundary", () => {
  for (const order of ["graph-first", "cache-first"] as const) {
    it(`retains cached browse in ${order} order without waiting for product relay planning`, async () => {
      const run = await fixture("none", false, { holdProductPlan: true })
      try {
        await run.cacheStarted
        if (order === "cache-first") {
          run.releaseCache()
          await run.waitForProduct()
        }
        const reading = run.completeNetwork(true)
        await run.graphCompleted
        if (order === "graph-first") {
          expect(run.loaderComplete()).toBe(false)
          run.releaseCache()
        }
        const completed = await reading
        expect(completed?.complete).toBe(true)
        const catalog = projectRawEventCatalog(completed!)
        expect(catalog.state).toBe("stale")
        expect(catalog.products).toHaveLength(1)
        expect(catalog.products[0]!.pickupFulfillment).toBeNull()
        expect(catalog.purchaseReady).toBe(false)
        expect(run.productPlanReads()).toBe(1)
        expect(run.productNetworkReads()).toBe(0)
        expect(run.unscopedAuthorCacheReads()).toBe(0)
      } finally {
        await run.cleanup()
      }
    })
  }

  for (const cache of ["empty", "failed", "deletion", "withdrawal"] as const) {
    it(`settles a graph-first ${cache} cache without restoring unsafe cards or waiting for relays`, async () => {
      const run = await fixture(
        cache === "deletion" || cache === "withdrawal" ? cache : "none",
        false,
        {
          holdProductPlan: true,
          emptyCache: cache === "empty",
          failedCache: cache === "failed",
        }
      )
      try {
        await run.cacheStarted
        const reading = run.completeNetwork(true)
        await run.graphCompleted
        run.releaseCache()
        const completed = await reading
        expect(completed?.complete).toBe(true)
        const catalog = projectRawEventCatalog(completed!)
        expect(catalog.products).toEqual([])
        expect(catalog.purchaseReady).toBe(false)
        expect(run.productNetworkReads()).toBe(0)
        expect(run.unscopedAuthorCacheReads()).toBe(0)
      } finally {
        await run.cleanup()
      }
    })
  }

  it("cancels a local-cache wait without awaiting storage or publishing late progress", async () => {
    const run = await fixture("none", false, { holdProductPlan: true })
    try {
      await run.cacheStarted
      const reading = run.completeNetwork(true)
      await run.graphCompleted
      await run.cancel()
      await run.loaderSettled
      await reading
      expect(run.loaderError()).toMatchObject({ name: "AbortError" })
      const count = run.snapshots.length
      run.releaseCache()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(run.snapshots).toHaveLength(count)
      expect(run.productNetworkReads()).toBe(0)
    } finally {
      await run.cleanup()
    }
  })

  for (const terminal of ["deleted", "removed-products"] as const) {
    it(`does not wait for obsolete cache or restore cards after ${terminal}`, async () => {
      const run = await fixture("none", false, { holdProductPlan: true })
      try {
        await run.cacheStarted
        const reading = run.completeNetwork(false, terminal)
        await run.graphCompleted
        await run.loaderSettled
        const count = run.snapshots.length
        run.releaseCache()
        const completed = await reading
        expect(completed?.complete).toBe(true)
        expect(projectRawEventCatalog(completed!).products).toEqual([])
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(run.snapshots).toHaveLength(count)
        expect(run.productNetworkReads()).toBe(0)
      } finally {
        await run.cleanup()
      }
    })
  }
})
