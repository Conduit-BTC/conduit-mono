import { describe, expect, it } from "bun:test"
import { hashKey, QueryClient, QueryObserver } from "@tanstack/react-query"
import {
  encodeEventMarketNaddr,
  evaluateListingSafety,
  prepareProductCatalog,
  type CommerceProductRecord,
  type EventMarketResolution,
  type Product,
  type ProductsByIdsResult,
} from "@conduit/core"
import {
  eventCatalogQueryIdentity,
  eventCatalogQueryOptions,
  type EventCatalogQueryScope,
} from "../src/lib/event-catalog-query"
import {
  projectRawEventCatalog,
  resolveProductCartFulfillmentFromCatalogs,
  getProductEventMarketCandidates,
  eventCatalogNeedsProductRefresh,
  getEventCatalogProductSourceObservation,
  takeEventCatalogProductRefreshObservations,
  type RawEventCatalog,
  type loadRawEventCatalog,
} from "../src/lib/event-market-adapter"

import { readEventCatalogProducts } from "../src/lib/event-catalog-products"
import { eventCatalogCacheCoherence } from "../src/lib/event-catalog-cache-coherence"
import { getEventCatalogQueryDisplayState } from "../src/lib/event-catalog-query-state"
import { getEventCatalogCartAction } from "../src/lib/event-market-cart-action"

const organizer = "a".repeat(64)
const merchant = "b".repeat(64)
const collectionCoordinate = `30405:${organizer}:summer-market`
const calendarCoordinate = `31923:${organizer}:summer-market`
const pickupCoordinate = `30406:${organizer}:summer-market-pickup`
const productCoordinate = `30402:${merchant}:coffee`

function market(
  state: EventMarketResolution["state"] = "active"
): EventMarketResolution {
  const pickup = {
    coordinate: pickupCoordinate,
    eventId: "3".repeat(64),
    authorPubkey: organizer,
    dTag: "summer-market-pickup",
    title: "Event pickup",
    content: "",
    price: 0,
    currency: "SATS",
    countries: [],
    location: "Public hall entrance",
    geohash: "dpz83",
    createdAt: 102,
  }
  return {
    state,
    reference: collectionCoordinate,
    organizerPubkey: organizer,
    collectionCoordinate,
    calendarCoordinate,
    pickupCoordinate,
    collection: {
      coordinate: collectionCoordinate,
      eventId: "1".repeat(64),
      authorPubkey: organizer,
      dTag: "summer-market",
      title: "Summer Market",
      content: "",
      eventCoordinates: [calendarCoordinate],
      pickupCoordinates: [pickupCoordinate],
      productCoordinates: [productCoordinate],
      unsupportedReferences: [],
      createdAt: 100,
    },
    calendar: {
      coordinate: calendarCoordinate,
      eventId: "2".repeat(64),
      authorPubkey: organizer,
      dTag: "summer-market",
      kind: 31923,
      title: "Summer Market",
      content: "",
      locations: ["Public hall"],
      start: 1_800_000_000_000,
      end: 1_800_003_600_000,
      createdAt: 101,
    },
    pickup,
    pickups: [pickup],
    organizerProductCoordinates: [productCoordinate],
    acceptedProductCoordinates: [productCoordinate],
    acceptedProductEvidence: [
      {
        productCoordinate,
        eventId: "4".repeat(64),
        createdAt: 103_000,
        shippingOptionCoordinates: [pickupCoordinate],
        merchantPubkey: merchant,
      },
    ],
    organizerOnlyProductCoordinates: [],
    participationRequests: [{ productCoordinate, merchantPubkey: merchant }],
    participationBudget: {
      state: "within_budget",
      targetCount: 1,
      targetLimit: 64,
    },
    pickupBudget: {
      state: "within_budget",
      targetCount: 1,
      targetLimit: 64,
    },
    coverage: {
      attemptedRelayCount: 2,
      completeRelayCount: 2,
      partialRelayCount: 0,
      failedRelayCount: 0,
    },
  }
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: productCoordinate,
    pubkey: merchant,
    title: "Coffee",
    price: 2_000,
    currency: "SATS",
    priceSats: 2_000,
    type: "simple",
    format: "physical",
    visibility: "public",
    images: [{ url: "https://cdn.conduit.market/coffee.png" }],
    tags: [],
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 103_000,
    updatedAt: 103_000,
    collectionRefs: [collectionCoordinate],
    shippingOptionRefs: [{ coordinate: pickupCoordinate }],
    ...overrides,
  }
}

function commerceRecord(
  candidate: Product,
  overrides: Partial<CommerceProductRecord> = {}
): CommerceProductRecord {
  return {
    product: candidate,
    safety: evaluateListingSafety(candidate),
    addressId: candidate.id,
    eventId: "4".repeat(64),
    eventCreatedAt: candidate.createdAt / 1_000,
    dTag: candidate.id.split(":").at(-1) ?? null,
    ...overrides,
  }
}

