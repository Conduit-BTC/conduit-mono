import { describe, expect, it } from "bun:test"
import {
  evaluateListingSafety,
  resolveEventMarketProductParticipation,
  prepareProductCatalog,
  type CommerceProductRecord,
  type EventMarketResolution,
  type Product,
  type ProductsByIdsResult,
} from "@conduit/core"
import {
  buildPickupFulfillmentSnapshot,
  buildPickupFulfillmentTerms,
  buildEventCatalogFamilyPickupFulfillments,
  getCartEventFulfillmentBlock,
  getProductEventMarketCandidates,
  pickupItemMatchesCanonicalSnapshot,
  projectEventCatalogHydration,
  projectEventCatalogProducts,
  resolveProductCartFulfillment,
  type EventCatalog,
  type PickupFreshnessItem,
} from "../apps/market/src/lib/event-market-adapter"
import {
  createCartItemFromProduct,
  type CartPickupFulfillment,
} from "../apps/market/src/lib/cart-model"

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

function merchantOwnedMarket(): EventMarketResolution {
  const base = market()
  const ownedCollection = `30405:${merchant}:merchant-market`
  const ownedCalendar = `31923:${merchant}:merchant-market`
  const ownedPickup = `30406:${merchant}:merchant-market-pickup`
  const pickup = {
    ...base.pickup!,
    coordinate: ownedPickup,
    authorPubkey: merchant,
    dTag: "merchant-market-pickup",
  }
  return {
    ...base,
    reference: ownedCollection,
    organizerPubkey: merchant,
    collectionCoordinate: ownedCollection,
    calendarCoordinate: ownedCalendar,
    pickupCoordinate: ownedPickup,
    collection: {
      ...base.collection!,
      coordinate: ownedCollection,
      authorPubkey: merchant,
      dTag: "merchant-market",
      eventCoordinates: [ownedCalendar],
      pickupCoordinates: [ownedPickup],
    },
    calendar: {
      ...base.calendar!,
      coordinate: ownedCalendar,
      authorPubkey: merchant,
      dTag: "merchant-market",
    },
    pickup,
    pickups: [pickup],
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

function marketWithAcceptedRecords(
  records: readonly CommerceProductRecord[],
  requested: readonly string[] = records.map((record) => record.product.id),
  base: EventMarketResolution = market()
): EventMarketResolution {
  const recordsByCoordinate = new Map(
    records.map((record) => [record.product.id, record])
  )
  return {
    ...base,
    collection: {
      ...base.collection!,
      productCoordinates: [...requested],
    },
    organizerProductCoordinates: [...requested],
    acceptedProductCoordinates: [...requested],
    acceptedProductEvidence: requested.map((productCoordinate) => {
      const record = recordsByCoordinate.get(productCoordinate)
      if (!record) {
        throw new Error(`Missing accepted record for ${productCoordinate}`)
      }
      return {
        productCoordinate,
        eventId: record.eventId,
        createdAt: record.eventCreatedAt * 1_000,
        shippingOptionCoordinates:
          record.product.shippingOptionRefs?.map(
            (reference) => reference.coordinate
          ) ?? [],
        merchantPubkey: record.product.pubkey,
      }
    }),
    organizerOnlyProductCoordinates: [],
    participationRequests: requested.map((productCoordinate) => ({
      productCoordinate,
      merchantPubkey:
        recordsByCoordinate.get(productCoordinate)!.product.pubkey,
    })),
  }
}

function pickupSnapshot(): CartPickupFulfillment {
  const snapshot = buildPickupFulfillmentSnapshot(
    product(),
    market(),
    { eventId: "4".repeat(64), eventCreatedAt: 103 },
    null
  )
  if (!snapshot) throw new Error("Expected canonical pickup snapshot")
  return snapshot
}

function catalog(
  catalogProduct: Product = product(),
  overrides: Partial<EventCatalog> = {},
  resolution: EventMarketResolution = market()
): EventCatalog {
  const snapshot = buildPickupFulfillmentSnapshot(
    catalogProduct,
    resolution,
    { eventId: "4".repeat(64), eventCreatedAt: 103 },
    null
  )
  return {
    state: resolution.state,
    reference: collectionCoordinate,
    canonicalNaddr: "naddr1test",
    organizerPubkey: organizer,
    collection: resolution.collection,
    calendar: resolution.calendar,
    pickup: resolution.pickup,
    pickups: resolution.pickups,
    products: [
      {
        product: catalogProduct,
        evidenceState: "live",
        participation: resolveEventMarketProductParticipation(
          catalogProduct,
          resolution
        ),
        pickupFulfillment: snapshot,
      },
    ],
    acceptedProductCount: 1,
    unresolvedProductCoordinates: [],
    productReadState: "ready",
    purchaseReady: true,
    ...overrides,
  }
}

function pickupItem(
  fulfillment: CartPickupFulfillment = pickupSnapshot()
): PickupFreshnessItem & { fulfillment: CartPickupFulfillment } {
  return {
    productId: productCoordinate,
    merchantPubkey: merchant,
    format: "physical",
    fulfillment,
    shippingOptionId: pickupCoordinate,
    shippingOptionDTag: "summer-market-pickup",
    shippingCostSats: fulfillment.costSats,
    sourceShippingCost: { ...fulfillment.sourceCost },
  }
}

function clonePickupItem(
  item: ReturnType<typeof pickupItem>
): ReturnType<typeof pickupItem> {
  return JSON.parse(JSON.stringify(item)) as ReturnType<typeof pickupItem>
}

describe("Market event adapter", () => {
  it("keeps a retained accepted product visible without making it purchasable", () => {
    const projection = projectEventCatalogHydration({
      resolution: market("stale"),
      result: productRead({
        issue: "lookup_unavailable",
        source: "local_cache",
        stale: true,
        listing: "unavailable",
      }),
    })

    expect(projection.productReadState).toBe("unavailable")
    expect(projection.acceptedProductCount).toBe(1)
    expect(projection.unresolvedProductCoordinates).toEqual([])
    expect(projection.products).toHaveLength(1)
    expect(projection.products[0]!.evidenceState).toBe("retained")
    expect(projection.products[0]!.pickupFulfillment).toBeNull()
  })

  it("keeps exact per-product live evidence purchasable when the wider batch is stale", () => {
    const projection = projectEventCatalogHydration({
      resolution: market(),
      result: productRead({ stale: true }),
    })

    expect(projection.productReadState).toBe("ready")
    expect(projection.products).toHaveLength(1)
    expect(projection.products[0]!.evidenceState).toBe("live")
    expect(projection.products[0]!.pickupFulfillment).not.toBeNull()
  })

  it("preserves unresolved acceptance under an unavailable read without inventing product details", () => {
    const projection = projectEventCatalogHydration({
      resolution: market("partial"),
      result: productRead({
        includeRecord: false,
        issue: "lookup_unavailable",
        source: "local_cache",
        stale: true,
        listing: "unavailable",
      }),
    })

    expect(projection.productReadState).toBe("unavailable")
    expect(projection.acceptedProductCount).toBe(1)
    expect(projection.products).toEqual([])
    expect(projection.unresolvedProductCoordinates).toEqual([productCoordinate])
  })

  it("retains safe cached products while isolating exact live purchase evidence", () => {
    const liveRecord = commerceRecord(product({ visibility: "private" }))
    const unresolvedRecord = commerceRecord(
      product({
        id: "30402:" + merchant + ":tea",
        title: "Tea",
        visibility: "private",
      })
    )
    const cachedRecord = commerceRecord(
      product({
        id: "30402:" + merchant + ":cached-tea",
        title: "Cached tea",
        visibility: "private",
      })
    )
    const acceptedCoordinates = [
      liveRecord.product.id,
      unresolvedRecord.product.id,
      cachedRecord.product.id,
    ]
    const resolution = marketWithAcceptedRecords(
      [liveRecord, unresolvedRecord, cachedRecord],
      acceptedCoordinates
    )

    const projected = projectEventCatalogHydration({
      resolution,
      result: {
        data: [liveRecord, cachedRecord],
        diagnostics: [
          {
            productId: liveRecord.product.id,
            addressId: liveRecord.product.id,
            issue: null,
            coverage: { listing: "complete", deletion: "partial" },
          },
          {
            productId: unresolvedRecord.product.id,
            addressId: unresolvedRecord.product.id,
            issue: "lookup_partial",
            coverage: { listing: "partial", deletion: "partial" },
          },
          {
            productId: cachedRecord.product.id,
            addressId: cachedRecord.product.id,
            issue: "cached_only",
            coverage: { listing: "complete", deletion: "partial" },
          },
        ],
        meta: {
          source: "local_cache",
          fetchedAt: 104_000,
          stale: true,
          degraded: true,
          capped: false,
          capabilities: {
            sortModes: [],
            textSearch: false,
            protectedSummaries: false,
            canonicalFreshness: true,
            cursorPagination: false,
          },
        },
      },
    })

    expect(projected.productReadState).toBe("partial")
    expect(projected.acceptedProductCount).toBe(3)
    expect(projected.unresolvedProductCoordinates).toEqual([
      unresolvedRecord.product.id,
    ])
    expect(
      projected.products.map(({ product: candidate }) => candidate.id)
    ).toEqual([liveRecord.product.id, cachedRecord.product.id])
    expect(projected.products[0]!.evidenceState).toBe("live")
    expect(projected.products[0]!.pickupFulfillment).not.toBeNull()
    expect(projected.products[1]!.evidenceState).toBe("retained")
    expect(projected.products[1]!.pickupFulfillment).toBeNull()
  })

  it("distinguishes a complete empty organizer collection from degraded hydration", () => {
    const resolution: EventMarketResolution = {
      ...market(),
      collection: {
        ...market().collection!,
        productCoordinates: [],
      },
      organizerProductCoordinates: [],
      acceptedProductCoordinates: [],
      acceptedProductEvidence: [],
      organizerOnlyProductCoordinates: [],
      participationRequests: [],
    }
    const projection = projectEventCatalogHydration({
      resolution,
      result: { ...productRead({ includeRecord: false }), diagnostics: [] },
    })

    expect(projection.productReadState).toBe("ready")
    expect(projection.acceptedProductCount).toBe(0)
    expect(projection.products).toEqual([])
    expect(projection.unresolvedProductCoordinates).toEqual([])
  })

  it("does not erase accepted evidence from a bounded product-missing result", () => {
    const projection = projectEventCatalogHydration({
      resolution: market("partial"),
      result: productRead({
        includeRecord: false,
        issue: "product_missing",
      }),
    })

    expect(projection.productReadState).toBe("partial")
    expect(projection.acceptedProductCount).toBe(1)
    expect(projection.products).toEqual([])
    expect(projection.unresolvedProductCoordinates).toEqual([productCoordinate])
  })

  it("never invents acceptance from organizer-only coordinates", () => {
    const resolution: EventMarketResolution = {
      ...market("partial"),
      acceptedProductCoordinates: [],
      acceptedProductEvidence: [],
      organizerOnlyProductCoordinates: [productCoordinate],
      participationRequests: [],
    }
    const projection = projectEventCatalogHydration({
      resolution,
      result: productRead(),
    })

    expect(projection.productReadState).toBe("ready")
    expect(projection.acceptedProductCount).toBe(0)
    expect(projection.products).toEqual([])
    expect(projection.unresolvedProductCoordinates).toEqual([])
  })

  it("honors a newer signed merchant withdrawal", () => {
    const withdrawnProduct = product({
      collectionRefs: [],
      createdAt: 104_000,
      updatedAt: 104_000,
    })
    const projection = projectEventCatalogHydration({
      resolution: market("partial"),
      result: productRead({
        product: withdrawnProduct,
        issue: "lookup_unavailable",
        source: "local_cache",
        stale: true,
        listing: "unavailable",
        eventCreatedAt: 104,
      }),
    })

    expect(projection.productReadState).toBe("ready")
    expect(projection.acceptedProductCount).toBe(0)
    expect(projection.products).toEqual([])
    expect(projection.unresolvedProductCoordinates).toEqual([])
  })

  it("does not let an older retained no-ref revision impersonate newer accepted evidence", () => {
    const resolution: EventMarketResolution = {
      ...market("partial"),
      acceptedProductEvidence: [
        {
          productCoordinate,
          eventId: "3".repeat(64),
          createdAt: 104_000,
          shippingOptionCoordinates: [pickupCoordinate],
          merchantPubkey: merchant,
        },
      ],
    }
    const projection = projectEventCatalogHydration({
      resolution,
      result: productRead({
        product: product({ collectionRefs: [] }),
        issue: "lookup_unavailable",
        source: "local_cache",
        stale: true,
        listing: "unavailable",
        eventId: "4".repeat(64),
        eventCreatedAt: 103,
      }),
    })

    expect(projection.productReadState).toBe("unavailable")
    expect(projection.acceptedProductCount).toBe(1)
    expect(projection.products).toEqual([])
    expect(projection.unresolvedProductCoordinates).toEqual([productCoordinate])
  })

  it("keeps a live variable parent and retained child visible without authorizing the child", () => {
    const parent = product({ type: "variable", visibility: "private" })
    const child = product({
      id: "30402:" + merchant + ":coffee-cached-child",
      title: "Coffee - Cached child",
      type: "variation",
      visibility: "private",
      parentProductId: parent.id,
      specifications: [{ key: "size", value: "Cached" }],
      createdAt: 104_000,
      updatedAt: 104_000,
    })
    const rawRecords = [
      commerceRecord(parent),
      commerceRecord(child, { eventId: "5".repeat(64) }),
    ]
    const prepared = prepareProductCatalog(rawRecords, {
      source: "commerce",
      fetchedAt: 105_000,
      stale: false,
      degraded: false,
      capped: false,
    }).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected family")

    const requested = [parent.id, child.id]
    const resolution = marketWithAcceptedRecords(rawRecords, requested)
    const parentRecord = {
      ...prepared.family.parent,
      family: prepared.family,
    }
    const childRecord = prepared.family.children[0]!

    const projected = projectEventCatalogHydration({
      resolution,
      result: {
        data: [parentRecord, childRecord],
        diagnostics: [
          {
            productId: parent.id,
            addressId: parent.id,
            issue: null,
            coverage: { listing: "complete", deletion: "partial" },
          },
          {
            productId: child.id,
            addressId: child.id,
            issue: "cached_only",
            coverage: { listing: "complete", deletion: "partial" },
          },
        ],
        meta: {
          source: "local_cache",
          fetchedAt: 105_000,
          stale: true,
          degraded: true,
          capped: false,
          capabilities: {
            sortModes: [],
            textSearch: false,
            protectedSummaries: false,
            canonicalFreshness: true,
            cursorPagination: false,
          },
        },
      },
    })

    expect(projected.productReadState).toBe("partial")
    expect(projected.unresolvedProductCoordinates).toEqual([])
    expect(projected.products).toHaveLength(1)
    expect(projected.products[0]!.product.id).toBe(parent.id)
    expect(projected.products[0]!.family?.state).toBe("ready")
    expect(
      projected.products[0]!.family?.children.map(
        (candidate) => candidate.product.id
      )
    ).toEqual([child.id])
    expect(projected.products[0]!.familyPickupFulfillments).toEqual({
      [child.id]: null,
    })
  })

  it("renders an exact merchant-hidden event listing with pickup authorization", async () => {
    const hiddenProduct = product({ visibility: "private" })
    const record = commerceRecord(hiddenProduct)
    const resolution = marketWithAcceptedRecords([record])
    const projected = projectEventCatalogProducts({
      requested: [hiddenProduct.id],
      records: [record],
      liveCoordinates: new Set([hiddenProduct.id]),
      resolution,
    })

    expect(projected).toHaveLength(1)
    expect(projected[0]!.pickupFulfillment).not.toBeNull()

    const cartResolution = await resolveProductCartFulfillment(
      hiddenProduct,
      null,
      async () =>
        catalog(
          hiddenProduct,
          {
            products: projected,
          },
          resolution
        )
    )
    expect(cartResolution.status).toBe("pickup")
  })

  it("rejects other safety-hidden, blocked, and unprepared event listings", async () => {
    const pendingProduct = product()
    const externalProduct = product()
    const unsafeRecords = [
      commerceRecord(product({ visibility: "private", images: [] })),
      commerceRecord(product({ title: "Counterfeit goods" })),
      commerceRecord(
        product({
          type: "variation",
          parentProductId: "30402:" + merchant + ":missing-parent",
          specifications: [{ key: "size", value: "Large" }],
        })
      ),
      commerceRecord(pendingProduct, {
        safety: {
          state: "pending_review",
          reasons: [
            {
              code: "pending_review",
              label: "Pending review",
              detail: "A retained review decision has not completed.",
              merchantAction: "Wait for review.",
              source: "human_review",
            },
          ],
          marketVisible: false,
          purchasable: false,
          source: "human_review",
          evaluatedAt: 103_000,
        },
      }),
      commerceRecord(externalProduct, {
        safety: {
          state: "blocked",
          reasons: [
            {
              code: "external_decision",
              label: "External decision",
              detail: "A retained external decision blocks this listing.",
              merchantAction: "Review the external decision.",
              source: "external_decision",
            },
          ],
          marketVisible: false,
          purchasable: false,
          source: "external_decision",
          evaluatedAt: 103_000,
        },
      }),
    ]

    for (const unsafeRecord of unsafeRecords) {
      const unsafeProduct = unsafeRecord.product
      const resolution = marketWithAcceptedRecords([unsafeRecord])
      const projected = projectEventCatalogProducts({
        requested: [unsafeProduct.id],
        records: [unsafeRecord],
        liveCoordinates: new Set([unsafeProduct.id]),
        resolution,
      })
      expect(projected).toEqual([])

      const cartResolution = await resolveProductCartFulfillment(
        unsafeProduct,
        null,
        async () =>
          catalog(
            unsafeProduct,
            {
              products: projected,
            },
            resolution
          )
      )
      expect(cartResolution.status).toBe("blocked")
    }
  })

  it("folds exact accepted children into a requested parent family without reordering atomic children", () => {
    const parent = product({ type: "variable", visibility: "private" })
    const childCoordinates = [
      `30402:${merchant}:coffee-small`,
      `30402:${merchant}:coffee-large`,
    ]
    const children = childCoordinates.map((id, index) =>
      product({
        id,
        title: index === 0 ? "Coffee - Small" : "Coffee - Large",
        type: "variation",
        visibility: "private",
        parentProductId: parent.id,
        specifications: [
          { key: "size", value: index === 0 ? "Small" : "Large" },
        ],
        createdAt: 104_000 + index * 1_000,
        updatedAt: 104_000 + index * 1_000,
      })
    )
    const unsafeChildCoordinate = `30402:${merchant}:coffee-counterfeit`
    const unsafeChild = product({
      id: unsafeChildCoordinate,
      title: "Counterfeit goods",
      type: "variation",
      visibility: "private",
      parentProductId: parent.id,
      specifications: [{ key: "size", value: "Unsafe" }],
      createdAt: 106_000,
      updatedAt: 106_000,
    })
    const familyChildren = [...children, unsafeChild]
    const records: CommerceProductRecord[] = [parent, ...familyChildren].map(
      (candidate, index) =>
        commerceRecord(candidate, {
          eventId: String(4 + index).repeat(64),
        })
    )
    const prepared = prepareProductCatalog(records, {
      source: "commerce",
      fetchedAt: 107_000,
      stale: false,
      degraded: false,
      capped: false,
    }).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected family")

    const requested = [
      childCoordinates[1]!,
      parent.id,
      unsafeChildCoordinate,
      childCoordinates[0]!,
    ]
    const resolution = marketWithAcceptedRecords(records, requested)
    const parentRecord = {
      ...prepared.family.parent,
      family: prepared.family,
    }
    const projectionRecords = [parentRecord, ...prepared.family.children]

    const folded = projectEventCatalogProducts({
      requested,
      records: projectionRecords,
      liveCoordinates: new Set(requested),
      resolution,
    })
    expect(folded.map((entry) => entry.product.id)).toEqual([parent.id])
    expect(
      folded[0]!.family?.children
        .map((child) => child.product.id)
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(
      [...childCoordinates].sort((left, right) => left.localeCompare(right))
    )
    expect(
      Object.values(folded[0]!.familyPickupFulfillments ?? {}).filter(Boolean)
    ).toHaveLength(2)
    expect(
      folded[0]!.familyPickupFulfillments?.[unsafeChildCoordinate]
    ).toBeUndefined()

    const atomicRequested = [
      childCoordinates[1]!,
      unsafeChildCoordinate,
      childCoordinates[0]!,
    ]
    const atomicResolution = marketWithAcceptedRecords(
      records,
      atomicRequested,
      resolution
    )
    const atomic = projectEventCatalogProducts({
      requested: atomicRequested,
      records: [parentRecord, ...prepared.family.children].reverse(),
      liveCoordinates: new Set(atomicRequested),
      resolution: atomicResolution,
    })
    expect(atomicResolution.acceptedProductCoordinates).not.toContain(parent.id)
    expect(atomic.map((entry) => entry.product.id)).toEqual([
      childCoordinates[1]!,
      childCoordinates[0]!,
    ])
    expect(atomic.every((entry) => entry.family === undefined)).toBe(true)
    expect(atomic.every((entry) => entry.pickupFulfillment !== null)).toBe(true)

    const unsafeParent = product({
      type: "variable",
      visibility: "private",
      title: "Counterfeit goods",
    })
    const unsafeRecords = [unsafeParent, ...familyChildren].map(
      (candidate, index) =>
        commerceRecord(candidate, {
          eventId: String(8 + index).repeat(64),
        })
    )
    const unsafePrepared = prepareProductCatalog(unsafeRecords, {
      source: "commerce",
      fetchedAt: 108_000,
      stale: false,
      degraded: false,
      capped: false,
    }).items[0]
    if (unsafePrepared?.kind !== "family") {
      throw new Error("Expected unsafe family")
    }
    const unsafeProjection = projectEventCatalogProducts({
      requested: atomicRequested,
      records: [
        {
          ...unsafePrepared.family.parent,
          family: unsafePrepared.family,
        },
        ...unsafePrepared.family.children,
      ],
      liveCoordinates: new Set(atomicRequested),
      resolution: marketWithAcceptedRecords(unsafeRecords, atomicRequested),
    })
    expect(unsafeProjection).toEqual([])
  })

  it("renders a safe accepted hidden variation from an exact child-only read", () => {
    const parentId = `30402:${merchant}:coffee-parent`
    const child = product({
      id: `30402:${merchant}:coffee-child-only`,
      title: "Coffee - Child only",
      type: "variation",
      visibility: "private",
      parentProductId: parentId,
      specifications: [{ key: "size", value: "Child only" }],
    })
    const record = commerceRecord(child, {
      safety: evaluateListingSafety(child, undefined, {
        variationGroupRole: "variation",
        hasGroupImage: true,
      }),
    })
    const resolution = marketWithAcceptedRecords([record])

    const projected = projectEventCatalogProducts({
      requested: [child.id],
      records: [record],
      liveCoordinates: new Set([child.id]),
      resolution,
    })

    expect(projected).toHaveLength(1)
    expect(projected[0]?.product.id).toBe(child.id)
    expect(projected[0]?.family).toBeUndefined()
    expect(projected[0]?.pickupFulfillment).not.toBeNull()
  })

  it("does not borrow a group image from unsafe or unaccepted children", () => {
    const parent = product({
      type: "variable",
      visibility: "private",
      images: [],
    })
    const acceptedChild = product({
      id: `30402:${merchant}:coffee-no-image`,
      type: "variation",
      visibility: "private",
      images: [],
      parentProductId: parent.id,
      specifications: [{ key: "size", value: "No image" }],
      createdAt: 104_000,
      updatedAt: 104_000,
    })
    const unsafeImageDonor = product({
      id: `30402:${merchant}:coffee-unsafe-image`,
      title: "Counterfeit goods",
      type: "variation",
      visibility: "private",
      parentProductId: parent.id,
      specifications: [{ key: "size", value: "Unsafe donor" }],
      createdAt: 105_000,
      updatedAt: 105_000,
    })
    const unacceptedImageDonor = product({
      id: `30402:${merchant}:coffee-unaccepted-image`,
      type: "variation",
      visibility: "private",
      parentProductId: parent.id,
      specifications: [{ key: "size", value: "Unaccepted donor" }],
      createdAt: 106_000,
      updatedAt: 106_000,
    })
    const records = [
      parent,
      acceptedChild,
      unsafeImageDonor,
      unacceptedImageDonor,
    ].map((candidate, index) =>
      commerceRecord(candidate, {
        eventId: String(4 + index).repeat(64),
      })
    )
    const prepared = prepareProductCatalog(records, {
      source: "commerce",
      fetchedAt: 107_000,
      stale: false,
      degraded: false,
      capped: false,
    }).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected family")

    const requested = [parent.id, acceptedChild.id, unsafeImageDonor.id]
    const resolution = marketWithAcceptedRecords(records, requested)
    const projection = projectEventCatalogProducts({
      requested,
      records: [
        {
          ...prepared.family.parent,
          family: prepared.family,
        },
        ...prepared.family.children,
      ],
      liveCoordinates: new Set(requested),
      resolution,
    })

    expect(resolution.acceptedProductCoordinates).not.toContain(
      unacceptedImageDonor.id
    )
    expect(projection).toEqual([])
  })

  it("does not borrow a group image from a cache-only accepted child", () => {
    const parent = product({
      type: "variable",
      visibility: "private",
      images: [],
    })
    const liveChild = product({
      id: `30402:${merchant}:coffee-live-no-image`,
      type: "variation",
      visibility: "private",
      images: [],
      parentProductId: parent.id,
      specifications: [{ key: "size", value: "Live no image" }],
      createdAt: 104_000,
      updatedAt: 104_000,
    })
    const cacheOnlyImageDonor = product({
      id: `30402:${merchant}:coffee-cache-image`,
      type: "variation",
      visibility: "private",
      parentProductId: parent.id,
      specifications: [{ key: "size", value: "Cached image" }],
      createdAt: 105_000,
      updatedAt: 105_000,
    })
    const records = [parent, liveChild, cacheOnlyImageDonor].map(
      (candidate, index) =>
        commerceRecord(candidate, {
          eventId: String(4 + index).repeat(64),
        })
    )
    const prepared = prepareProductCatalog(records, {
      source: "commerce",
      fetchedAt: 106_000,
      stale: false,
      degraded: false,
      capped: false,
    }).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected family")

    const requested = [parent.id, liveChild.id, cacheOnlyImageDonor.id]
    const resolution = marketWithAcceptedRecords(records, requested)
    const projection = projectEventCatalogProducts({
      requested,
      records: [
        {
          ...prepared.family.parent,
          family: prepared.family,
        },
        ...prepared.family.children,
      ],
      liveCoordinates: new Set([parent.id, liveChild.id]),
      resolution,
    })

    expect(projection).toEqual([])
  })

  it("requires exact current child acceptance for family pickup snapshots", () => {
    const parent = product({ type: "variable" })
    const childCoordinate = `30402:${merchant}:coffee-large`
    const child = product({
      id: childCoordinate,
      title: "Coffee — Large",
      type: "variation",
      parentProductId: parent.id,
      specifications: [{ key: "size", value: "Large" }],
      createdAt: 104_000,
      updatedAt: 104_000,
    })
    const records: CommerceProductRecord[] = [parent, child].map(
      (candidate, index) => ({
        product: candidate,
        addressId: candidate.id,
        eventId: String(4 + index).repeat(64),
        eventCreatedAt: candidate.createdAt / 1_000,
        dTag: candidate.id.split(":").at(-1) ?? null,
      })
    )
    const prepared = prepareProductCatalog(records, {
      source: "commerce",
      fetchedAt: 105_000,
      stale: false,
      degraded: false,
      capped: false,
    }).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected family")

    const parentOnly = market()
    expect(
      buildEventCatalogFamilyPickupFulfillments(prepared.family, parentOnly)[
        childCoordinate
      ]
    ).toBeNull()

    const childAccepted: EventMarketResolution = {
      ...parentOnly,
      collection: {
        ...parentOnly.collection!,
        productCoordinates: [productCoordinate, childCoordinate],
      },
      organizerProductCoordinates: [productCoordinate, childCoordinate],
      acceptedProductCoordinates: [productCoordinate, childCoordinate],
      acceptedProductEvidence: [
        ...parentOnly.acceptedProductEvidence,
        {
          productCoordinate: childCoordinate,
          eventId: "5".repeat(64),
          createdAt: 104_000,
          shippingOptionCoordinates: [pickupCoordinate],
          merchantPubkey: merchant,
        },
      ],
      participationRequests: [
        ...parentOnly.participationRequests,
        { productCoordinate: childCoordinate, merchantPubkey: merchant },
      ],
    }
    const exact = buildEventCatalogFamilyPickupFulfillments(
      prepared.family,
      childAccepted
    )[childCoordinate]
    expect(exact).toMatchObject({
      product: {
        coordinate: childCoordinate,
        eventId: "5".repeat(64),
        createdAt: 104_000,
      },
    })

    const staleChild = {
      ...prepared.family,
      children: prepared.family.children.map((record) => ({
        ...record,
        eventCreatedAt: record.eventCreatedAt - 1,
      })),
    }
    expect(
      buildEventCatalogFamilyPickupFulfillments(staleChild, childAccepted)[
        childCoordinate
      ]
    ).toBeNull()
  })

  it("preserves exact author, product, event, collection, and pickup revisions", () => {
    const snapshot = buildPickupFulfillmentSnapshot(
      product(),
      market(),
      { eventId: "4".repeat(64), eventCreatedAt: 103 },
      null
    )

    expect(snapshot?.type).toBe("pickup")
    expect(snapshot?.organizerPubkey).toBe(organizer)
    expect(snapshot?.product).toEqual({
      coordinate: productCoordinate,
      merchantPubkey: merchant,
      eventId: "4".repeat(64),
      createdAt: 103_000,
    })
    expect(snapshot?.calendar.eventId).toBe("2".repeat(64))
    expect(snapshot?.collection.eventId).toBe("1".repeat(64))
    expect(snapshot?.option.eventId).toBe("3".repeat(64))
    expect(snapshot?.option.location).toBe("Public hall entrance")
    expect(snapshot?.option.geohash).toBe("dpz83")
    expect(snapshot?.handoffMode).toBe("organizer_handoff")
    expect(snapshot?.handlerPubkey).toBe(organizer)
    expect(snapshot?.costSats).toBe(0)
  })

  it("fails closed when Commerce event seconds do not match Product milliseconds", () => {
    expect(
      buildPickupFulfillmentSnapshot(
        product({ createdAt: 104_000, updatedAt: 104_000 }),
        market(),
        { eventId: "4".repeat(64), eventCreatedAt: 103 },
        null
      )
    ).toBeNull()
  })

  it("binds the complete cart wrapper to the freshly rebuilt pickup snapshot", () => {
    const canonical = pickupSnapshot()
    const stored = pickupItem(canonical)

    expect(
      pickupItemMatchesCanonicalSnapshot(stored, canonical, merchant)
    ).toBe(true)

    const tampering: Array<
      [string, (item: ReturnType<typeof pickupItem>) => void]
    > = [
      [
        "product coordinate",
        (item) => (item.productId = `${productCoordinate}-x`),
      ],
      ["merchant", (item) => (item.merchantPubkey = "c".repeat(64))],
      ["format", (item) => (item.format = "digital")],
      [
        "outer pickup option",
        (item) => (item.shippingOptionId = `${pickupCoordinate}-x`),
      ],
      ["outer pickup d tag", (item) => (item.shippingOptionDTag = "other")],
      ["outer sats cost", (item) => (item.shippingCostSats = 1)],
      ["missing outer sats cost", (item) => delete item.shippingCostSats],
      ["outer source amount", (item) => (item.sourceShippingCost!.amount = 1)],
      [
        "outer raw currency",
        (item) => (item.sourceShippingCost!.currency = "sat"),
      ],
      [
        "outer normalized currency",
        (item) => (item.sourceShippingCost!.normalizedCurrency = "BTC"),
      ],
      ["missing outer source cost", (item) => delete item.sourceShippingCost],
      [
        "product revision time",
        (item) => (item.fulfillment.product.createdAt += 1),
      ],
      [
        "calendar revision time",
        (item) => (item.fulfillment.calendar.createdAt += 1),
      ],
      [
        "collection revision time",
        (item) => (item.fulfillment.collection.createdAt += 1),
      ],
      [
        "pickup revision time",
        (item) => (item.fulfillment.option.createdAt += 1),
      ],
      [
        "pickup handoff mode",
        (item) => (item.fulfillment.handoffMode = "merchant_handoff"),
      ],
      ["pickup handler", (item) => (item.fulfillment.handlerPubkey = merchant)],
      [
        "missing pickup handoff mode",
        (item) => delete item.fulfillment.handoffMode,
      ],
      [
        "missing pickup handler",
        (item) => delete item.fulfillment.handlerPubkey,
      ],
      ["pickup title", (item) => (item.fulfillment.option.title = "Other")],
      [
        "pickup location",
        (item) => (item.fulfillment.option.location = "Other entrance"),
      ],
      ["pickup geohash", (item) => (item.fulfillment.option.geohash = "9q8yy")],
      ["pickup sats cost", (item) => (item.fulfillment.costSats = 1)],
      [
        "pickup source amount",
        (item) => (item.fulfillment.sourceCost.amount = 1),
      ],
      [
        "pickup raw currency",
        (item) => (item.fulfillment.sourceCost.currency = "sat"),
      ],
      [
        "pickup normalized currency",
        (item) => (item.fulfillment.sourceCost.normalizedCurrency = "BTC"),
      ],
      [
        "coordinated option identity",
        (item) => {
          item.fulfillment.option.coordinate = `30406:${organizer}:other-pickup`
          item.shippingOptionId = item.fulfillment.option.coordinate
          item.shippingOptionDTag = "other-pickup"
        },
      ],
      [
        "coordinated sats and source cost",
        (item) => {
          item.fulfillment.costSats = 1
          item.fulfillment.sourceCost.amount = 1
          item.shippingCostSats = 1
          item.sourceShippingCost!.amount = 1
        },
      ],
    ]

    for (const [field, mutate] of tampering) {
      const tampered = clonePickupItem(stored)
      mutate(tampered)
      expect({
        field,
        matches: pickupItemMatchesCanonicalSnapshot(
          tampered,
          canonical,
          merchant
        ),
      }).toEqual({ field, matches: false })
    }
  })

  it("treats a changed fiat conversion as a quote refresh, not stale pickup evidence", () => {
    const storedFulfillment: CartPickupFulfillment = {
      ...pickupSnapshot(),
      costSats: 100_000,
      sourceCost: {
        amount: 1,
        currency: "USD",
        normalizedCurrency: "USD",
      },
    }
    const stored = pickupItem(storedFulfillment)
    const refreshed: CartPickupFulfillment = {
      ...storedFulfillment,
      costSats: 95_000,
    }

    expect(
      pickupItemMatchesCanonicalSnapshot(stored, refreshed, merchant)
    ).toBe(true)

    const mismatchedWrapper = clonePickupItem(stored)
    mismatchedWrapper.shippingCostSats = 99_000
    expect(
      pickupItemMatchesCanonicalSnapshot(mismatchedWrapper, refreshed, merchant)
    ).toBe(false)

    const changedSource = clonePickupItem(stored)
    changedSource.sourceShippingCost!.amount = 2
    changedSource.fulfillment.sourceCost.amount = 2
    expect(
      pickupItemMatchesCanonicalSnapshot(changedSource, refreshed, merchant)
    ).toBe(false)
  })

  it("builds canonical fiat pickup terms before a conversion quote exists", () => {
    const usdMarket = market()
    const usdPickup = {
      ...usdMarket.pickups[0]!,
      price: 1,
      currency: "USD",
    }
    usdMarket.pickup = usdPickup
    usdMarket.pickups = [usdPickup]
    const evidence = { eventId: "4".repeat(64), eventCreatedAt: 103 }

    expect(
      buildPickupFulfillmentTerms(product(), usdMarket, evidence)?.sourceCost
    ).toEqual({ amount: 1, currency: "USD", normalizedCurrency: "USD" })
    expect(
      buildPickupFulfillmentSnapshot(product(), usdMarket, evidence, null)
    ).toBeNull()
    expect(
      buildPickupFulfillmentSnapshot(product(), usdMarket, evidence, {
        rate: 100_000,
        fetchedAt: 1,
        source: "env",
      })?.costSats
    ).toBe(1_000)
  })

  it("adds the product shipping-option extra cost to the pickup base price", () => {
    const pricedMarket = market()
    const pricedPickup = {
      ...pricedMarket.pickups[0]!,
      price: 10,
      currency: "SATS",
    }
    pricedMarket.pickup = pricedPickup
    pricedMarket.pickups = [pricedPickup]
    const snapshot = buildPickupFulfillmentSnapshot(
      product({
        shippingOptionRefs: [
          {
            coordinate: pickupCoordinate,
            extraCost: {
              amount: 5,
              currency: "SATS",
              normalizedCurrency: "SATS",
            },
          },
        ],
      }),
      pricedMarket,
      { eventId: "4".repeat(64), eventCreatedAt: 103 },
      null
    )

    expect(snapshot?.sourceCost).toEqual({
      amount: 15,
      currency: "SATS",
      normalizedCurrency: "SATS",
    })
    expect(snapshot?.costSats).toBe(15)
  })

  it("fails closed when pickup base and product extra-cost currencies conflict", () => {
    const pricedMarket = market()
    const pricedPickup = {
      ...pricedMarket.pickups[0]!,
      price: 10,
      currency: "USD",
    }
    pricedMarket.pickup = pricedPickup
    pricedMarket.pickups = [pricedPickup]
    const snapshot = buildPickupFulfillmentSnapshot(
      product({
        shippingOptionRefs: [
          {
            coordinate: pickupCoordinate,
            extraCost: {
              amount: 5,
              currency: "EUR",
              normalizedCurrency: "EUR",
            },
          },
        ],
      }),
      pricedMarket,
      { eventId: "4".repeat(64), eventCreatedAt: 103 },
      null
    )

    expect(snapshot).toBeNull()
  })

  it("does not treat ordinary collection membership as pickup fulfillment", () => {
    const snapshot = buildPickupFulfillmentSnapshot(
      product({ shippingOptionRefs: [], shippingOptionId: undefined }),
      market(),
      { eventId: "4".repeat(64), eventCreatedAt: 103 },
      null
    )

    expect(snapshot).toBeNull()
  })

  it("never creates pickup fulfillment for a signed digital product", () => {
    const snapshot = buildPickupFulfillmentSnapshot(
      product({ format: "digital" }),
      market(),
      { eventId: "4".repeat(64), eventCreatedAt: 103 },
      null
    )

    expect(snapshot).toBeNull()
  })

  it("retains safe signed provenance for an ended read-only archive", () => {
    const snapshot = buildPickupFulfillmentSnapshot(
      product(),
      market("ended"),
      { eventId: "4".repeat(64), eventCreatedAt: 103 },
      null
    )

    expect(snapshot?.option.coordinate).toBe(pickupCoordinate)
  })

  it("resolves an exact collection-level fulfillment claim to pickup", async () => {
    const listing = product({
      shippingOptionRefs: [{ coordinate: collectionCoordinate }],
      shippingOptionId: collectionCoordinate,
    })
    const result = await resolveProductCartFulfillment(
      listing,
      null,
      async () => catalog(listing)
    )

    expect(result.status).toBe("pickup")
    if (result.status !== "pickup") throw new Error("Expected pickup")
    expect(result.fulfillment.collection.coordinate).toBe(collectionCoordinate)
    expect(result.fulfillment.option.coordinate).toBe(pickupCoordinate)
  })

  it("resolves a direct organizer pickup that exactly matches the collection", async () => {
    const listing = product()
    const result = await resolveProductCartFulfillment(
      listing,
      null,
      async () => catalog(listing)
    )

    expect(result).toMatchObject({
      status: "pickup",
      collectionCoordinate,
    })
  })

  it("resolves a merchant-owned booth without granting organizer handoff", async () => {
    const merchantPickupCoordinate = `30406:${merchant}:merchant-booth`
    const merchantPickup = {
      ...market().pickups[0]!,
      coordinate: merchantPickupCoordinate,
      authorPubkey: merchant,
      dTag: "merchant-booth",
      title: "Merchant booth",
    }
    const merchantMarket = market()
    merchantMarket.pickupCoordinate = merchantPickupCoordinate
    merchantMarket.pickup = merchantPickup
    merchantMarket.pickups = [merchantPickup]
    merchantMarket.collection = {
      ...merchantMarket.collection!,
      pickupCoordinates: [merchantPickupCoordinate],
    }
    const listing = product({
      shippingOptionRefs: [{ coordinate: merchantPickupCoordinate }],
      shippingOptionId: merchantPickupCoordinate,
    })

    const result = await resolveProductCartFulfillment(
      listing,
      null,
      async () => catalog(listing, {}, merchantMarket)
    )

    expect(result).toMatchObject({
      status: "pickup",
      fulfillment: {
        handoffMode: "merchant_handoff",
        handlerPubkey: merchant,
        option: { coordinate: merchantPickupCoordinate },
      },
    })
  })

  it("resolves a same-author merchant event through the signed event graph", async () => {
    const resolution = merchantOwnedMarket()
    const listing = product({
      collectionRefs: [resolution.collectionCoordinate!],
      shippingOptionRefs: [{ coordinate: resolution.pickupCoordinate! }],
      shippingOptionId: resolution.pickupCoordinate,
    })
    const result = await resolveProductCartFulfillment(
      listing,
      null,
      async () =>
        catalog(
          listing,
          {
            reference: resolution.collectionCoordinate!,
            organizerPubkey: merchant,
          },
          resolution
        )
    )

    expect(getProductEventMarketCandidates(listing)).toEqual([
      expect.objectContaining({
        collectionCoordinate: resolution.collectionCoordinate,
        directPickupCoordinates: [resolution.pickupCoordinate],
      }),
    ])
    expect(result).toMatchObject({
      status: "pickup",
      collectionCoordinate: resolution.collectionCoordinate,
    })
  })

  it("blocks event pickup combined with ordinary shipping on generic surfaces", async () => {
    const ordinaryShipping = `30406:${merchant}:postal-shipping`
    const listing = product({
      shippingOptionRefs: [
        { coordinate: pickupCoordinate },
        { coordinate: ordinaryShipping },
      ],
      shippingOptionId: pickupCoordinate,
    })
    for (const candidate of [
      listing,
      product({
        shippingOptionRefs: [...listing.shippingOptionRefs!].reverse(),
        shippingOptionId: ordinaryShipping,
      }),
    ]) {
      const result = await resolveProductCartFulfillment(
        candidate,
        null,
        async () => catalog(candidate)
      )

      expect(result).toMatchObject({
        status: "blocked",
        eventState: "conflicting",
        collectionCoordinate,
      })
    }
  })

  it("blocks conflicting signed product price evidence before pickup checkout", async () => {
    const listing = product({ priceEvidenceMalformed: true })

    expect(
      buildPickupFulfillmentSnapshot(
        listing,
        market(),
        { eventId: "4".repeat(64), eventCreatedAt: 103 },
        null
      )
    ).toBeNull()
    await expect(
      resolveProductCartFulfillment(listing, null, async () => catalog(listing))
    ).resolves.toMatchObject({
      status: "blocked",
      eventState: "conflicting",
      collectionCoordinate,
    })
  })

  it("blocks a nonmatching organizer option inside an active event graph", async () => {
    const standardShipping = `30406:${organizer}:postal-shipping`
    const listing = product({
      shippingOptionRefs: [{ coordinate: standardShipping }],
      shippingOptionId: standardShipping,
    })
    const result = await resolveProductCartFulfillment(
      listing,
      null,
      async () => catalog(listing)
    )

    expect(getProductEventMarketCandidates(listing)).toHaveLength(1)
    expect(result).toMatchObject({
      status: "blocked",
      eventState: "conflicting",
      collectionCoordinate,
    })
  })

  it("keeps a standard collection shipping option without a NIP-52 link as shipping", async () => {
    const standardShipping = `30406:${organizer}:collection-shipping`
    const listing = product({
      shippingOptionRefs: [{ coordinate: standardShipping }],
      shippingOptionId: standardShipping,
    })
    const ordinaryCatalog = catalog(listing, {
      state: "malformed",
      calendar: undefined,
      pickup: undefined,
      pickups: [],
      collection: {
        ...market().collection!,
        eventCoordinates: [],
        pickupCoordinates: [standardShipping],
      },
      products: [],
      purchaseReady: false,
    })

    const result = await resolveProductCartFulfillment(
      listing,
      null,
      async () => ordinaryCatalog
    )

    expect(getProductEventMarketCandidates(listing)).toHaveLength(1)
    expect(result).toMatchObject({ status: "standard", type: "shipping" })
  })

  it("keeps an ordinary collection-level shipping reference as shipping", async () => {
    const listing = product({
      shippingOptionRefs: [{ coordinate: collectionCoordinate }],
      shippingOptionId: collectionCoordinate,
    })
    const ordinaryCatalog = catalog(listing, {
      state: "malformed",
      calendar: undefined,
      pickup: undefined,
      pickups: [],
      collection: {
        ...market().collection!,
        eventCoordinates: [],
        pickupCoordinates: [],
      },
      products: [],
      purchaseReady: false,
    })

    const result = await resolveProductCartFulfillment(
      listing,
      null,
      async () => ordinaryCatalog
    )

    expect(getProductEventMarketCandidates(listing)).toHaveLength(1)
    expect(result).toMatchObject({ status: "standard", type: "shipping" })
  })

  it("keeps unresolved public collection-level shipping ordinary", async () => {
    const listing = product({
      shippingOptionRefs: [{ coordinate: collectionCoordinate }],
      shippingOptionId: collectionCoordinate,
    })
    const result = await resolveProductCartFulfillment(
      listing,
      null,
      async () => ({
        state: "unavailable",
        reference: collectionCoordinate,
        canonicalNaddr: "naddr1test",
        products: [],
        pickups: [],
        productReadState: "not_requested",
        purchaseReady: false,
      })
    )

    expect(result).toMatchObject({ status: "standard", type: "shipping" })
  })

  it("keeps unresolved public same-author shipping ordinary", async () => {
    const ownedCollection = `30405:${merchant}:merchant-collection`
    const ownedShipping = `30406:${merchant}:merchant-shipping`
    const listing = product({
      collectionRefs: [ownedCollection],
      shippingOptionRefs: [{ coordinate: ownedShipping }],
      shippingOptionId: ownedShipping,
    })
    const result = await resolveProductCartFulfillment(
      listing,
      null,
      async () => ({
        state: "partial",
        reference: ownedCollection,
        canonicalNaddr: "naddr1owned",
        products: [],
        pickups: [],
        productReadState: "not_requested",
        purchaseReady: false,
      })
    )

    expect(result).toMatchObject({ status: "standard", type: "shipping" })
  })

  it("treats a merchant-owned direct option as a possible event pickup", () => {
    const standardShipping = `30406:${merchant}:postal-shipping`
    const listing = product({
      shippingOptionRefs: [{ coordinate: standardShipping }],
      shippingOptionId: standardShipping,
    })

    expect(getProductEventMarketCandidates(listing)).toEqual([
      expect.objectContaining({
        collectionCoordinate,
        directPickupCoordinates: [standardShipping],
      }),
    ])
  })

  it("fails closed when an explicit event collection cannot be resolved", async () => {
    const listing = product({
      visibility: "private",
      shippingOptionRefs: [{ coordinate: collectionCoordinate }],
      shippingOptionId: collectionCoordinate,
    })
    const result = await resolveProductCartFulfillment(
      listing,
      null,
      async () => ({
        state: "unavailable",
        reference: collectionCoordinate,
        canonicalNaddr: "naddr1test",
        products: [],
        acceptedProductCount: 0,
        unresolvedProductCoordinates: [],
        pickups: [],
        productReadState: "not_requested",
        purchaseReady: false,
      })
    )

    expect(result).toMatchObject({
      status: "blocked",
      eventState: "unavailable",
      canonicalNaddr: "naddr1test",
    })
  })

  it("blocks a legacy shipping cart snapshot when current evidence requires pickup", () => {
    const listing = product({
      shippingOptionRefs: [{ coordinate: collectionCoordinate }],
      shippingOptionId: collectionCoordinate,
    })
    const currentCatalog = catalog(listing)
    const currentPickup = currentCatalog.products[0]!.pickupFulfillment!
    const shippingItem = {
      ...createCartItemFromProduct(listing, { type: "shipping" }),
      quantity: 1,
    }
    const resolution = {
      status: "pickup" as const,
      product: listing,
      fulfillment: currentPickup,
      collectionCoordinate,
      canonicalNaddr: "naddr1test",
      eventState: "active" as const,
    }

    expect(
      getCartEventFulfillmentBlock(
        [shippingItem],
        new Map([[listing.id, resolution]])
      )
    ).toMatchObject({
      productId: listing.id,
      canonicalNaddr: "naddr1test",
    })

    const pickupItemWithQuantity = {
      ...createCartItemFromProduct(listing, currentPickup),
      quantity: 1,
    }
    expect(
      getCartEventFulfillmentBlock(
        [pickupItemWithQuantity],
        new Map([[listing.id, resolution]])
      )
    ).toBeNull()
  })
})
