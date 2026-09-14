import { describe, expect, it } from "bun:test"
import {
  onlineManager,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query"
import {
  evaluateListingSafety,
  type CommerceProductRecord,
  type EventMarketResolution,
  type Product,
  type ProductsByIdsResult,
} from "@conduit/core"
import { getEventActionabilityPresentation } from "@conduit/ui"
import {
  eventCatalogQueryOptions,
  type EventCatalogQueryScope,
} from "../src/lib/event-catalog-query"
import {
  projectRawEventCatalog,
  type RawEventCatalog,
} from "../src/lib/event-market-adapter"
import { getEventCatalogQueryDisplayState } from "../src/lib/event-catalog-query-state"

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

describe("event catalog refresh presentation", () => {
  it("retains cards but exposes stale evidence after a no-progress refetch failure", async () => {
    const client = new QueryClient()
    const pending = deferred<RawEventCatalog>()
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      async () => pending.promise
    )
    const retained = raw()
    const before = JSON.stringify(retained)
    client.setQueryData(options.queryKey, retained)
    const observer = new QueryObserver(client, options)
    const release = observer.subscribe(() => {})
    try {
      expect(projectRawEventCatalog(retained).purchaseReady).toBe(true)
      pending.reject(new Error("read failed before progress"))
      await new Promise((resolve) => setTimeout(resolve, 0))
      const query = observer.getCurrentResult()
      expect(query.isError).toBe(true)
      const display = getEventCatalogQueryDisplayState(query)
      expect(display.isHydrating).toBe(false)
      expect(display.isInitialLoading).toBe(false)
      expect(display.data?.products).toHaveLength(1)
      expect(display.data?.purchaseReady).toBe(false)
      expect(display.data?.products[0]?.pickupFulfillment).toBeNull()
      expect(display.data?.state).toBe("stale")
      expect(
        getEventActionabilityPresentation({
          state: display.data!.state,
          availableProductCount: 0,
        })
      ).toMatchObject({ label: "Event evidence is stale", prominent: true })
      expect(JSON.stringify(client.getQueryData(options.queryKey))).toBe(before)
    } finally {
      release()
      client.clear()
    }
  })

  it("retains cards as stale and blocks pickup while a refresh is paused", () => {
    const client = new QueryClient()
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      async () => raw()
    )
    client.setQueryData(options.queryKey, raw())
    onlineManager.setOnline(false)
    const observer = new QueryObserver(client, options)
    const release = observer.subscribe(() => {})
    try {
      const query = observer.getCurrentResult()
      expect(query.isPaused).toBe(true)
      const display = getEventCatalogQueryDisplayState(query)
      expect(display.isHydrating).toBe(false)
      expect(display.data?.state).toBe("stale")
      expect(display.data?.products).toHaveLength(1)
      expect(display.data?.purchaseReady).toBe(false)
      expect(display.data?.products[0]?.pickupFulfillment).toBeNull()
    } finally {
      release()
      client.clear()
      onlineManager.setOnline(true)
    }
  })

  it("marks retained partial success stale after a failed refresh", () => {
    const retained = { ...raw(), resolution: market("partial") }
    const display = getEventCatalogQueryDisplayState({
      data: retained,
      isError: true,
      isFetching: false,
      isPaused: false,
      isPending: false,
    })
    expect(display.data?.state).toBe("stale")
    expect(display.data?.products).toHaveLength(1)
    expect(display.data?.purchaseReady).toBe(false)
    expect(display.data?.products[0]?.pickupFulfillment).toBeNull()
    expect(retained.resolution.state).toBe("partial")
  })

  it("keeps terminal states and the raw cache unchanged", () => {
    for (const state of [
      "deleted",
      "conflict",
      "ended",
      "malformed",
      "missing",
      "unavailable",
    ] as const) {
      const retained = { ...raw(), resolution: market(state) }
      const before = JSON.stringify(retained)
      const display = getEventCatalogQueryDisplayState({
        data: retained,
        isError: true,
        isFetching: false,
        isPaused: false,
        isPending: false,
      })
      expect(display.data?.state).toBe(state)
      expect(display.data?.purchaseReady).toBe(false)
      expect(JSON.stringify(retained)).toBe(before)
    }
  })

  it("keeps active retries checking and restores authority only after success", () => {
    const retained = raw()
    const query = {
      data: retained,
      isError: false,
      isFetching: true,
      isPaused: false,
      isPending: false,
    }
    expect(getEventCatalogQueryDisplayState(query)).toMatchObject({
      isHydrating: true,
      data: { purchaseReady: false },
    })
    expect(
      getEventCatalogQueryDisplayState({ ...query, isFetching: false })
    ).toMatchObject({
      isHydrating: false,
      data: { state: "active", purchaseReady: true },
    })
    expect(
      getEventCatalogQueryDisplayState({
        ...query,
        data: undefined,
        isPending: true,
      })
    ).toMatchObject({ isInitialLoading: true })
  })
})