function productRead(
  options: {
    product?: Product
    includeRecord?: boolean
    issue?: ProductsByIdsResult["diagnostics"][number]["issue"]
    source?: ProductsByIdsResult["meta"]["source"]
    stale?: boolean
    listing?: "complete" | "partial" | "unavailable"
    eventId?: string
    eventCreatedAt?: number
  } = {}
): ProductsByIdsResult {
  const candidate = options.product ?? product()
  const record = commerceRecord(candidate, {
    eventId: options.eventId ?? "4".repeat(64),
    eventCreatedAt: options.eventCreatedAt ?? 103,
  })
  return {
    data: options.includeRecord === false ? [] : [record],
    meta: {
      source: options.source ?? "commerce",
      degraded: (options.issue ?? null) !== null,
      stale: options.stale ?? false,
      capped: false,
      capabilities: {
        sortModes: [],
        textSearch: false,
        protectedSummaries: false,
        canonicalFreshness: true,
        cursorPagination: false,
      },
      fetchedAt: 1,
    },
    diagnostics: [
      {
        productId: candidate.id,
        addressId: candidate.id,
        issue: options.issue ?? null,
        coverage: {
          listing: options.listing ?? "complete",
          deletion: "complete",
        },
      },
    ],
  }
}

const scope: EventCatalogQueryScope = {
  relayScope: "relay-a",
  authenticatedPubkey: null,
  authGeneration: 1,
}
function raw(): RawEventCatalog {
  return {
    reference: collectionCoordinate,
    resolution: market(),
    result: productRead(),
    complete: true,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe("shared progressive event catalogs", () => {
  it("reuses a completed catalog on immediate navigation back", async () => {
    const client = new QueryClient()
    let reads = 0
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      async () => {
        reads++
        return raw()
      }
    )
    await client.fetchQuery(options)
    const observer = new QueryObserver(client, options)
    const stop = observer.subscribe(() => {})
    try {
      expect(reads).toBe(1)
      expect(observer.getCurrentResult().isFetching).toBe(false)
      expect(
        projectRawEventCatalog(observer.getCurrentResult().data!).purchaseReady
      ).toBe(true)
    } finally {
      stop()
      client.clear()
    }
  })

  it("projects completed product evidence while other products are still hydrating", () => {
    const snapshot = { ...raw(), complete: false, resolutionComplete: true }
    const catalog = projectRawEventCatalog(snapshot)
    expect(catalog.purchaseReady).toBe(true)
    expect(catalog.products[0]?.pickupFulfillment).not.toBeNull()
    expect(
      projectRawEventCatalog({ ...snapshot, resolutionComplete: false })
        .purchaseReady
    ).toBe(false)
  })

  it("makes a finished merchant actionable while another merchant is held, then reuses the final cache", async () => {
    const client = new QueryClient()
    const held = deferred<ProductsByIdsResult>()
    const progressed = deferred<void>()
    const fast = product()
    const slow = product({
      id: `30402:${"c".repeat(64)}:tea`,
      pubkey: "c".repeat(64),
    })
    const resolution = market()
    resolution.organizerProductCoordinates.push(slow.id)
    resolution.acceptedProductCoordinates.push(slow.id)
    resolution.acceptedProductEvidence.push({
      ...resolution.acceptedProductEvidence[0]!,
      productCoordinate: slow.id,
      merchantPubkey: slow.pubkey,
    })
    let reads = 0
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      async (_reference, loaderOptions) => {
        const result = await readEventCatalogProducts(
          [fast.id, slow.id],
          {
            shouldContinue: loaderOptions?.shouldContinue,
            onProgress: (result) => {
              loaderOptions?.onProgress?.({
                reference: collectionCoordinate,
                resolution,
                result,
                resolutionComplete: true,
                complete: false,
              })
              if (result.data.some((entry) => entry.product.id === fast.id))
                progressed.resolve()
            },
          },
          async (ids) => {
            reads++
            return ids.includes(slow.id) ? held.promise : productRead()
          },
          async () =>
            productRead({
              product: slow,
              source: "local_cache",
              stale: true,
              issue: "cached_only",
              listing: "unavailable",
            })
        )
        return {
          reference: collectionCoordinate,
          resolution,
          result,
          complete: true,
        }
      }
    )
    const observer = new QueryObserver(client, options)
    const release = observer.subscribe(() => {})
    try {
      await progressed.promise
      // Local evidence settles independently while the slow merchant remains
      // held. Progress cannot borrow authority before that reconciliation.
      await eventCatalogCacheCoherence(client).settled(
        observer.getCurrentResult().data!,
        hashKey(options.queryKey)
      )
      const query = observer.getCurrentResult()
      const display = getEventCatalogQueryDisplayState(query)
      expect(query.isFetching).toBe(true)
      expect(display.data?.products.map((entry) => entry.product.id)).toEqual([
        fast.id,
        slow.id,
      ])
      expect(display.data!.products[1]!.pickupFulfillment).toBeNull()
      expect(display.data!.products[1]!.evidenceState).toBe("retained")
      const pickup = display.data!.products[0]!.pickupFulfillment
      expect(
        getEventCatalogCartAction({
          state: display.data!.state,
          purchaseReady: display.data!.purchaseReady,
          hasPickupFulfillment: !!pickup,
          isChecking: display.isHydrating && !pickup,
        })
      ).toEqual({ enabled: true, disabledLabel: null })
      held.resolve(productRead({ product: slow }))
      await client.fetchQuery(options)
      const completed = getEventCatalogQueryDisplayState(
        observer.getCurrentResult()
      )
      expect(completed.data?.products).toHaveLength(2)
      expect(completed.isHydrating).toBe(false)
      release()
      await client.fetchQuery(options)
      expect(reads).toBe(2)
    } finally {
      held.resolve(productRead({ product: slow }))
      release()
      client.clear()
    }
  })

  it("limits five merchants to two active reads while publishing completed merchants before queued ones", async () => {
    const products = ["b", "c", "d", "e", "f"].map((key) =>
      product({ id: `30402:${key.repeat(64)}:item`, pubkey: key.repeat(64) })
    )
    const gates = products.map(() => deferred<void>())
    const startedSignals = products.map(() => deferred<void>())
    const started: number[] = []
    const snapshots: ProductsByIdsResult[] = []
    let active = 0
    let peakActive = 0
    const running = readEventCatalogProducts(
      products.map((entry) => entry.id),
      { onProgress: (snapshot) => snapshots.push(snapshot) },
      async (ids) => {
        const index = products.findIndex((entry) => entry.id === ids[0])
        started.push(index)
        active++
        peakActive = Math.max(peakActive, active)
        startedSignals[index]!.resolve()
        try {
          await gates[index]!.promise
          return productRead({ product: products[index]! })
        } finally {
          active--
        }
      },
      async () => productRead({ includeRecord: false, source: "local_cache" })
    )
    try {
      await startedSignals[1]!.promise
      expect(started).toEqual([0, 1])
      expect(active).toBe(2)
      gates[0]!.resolve()
      await startedSignals[2]!.promise
      expect(started).toEqual([0, 1, 2])
      const progress = snapshots.at(-1)!
      expect(progress.data.map((entry) => entry.product.id)).toEqual([
        products[0]!.id,
      ])
      expect(
        progress.diagnostics.find(
          (entry) => entry.productId === products[0]!.id
        )?.issue
      ).toBeNull()
      expect(
        progress.diagnostics.find(
          (entry) => entry.productId === products[4]!.id
        )?.issue
      ).toBe("cached_only")
      // Keep merchant 1 held while the other worker drains the remaining queue.
      gates[2]!.resolve()
      await startedSignals[3]!.promise
      gates[3]!.resolve()
      await startedSignals[4]!.promise
      expect(started).toEqual([0, 1, 2, 3, 4])
      expect(peakActive).toBe(2)
    } finally {
      for (const gate of gates) gate.resolve()
      await running
    }
    expect((await running).data.map((entry) => entry.product.id)).toEqual(
      products.map((entry) => entry.id)
    )
    expect(active).toBe(0)
  })

  it("keeps a child-only cached family visible while its merchant read is queued", async () => {
    const parent = product({
      type: "variable",
      images: [],
      visibility: "private",
    })
    const child = product({
      id: `30402:${merchant}:small`,
      type: "variation",
      visibility: "private",
      parentProductId: parent.id,
      specifications: [{ key: "size", value: "Small" }],
    })
    const prepared = prepareProductCatalog(
      [commerceRecord(parent), commerceRecord(child)],
      {
        source: "local_cache",
        stale: true,
        degraded: true,
        capped: false,
        fetchedAt: 1,
      }
    ).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected cached family")
    const family = { ...prepared.family.parent, family: prepared.family }
    const resolution = market()
    resolution.organizerProductCoordinates = [child.id]
    resolution.acceptedProductCoordinates = [child.id]
    resolution.acceptedProductEvidence = [
      {
        ...resolution.acceptedProductEvidence[0]!,
        productCoordinate: child.id,
      },
    ]
    const queuedBehind = ["c", "d", "e", "f"].map(
      (key) => `30402:${key.repeat(64)}:other`
    )
    const held = deferred<ProductsByIdsResult>()
    const queued = deferred<void>()
    const started: string[] = []
    const snapshots: ProductsByIdsResult[] = []
    const running = readEventCatalogProducts(
      [...queuedBehind, child.id],
      {
        onProgress: (snapshot) => snapshots.push(snapshot),
      },
      async (ids) => {
        started.push(ids[0]!)
        if (started.length === 2) queued.resolve()
        return ids.includes(child.id)
          ? {
              ...productRead({ product: child }),
              data: [
                {
                  ...commerceRecord(child),
                  safety: evaluateListingSafety(child, undefined, {
                    variationGroupRole: "variation",
                    hasGroupImage: true,
                  }),
                },
              ],
            }
          : held.promise
      },
      async () => ({
        data: [family],
        meta: {
          ...productRead().meta,
          source: "local_cache",
          stale: true,
          degraded: true,
        },
      })
    )
    try {
      await queued.promise
      expect(started).not.toContain(child.id)
      expect(snapshots).not.toHaveLength(0)
      for (const snapshot of snapshots) {
        const retained = projectRawEventCatalog({
          reference: collectionCoordinate,
          resolution,
          result: snapshot,
          resolutionComplete: true,
          complete: false,
        })
        expect(retained.products.map((entry) => entry.product.id)).toEqual([
          child.id,
        ])
        expect(retained.products[0]?.pickupFulfillment).toBeNull()
        expect(
          snapshot.diagnostics.find((entry) => entry.productId === child.id)
            ?.issue
        ).toBe("cached_only")
        expect(
          snapshot.diagnostics.some((entry) => entry.productId === parent.id)
        ).toBe(false)
      }
    } finally {
      held.resolve({ ...productRead(), data: [], diagnostics: [] })
      await running
    }
    const complete = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution,
      result: await running,
      complete: true,
    })
    expect(complete.products.map((entry) => entry.product.id)).toEqual([
      child.id,
    ])
    expect(complete.products[0]?.pickupFulfillment).not.toBeNull()
  })

  it("does not reuse canceled progressive authorization before a remounted read emits evidence", async () => {
    const client = new QueryClient()
    const first = deferred<RawEventCatalog>()
    const second = deferred<RawEventCatalog>()
    let reads = 0
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      async (_reference, loaderOptions) => {
        if (++reads === 1) {
          loaderOptions?.onProgress?.({
            ...raw(),
            complete: false,
            resolutionComplete: true,
          })
          return first.promise
        }
        return second.promise
      }
    )
    const firstObserver = new QueryObserver(client, options)
    const leave = firstObserver.subscribe(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      getEventCatalogQueryDisplayState(firstObserver.getCurrentResult()).data
        ?.purchaseReady
    ).toBe(true)
    leave()
    const secondObserver = new QueryObserver(client, options)
    const stop = secondObserver.subscribe(() => {})
    try {
      expect(reads).toBe(2)
      const display = getEventCatalogQueryDisplayState(
        secondObserver.getCurrentResult()
      )
      expect(display.isHydrating).toBe(true)
      expect(display.data?.products).toHaveLength(1)
      expect(display.data?.purchaseReady).toBe(false)
      expect(display.data?.products[0]?.pickupFulfillment).toBeNull()
      second.resolve(raw())
      await client.fetchQuery(options)
      expect(
        getEventCatalogQueryDisplayState(secondObserver.getCurrentResult()).data
          ?.purchaseReady
      ).toBe(true)
    } finally {
      first.resolve(raw())
      second.resolve(raw())
      stop()
      client.clear()
    }
  })

  it("shares a matching pending detail/card query and reprices without another read", async () => {
    const client = new QueryClient()
    const pending = deferred<RawEventCatalog>()
    let reads = 0
    const loader: typeof loadRawEventCatalog = async () => {
      reads++
      return pending.promise
    }
    const first = client.fetchQuery(
      eventCatalogQueryOptions(
        client,
        collectionCoordinate,
        scope,
        () => true,
        loader
      )
    )
    const second = client.fetchQuery(
      eventCatalogQueryOptions(
        client,
        encodeEventMarketNaddr(collectionCoordinate),
        scope,
        () => true,
        loader
      )
    )
    const snapshot = raw()
    snapshot.resolution!.pickup!.price = 5
    snapshot.resolution!.pickup!.currency = "USD"
    pending.resolve(snapshot)
    const [detail, card] = await Promise.all([first, second])
    expect(detail).toBe(card)
    expect(reads).toBe(1)
    const quoteA = projectRawEventCatalog(detail, 50_000)
    const quoteB = projectRawEventCatalog(detail, 100_000)
    expect(quoteA.products[0]?.pickupFulfillment?.costSats).toBe(10_000)
    expect(quoteB.products[0]?.pickupFulfillment?.costSats).toBe(5_000)
    const resolution = resolveProductCartFulfillmentFromCatalogs(
      product(),
      getProductEventMarketCandidates(product()).map((candidate) => ({
        candidate,
        catalog: quoteB,
      }))
    )
    expect(resolution.status).toBe("pickup")
    expect(reads).toBe(1)
    client.clear()
  })

  it("canonicalizes coordinate and naddr while separating relay hints, principal and auth generation", () => {
    const key = eventCatalogQueryIdentity(collectionCoordinate, scope).queryKey
    expect(
      eventCatalogQueryIdentity(
        encodeEventMarketNaddr(collectionCoordinate),
        scope
      ).queryKey
    ).toEqual(key)
    const hints = ["wss://nos.lol", "wss://relay.conduit.market"]
    expect(
      eventCatalogQueryIdentity(
        encodeEventMarketNaddr(collectionCoordinate, hints),
        scope
      ).queryKey
    ).toEqual(
      eventCatalogQueryIdentity(
        encodeEventMarketNaddr(collectionCoordinate, hints.toReversed()),
        scope
      ).queryKey
    )
    expect(
      eventCatalogQueryIdentity(
        encodeEventMarketNaddr(collectionCoordinate, hints),
        scope
      ).queryKey
    ).not.toEqual(key)
    for (const changed of [
      { ...scope, relayScope: "relay-b" },
      { ...scope, authenticatedPubkey: merchant },
      { ...scope, authGeneration: 2 },
    ]) {
      expect(
        eventCatalogQueryIdentity(collectionCoordinate, changed).queryKey
      ).not.toEqual(key)
    }
  })

  type FocusRecoveryCase = {
    name: string
    load: () => Promise<RawEventCatalog>
    initialData?: RawEventCatalog
    staleTime?: number
    expectedReadsAfterFocus: number
    expectedError: boolean
    expectedComplete?: boolean
  }

  const focusRecoveryCases: FocusRecoveryCase[] = [
    {
      name: "does not restart a stale event read when the window regains focus",
      load: async () => raw(),
      staleTime: 0,
      expectedReadsAfterFocus: 1,
      expectedError: false,
      expectedComplete: true,
    },
    {
      name: "restarts a completed event read when every relay is unavailable",
      load: async () => {
        const catalog = raw()
        return {
          ...catalog,
          resolution: {
            ...catalog.resolution,
            coverage: {
              attemptedRelayCount: 2,
              completeRelayCount: 0,
              partialRelayCount: 0,
              failedRelayCount: 2,
            },
          },
        }
      },
      expectedReadsAfterFocus: 2,
      expectedError: false,
      expectedComplete: true,
    },
    {
      name: "restarts a stale incomplete event read when the window regains focus",
      load: async () => ({ ...raw(), complete: false }),
      expectedReadsAfterFocus: 2,
      expectedError: false,
      expectedComplete: false,
    },
    {
      name: "restarts a failed event read when the window regains focus",
      load: async () => {
        throw new Error("relay unavailable")
      },
      expectedReadsAfterFocus: 2,
      expectedError: true,
    },
    {
      name: "restarts a failed refresh that retained a completed event catalog",
      load: async () => {
        throw new Error("relay unavailable")
      },
      initialData: raw(),
      staleTime: 0,
      expectedReadsAfterFocus: 2,
      expectedError: true,
      expectedComplete: true,
    },
  ]

  for (const scenario of focusRecoveryCases) {
    it(scenario.name, async () => {
      const client = new QueryClient()
      let reads = 0
      const baseOptions = eventCatalogQueryOptions(
        client,
        collectionCoordinate,
        scope,
        () => true,
        async () => {
          reads++
          return scenario.load()
        }
      )
      if (scenario.initialData)
        client.setQueryData(baseOptions.queryKey, scenario.initialData)
      const observer = new QueryObserver(client, {
        ...baseOptions,
        ...(scenario.staleTime === undefined
          ? {}
          : { staleTime: scenario.staleTime }),
      })
      const release = observer.subscribe(() => {})
      const expectState = () => {
        const result = observer.getCurrentResult()
        expect(result.isError).toBe(scenario.expectedError)
        if (scenario.expectedComplete !== undefined)
          expect(result.data?.complete).toBe(scenario.expectedComplete)
      }

      try {
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(reads).toBe(1)
        expectState()

        client.getQueryCache().onFocus()
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(reads).toBe(scenario.expectedReadsAfterFocus)
        expectState()
      } finally {
        release()
        client.clear()
      }
    })
  }

  it("shows organizer-only cached cards without inventing acceptance or pickup authority", () => {
    const resolution = market("stale")
    resolution.acceptedProductCoordinates = []
    resolution.acceptedProductEvidence = []
    const projected = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution,
      previewRecords: [commerceRecord(product())],
      complete: false,
    })
    expect(projected.collection?.title).toBe("Summer Market")
    expect(projected.products).toHaveLength(1)
    expect(projected.products[0]?.participation.accepted).toBe(false)
    expect(projected.products[0]?.pickupFulfillment).toBeNull()
    expect(projected.purchaseReady).toBe(false)
    expect(projected.acceptedProductCount).toBe(0)
    const withdrawn = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution,
      previewRecords: [commerceRecord(product({ collectionRefs: [] }))],
      complete: false,
    })
    expect(withdrawn.products).toHaveLength(0)
  })

  it("strips completed pickup authorization during refresh or after failure", () => {
    expect(
      projectRawEventCatalog(raw()).products[0]?.pickupFulfillment
    ).not.toBeNull()
    const projected = projectRawEventCatalog(raw(), null, false)
    expect(projected.products).toHaveLength(1)
    expect(projected.purchaseReady).toBe(false)
    expect(projected.products[0]?.participation.purchaseReady).toBe(false)
    expect(projected.products[0]?.pickupFulfillment).toBeNull()
  })

  it("publishes a browse-only header before completion and retains no authority after failure", async () => {
    const client = new QueryClient()
    const pending = deferred<RawEventCatalog>()
    const loader: typeof loadRawEventCatalog = async (_reference, options) => {
      options?.onProgress?.({ ...raw(), complete: true })
      return pending.promise
    }
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      loader
    )
    const observer = new QueryObserver(client, options)
    const release = observer.subscribe(() => {})
    expect(observer.getCurrentResult().data?.complete).toBe(false)
    expect(
      projectRawEventCatalog(observer.getCurrentResult().data!).purchaseReady
    ).toBe(false)
    pending.reject(new Error("relay unavailable"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(observer.getCurrentResult().isError).toBe(true)
    expect(
      projectRawEventCatalog(observer.getCurrentResult().data!).purchaseReady
    ).toBe(false)
    release()
    client.clear()
  })

  it("ignores late progress and rejects final results after the auth scope changes", async () => {
    const client = new QueryClient()
    const pending = deferred<RawEventCatalog>()
    let emit: ((snapshot: RawEventCatalog) => void) | undefined
    let active = true
    const loader: typeof loadRawEventCatalog = async (_reference, options) => {
      emit = options?.onProgress
      return pending.promise
    }
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => active,
      loader
    )
    const running = client.fetchQuery(options)
    active = false
    emit?.(raw())
    expect(client.getQueryData(options.queryKey)).toBeUndefined()
    pending.resolve(raw())
    await expect(running).rejects.toThrow("cancelled")
    expect(client.getQueryData(options.queryKey)).toBeUndefined()
    client.clear()
  })

  it("cancels the shared transport only after its last observer leaves", async () => {
    const client = new QueryClient()
    const pending = deferred<RawEventCatalog>()
    let signal: AbortSignal | undefined
    const loader: typeof loadRawEventCatalog = async (_reference, options) => {
      signal = options?.signal
      return pending.promise
    }
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      loader
    )
    const detail = new QueryObserver(client, options)
    const card = new QueryObserver(client, options)
    const stopDetail = detail.subscribe(() => {})
    const stopCard = card.subscribe(() => {})
    stopDetail()
    expect(signal?.aborted).toBe(false)
    stopCard()
    expect(signal?.aborted).toBe(true)
    pending.resolve(raw())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.getQueryData(options.queryKey)).toBeUndefined()
    client.clear()
  })
  it("preserves a stale completed browse catalog and a hidden signed cache entry", () => {
    const resolution = market("stale")
    resolution.acceptedProductCoordinates = []
    resolution.acceptedProductEvidence = []
    const projected = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution,
      previewRecords: [commerceRecord(product({ visibility: "private" }))],
      complete: true,
    })
    expect(projected.products).toHaveLength(1)
    expect(projected.purchaseReady).toBe(false)
    expect(projected.productReadState).toBe("unavailable")
  })

  it("retains safe hidden family choices while excluding unsafe and organizer-unlisted children", () => {
    const parent = product({
      type: "variable",
      visibility: "private",
      images: [],
    })
    const child = (
      suffix: string,
      visibility: Product["visibility"] = "private"
    ) =>
      product({
        id: `30402:${merchant}:${suffix}`,
        type: "variation",
        visibility,
        parentProductId: parent.id,
        specifications: [{ key: "size", value: suffix }],
      })
    const good = child("good")
    const unsafe = child("unsafe", "public")
    const unlisted = child("unlisted", "public")
    const records = [parent, good, unsafe, unlisted].map((entry) =>
      commerceRecord(entry)
    )
    const prepared = prepareProductCatalog(records, {
      source: "local_cache",
      stale: true,
      degraded: true,
      capped: false,
      fetchedAt: 1,
    }).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected fixture family")
    const unsafeRecord = prepared.family.children.find(
      (entry) => entry.product.id === unsafe.id
    )!
    unsafeRecord.safety = {
      ...unsafeRecord.safety,
      state: "blocked",
      source: "external_decision",
    }
    const resolution = market("stale")
    resolution.organizerProductCoordinates = [parent.id, good.id, unsafe.id]
    resolution.acceptedProductCoordinates = []
    resolution.acceptedProductEvidence = []
    const rawFamily = { ...prepared.family.parent, family: prepared.family }
    const projected = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution,
      previewRecords: [rawFamily],
      complete: false,
    })
    expect(projected.products).toHaveLength(1)
    expect(
      projected.products[0]?.family?.children.map((entry) => entry.product.id)
    ).toEqual([good.id])
    expect(projected.products[0]?.pickupFulfillment).toBeNull()
    expect(projected.products[0]?.familyPickupFulfillments).toBeUndefined()
    expect(projected.unresolvedProductCoordinates).toEqual([unsafe.id])
    expect(projected.purchaseReady).toBe(false)

    // The same eligible child remains selectable when exact live acceptance
    // arrives; unsafe and organizer-unlisted children still stay excluded.
    const liveResolution = {
      ...resolution,
      state: "active" as const,
      acceptedProductCoordinates: [parent.id, good.id, unsafe.id],
      acceptedProductEvidence: records
        .filter((entry) => entry.product.id !== unlisted.id)
        .map((entry) => ({
          productCoordinate: entry.product.id,
          eventId: entry.eventId,
          createdAt: entry.eventCreatedAt * 1_000,
          shippingOptionCoordinates: [pickupCoordinate],
          merchantPubkey: merchant,
        })),
    }
    const result = productRead()
    result.data = [rawFamily, ...prepared.family.children]
    result.diagnostics = result.data.map((entry) => ({
      productId: entry.product.id,
      addressId: entry.product.id,
      issue: null,
      coverage: { listing: "complete", deletion: "complete" },
    }))
    const live = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution: liveResolution,
      result,
      complete: true,
    })
    expect(
      live.products[0]?.family?.children.map((entry) => entry.product.id)
    ).toEqual([good.id])
    const retainedFamily = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution: liveResolution,
      result: {
        ...result,
        diagnostics: result.diagnostics.map((entry) => ({
          ...entry,
          issue: "cached_only",
        })),
      },
      complete: false,
      resolutionComplete: true,
    })
    expect(retainedFamily.products).toHaveLength(1)
    expect(
      retainedFamily.products[0]?.family?.children.map(
        (entry) => entry.product.id
      )
    ).toEqual([good.id])
    expect(retainedFamily.products[0]?.pickupFulfillment).toBeNull()
    expect(retainedFamily.products[0]?.familyPickupFulfillments).toEqual({
      [good.id]: null,
    })
  })

  it("retains an atomic contextual child even when its parent is not organizer-listed", () => {
    const atomic = commerceRecord(
      product({
        id: `30402:${merchant}:atomic`,
        type: "variation",
        parentProductId: productCoordinate,
        specifications: [{ key: "size", value: "Atomic" }],
      })
    )
    atomic.safety = evaluateListingSafety(atomic.product, undefined, {
      variationGroupRole: "variation",
      hasGroupImage: true,
    })
    const resolution = market("stale")
    resolution.organizerProductCoordinates = [atomic.product.id]
    resolution.acceptedProductCoordinates = []
    resolution.acceptedProductEvidence = []
    const projected = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution,
      previewRecords: [atomic],
      complete: false,
    })
    expect(projected.products.map((entry) => entry.product.id)).toEqual([
      atomic.product.id,
    ])
    expect(projected.products[0]?.pickupFulfillment).toBeNull()
  })
  it("waits for reconciled cache records before restoring cards and retracts stronger negative evidence", async () => {
    const client = new QueryClient()
    const pending = deferred<RawEventCatalog>()
    let emit: ((snapshot: RawEventCatalog) => void) | undefined
    const loader: typeof loadRawEventCatalog = async (_reference, options) => {
      emit = options?.onProgress
      return pending.promise
    }
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      loader
    )
    client.setQueryData(options.queryKey, raw(), {
      updatedAt: Date.now() - 61_000,
    })
    const refresh = client.fetchQuery(options)
    const resolution = market("stale")
    resolution.acceptedProductCoordinates = []
    resolution.acceptedProductEvidence = []
    emit?.({ reference: collectionCoordinate, resolution, complete: false })
    const header = projectRawEventCatalog(
      client.getQueryData(options.queryKey)!
    )
    expect(header.products).toHaveLength(0)
    expect(header.collection?.title).toBe("Summer Market")
    emit?.({
      reference: collectionCoordinate,
      resolution,
      previewRecords: [commerceRecord(product())],
      complete: false,
    })
    const retained = projectRawEventCatalog(
      client.getQueryData(options.queryKey)!
    )
    expect(retained.products).toHaveLength(1)
    expect(retained.purchaseReady).toBe(false)
    const withdrawn = {
      ...resolution,
      browseExcludedProductCoordinates: [productCoordinate],
    }
    emit?.({
      reference: collectionCoordinate,
      resolution: withdrawn,
      complete: false,
    })
    const removed = projectRawEventCatalog(
      client.getQueryData(options.queryKey)!
    )
    expect(removed.products).toHaveLength(0)
    expect(removed.unresolvedProductCoordinates).toHaveLength(0)
    pending.resolve({
      reference: collectionCoordinate,
      resolution: withdrawn,
      complete: true,
    })
    await refresh
    client.clear()
  })
  it("blocks an older shared catalog when the product surface observes a newer signed revision", () => {
    const current = projectRawEventCatalog(raw())
    const newer = product({ createdAt: 104_000, updatedAt: 104_000 })
    const candidates = getProductEventMarketCandidates(newer)
    const blocked = resolveProductCartFulfillmentFromCatalogs(
      newer,
      candidates.map((candidate) => ({ candidate, catalog: current }))
    )
    expect(blocked.status).toBe("blocked")
    if (blocked.status === "blocked")
      expect(blocked.reason).toContain("newer product revision")
    const refreshedRaw = raw()
    refreshedRaw.resolution!.acceptedProductEvidence[0]!.createdAt = 104_000
    refreshedRaw.result = productRead({ product: newer, eventCreatedAt: 104 })
    const refreshed = resolveProductCartFulfillmentFromCatalogs(
      newer,
      candidates.map((candidate) => ({
        candidate,
        catalog: projectRawEventCatalog(refreshedRaw),
      }))
    )
    expect(refreshed.status).toBe("pickup")
    expect(refreshed.product.createdAt).toBe(104_000)
  })
  it("reconciles equal-timestamp price and reference changes once without treating quote values as source changes", () => {
    const catalog = projectRawEventCatalog(raw())
    const attempted = new Set<string>()
    const changedPrice = product({ price: 9_000, priceSats: 9_000 })
    const changedRefs = product({
      shippingOptionRefs: [
        {
          coordinate: pickupCoordinate,
          extraCost: {
            amount: 500,
            currency: "SATS",
            normalizedCurrency: "SATS",
          },
        },
      ],
    })
    const changedCollections = product({
      collectionRefs: [collectionCoordinate, `30405:${organizer}:another`],
    })
    for (const changed of [changedPrice, changedRefs, changedCollections]) {
      expect(eventCatalogNeedsProductRefresh(changed, catalog)).toBe(true)
      const blocked = resolveProductCartFulfillmentFromCatalogs(
        changed,
        getProductEventMarketCandidates(changed).map((candidate) => ({
          candidate,
          catalog,
        }))
      )
      expect(blocked.status).toBe("blocked")
      expect(
        takeEventCatalogProductRefreshObservations(
          [changed],
          catalog,
          "account-a",
          attempted
        )
      ).toEqual([changed])
      expect(
        takeEventCatalogProductRefreshObservations(
          [changed],
          catalog,
          "account-a",
          attempted
        )
      ).toEqual([])
    }
    const converted = product({ priceSats: 987_654, shippingCostSats: 123_456 })
    expect(getEventCatalogProductSourceObservation(converted)).toBe(
      getEventCatalogProductSourceObservation(product())
    )
    expect(eventCatalogNeedsProductRefresh(converted, catalog)).toBe(false)
    expect(
      takeEventCatalogProductRefreshObservations(
        [converted],
        catalog,
        "account-a",
        attempted
      )
    ).toEqual([])
    expect(
      takeEventCatalogProductRefreshObservations(
        [changedPrice],
        catalog,
        "account-b",
        attempted
      )
    ).toEqual([changedPrice])
    const reconciled = raw()
    reconciled.result = productRead({ product: changedPrice })
    const settled = projectRawEventCatalog(reconciled)
    expect(eventCatalogNeedsProductRefresh(changedPrice, settled)).toBe(false)
    expect(
      resolveProductCartFulfillmentFromCatalogs(
        changedPrice,
        getProductEventMarketCandidates(changedPrice).map((candidate) => ({
          candidate,
          catalog: settled,
        }))
      ).status
    ).toBe("pickup")
  })

  it("rereads an absent product once per scoped source observation and never grants stale pickup", async () => {
    const client = new QueryClient()
    const absent = raw()
    absent.result = productRead({ includeRecord: false })
    const attempted = new Set<string>()
    let reads = 0
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      async () => {
        reads++
        return absent
      }
    )
    client.setQueryData(options.queryKey, absent)
    for (let render = 0; render < 3; render++) {
      const catalog = projectRawEventCatalog(
        client.getQueryData(options.queryKey)!
      )
      const pending = takeEventCatalogProductRefreshObservations(
        [product()],
        catalog,
        "account-a",
        attempted
      )
      if (pending.length > 0) {
        await client.invalidateQueries({
          queryKey: options.queryKey,
          refetchType: "none",
        })
        await client.fetchQuery(options)
      }
      expect(
        resolveProductCartFulfillmentFromCatalogs(
          product(),
          getProductEventMarketCandidates(product()).map((candidate) => ({
            candidate,
            catalog,
          }))
        ).status
      ).toBe("blocked")
    }
    expect(reads).toBe(1)
    const changed = product({ stock: 4 })
    expect(
      takeEventCatalogProductRefreshObservations(
        [changed],
        projectRawEventCatalog(absent),
        "account-a",
        attempted
      )
    ).toEqual([changed])
    expect(
      takeEventCatalogProductRefreshObservations(
        [changed],
        projectRawEventCatalog(absent),
        "account-a",
        attempted
      )
    ).toEqual([])
    client.clear()
  })

  it("accepts a newer authoritative catalog revision without refreshing for an older source observation", () => {
    const newerProduct = product({
      price: 5_000,
      priceSats: 5_000,
      createdAt: 104_000,
      updatedAt: 104_000,
    })
    const newer = raw()
    newer.resolution!.acceptedProductEvidence[0]!.createdAt = 104_000
    newer.result = productRead({ product: newerProduct, eventCreatedAt: 104 })
    const catalog = projectRawEventCatalog(newer)
    expect(eventCatalogNeedsProductRefresh(product(), catalog)).toBe(false)
    expect(
      takeEventCatalogProductRefreshObservations(
        [product()],
        catalog,
        "account-a",
        new Set()
      )
    ).toEqual([])
    const resolution = resolveProductCartFulfillmentFromCatalogs(
      product(),
      getProductEventMarketCandidates(product()).map((candidate) => ({
        candidate,
        catalog,
      }))
    )
    expect(resolution.status).toBe("pickup")
    expect(resolution.product.price).toBe(5_000)
    expect(resolution.product.createdAt).toBe(104_000)
  })

  it("compares folded children against exact child terms and never borrows parent authorization", () => {
    const parent = product({ type: "variable" })
    const child = product({
      id: `30402:${merchant}:child`,
      type: "variation",
      parentProductId: parent.id,
      specifications: [{ key: "Size", value: "Small" }],
    })
    const records = [commerceRecord(parent), commerceRecord(child)]
    const prepared = prepareProductCatalog(records, {
      source: "commerce",
      stale: false,
      degraded: false,
      capped: false,
      fetchedAt: 1,
    }).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected fixture family")
    const snapshot = raw()
    snapshot.resolution!.organizerProductCoordinates = [parent.id, child.id]
    snapshot.resolution!.acceptedProductCoordinates = [parent.id, child.id]
    snapshot.resolution!.acceptedProductEvidence.push({
      ...snapshot.resolution!.acceptedProductEvidence[0]!,
      productCoordinate: child.id,
    })
    snapshot.result!.data = [
      { ...prepared.family.parent, family: prepared.family },
      ...prepared.family.children,
    ]
    snapshot.result!.diagnostics = snapshot.result!.data.map((record) => ({
      productId: record.product.id,
      addressId: record.product.id,
      issue: null,
      coverage: { listing: "complete", deletion: "complete" },
    }))
    const catalog = projectRawEventCatalog(snapshot)
    const resolve = (candidateProduct: Product) =>
      resolveProductCartFulfillmentFromCatalogs(
        candidateProduct,
        getProductEventMarketCandidates(candidateProduct).map((candidate) => ({
          candidate,
          catalog,
        }))
      )
    expect(catalog.products).toHaveLength(1)
    expect(eventCatalogNeedsProductRefresh(child, catalog)).toBe(false)
    expect(resolve(child).status).toBe("pickup")
    const changed = { ...child, price: 9_000, priceSats: 9_000 }
    expect(eventCatalogNeedsProductRefresh(changed, catalog)).toBe(true)
    expect(resolve(changed).status).toBe("blocked")
    const attempted = new Set<string>()
    expect(
      takeEventCatalogProductRefreshObservations(
        [changed],
        catalog,
        "account-a",
        attempted
      )
    ).toEqual([changed])
    expect(
      takeEventCatalogProductRefreshObservations(
        [changed],
        catalog,
        "account-a",
        attempted
      )
    ).toEqual([])
    catalog.products[0]!.familyPickupFulfillments![child.id] = null
    expect(resolve(child).status).toBe("blocked")
  })
})
