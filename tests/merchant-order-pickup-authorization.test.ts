import { describe, expect, it } from "bun:test"
import { orderItemSchema } from "@conduit/core"
import type {
  EventMarketResolution,
  OrderPickupFulfillmentSchema,
  OrderSummary,
  Product,
  ProductsByIdsResult,
} from "@conduit/core"
import {
  getMerchantPickupAuthorizationMessage,
  verifyMerchantPickupOrderAuthorization,
  type MerchantPickupAuthorizationDependencies,
} from "../apps/merchant/src/lib/order-pickup-authorization"

const organizer = "a".repeat(64)
const merchant = "b".repeat(64)
const collectionCoordinate = `30405:${organizer}:summer-market`
const calendarCoordinate = `31923:${organizer}:summer-market`
const pickupCoordinate = `30406:${organizer}:summer-market-pickup`
const productCoordinate = `30402:${merchant}:coffee`

function pickupSnapshot(): OrderPickupFulfillmentSchema {
  return {
    type: "pickup",
    organizerPubkey: organizer,
    handoffMode: "organizer_handoff",
    handlerPubkey: organizer,
    product: {
      coordinate: productCoordinate,
      merchantPubkey: merchant,
      eventId: "4".repeat(64),
      createdAt: 103,
    },
    calendar: {
      coordinate: calendarCoordinate,
      eventId: "2".repeat(64),
      createdAt: 101,
    },
    collection: {
      coordinate: collectionCoordinate,
      eventId: "1".repeat(64),
      createdAt: 100,
    },
    option: {
      coordinate: pickupCoordinate,
      eventId: "3".repeat(64),
      createdAt: 102,
      title: "Event pickup",
      location: "Public hall entrance",
      geohash: "dpz83",
    },
    costSats: 0,
    sourceCost: {
      amount: 0,
      currency: "SATS",
      normalizedCurrency: "SATS",
    },
  }
}

function orderItems(
  fulfillment: OrderPickupFulfillmentSchema = pickupSnapshot()
): OrderSummary["items"] {
  return [
    {
      productId: productCoordinate,
      title: "Coffee",
      format: "physical",
      fulfillment,
      quantity: 1,
      priceAtPurchase: 2_000,
      currency: "SATS",
      sourcePrice: {
        amount: 2_000,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
      shippingOptionId: fulfillment.option.coordinate,
      shippingOptionDTag: fulfillment.option.coordinate
        .split(":")
        .slice(2)
        .join(":"),
      shippingCostSats: fulfillment.costSats,
      sourceShippingCost: { ...fulfillment.sourceCost },
    },
  ]
}

function market(
  state: EventMarketResolution["state"] = "active"
): EventMarketResolution {
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
    pickup: {
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
    },
    pickups: [],
    organizerProductCoordinates: [productCoordinate],
    acceptedProductCoordinates: [productCoordinate],
    acceptedProductEvidence: [
      {
        productCoordinate,
        eventId: "4".repeat(64),
        createdAt: 103,
        shippingOptionCoordinates: [pickupCoordinate],
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
      completeRelayCount: state === "partial" ? 1 : 2,
      partialRelayCount: 0,
      failedRelayCount: state === "partial" ? 1 : 0,
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
    sourcePrice: {
      amount: 2_000,
      currency: "SATS",
      normalizedCurrency: "SATS",
    },
    type: "simple",
    format: "physical",
    visibility: "public",
    images: [],
    tags: [],
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 103,
    updatedAt: 103,
    collectionRefs: [collectionCoordinate],
    shippingOptionRefs: [{ coordinate: pickupCoordinate }],
    ...overrides,
  }
}

function products(
  options: {
    product?: Product
    eventId?: string
    eventCreatedAt?: number
    issue?: ProductsByIdsResult["diagnostics"][number]["issue"]
    source?: ProductsByIdsResult["meta"]["source"]
    stale?: boolean
    listing?: "complete" | "partial" | "unavailable"
    deletion?: "complete" | "partial" | "unavailable"
    includeRecord?: boolean
  } = {}
): ProductsByIdsResult {
  const record = {
    product: options.product ?? product(),
    eventId: options.eventId ?? "4".repeat(64),
    addressId: productCoordinate,
    dTag: "coffee",
    eventCreatedAt: options.eventCreatedAt ?? 103,
  }
  return {
    data: options.includeRecord === false ? [] : [record],
    meta: {
      source: options.source ?? "commerce",
      degraded: false,
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
          deletion: options.deletion ?? "complete",
        },
      },
    ],
  }
}

