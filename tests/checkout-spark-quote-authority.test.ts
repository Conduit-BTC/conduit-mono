import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  parseProductEvent,
  deriveCheckoutSparkSignedCommerceObligations,
} from "@conduit/core"
import type { ParsedShippingOption, Product } from "@conduit/core"
import { authorizeCurrentCheckoutItems } from "../apps/market/src/lib/checkout-authorization"
import { buildCheckoutSparkCommerceEvidence } from "../apps/market/src/lib/checkout-spark-commerce-evidence"
import { buildCheckoutSparkQuoteAuthority } from "../apps/market/src/lib/checkout-spark-quote-authority"
import {
  createCartItemFromProduct,
  type CartItem,
} from "../apps/market/src/lib/cart-model"

import { createEventMarketCheckoutFixture } from "./helpers/event-market-checkout-fixture"

const MERCHANT = "a".repeat(64)
const ORGANIZER = "b".repeat(64)
const PRODUCT_ID = `30402:${MERCHANT}:notebook`
const SHIPPING_ID = `30406:${MERCHANT}:notebook-shipping-standard`
const PRODUCT_EVENT_ID = "1".repeat(64)
const SHIPPING_EVENT_ID = "2".repeat(64)
const NOW = 1_700_000_000_000

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: PRODUCT_ID,
    sourceEventId: PRODUCT_EVENT_ID,
    pubkey: MERCHANT,
    title: "Notebook",
    price: 20,
    currency: "SATS",
    sourcePrice: {
      amount: 20,
      currency: "SATS",
      normalizedCurrency: "SATS",
    },
    type: "simple",
    specifications: [],
    format: "digital",
    visibility: "public",
    images: [],
    tags: [],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  }
}

function shippingOption(): ParsedShippingOption {
  return {
    id: SHIPPING_ID,
    eventId: SHIPPING_EVENT_ID,
    pubkey: MERCHANT,
    dTag: "notebook-shipping-standard",
    title: "Standard Shipping",
    currency: "USD",
    price: 5,
    countries: ["US"],
    countryRules: [{ code: "US", name: "US", restrictTo: [], exclude: [] }],
    service: "standard",
    createdAt: 1,
    launchUnsupportedTags: [],
  }
}

async function authorize(
  listing: Product,
  options: {
    item?: CartItem
    rawItem?: CartItem
    resolved?: Product
    shipping?: ParsedShippingOption[]
  } = {}
) {
  const item = options.item ?? {
    ...createCartItemFromProduct(listing),
    quantity: 2,
  }
  return authorizeCurrentCheckoutItems({
    mode: "direct_payment",
    reviewedItems: [item],
    rawItems: [options.rawItem ?? item],
    refreshedProducts: [listing],
    readShippingOptions: async () => options.shipping ?? [],
    resolveProductFulfillment: async () => ({
      status: "standard",
      type: listing.format === "digital" ? "digital" : "shipping",
      product: options.resolved ?? listing,
    }),
    authorizePickupHandlers: async () => undefined,
  })
}

