import { describe, expect, it } from "bun:test"
import type { ParsedShippingOption, Product } from "@conduit/core"
import { authorizeCurrentCheckoutItems } from "../apps/market/src/lib/checkout-authorization"
import { buildCheckoutSparkCommerceEvidence } from "../apps/market/src/lib/checkout-spark-commerce-evidence"
import { buildCheckoutSparkQuoteAuthority } from "../apps/market/src/lib/checkout-spark-quote-authority"
import {
  createCartItemFromProduct,
  type CartItem,
  type CartPickupFulfillment,
} from "../apps/market/src/lib/cart-model"

const MERCHANT = "a".repeat(64)
const ORGANIZER = "b".repeat(64)
const PRODUCT_ID = `30402:${MERCHANT}:notebook`
const SHIPPING_ID = `30406:${MERCHANT}:notebook-shipping-standard`
const PICKUP_ID = `30406:${ORGANIZER}:market-pickup`
const PRODUCT_EVENT_ID = "1".repeat(64)
const SHIPPING_EVENT_ID = "2".repeat(64)
const PICKUP_EVENT_ID = "3".repeat(64)
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

function pickup(): CartPickupFulfillment {
  return {
    type: "pickup",
    organizerPubkey: ORGANIZER,
    product: {
      coordinate: PRODUCT_ID,
      eventId: PRODUCT_EVENT_ID,
      createdAt: 10,
      merchantPubkey: MERCHANT,
    },
    calendar: {
      coordinate: `31923:${ORGANIZER}:market`,
      eventId: "4".repeat(64),
      createdAt: 1,
    },
    collection: {
      coordinate: `30405:${ORGANIZER}:market`,
      eventId: "5".repeat(64),
      createdAt: 1,
    },
    option: {
      coordinate: PICKUP_ID,
      eventId: PICKUP_EVENT_ID,
      createdAt: 1,
      title: "Market booth",
      location: "Hall A",
    },
    handoffMode: "organizer_handoff",
    handlerPubkey: ORGANIZER,
    costSats: 0,
    sourceCost: {
      amount: 0,
      currency: "SATS",
      normalizedCurrency: "SATS",
    },
  }
}

async function authorize(
  listing: Product,
  options: {
    item?: CartItem
    rawItem?: CartItem
    resolved?: Product
    shipping?: ParsedShippingOption[]
    pickup?: CartPickupFulfillment
  } = {}
) {
  const item = options.item ?? {
    ...createCartItemFromProduct(listing, options.pickup),
    quantity: 2,
  }
  return authorizeCurrentCheckoutItems({
    mode: "direct_payment",
    reviewedItems: [item],
    rawItems: [options.rawItem ?? item],
    refreshedProducts: [listing],
    readShippingOptions: async () => options.shipping ?? [],
    resolveProductFulfillment: async () =>
      options.pickup
        ? {
            status: "pickup",
            product: options.resolved ?? listing,
            fulfillment: options.pickup,
          }
        : {
            status: "standard",
            type: listing.format,
            product: options.resolved ?? listing,
          },
    authorizePickupHandlers: async () => undefined,
  })
}

describe("checkout Spark quote authority", () => {
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
    const listing = product({
      format: "physical",
      shippingOptionId: PICKUP_ID,
      shippingOptionDTag: "market-pickup",
    })
    const fulfillment = pickup()
    const authorization = await authorize(listing, {
      item: {
        ...createCartItemFromProduct(listing, fulfillment),
        quantity: 2,
      },
      pickup: fulfillment,
    })
    expect(authorization.status).toBe("ok")
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

  it("rejects differing listing and pickup-catalog product revisions", async () => {
    const listing = product({
      format: "physical",
      shippingOptionId: PICKUP_ID,
      shippingOptionDTag: "market-pickup",
    })
    const resolved = { ...listing, sourceEventId: "6".repeat(64) }
    const fulfillment = pickup()
    const authorization = await authorize(listing, {
      item: {
        ...createCartItemFromProduct(resolved, fulfillment),
        quantity: 2,
      },
      resolved,
      pickup: fulfillment,
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

  it("accepts a current pickup graph only with the exact product revision", async () => {
    const listing = product({
      format: "physical",
      shippingOptionId: PICKUP_ID,
      shippingOptionDTag: "market-pickup",
    })
    const fulfillment = pickup()
    const authorization = await authorize(listing, {
      pickup: fulfillment,
    })
    if (authorization.status !== "ok") throw new Error("Expected checkout")

    const bundle = buildCheckoutSparkQuoteAuthority({
      authorization,
      rateInput: null,
    })
    expect(bundle.lines[0]?.shippingOption).toEqual({
      coordinate: PICKUP_ID,
      eventId: PICKUP_EVENT_ID,
    })

    const changed = {
      ...authorization,
      items: [
        {
          ...authorization.items[0]!,
          fulfillment: {
            ...fulfillment,
            product: { ...fulfillment.product, eventId: "7".repeat(64) },
          },
        },
      ],
    }
    expect(() =>
      buildCheckoutSparkQuoteAuthority({
        authorization: changed,
        rateInput: null,
      })
    ).toThrow("Current signed checkout evidence changed")
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
