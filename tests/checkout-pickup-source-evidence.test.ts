import { expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  buildEventMarketPickupDraft,
  evaluateListingSafety,
  parseProductEvent,
  resolveEventMarketEvidence,
  type ProductsByIdsResult,
} from "@conduit/core"
import { authorizeCurrentCheckoutItems } from "../apps/market/src/lib/checkout-authorization"
import { buildCheckoutSparkCommerceEvidence } from "../apps/market/src/lib/checkout-spark-commerce-evidence"
import { buildCheckoutSparkQuoteAuthority } from "../apps/market/src/lib/checkout-spark-quote-authority"
import { createCartItemFromProduct } from "../apps/market/src/lib/cart-model"
import {
  getProductEventMarketCandidates,
  projectRawEventCatalog,
  resolveProductCartFulfillmentFromCatalogs,
} from "../apps/market/src/lib/event-market-adapter"

const NOW = 1_800_000_001_000

function fixture(unsignedAnnotations = false) {
  const organizerKey = generateSecretKey()
  const merchantKey = generateSecretKey()
  const organizer = getPublicKey(organizerKey)
  const merchant = getPublicKey(merchantKey)
  const collectionCoordinate = `30405:${organizer}:market`
  const calendarCoordinate = `31923:${organizer}:day`
  const pickupCoordinate = `30406:${merchant}:booth`
  const productCoordinate = `30402:${merchant}:coffee`
  const sign = (
    draft: { kind: number; tags: string[][]; content: string },
    key = organizerKey
  ) => {
    const event = finalizeEvent({ ...draft, created_at: 1_800_000_000 }, key)
    return unsignedAnnotations
      ? {
          ...event,
          buyerContact: { email: "private-fixture@example.com" },
          note: "Private fixture note",
        }
      : event
  }
  const calendar = sign(
    buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: "day",
      title: "Market day",
      start: 1_800_000_000,
      end: 1_800_003_600,
    })
  )
  const collection = sign(
    buildEventMarketCollectionDraft({
      dTag: "market",
      title: "Market",
      eventCoordinate: calendarCoordinate,
      productCoordinates: [productCoordinate],
      orderAcceptance: "open",
    })
  )
  const pickup = sign(
    buildEventMarketPickupDraft({
      dTag: "booth",
      title: "Merchant booth",
      price: 0,
      currency: "SAT",
      countries: ["US"],
      location: "Public hall",
    }),
    merchantKey
  )
  const productEvent = sign(
    {
      kind: 30402,
      content: "Fresh coffee for local pickup.",
      tags: [
        ["d", "coffee"],
        ["title", "Coffee"],
        ["price", "1000", "SAT"],
        ["type", "simple", "physical"],
        ["image", "https://cdn.conduit.market/coffee.png"],
        ["t", "coffee"],
        ["t", "groceries"],
        ["t", "pickup"],
        ["a", collectionCoordinate],
        ["shipping_option", pickupCoordinate],
      ],
    },
    merchantKey
  )
  const product = {
    ...parseProductEvent(productEvent),
    sourceEventId: productEvent.id,
  }
  const result: ProductsByIdsResult = {
    data: [
      {
        product,
        addressId: product.id,
        eventId: productEvent.id,
        eventCreatedAt: productEvent.created_at,
        dTag: "coffee",
        safety: evaluateListingSafety(product),
      },
    ],
    diagnostics: [
      {
        productId: product.id,
        addressId: product.id,
        issue: null,
        coverage: { listing: "complete", deletion: "complete" },
      },
    ],
    meta: {
      source: "commerce",
      degraded: false,
      stale: false,
      capped: false,
      fetchedAt: NOW,
      capabilities: {
        sortModes: [],
        textSearch: false,
        protectedSummaries: false,
        canonicalFreshness: true,
        cursorPagination: false,
      },
    },
  }
  const resolution = resolveEventMarketEvidence({
    reference: collectionCoordinate,
    events: [calendar, collection, pickup],
    productRequestEvents: [productEvent],
    livePickupEventIds: new Set([pickup.id]),
    nowMs: NOW,
  })
  const catalog = projectRawEventCatalog({
    reference: collectionCoordinate,
    complete: true,
    resolution,
    result,
  })
  const resolve = () =>
    resolveProductCartFulfillmentFromCatalogs(product, [
      { candidate: getProductEventMarketCandidates(product)[0]!, catalog },
    ])
  const resolved = resolve()
  if (resolved.status !== "pickup") throw new Error("Expected current pickup")
  const item = {
    ...createCartItemFromProduct(product, resolved.fulfillment),
    quantity: 1,
  }
  return { calendar, collection, pickup, product, catalog, resolve, item }
}

