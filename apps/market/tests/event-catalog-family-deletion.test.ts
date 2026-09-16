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
  getProductsByIds,
  resolveEventMarketEvidence,
  type CachedProduct,
  type CachedProductTombstone,
} from "@conduit/core"
import { eventCatalogQueryOptions } from "../src/lib/event-catalog-query"
import { getEventCatalogQueryDisplayState } from "../src/lib/event-catalog-query-state"
import type { RawEventCatalog } from "../src/lib/event-market-adapter"
import { getEventCatalogCartAction } from "../src/lib/event-market-cart-action"

const scope = {
  relayScope: "family-deletion-regression",
  authenticatedPubkey: null,
  authGeneration: 0,
}
const scenarios = [
  {
    name: "public child / parent",
    target: "parent",
    hidden: false,
    grouped: false,
    siblingImage: false,
  },
  {
    name: "accepted hidden child / parent",
    target: "parent",
    hidden: true,
    grouped: false,
    siblingImage: false,
  },
  {
    name: "public child / only image sibling",
    target: "image-source",
    hidden: false,
    grouped: false,
    siblingImage: true,
  },
  {
    name: "grouped parent / parent",
    target: "parent",
    hidden: false,
    grouped: true,
    siblingImage: false,
  },
] as const
type Scenario = (typeof scenarios)[number]

afterEach(() => __resetCommerceTestOverrides())