function dependencies(
  resolution: EventMarketResolution = market(),
  productResult: ProductsByIdsResult = products()
): MerchantPickupAuthorizationDependencies {
  return {
    getEventMarket: async () => resolution,
    getProductsByIds: async () => productResult,
  }
}

async function verify(
  deps: MerchantPickupAuthorizationDependencies = dependencies(),
  items: OrderSummary["items"] = orderItems(),
  merchantPubkey = merchant
) {
  return verifyMerchantPickupOrderAuthorization({ items, merchantPubkey }, deps)
}

function cloneSnapshot(): OrderPickupFulfillmentSchema {
  return structuredClone(pickupSnapshot())
}

describe("Merchant pickup order authorization", () => {
  it("verifies exact current organizer, merchant product, and two-sided participation evidence", async () => {
    let verifiedProductEventId: string | null = null
    expect(
      await verifyMerchantPickupOrderAuthorization(
        {
          items: orderItems(),
          merchantPubkey: merchant,
          onVerifiedProduct: (record) => {
            verifiedProductEventId = record.eventId
          },
        },
        dependencies()
      )
    ).toEqual({ status: "verified" })
    expect(verifiedProductEventId).toBe("4".repeat(64))
    expect(
      await verify(
        dependencies(
          market(),
          products({ listing: "partial", deletion: "unavailable" })
        )
      )
    ).toEqual({ status: "verified" })
  })

  it("preserves exact positive live evidence when another relay fails", async () => {
    expect(
      await verify(
        dependencies(
          market("partial"),
          products({ listing: "partial", deletion: "partial" })
        )
      )
    ).toEqual({ status: "verified" })
  })

  it("preserves an exact live product when the aggregate read is partial", async () => {
    expect(
      await verify(
        dependencies(
          market("partial"),
          products({
            stale: true,
            listing: "partial",
            deletion: "partial",
          })
        )
      )
    ).toEqual({ status: "verified" })
  })

  it("verifies a direct merchant booth handoff outside the organizer collection", async () => {
    const boothCoordinate = `30406:${merchant}:summer-market-booth`
    const merchantPickup = {
      ...market().pickup!,
      coordinate: boothCoordinate,
      eventId: "9".repeat(64),
      authorPubkey: merchant,
      dTag: "summer-market-booth",
      title: "Merchant booth",
      location: "Coffee booth",
      createdAt: 104,
    }
    const multiPickupMarket = market()
    multiPickupMarket.pickup = undefined
    multiPickupMarket.pickupCoordinate = undefined
    multiPickupMarket.pickups = [market().pickup!, merchantPickup]
    multiPickupMarket.collection = {
      ...multiPickupMarket.collection!,
      pickupCoordinates: [pickupCoordinate],
    }
    const merchantHandoff = cloneSnapshot()
    merchantHandoff.handoffMode = "merchant_handoff"
    merchantHandoff.handlerPubkey = merchant
    merchantHandoff.option = {
      coordinate: boothCoordinate,
      eventId: merchantPickup.eventId,
      createdAt: merchantPickup.createdAt,
      title: merchantPickup.title,
      location: merchantPickup.location,
      geohash: merchantPickup.geohash,
    }
    const merchantProduct = product({
      shippingOptionRefs: [{ coordinate: boothCoordinate }],
    })

    expect(
      await verify(
        dependencies(multiPickupMarket, products({ product: merchantProduct })),
        orderItems(merchantHandoff)
      )
    ).toEqual({ status: "verified" })
  })

  it("allows an existing pickup order to complete after the signed event ends", async () => {
    const ended = market("ended")
    ended.calendar = { ...ended.calendar!, end: 500 }
    expect(
      await verifyMerchantPickupOrderAuthorization(
        { items: orderItems(), merchantPubkey: merchant, nowMs: 500 },
        dependencies(ended)
      )
    ).toEqual({ status: "verified" })
  })

  it("accepts semantically equivalent signed replacements", async () => {
    const stockReplacement = product({
      stock: 4,
      createdAt: 200,
      updatedAt: 200,
    })
    expect(
      await verify(
        dependencies(
          market(),
          products({
            product: stockReplacement,
            eventId: "8".repeat(64),
            eventCreatedAt: 200,
          })
        )
      )
    ).toEqual({ status: "verified" })

    const otherProduct = `30402:${"c".repeat(64)}:tea`
    const collectionReplacement = market()
    collectionReplacement.collection = {
      ...collectionReplacement.collection!,
      eventId: "7".repeat(64),
      createdAt: 201,
      productCoordinates: [productCoordinate, otherProduct],
    }
    collectionReplacement.organizerProductCoordinates = [
      productCoordinate,
      otherProduct,
    ]
    collectionReplacement.acceptedProductCoordinates = [
      productCoordinate,
      otherProduct,
    ]
    expect(await verify(dependencies(collectionReplacement))).toEqual({
      status: "verified",
    })

    const equivalentGraphReplacement = market()
    equivalentGraphReplacement.calendar = {
      ...equivalentGraphReplacement.calendar!,
      eventId: "6".repeat(64),
      createdAt: 202,
    }
    equivalentGraphReplacement.pickup = {
      ...equivalentGraphReplacement.pickup!,
      eventId: "5".repeat(64),
      createdAt: 203,
    }
    expect(await verify(dependencies(equivalentGraphReplacement))).toEqual({
      status: "verified",
    })
  })

  it("fails closed for stale, unavailable, or cache-only evidence", async () => {
    expect(await verify(dependencies(market("stale")))).toEqual({
      status: "unverified",
      reason: "network_unavailable",
    })
    expect(
      await verify(
        dependencies(market(), products({ source: "local_cache", stale: true }))
      )
    ).toEqual({ status: "unverified", reason: "network_unavailable" })

    for (const state of [
      "missing",
      "malformed",
      "conflicting",
      "unsupported",
    ] as const) {
      expect(await verify(dependencies(market(state)))).toEqual({
        status: "unverified",
        reason: "organizer_evidence_not_current",
      })
    }
    expect(
      await verify(
        dependencies(
          market(),
          products({ issue: "lookup_partial", includeRecord: false })
        )
      )
    ).toEqual({ status: "unverified", reason: "network_unavailable" })
  })

  it("rejects known organizer or product deletion evidence", async () => {
    expect(await verify(dependencies(market("deleted")))).toEqual({
      status: "unverified",
      reason: "organizer_evidence_not_current",
    })
    expect(
      await verify(
        dependencies(
          market(),
          products({ issue: "product_missing", includeRecord: false })
        )
      )
    ).toEqual({
      status: "unverified",
      reason: "product_evidence_not_current",
    })
  })

  it("rejects one-sided or withdrawn product participation", async () => {
    expect(
      await verify(
        dependencies(
          market(),
          products({ product: product({ collectionRefs: [] }) })
        )
      )
    ).toEqual({ status: "unverified", reason: "authorization_missing" })

    const organizerWithdrew = market()
    organizerWithdrew.organizerProductCoordinates = []
    organizerWithdrew.acceptedProductCoordinates = []
    organizerWithdrew.organizerOnlyProductCoordinates = []
    organizerWithdrew.collection!.productCoordinates = []
    expect(await verify(dependencies(organizerWithdrew))).toEqual({
      status: "unverified",
      reason: "authorization_missing",
    })
  })

  it("rejects changed identities, graph links, and pickup display evidence", async () => {
    const changedPickupTitle = market()
    changedPickupTitle.pickup = {
      ...changedPickupTitle.pickup!,
      eventId: "8".repeat(64),
      createdAt: 200,
      title: "Different entrance",
    }
    expect(await verify(dependencies(changedPickupTitle))).toEqual({
      status: "unverified",
      reason: "revision_mismatch",
    })

    const changedPickupLocation = market()
    changedPickupLocation.pickup = {
      ...changedPickupLocation.pickup!,
      eventId: "8".repeat(64),
      createdAt: 200,
      location: "Different public hall",
    }
    expect(await verify(dependencies(changedPickupLocation))).toEqual({
      status: "unverified",
      reason: "revision_mismatch",
    })

    const changedPickupGeohash = market()
    changedPickupGeohash.pickup = {
      ...changedPickupGeohash.pickup!,
      eventId: "8".repeat(64),
      createdAt: 200,
      geohash: "dpz84",
    }
    expect(await verify(dependencies(changedPickupGeohash))).toEqual({
      status: "unverified",
      reason: "revision_mismatch",
    })

    expect(await verify(dependencies(), orderItems(), "c".repeat(64))).toEqual({
      status: "unverified",
      reason: "invalid_snapshot",
    })

    const changedCalendarLink = market()
    changedCalendarLink.collection = {
      ...changedCalendarLink.collection!,
      eventCoordinates: [`31923:${organizer}:different-event`],
    }
    expect(await verify(dependencies(changedCalendarLink))).toEqual({
      status: "unverified",
      reason: "revision_mismatch",
    })

    const changedPickupLink = market()
    changedPickupLink.collection = {
      ...changedPickupLink.collection!,
      pickupCoordinates: [`30406:${organizer}:different-pickup`],
    }
    expect(await verify(dependencies(changedPickupLink))).toEqual({
      status: "unverified",
      reason: "revision_mismatch",
    })
  })

  it("rejects schema-accepted malformed, conflicting, and mixed pickup claims before relay reads", async () => {
    const baseItems = orderItems()
    const missingPublicPlace = cloneSnapshot()
    delete missingPublicPlace.option.location
    delete missingPublicPlace.option.geohash
    const conflictingTitle = cloneSnapshot()
    conflictingTitle.option.title = "Different pickup title"
    const conflictingPlace = cloneSnapshot()
    conflictingPlace.option.location = "Different public hall"
    const conflictingGraph = cloneSnapshot()
    conflictingGraph.collection = {
      coordinate: `30405:${organizer}:different-products`,
      eventId: "9".repeat(64),
      createdAt: 200,
    }
    const shippingItem: OrderSummary["items"][number] = {
      ...baseItems[0]!,
      productId: `30402:${merchant}:shirt`,
      fulfillment: { type: "shipping" },
    }
    const malformedItems = orderItems(missingPublicPlace)
    const schemaAcceptedConflicts = [
      [...baseItems, ...orderItems(conflictingTitle)],
      [...baseItems, ...orderItems(conflictingPlace)],
      [...baseItems, ...orderItems(conflictingGraph)],
      [...baseItems, shippingItem],
    ]
    let relayReads = 0
    const unreadDependencies: MerchantPickupAuthorizationDependencies = {
      getEventMarket: async () => {
        relayReads += 1
        return market()
      },
      getProductsByIds: async () => {
        relayReads += 1
        return products()
      },
    }

    expect(await verify(unreadDependencies, malformedItems)).toEqual({
      status: "unverified",
      reason: "invalid_snapshot",
    })
    for (const items of schemaAcceptedConflicts) {
      expect(
        items.every((item) => orderItemSchema.safeParse(item).success)
      ).toBe(true)
      expect(await verify(unreadDependencies, items)).toEqual({
        status: "unverified",
        reason: "invalid_snapshot",
      })
    }
    expect(relayReads).toBe(0)
  })

  it("rejects unsafe product fulfillment, format, and source-price replacements", async () => {
    expect(
      await verify(
        dependencies(
          market(),
          products({
            product: product({
              shippingOptionRefs: [
                { coordinate: `30406:${organizer}:different-pickup` },
              ],
            }),
            eventId: "8".repeat(64),
            eventCreatedAt: 200,
          })
        )
      )
    ).toEqual({ status: "unverified", reason: "authorization_missing" })

    expect(
      await verify(
        dependencies(
          market(),
          products({
            product: product({ pubkey: "c".repeat(64) }),
            eventId: "8".repeat(64),
            eventCreatedAt: 200,
          })
        )
      )
    ).toEqual({ status: "unverified", reason: "authorization_missing" })

    expect(
      await verify(
        dependencies(
          market(),
          products({
            product: product({ format: "digital" }),
            eventId: "8".repeat(64),
            eventCreatedAt: 200,
          })
        )
      )
    ).toEqual({ status: "unverified", reason: "authorization_missing" })

    expect(
      await verify(
        dependencies(
          market(),
          products({
            product: product({
              price: 2_001,
              priceSats: 2_001,
              sourcePrice: {
                amount: 2_001,
                currency: "SATS",
                normalizedCurrency: "SATS",
              },
            }),
            eventId: "8".repeat(64),
            eventCreatedAt: 200,
          })
        )
      )
    ).toEqual({ status: "unverified", reason: "price_mismatch" })

    expect(
      await verify(
        dependencies(
          market(),
          products({
            product: product({
              price: 2,
              currency: "USD",
              priceSats: undefined,
              sourcePrice: {
                amount: 2,
                currency: "USD",
                normalizedCurrency: "USD",
              },
            }),
            eventId: "8".repeat(64),
            eventCreatedAt: 200,
          })
        )
      )
    ).toEqual({ status: "unverified", reason: "price_mismatch" })
  })

  it("uses deterministic signed listing price fields when legacy order source price is absent", async () => {
    const legacyItems = orderItems()
    delete legacyItems[0]!.sourcePrice
    expect(await verify(dependencies(), legacyItems)).toEqual({
      status: "verified",
    })

    const fiatProduct = product({
      price: 2,
      currency: "USD",
      priceSats: undefined,
      sourcePrice: {
        amount: 2,
        currency: "USD",
        normalizedCurrency: "USD",
      },
    })
    expect(
      await verify(
        dependencies(
          market(),
          products({
            product: fiatProduct,
            eventId: "8".repeat(64),
            eventCreatedAt: 200,
          })
        ),
        legacyItems
      )
    ).toEqual({ status: "unverified", reason: "price_mismatch" })
  })

  it("verifies an exact native-zero pickup listing and signed order snapshot", async () => {
    const zeroItems = orderItems()
    zeroItems[0]!.priceAtPurchase = 0
    zeroItems[0]!.sourcePrice = {
      amount: 0,
      currency: "SATS",
      normalizedCurrency: "SATS",
    }
    const zeroProduct = product({
      price: 0,
      currency: "SATS",
      priceSats: 0,
      sourcePrice: {
        amount: 0,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
    })

    expect(
      await verify(
        dependencies(market(), products({ product: zeroProduct })),
        zeroItems
      )
    ).toEqual({ status: "verified" })
  })

  it("rejects zero fiat and a nonzero order amount against a native-zero listing", async () => {
    const zeroFiatItems = orderItems()
    zeroFiatItems[0]!.priceAtPurchase = 0
    zeroFiatItems[0]!.sourcePrice = {
      amount: 0,
      currency: "USD",
      normalizedCurrency: "USD",
    }
    const zeroFiatProduct = product({
      price: 0,
      currency: "USD",
      priceSats: undefined,
      sourcePrice: {
        amount: 0,
        currency: "USD",
        normalizedCurrency: "USD",
      },
    })
    expect(
      await verify(
        dependencies(market(), products({ product: zeroFiatProduct })),
        zeroFiatItems
      )
    ).toEqual({ status: "unverified", reason: "price_mismatch" })

    const positiveFiatZeroSatsItems = orderItems()
    positiveFiatZeroSatsItems[0]!.priceAtPurchase = 0
    positiveFiatZeroSatsItems[0]!.sourcePrice = {
      amount: 2,
      currency: "USD",
      normalizedCurrency: "USD",
    }
    const positiveFiatProduct = product({
      price: 2,
      currency: "USD",
      priceSats: undefined,
      sourcePrice: {
        amount: 2,
        currency: "USD",
        normalizedCurrency: "USD",
      },
    })
    expect(
      await verify(
        dependencies(market(), products({ product: positiveFiatProduct })),
        positiveFiatZeroSatsItems
      )
    ).toEqual({ status: "unverified", reason: "price_mismatch" })

    const mismatchedItems = orderItems()
    mismatchedItems[0]!.priceAtPurchase = 1
    mismatchedItems[0]!.sourcePrice = {
      amount: 0,
      currency: "SATS",
      normalizedCurrency: "SATS",
    }
    const nativeZeroProduct = product({
      price: 0,
      currency: "SATS",
      priceSats: 0,
      sourcePrice: {
        amount: 0,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
    })
    expect(
      await verify(
        dependencies(market(), products({ product: nativeZeroProduct })),
        mismatchedItems
      )
    ).toEqual({ status: "unverified", reason: "price_mismatch" })
  })

  it("derives signed pickup base plus merchant extra cost and rejects mutually consistent buyer forgeries", async () => {
    const pricedMarket = market()
    pricedMarket.pickup = {
      ...pricedMarket.pickup!,
      price: 10,
      currency: "SATS",
    }
    const pricedProduct = product({
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
    })
    const pricedDependencies = dependencies(
      pricedMarket,
      products({ product: pricedProduct })
    )
    const canonical = cloneSnapshot()
    canonical.sourceCost = {
      amount: 15,
      currency: "SATS",
      normalizedCurrency: "SATS",
    }
    canonical.costSats = 15
    expect(await verify(pricedDependencies, orderItems(canonical))).toEqual({
      status: "verified",
    })

    const changedPickupCostMarket = market()
    changedPickupCostMarket.pickup = {
      ...changedPickupCostMarket.pickup!,
      eventId: "8".repeat(64),
      createdAt: 200,
      price: 11,
      currency: "SATS",
    }
    expect(
      await verify(
        dependencies(
          changedPickupCostMarket,
          products({ product: pricedProduct })
        ),
        orderItems(canonical)
      )
    ).toEqual({ status: "unverified", reason: "cost_mismatch" })

    const forgedRawCost = structuredClone(canonical)
    forgedRawCost.sourceCost.amount = 7
    forgedRawCost.costSats = 7
    expect(await verify(pricedDependencies, orderItems(forgedRawCost))).toEqual(
      { status: "unverified", reason: "cost_mismatch" }
    )

    const forgedSats = structuredClone(canonical)
    forgedSats.costSats = 14
    expect(await verify(pricedDependencies, orderItems(forgedSats))).toEqual({
      status: "unverified",
      reason: "cost_mismatch",
    })
  })

  it("validates deterministic msat and BTC conversion without a rate oracle", async () => {
    const cases = [
      { amount: 2_000, currency: "MSATS", costSats: 2 },
      { amount: 0.00000002, currency: "BTC", costSats: 2 },
    ] as const

    for (const testCase of cases) {
      const pricedMarket = market()
      pricedMarket.pickup = {
        ...pricedMarket.pickup!,
        price: testCase.amount,
        currency: testCase.currency,
      }
      const canonical = cloneSnapshot()
      canonical.sourceCost = {
        amount: testCase.amount,
        currency: testCase.currency,
        normalizedCurrency: testCase.currency,
      }
      canonical.costSats = testCase.costSats
      expect(
        await verify(dependencies(pricedMarket), orderItems(canonical))
      ).toEqual({ status: "verified" })

      const forged = structuredClone(canonical)
      forged.costSats += 1
      expect(
        await verify(dependencies(pricedMarket), orderItems(forged))
      ).toEqual({ status: "unverified", reason: "cost_mismatch" })
    }
  })

  it("keeps a fiat conversion snapshot internally consistent without applying today's rate", async () => {
    const pricedMarket = market()
    pricedMarket.pickup = {
      ...pricedMarket.pickup!,
      price: 10,
      currency: "USD",
    }
    const canonical = cloneSnapshot()
    canonical.sourceCost = {
      amount: 10,
      currency: "USD",
      normalizedCurrency: "USD",
    }
    canonical.costSats = 1_250

    expect(
      await verify(dependencies(pricedMarket), orderItems(canonical))
    ).toEqual({ status: "verified" })

    const impossibleZero = structuredClone(canonical)
    impossibleZero.costSats = 0
    expect(
      await verify(dependencies(pricedMarket), orderItems(impossibleZero))
    ).toEqual({ status: "unverified", reason: "cost_mismatch" })
  })

  it("returns only privacy-safe diagnostics when reads fail", async () => {
    const result = await verify({
      getEventMarket: async () => {
        throw new Error("relay included sensitive details")
      },
      getProductsByIds: async () => products(),
    })
    expect(result).toEqual({
      status: "unverified",
      reason: "network_unavailable",
    })
    expect(getMerchantPickupAuthorizationMessage(result)).not.toContain(
      organizer
    )
    expect(getMerchantPickupAuthorizationMessage(result)).not.toContain(
      "sensitive details"
    )
  })
})