it("carries the exact signed pickup graph through submit authorization, outside the cart", async () => {
  const source = fixture()
  const resolved = source.resolve()
  if (resolved.status !== "pickup") throw new Error("Expected current pickup")
  const authorization = await authorizeCurrentCheckoutItems({
    mode: "direct_payment",
    reviewedItems: [source.item],
    rawItems: [source.item],
    refreshedProducts: [source.product],
    resolveProductFulfillment: async () => resolved,
    readShippingOptions: async () => [],
  })
  expect(authorization.status).toBe("ok")
  if (authorization.status !== "ok") throw new Error("Expected authorization")
  expect(authorization.pickupSourceEvents).toEqual(
    structuredClone([source.calendar, source.collection, source.pickup])
  )
  resolved.pickupSourceEvents![0]!.tags[0]![1] = "changed-resolution"
  expect(authorization.pickupSourceEvents![0]!.tags[0]![1]).toBe("day")
  expect(JSON.stringify(authorization.items).includes('"signedEvent"')).toBe(
    false
  )
  expect(
    JSON.stringify(authorization.items).includes('"pickupSourceEvents"')
  ).toBe(false)
  const quote = buildCheckoutSparkQuoteAuthority({
    authorization,
    rateInput: null,
    nowMs: NOW,
  })
  const commerce = buildCheckoutSparkCommerceEvidence(quote)
  expect(quote.pickupSourceEvents).toEqual(authorization.pickupSourceEvents)
  expect(commerce.lines[0]?.pickup).toEqual({
    calendar: {
      coordinate: source.catalog.calendar!.coordinate,
      eventId: source.calendar.id,
    },
    collection: {
      coordinate: source.catalog.collection!.coordinate,
      eventId: source.collection.id,
    },
  })
  expect(commerce.lines[0]?.shippingOption).toEqual({
    coordinate: source.catalog.pickups[0]!.coordinate,
    eventId: source.pickup.id,
  })
  expect(commerce.lines[0]?.unitShippingSats).toBe(0)
  const frozen = JSON.stringify(quote)
  authorization.pickupSourceEvents![0]!.tags[0]![1] = "changed-source"
  source.calendar.tags[0]![1] = "changed-original"
  source.catalog.calendar!.signedEvent!.tags[0]![1] = "changed-projection"
  expect(JSON.stringify(quote)).toBe(frozen)
  expect(Object.isFrozen(quote.pickupSourceEvents![0]!.tags[0])).toBe(true)
})

it("retains only signed public fields, excluding unsigned private annotations", () => {
  const source = fixture(true)
  expect(
    [
      source.catalog.calendar!.signedEvent!,
      source.catalog.collection!.signedEvent!,
      source.catalog.pickups[0]!.signedEvent!,
    ].every((event) => Object.keys(event).length === 7)
  ).toBe(true)
  Object.assign(source.catalog.calendar!.signedEvent!, {
    buyerContact: { email: "private-projection@example.com" },
  })
  const resolved = source.resolve()
  if (resolved.status !== "pickup") throw new Error("Expected current pickup")
  expect(
    resolved.pickupSourceEvents?.every(
      (event) =>
        Object.keys(event).sort().join(",") ===
        "content,created_at,id,kind,pubkey,sig,tags"
    )
  ).toBe(true)
})

it("excludes unsigned annotations added between authorization and quote freezing", async () => {
  const source = fixture()
  const authorization = await authorizeCurrentCheckoutItems({
    mode: "direct_payment",
    reviewedItems: [source.item],
    rawItems: [source.item],
    refreshedProducts: [source.product],
    resolveProductFulfillment: async () => source.resolve(),
    readShippingOptions: async () => [],
  })
  if (authorization.status !== "ok") throw new Error("Expected authorization")
  Object.assign(authorization.pickupSourceEvents![0]!, {
    buyerContact: { email: "private-quote@example.test" },
    note: "Private local annotation",
  })
  const quote = buildCheckoutSparkQuoteAuthority({
    authorization,
    rateInput: null,
    nowMs: NOW,
  })
  expect(quote.pickupSourceEvents).toEqual(
    structuredClone([source.calendar, source.collection, source.pickup])
  )
})

it("detaches parsed and selected source bytes from caller and catalog mutations", () => {
  const source = fixture()
  source.calendar.tags[0]![1] = "changed-original"
  source.collection.tags[0]![1] = "changed-original"
  source.pickup.tags[0]![1] = "changed-original"
  const resolved = source.resolve()
  if (resolved.status !== "pickup") throw new Error("Expected current pickup")
  expect(
    resolved.pickupSourceEvents?.map((event) => event.tags[0]![1])
  ).toEqual(["day", "market", "booth"])
  source.catalog.calendar!.signedEvent!.tags[0]![1] = "changed-catalog"
  source.catalog.collection!.signedEvent!.tags[0]![1] = "changed-catalog"
  source.catalog.pickups[0]!.signedEvent!.tags[0]![1] = "changed-catalog"
  expect(
    resolved.pickupSourceEvents?.map((event) => event.tags[0]![1])
  ).toEqual(["day", "market", "booth"])
})

it.each(["missing", "invalid_signature", "different_revision"] as const)(
  "does not fabricate pickup sources from a %s calendar projection",
  (reason) => {
    const source = fixture()
    if (reason === "missing") delete source.catalog.calendar!.signedEvent
    if (reason === "invalid_signature") {
      source.catalog.calendar!.signedEvent!.sig = "0".repeat(128)
    }
    if (reason === "different_revision") {
      source.catalog.calendar!.signedEvent = fixture().calendar
    }
    const resolved = source.resolve()
    expect(resolved.status).toBe("pickup")
    if (resolved.status !== "pickup")
      throw new Error("Expected pickup projection")
    expect(resolved.pickupSourceEvents).toBeUndefined()
  }
)

it.each(["stale", "ended", "deleted"] as const)(
  "does not promote retained signed bytes from a %s catalog to checkout authority",
  (state) => {
    const source = fixture()
    source.catalog.state = state
    source.catalog.purchaseReady = false
    expect(source.resolve().status).toBe("blocked")
  }
)