describe("checkout Spark quote authority", () => {
  it("carries a fresh fiat variation quote from authorization into exact signed allocation", async () => {
    const key = generateSecretKey()
    const merchant = getPublicKey(key)
    const event = finalizeEvent(
      {
        kind: 30_402,
        created_at: NOW / 1_000,
        tags: [
          ["d", "child"],
          ["title", "Child"],
          ["price", "2.5", "USD"],
          ["type", "variation", "digital"],
          ["a", `30402:${merchant}:family`],
          ["spec", "Size", "Large"],
        ],
        content: "",
      },
      key
    )
    const listing = { ...parseProductEvent(event), sourceEventId: event.id }
    const item = {
      ...createCartItemFromProduct(listing),
      familyProductId: listing.parentProductId,
      quantity: 2,
    }
    const authorization = await authorize(listing, { item })
    if (authorization.status !== "ok") throw new Error("Expected checkout")
    const authority = buildCheckoutSparkQuoteAuthority({
      authorization,
      rateInput: { rate: 100_000, fetchedAt: NOW, source: "mempool" },
      nowMs: NOW,
    })
    const evidence = buildCheckoutSparkCommerceEvidence(authority)
    expect(evidence.pricing?.rate.rate).toBe(100_000)
    expect(evidence.lines[0]?.variation?.familyCoordinate).toBe(
      listing.parentProductId
    )
    expect(
      deriveCheckoutSparkSignedCommerceObligations({
        quote: evidence,
        products: authority.products,
        merchantPubkey: merchant,
        acceptedAtMs: NOW,
      })
    ).toEqual([{ kind: "merchant", recipientId: merchant, amountSats: 5_000 }])
  })

  it("binds cart-order quote lines when signed listing reads arrive reversed", async () => {
    const first = product()
    const second = product({
      id: `30402:${MERCHANT}:second-notebook`,
      sourceEventId: "7".repeat(64),
      title: "Second notebook",
      price: 35,
      sourcePrice: {
        amount: 35,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
    })
    const cartItems = [
      { ...createCartItemFromProduct(first), quantity: 1 },
      { ...createCartItemFromProduct(second), quantity: 1 },
    ]
    const authorization = await authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      reviewedItems: cartItems,
      rawItems: cartItems,
      refreshedProducts: [second, first],
      readShippingOptions: async () => [],
      resolveProductFulfillment: async (listing) => ({
        status: "standard",
        type: "digital",
        product: listing,
      }),
      authorizePickupHandlers: async () => undefined,
    })
    expect(authorization.status).toBe("ok")
    if (authorization.status !== "ok") throw new Error("Expected checkout")
    expect(authorization.items.map((item) => item.productId)).toEqual([
      first.id,
      second.id,
    ])

    const authority = buildCheckoutSparkQuoteAuthority({
      authorization,
      rateInput: null,
      nowMs: NOW,
    })
    expect(authority.products.map((listing) => listing.id)).toEqual([
      second.id,
      first.id,
    ])
    expect(authority.lines.map((line) => line.productCoordinate)).toEqual([
      first.id,
      second.id,
    ])
    const evidence = buildCheckoutSparkCommerceEvidence(authority)
    expect(evidence.lines).toEqual([
      {
        ...authority.lines[0],
        unitMerchandiseSats: 20,
        unitShippingSats: 0,
      },
      {
        ...authority.lines[1],
        unitMerchandiseSats: 35,
        unitShippingSats: 0,
      },
    ])
    expect(evidence.commerceTotalSats).toBe(55)
  })

  it("freezes the exact listing revision, quantity, and SATS quote", async () => {
    const listing = product()
    const authorization = await authorize(listing)
    if (authorization.status !== "ok") throw new Error("Expected checkout")

    const bundle = buildCheckoutSparkQuoteAuthority({
      authorization,
      rateInput: null,
      nowMs: NOW,
    })

    expect(bundle.pricing.totalSats).toBe(40)
    expect(bundle.lines).toEqual([
      {
        productCoordinate: PRODUCT_ID,
        productEventId: PRODUCT_EVENT_ID,
        merchantPubkey: MERCHANT,
        quantity: 2,
      },
    ])
    expect(bundle.products[0]?.sourceEventId).toBe(PRODUCT_EVENT_ID)
    expect(Object.isFrozen(bundle)).toBe(true)
    expect(Object.isFrozen(bundle.pricing.items[0])).toBe(true)
    listing.title = "A later local edit"
    expect(bundle.products[0]?.title).toBe("Notebook")
  })

  it("freezes the selected signed 30406 revision and fresh fiat quote", async () => {
    const listing = product({
      format: "physical",
      price: 20,
      currency: "USD",
      sourcePrice: {
        amount: 20,
        currency: "USD",
        normalizedCurrency: "USD",
      },
      shippingOptionId: SHIPPING_ID,
      shippingOptionDTag: "notebook-shipping-standard",
    })
    const raw = { ...createCartItemFromProduct(listing), quantity: 2 }
    const option = shippingOption()
    const reviewed: CartItem = {
      ...raw,
      sourceShippingCost: {
        amount: 5,
        currency: "USD",
        normalizedCurrency: "USD",
      },
      shippingCountries: ["US"],
      shippingCountryRules: option.countryRules,
      canonicalShippingResolved: true,
    }
    const authorization = await authorize(listing, {
      item: reviewed,
      rawItem: raw,
      shipping: [option],
    })
    if (authorization.status !== "ok") throw new Error("Expected checkout")

    const bundle = buildCheckoutSparkQuoteAuthority({
      authorization,
      rateInput: { rate: 50_000, fetchedAt: NOW, source: "mempool" },
      nowMs: NOW + 30_000,
    })

    expect(bundle.pricing.totalSats).toBe(100_000)
    expect(bundle.lines[0]?.shippingOption).toEqual({
      coordinate: SHIPPING_ID,
      eventId: SHIPPING_EVENT_ID,
    })
    expect(bundle.pricing.quote?.fetchedAt).toBe(NOW)

    expect(() =>
      buildCheckoutSparkQuoteAuthority({
        authorization,
        rateInput: { rate: 50_000, fetchedAt: NOW, source: "mempool" },
        nowMs: NOW + 3_600_000,
      })
    ).toThrow("Current signed checkout evidence changed")
  })

  it("rejects a resolved shipping capability that contradicts the signed listing", async () => {
    const listing = product()
    const authorization = await authorize(listing)
    if (authorization.status !== "ok") throw new Error("Expected checkout")
    expect(() =>
      buildCheckoutSparkQuoteAuthority({
        authorization: {
          ...authorization,
          listingReadProducts: [
            { ...listing, shippingOptionLaunchUnsupported: true },
          ],
        },
        rateInput: null,
      })
    ).toThrow("Current signed checkout evidence changed")
  })

  it("rejects differing listing and fulfillment-resolved product revisions", async () => {
    const listing = product()
    const resolved = { ...listing, sourceEventId: "6".repeat(64) }
    const authorization = await authorize(listing, {
      item: { ...createCartItemFromProduct(resolved), quantity: 2 },
      resolved,
    })
    expect(authorization.status).toBe("ok")
    if (authorization.status !== "ok") throw new Error("Expected checkout")
    expect(() =>
      buildCheckoutSparkQuoteAuthority({ authorization, rateInput: null })
    ).toThrow("Current signed checkout evidence changed")
  })

  it("rejects contradictory price and variation projections even with the same event id", async () => {
    const listing = product()
    const authorization = await authorize(listing)
    if (authorization.status !== "ok") throw new Error("Expected checkout")

    for (const resolved of [
      { ...listing, price: 21 },
      { ...listing, specifications: [{ key: "size", value: "XL" }] },
      { ...listing, publicZapEnabled: false },
      { ...listing, visibility: "private" as const },
    ]) {
      expect(() =>
        buildCheckoutSparkQuoteAuthority({
          authorization: {
            ...authorization,
            fulfillmentResolvedProducts: [resolved],
          },
          rateInput: null,
        })
      ).toThrow("Current signed checkout evidence changed")
    }
  })

  it("rejects duplicate lines whose combined quantity could bypass stock", async () => {
    const listing = product({ stock: 3 })
    const authorization = await authorize(listing)
    if (authorization.status !== "ok") throw new Error("Expected checkout")
    const line = authorization.items[0]!

    expect(() =>
      buildCheckoutSparkQuoteAuthority({
        authorization: {
          ...authorization,
          items: [line, { ...line, cartLineId: "second-line" }],
        },
        rateInput: null,
      })
    ).toThrow("Current signed checkout evidence changed")
  })

  it("rejects a forged digital lane for a physical signed listing", async () => {
    const listing = product()
    const authorization = await authorize(listing)
    if (authorization.status !== "ok") throw new Error("Expected checkout")

    expect(() =>
      buildCheckoutSparkQuoteAuthority({
        authorization: {
          ...authorization,
          listingReadProducts: [{ ...listing, format: "physical" }],
          fulfillmentResolvedProducts: [{ ...listing, format: "physical" }],
        },
        rateInput: null,
      })
    ).toThrow("Current signed checkout evidence changed")
  })

  it("composes current signed Event Market and digital evidence into an exact Spark quote", async () => {
    const event = await createEventMarketCheckoutFixture()
    const digital = product()
    const eventItem = { ...event.item, quantity: 2 }
    const items = [
      eventItem,
      { ...createCartItemFromProduct(digital), quantity: 1 },
    ]
    const authorization = await authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      reviewedItems: items,
      rawItems: items,
      refreshedProducts: [digital, event.product],
      futureEventMarketDependencies: event.futureEventMarketDependencies,
      readShippingOptions: async () => {
        throw new Error("No shipping option required")
      },
      authorizePickupHandlers: async () => undefined,
    })
    if (authorization.status !== "ok") throw new Error("Expected checkout")
    const bundle = buildCheckoutSparkQuoteAuthority({
      authorization,
      rateInput: null,
    })
    expect(bundle.lines).toEqual([
      {
        productCoordinate: event.product.id,
        productEventId: event.product.sourceEventId,
        merchantPubkey: event.merchant,
        quantity: 2,
      },
      {
        productCoordinate: digital.id,
        productEventId: digital.sourceEventId,
        merchantPubkey: digital.pubkey,
        quantity: 1,
      },
    ])
    expect(bundle.products.map((listing) => listing.id)).toEqual([
      digital.id,
      event.product.id,
    ])
    expect(bundle.pricing.totalSats).toBe(220)
    const evidence = buildCheckoutSparkCommerceEvidence(bundle)
    expect(evidence.lines[0]).toEqual({
      ...bundle.lines[0],
      unitMerchandiseSats: 100,
      unitShippingSats: 0,
    })
    expect(evidence.commerceTotalSats).toBe(220)

    for (const fulfillment of [
      {
        ...event.fulfillment,
        product: { ...event.fulfillment.product, eventId: "7".repeat(64) },
      },
      { ...event.fulfillment, payeePubkey: event.organizer },
      { ...event.fulfillment, assignment: "Invented table" },
      {
        ...event.fulfillment,
        grant: { ...event.fulfillment.grant, ancestryEventIds: [] },
      },
      {
        ...event.fulfillment,
        market: {
          ...event.fulfillment.market,
          signedEvent: {
            ...event.fulfillment.market.signedEvent,
            content: "Altered after signing",
          },
        },
      },
    ]) {
      expect(() =>
        buildCheckoutSparkQuoteAuthority({
          authorization: {
            ...authorization,
            items: [
              { ...authorization.items[0]!, fulfillment },
              authorization.items[1]!,
            ],
          },
          rateInput: null,
        })
      ).toThrow("Current signed checkout evidence changed")
    }
  })

  it("rejects shipping charges or retired pickup snapshots at the current Event Market quote boundary", async () => {
    const event = await createEventMarketCheckoutFixture()
    const authorization = await authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      reviewedItems: [event.item],
      rawItems: [event.item],
      refreshedProducts: [event.product],
      futureEventMarketDependencies: event.futureEventMarketDependencies,
      readShippingOptions: async () => [],
      authorizePickupHandlers: async () => undefined,
    })
    if (authorization.status !== "ok") throw new Error("Expected checkout")
    for (const changed of [
      { ...authorization.items[0]!, shippingOptionId: SHIPPING_ID },
      { ...authorization.items[0]!, shippingCostSats: 1 },
      {
        ...authorization.items[0]!,
        sourceShippingCost: {
          amount: 1,
          currency: "SATS",
          normalizedCurrency: "SATS",
        },
      },
      {
        ...authorization.items[0]!,
        fulfillment: { type: "pickup" } as unknown as CartItem["fulfillment"],
      },
      {
        ...authorization.items[0]!,
        fulfillment: {
          type: "event_pickup_pending",
        } as unknown as CartItem["fulfillment"],
      },
    ]) {
      expect(() =>
        buildCheckoutSparkQuoteAuthority({
          authorization: { ...authorization, items: [changed] },
          rateInput: null,
        })
      ).toThrow("Current signed checkout evidence changed")
    }
  })

  it("rejects missing revisions, invalid quantity, and order-first shipping", async () => {
    const listing = product()
    const authorization = await authorize(listing)
    if (authorization.status !== "ok") throw new Error("Expected checkout")

    for (const changed of [
      {
        ...authorization,
        items: [{ ...authorization.items[0]!, quantity: 0 }],
      },
      {
        ...authorization,
        items: [{ ...authorization.items[0]!, productEventId: undefined }],
      },
      {
        ...authorization,
        listingReadProducts: [{ ...listing, sourceEventId: undefined }],
      },
      {
        ...authorization,
        listingReadProducts: [{ ...listing, type: "variable" as const }],
        fulfillmentResolvedProducts: [
          { ...listing, type: "variable" as const },
        ],
      },
      { ...authorization, listingReadProducts: [{ ...listing, stock: 1 }] },
      {
        ...authorization,
        fulfillmentResolvedProducts: [{ ...listing, stock: 3 }],
      },
      {
        ...authorization,
        shippingOptionEvidence: {
          status: "unavailable_order_first" as const,
          options: [] as const,
        },
      },
    ]) {
      expect(() =>
        buildCheckoutSparkQuoteAuthority({
          authorization: changed,
          rateInput: null,
        })
      ).toThrow("Current signed checkout evidence changed")
    }
  })

  it("rejects an unrelated or replaced shipping option after authorization", async () => {
    const listing = product({
      format: "physical",
      price: 20,
      currency: "USD",
      sourcePrice: {
        amount: 20,
        currency: "USD",
        normalizedCurrency: "USD",
      },
      shippingOptionId: SHIPPING_ID,
      shippingOptionDTag: "notebook-shipping-standard",
    })
    const option = shippingOption()
    const reviewed: CartItem = {
      ...createCartItemFromProduct(listing),
      quantity: 1,
      sourceShippingCost: {
        amount: 5,
        currency: "USD",
        normalizedCurrency: "USD",
      },
      shippingCountries: ["US"],
      shippingCountryRules: option.countryRules,
      canonicalShippingResolved: true,
    }
    const authorization = await authorize(listing, {
      item: reviewed,
      rawItem: { ...createCartItemFromProduct(listing), quantity: 1 },
      shipping: [option],
    })
    if (authorization.status !== "ok") throw new Error("Expected checkout")

    for (const changedOption of [
      { ...option, pubkey: ORGANIZER },
      { ...option, eventId: "not-an-event-id" },
      { ...option, price: 6 },
    ]) {
      expect(() =>
        buildCheckoutSparkQuoteAuthority({
          authorization: {
            ...authorization,
            shippingOptionEvidence: {
              status: "verified",
              options: [changedOption],
            },
          },
          rateInput: { rate: 50_000, fetchedAt: NOW, source: "mempool" },
          nowMs: NOW,
        })
      ).toThrow("Current signed checkout evidence changed")
    }

    const otherOption = {
      ...option,
      id: `30406:${MERCHANT}:other-shipping`,
      dTag: "other-shipping",
    }
    expect(() =>
      buildCheckoutSparkQuoteAuthority({
        authorization: {
          ...authorization,
          items: [
            {
              ...authorization.items[0]!,
              shippingOptionId: otherOption.id,
              shippingOptionDTag: otherOption.dTag,
            },
          ],
          shippingOptionEvidence: {
            status: "verified",
            options: [otherOption],
          },
        },
        rateInput: { rate: 50_000, fetchedAt: NOW, source: "mempool" },
        nowMs: NOW,
      })
    ).toThrow("Current signed checkout evidence changed")
  })
})
