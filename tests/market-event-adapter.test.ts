import { describe, expect, it } from "bun:test"
import {
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
    organizerOnlyProductCoordinates: [],
    participationRequests: [{ productCoordinate, merchantPubkey: merchant }],
    participationBudget: {
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
    images: [],
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
  return {
    data:
      options.includeRecord === false
        ? []
        : [
            {
              product: options.product ?? product(),
              addressId: productCoordinate,
              eventId: options.eventId ?? "4".repeat(64),
              eventCreatedAt: options.eventCreatedAt ?? 103,
              dTag: "coffee",
            },
          ],
    meta: {
      source: options.source ?? "commerce",
      degraded: (options.issue ?? null) !== null,
      stale: options.stale ?? false,
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
        productId: productCoordinate,
        addressId: productCoordinate,
        issue: options.issue ?? null,
        coverage: {
          listing: options.listing ?? "complete",
          deletion: "complete",
        },
      },
    ],
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
  it("keeps a retained organizer-accepted product visible without making it purchasable", () => {
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

  it("distinguishes a complete empty organizer collection from degraded hydration", () => {
    const resolution: EventMarketResolution = {
      ...market(),
      collection: {
        ...market().collection!,
        productCoordinates: [],
      },
      organizerProductCoordinates: [],
      acceptedProductCoordinates: [],
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

  it("omits products with definitive missing evidence or a live merchant withdrawal", () => {
    const deleted = projectEventCatalogHydration({
      resolution: market(),
      result: productRead({
        includeRecord: false,
        issue: "product_missing",
      }),
    })
    expect(deleted.acceptedProductCount).toBe(0)
    expect(deleted.products).toEqual([])

    const withdrawnResolution: EventMarketResolution = {
      ...market(),
      acceptedProductCoordinates: [],
      organizerOnlyProductCoordinates: [productCoordinate],
      participationRequests: [],
    }
    const withdrawn = projectEventCatalogHydration({
      resolution: withdrawnResolution,
      result: productRead({ product: product({ collectionRefs: [] }) }),
    })
    expect(withdrawn.acceptedProductCount).toBe(0)
    expect(withdrawn.products).toEqual([])
  })

  it("keeps a retained signed merchant withdrawal out of accepted products", () => {
    const withdrawnResolution: EventMarketResolution = {
      ...market("partial"),
      acceptedProductEvidence: [
        {
          productCoordinate,
          eventId: "f".repeat(64),
          createdAt: 103_000,
          shippingOptionCoordinates: [pickupCoordinate],
        },
      ],
    }
    const withdrawn = projectEventCatalogHydration({
      resolution: withdrawnResolution,
      result: productRead({
        product: product({ collectionRefs: [] }),
        issue: "lookup_unavailable",
        source: "local_cache",
        stale: true,
        listing: "unavailable",
      }),
    })

    expect(withdrawn.acceptedProductCount).toBe(0)
    expect(withdrawn.products).toEqual([])
    expect(withdrawn.unresolvedProductCoordinates).toEqual([])
    expect(withdrawn.productReadState).toBe("ready")
  })

  it("does not let an older retained no-ref revision suppress newer accepted evidence", () => {
    const retainedAccepted = projectEventCatalogHydration({
      resolution: {
        ...market("partial"),
        acceptedProductEvidence: [
          {
            productCoordinate,
            eventId: "3".repeat(64),
            createdAt: 104_000,
            shippingOptionCoordinates: [pickupCoordinate],
          },
        ],
      },
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

    expect(retainedAccepted.acceptedProductCount).toBe(1)
    expect(retainedAccepted.products).toHaveLength(1)
    expect(retainedAccepted.products[0]!.evidenceState).toBe("retained")
    expect(retainedAccepted.products[0]!.pickupFulfillment).toBeNull()
  })

  it("does not infer withdrawal from retained no-ref data without comparable acceptance evidence", () => {
    const retainedAccepted = projectEventCatalogHydration({
      resolution: {
        ...market("partial"),
        acceptedProductCoordinates: [],
        acceptedProductEvidence: [],
        organizerOnlyProductCoordinates: [productCoordinate],
        participationRequests: [],
      },
      result: productRead({
        product: product({ collectionRefs: [] }),
        issue: "lookup_unavailable",
        source: "local_cache",
        stale: true,
        listing: "unavailable",
      }),
    })

    expect(retainedAccepted.acceptedProductCount).toBe(1)
    expect(retainedAccepted.products).toHaveLength(1)
    expect(retainedAccepted.products[0]!.evidenceState).toBe("retained")
    expect(retainedAccepted.products[0]!.pickupFulfillment).toBeNull()
  })

  it("folds exact accepted children into a requested parent family without reordering atomic children", () => {
    const parent = product({ type: "variable" })
    const childCoordinates = [
      `30402:${merchant}:coffee-small`,
      `30402:${merchant}:coffee-large`,
    ]
    const children = childCoordinates.map((id, index) =>
      product({
        id,
        title: index === 0 ? "Coffee - Small" : "Coffee - Large",
        type: "variation",
        parentProductId: parent.id,
        specifications: [
          { key: "size", value: index === 0 ? "Small" : "Large" },
        ],
        createdAt: 104_000 + index * 1_000,
        updatedAt: 104_000 + index * 1_000,
      })
    )
    const records: CommerceProductRecord[] = [parent, ...children].map(
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
      fetchedAt: 107_000,
      stale: false,
      degraded: false,
      capped: false,
    }).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected family")

    const requested = [childCoordinates[1]!, parent.id, childCoordinates[0]!]
    const resolution: EventMarketResolution = {
      ...market(),
      collection: {
        ...market().collection!,
        productCoordinates: requested,
      },
      organizerProductCoordinates: requested,
      acceptedProductCoordinates: requested,
      participationRequests: requested.map((productCoordinate) => ({
        productCoordinate,
        merchantPubkey: merchant,
      })),
    }
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
      Object.values(folded[0]!.familyPickupFulfillments ?? {}).filter(Boolean)
    ).toHaveLength(2)

    const atomicRequested = [childCoordinates[1]!, childCoordinates[0]!]
    const atomicResolution: EventMarketResolution = {
      ...resolution,
      collection: {
        ...resolution.collection!,
        productCoordinates: atomicRequested,
      },
      organizerProductCoordinates: atomicRequested,
      acceptedProductCoordinates: atomicRequested,
      participationRequests: atomicRequested.map((productCoordinate) => ({
        productCoordinate,
        merchantPubkey: merchant,
      })),
    }
    const atomic = projectEventCatalogProducts({
      requested: atomicRequested,
      records: [...prepared.family.children].reverse(),
      liveCoordinates: new Set(atomicRequested),
      resolution: atomicResolution,
    })
    expect(atomic.map((entry) => entry.product.id)).toEqual(atomicRequested)
    expect(atomic.every((entry) => entry.family === undefined)).toBe(true)
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