async function settleObserver() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function fixture(scenario: Scenario, deletionTarget = scenario.target) {
  const nowMs = Date.now()
  const createdAt = Math.floor(nowMs / 1000) - 1000
  const organizerKey = generateSecretKey()
  const merchantKey = generateSecretKey()
  const organizer = getPublicKey(organizerKey)
  const merchant = getPublicKey(merchantKey)
  const collection = `30405:${organizer}:market`
  const calendar = `31923:${organizer}:calendar`
  const pickup = `30406:${organizer}:pickup`
  const coordinate = (name: string) => `30402:${merchant}:${name}`
  const requested = [
    coordinate(scenario.grouped ? "parent" : "coffee"),
    coordinate("tea"),
  ]
  const sign = (draft: { kind: number; content: string; tags: string[][] }) =>
    finalizeEvent({ ...draft, created_at: createdAt }, organizerKey)
  const graph = [
    sign(
      buildEventMarketCalendarDraft({
        kind: 31923,
        dTag: "calendar",
        title: "Market",
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
        title: "Catalog",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: ["coffee", "tea", "parent", "image-source"].map(
          coordinate
        ),
      })
    ),
  ]
  const listing = (name: string, timestamp = createdAt) => {
    const variation = name === "coffee" || name === "image-source"
    const hasImage =
      !scenario.siblingImage || name === "tea" || name === "image-source"
    return finalizeEvent(
      {
        kind: 30402,
        content: `Public ${name} description`,
        created_at: timestamp,
        tags: [
          ["d", name],
          ["title", name],
          ["price", "1000", "SATS"],
          [
            "type",
            variation ? "variation" : name === "parent" ? "variable" : "simple",
            "physical",
          ],
          ...(variation
            ? [
                ["a", coordinate("parent")],
                ["spec", "size", name],
              ]
            : []),
          [
            "visibility",
            scenario.hidden && name !== "tea" ? "hidden" : "public",
          ],
          ["stock", "5"],
          ...(hasImage
            ? [["image", "https://cdn.conduit.market/conduit-test/product.png"]]
            : []),
          ["a", collection],
          ["shipping_option", pickup],
        ],
      },
      merchantKey
    )
  }
  let listings = ["coffee", "tea", "parent", "image-source"].map((name) =>
    listing(name)
  )
  let cachedProducts: CachedProduct[] = []
  let tombstones: CachedProductTombstone[] = []
  let relayReads = 0
  __setCommerceTestOverrides({
    now: () => nowMs,
    getRelayLists: async () => new Map(),
    fetchEventsFanout: async (filter) => {
      relayReads++
      return listings
        .filter(
          (event) =>
            filter.kinds?.includes(event.kind) &&
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            (!filter["#d"] ||
              filter["#d"].includes(
                event.tags.find((tag) => tag[0] === "d")![1]!
              ))
        )
        .map((event) => new NDKEvent(undefined, event))
    },
    getCachedProducts: async (pubkey, authors) =>
      cachedProducts.filter(
        (row) =>
          (!pubkey || row.pubkey === pubkey) &&
          (!authors || authors.includes(row.pubkey))
      ),
    putCachedProducts: async (rows) => {
      for (const row of rows)
        cachedProducts = [
          ...cachedProducts.filter((old) => old.id !== row.id),
          row,
        ]
    },
    getCachedProductTombstones: async (pubkey, authors) =>
      tombstones.filter(
        (row) =>
          (!pubkey || row.pubkey === pubkey) &&
          (!authors || authors.includes(row.pubkey))
      ),
    putCachedProductTombstones: async (rows) => {
      for (const row of rows)
        tombstones = [...tombstones.filter((old) => old.id !== row.id), row]
    },
  })
  for (const event of listings)
    await cacheSignedProductListingEvent(new NDKEvent(undefined, event))
  const read = async (): Promise<RawEventCatalog> => ({
    reference: collection,
    resolution: resolveEventMarketEvidence({
      reference: collection,
      events: graph,
      productRequestEvents: listings,
      nowMs,
    }),
    result: await getProductsByIds(
      requested,
      scenario.hidden
        ? { includeMerchantHiddenProductIds: [requested[0]!] }
        : {}
    ),
    complete: true,
    resolutionComplete: true,
  })
  const raw = await read()
  expect(raw.result!.data).toHaveLength(2)
  const targetEvent = listings.find((event) =>
    event.tags.some((tag) => tag[0] === "d" && tag[1] === deletionTarget)
  )!
  return {
    collection,
    requested,
    raw,
    read,
    relayReads: () => relayReads,
    async remove(
      tag: "a" | "e",
      foreignAuthor = false,
      differentEvent = false
    ) {
      const value =
        tag === "a"
          ? coordinate(deletionTarget)
          : differentEvent
            ? listing("unrelated").id
            : targetEvent.id
      await cacheSignedProductDeletionEvent(
        new NDKEvent(
          undefined,
          finalizeEvent(
            {
              kind: 5,
              content: "",
              created_at: createdAt + 1,
              tags: [
                [tag, value],
                ["k", "30402"],
              ],
            },
            foreignAuthor ? generateSecretKey() : merchantKey
          )
        )
      )
    },
    async restore() {
      const event = listing(deletionTarget, createdAt + 2)
      listings = [...listings.filter((old) => old.id !== targetEvent.id), event]
      await cacheSignedProductListingEvent(new NDKEvent(undefined, event))
      return read()
    },
  }
}

type DisplayQuery = Parameters<typeof getEventCatalogQueryDisplayState>[0]
function expectActionable(query: DisplayQuery, productId: string) {
  const catalog = getEventCatalogQueryDisplayState(query).data!
  const entry = catalog.products.find(
    (product) => product.product.id === productId
  )
  expect(entry).toBeDefined()
  expect(
    getEventCatalogCartAction({
      state: catalog.state,
      purchaseReady: catalog.purchaseReady,
      hasPickupFulfillment: !!entry?.pickupFulfillment,
      isChecking: query.isFetching && !entry?.pickupFulfillment,
    }).enabled
  ).toBe(true)
}

function expectRetracted(
  query: DisplayQuery,
  affected: string,
  unaffected: string
) {
  const raw = query.data!
  const catalog = getEventCatalogQueryDisplayState(query).data!
  expect(catalog.products.some((entry) => entry.product.id === affected)).toBe(
    false
  )
  expect(
    raw.result!.diagnostics.find((entry) => entry.addressId === affected)?.issue
  ).toBe("listing_filtered")
  expect(
    catalog.products.some((entry) => entry.product.id === unaffected)
  ).toBe(true)
}

describe("retained exact product family dependencies", () => {
  it("shares bounded family evidence across exact targets and survives a serialized cache round trip", async () => {
    const f = await fixture(scenarios[0])
    const child = f.raw.result!.data.find(
      (record) => record.addressId === f.requested[0]
    )!
    const parentId = child.product.parentProductId!
    const result = await getProductsByIds([parentId, ...f.requested])
    const parent = result.data.find((record) => record.addressId === parentId)!
    const variation = result.data.find(
      (record) => record.addressId === child.addressId
    )!
    expect(parent.exactReadContext).toBeDefined()
    expect(parent.exactReadContext).toBe(variation.exactReadContext)
    expect(parent.exactReadContext!.records).toHaveLength(3)
    for (const record of parent.exactReadContext!.records) {
      expect(record).not.toHaveProperty("family")
      expect(record).not.toHaveProperty("exactReadContext")
    }
    const raw: RawEventCatalog = JSON.parse(
      JSON.stringify({ ...f.raw, result })
    )
    const client = new QueryClient()
    const options = eventCatalogQueryOptions(
      client,
      f.collection,
      scope,
      () => true,
      async () => raw
    )
    const observer = new QueryObserver(client, options)
    const stop = observer.subscribe(() => {})
    try {
      await client.fetchQuery(options)
      const relayReads = f.relayReads()
      await f.remove("a")
      await settleObserver()
      const query = observer.getCurrentResult()
      expect(
        query.data!.result!.data.map((record) => record.addressId)
      ).toEqual([f.requested[1]!])
      expectRetracted(query, parentId, f.requested[1]!)
      expectRetracted(query, child.addressId, f.requested[1]!)
      expectActionable(query, f.requested[1]!)
      expect(f.relayReads()).toBe(relayReads)
    } finally {
      stop()
      client.clear()
    }
  })

  for (const scenario of scenarios) {
    for (const tag of ["a", "e"] as const) {
      for (const mounted of [true, false]) {
        it(`${scenario.name}: ${tag} deletion ${mounted ? "while mounted" : "on warm return"} keeps unrelated products and freshness without relay reads`, async () => {
          const f = await fixture(scenario)
          const client = new QueryClient()
          let loads = 0
          const options = eventCatalogQueryOptions(
            client,
            f.collection,
            scope,
            () => true,
            async () => {
              loads++
              return f.raw
            }
          )
          const observer = new QueryObserver(client, options)
          let stop = observer.subscribe(() => {})
          try {
            await client.fetchQuery(options)
            const before = observer.getCurrentResult()
            expectActionable(before, f.requested[0]!)
            const unaffected = client
              .getQueryData<RawEventCatalog>(options.queryKey)!
              .result!.data.find((entry) => entry.addressId === f.requested[1])
            const relayReads = f.relayReads()
            if (!mounted) stop()
            await f.remove(tag)
            if (!mounted) stop = observer.subscribe(() => {})
            await settleObserver()
            const after = observer.getCurrentResult()
            expectRetracted(after, f.requested[0]!, f.requested[1]!)
            expectActionable(after, f.requested[1]!)
            expect(
              client
                .getQueryData<RawEventCatalog>(options.queryKey)!
                .result!.data.find(
                  (entry) => entry.addressId === f.requested[1]
                )
            ).toBe(unaffected)
            expect(after.dataUpdatedAt).toBe(before.dataUpdatedAt)
            expect(after.isFetching).toBe(false)
            expect(loads).toBe(1)
            expect(f.relayReads()).toBe(relayReads)
            expect(
              (await f.read()).result!.data.some(
                (entry) => entry.addressId === f.requested[0]
              )
            ).toBe(false)
          } finally {
            stop()
            client.clear()
          }
        })
      }
    }
  }

  for (const scenario of scenarios.slice(0, 3)) {
    for (const tag of ["a", "e"] as const) {
      it(`${scenario.name}: delayed snapshots stay retracted, and a successful newer revision restores after ${tag} deletion`, async () => {
        const f = await fixture(scenario)
        const client = new QueryClient()
        let current = f.raw
        let finish!: (raw: RawEventCatalog) => void
        let emit: ((raw: RawEventCatalog) => void) | undefined
        let loads = 0
        const pending = new Promise<RawEventCatalog>((resolve) => {
          finish = resolve
        })
        const options = eventCatalogQueryOptions(
          client,
          f.collection,
          scope,
          () => true,
          async (_reference, readOptions) => {
            loads++
            if (loads !== 2) return current
            emit = readOptions?.onProgress
            return pending
          }
        )
        const observer = new QueryObserver(client, options)
        const stop = observer.subscribe(() => {})
        await client.fetchQuery(options)
        const refresh = observer.refetch()
        try {
          const relayReads = f.relayReads()
          await f.remove(tag)
          await settleObserver()
          expectRetracted(
            observer.getCurrentResult(),
            f.requested[0]!,
            f.requested[1]!
          )
          expect(emit).toBeDefined()
          emit!(f.raw)
          expectRetracted(
            observer.getCurrentResult(),
            f.requested[0]!,
            f.requested[1]!
          )
          expectActionable(observer.getCurrentResult(), f.requested[1]!)
          finish(f.raw)
          await refresh
          expectRetracted(
            observer.getCurrentResult(),
            f.requested[0]!,
            f.requested[1]!
          )
          expectActionable(observer.getCurrentResult(), f.requested[1]!)
          expect(f.relayReads()).toBe(relayReads)
          current = await f.restore()
          expect(
            current.result!.data.some(
              (entry) => entry.addressId === f.requested[0]
            )
          ).toBe(true)
          await observer.refetch()
          expectActionable(observer.getCurrentResult(), f.requested[0]!)
          expectActionable(observer.getCurrentResult(), f.requested[1]!)
          expect(loads).toBe(3)
        } finally {
          finish(f.raw)
          await refresh
          stop()
          client.clear()
        }
      })
    }
  }

  for (const scenario of scenarios.slice(0, 2)) {
    it(`${scenario.name}: deleting an optional sibling keeps the child's own-image eligibility`, async () => {
      const f = await fixture(scenario, "image-source")
      const client = new QueryClient()
      let loads = 0
      const options = eventCatalogQueryOptions(
        client,
        f.collection,
        scope,
        () => true,
        async () => {
          loads++
          return f.raw
        }
      )
      const observer = new QueryObserver(client, options)
      const stop = observer.subscribe(() => {})
      try {
        await client.fetchQuery(options)
        const before = observer.getCurrentResult()
        const relayReads = f.relayReads()
        await f.remove("a")
        await settleObserver()
        const after = observer.getCurrentResult()
        expectActionable(after, f.requested[0]!)
        expectActionable(after, f.requested[1]!)
        expect(after.dataUpdatedAt).toBe(before.dataUpdatedAt)
        expect(f.relayReads()).toBe(relayReads)
        expect(loads).toBe(1)
        expect(
          (await f.read()).result!.data.some(
            (record) => record.addressId === f.requested[0]
          )
        ).toBe(true)
      } finally {
        stop()
        client.clear()
      }
    })
  }

  for (const control of ["foreign author", "different parent event"] as const) {
    it(`ignores ${control} deletion without changing the retained child or freshness`, async () => {
      const f = await fixture(scenarios[0])
      const client = new QueryClient()
      const options = eventCatalogQueryOptions(
        client,
        f.collection,
        scope,
        () => true,
        async () => f.raw
      )
      const observer = new QueryObserver(client, options)
      const stop = observer.subscribe(() => {})
      try {
        await client.fetchQuery(options)
        const before = observer.getCurrentResult()
        const relayReads = f.relayReads()
        await f.remove(
          "e",
          control === "foreign author",
          control === "different parent event"
        )
        await settleObserver()
        const after = observer.getCurrentResult()
        expectActionable(after, f.requested[0]!)
        expect(after.data).toBe(before.data)
        expect(after.dataUpdatedAt).toBe(before.dataUpdatedAt)
        expect(f.relayReads()).toBe(relayReads)
      } finally {
        stop()
        client.clear()
      }
    })
  }
})
