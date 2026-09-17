import { describe, expect, it } from "bun:test"
import {
  getShopperPriceDisplay,
  prepareProductCatalog,
  type PricingRateInput,
  type Product,
} from "@conduit/core"
import {
  buildEventCatalogBrowse,
  type EventCatalogSort,
} from "../apps/market/src/lib/event-catalog-browse"
import type { EventCatalogProduct } from "../apps/market/src/lib/event-market-adapter"

function entry(
  id: string,
  pubkey: string,
  overrides: Partial<Product> = {}
): EventCatalogProduct {
  return {
    product: {
      id,
      pubkey,
      title: id,
      price: 1,
      currency: "SAT",
      type: "simple",
      visibility: "public",
      images: [],
      tags: [],
      createdAt: 100,
      updatedAt: 100,
      ...overrides,
    },
    evidenceState: "live",
    participation: {
      status: "accepted",
      requested: true,
      accepted: true,
      pickupReferenced: true,
      collectionReferencedForFulfillment: false,
      purchaseReady: true,
    },
    pickupFulfillment: null,
  }
}

function browse(
  products: EventCatalogProduct[],
  overrides: Partial<Parameters<typeof buildEventCatalogBrowse>[0]> = {}
) {
  return buildEventCatalogBrowse({
    products,
    merchantNames: {},
    search: "",
    merchant: "",
    sort: "name",
    btcUsdRate: null,
    ...overrides,
  })
}

function pickup(): NonNullable<EventCatalogProduct["pickupFulfillment"]> {
  const pubkey = "a".repeat(64)
  const evidence = (kind: number) => ({
    coordinate: `${kind}:${pubkey}:test`,
    eventId: "b".repeat(64),
    createdAt: 100,
  })
  return {
    type: "pickup",
    organizerPubkey: pubkey,
    product: { ...evidence(30402), merchantPubkey: pubkey },
    calendar: evidence(31923),
    collection: evidence(30405),
    option: {
      ...evidence(30406),
      title: "Event pickup",
      location: "Event desk",
    },
    costSats: 0,
    sourceCost: { amount: 0, currency: "SAT", normalizedCurrency: "SAT" },
  }
}

const ids = (entries: EventCatalogProduct[]) =>
  entries.map(({ product }) => product.id)

describe("event catalog browsing", () => {
  it("keeps identical merchant names separate and counts the full catalog", () => {
    const products = [
      entry("zebra", "merchant-b"),
      entry("mug", "merchant-a"),
      entry("cap", "merchant-a"),
    ]
    const result = browse(products, {
      merchantNames: { "merchant-a": "Same shop", "merchant-b": "Same shop" },
      search: "MUG",
      merchant: "merchant-a",
    })
    expect(ids(result.products)).toEqual(["mug"])
    expect(result.merchants).toEqual([
      { pubkey: "merchant-a", name: "Same shop", count: 2 },
      { pubkey: "merchant-b", name: "Same shop", count: 1 },
    ])
    expect(
      result.groups.map(({ pubkey, products }) => [pubkey, ids(products)])
    ).toEqual([["merchant-a", ["mug"]]])
    expect(browse(products, { merchant: "unknown" }).products).toEqual([])
    expect(browse(products, { merchant: "unknown" }).groups).toEqual([])
  })

  it("searches event product and merchant names without case or accent sensitivity", () => {
    const products = [
      entry("coffee", "a", { title: "Café roast" }),
      entry("mug", "b"),
    ]
    const merchantNames = { a: "Lakefront", b: "Éclat" }
    expect(
      ids(browse(products, { search: " CAFE ", merchantNames }).products)
    ).toEqual(["coffee"])
    expect(
      ids(browse(products, { search: "eCLAT", merchantNames }).products)
    ).toEqual(["mug"])
    expect(
      browse(products, { search: "eclat", merchant: "a", merchantNames })
        .products
    ).toEqual([])
  })

  it("groups by seller identity with alphabetical groups and preserves selected product sorting", () => {
    const products = [
      entry("high", "b", { price: 30 }),
      entry("low", "a", { price: 10 }),
      entry("middle", "b", { price: 20 }),
    ]
    const result = browse(products, {
      merchantNames: { a: "Zed", b: "Alpha" },
      sort: "price-desc",
    })
    expect(
      result.groups.map(({ name, products }) => [name, ids(products)])
    ).toEqual([
      ["Alpha", ["high", "middle"]],
      ["Zed", ["low"]],
    ])
    expect(
      ids(
        browse(products, {
          merchantNames: { a: "Zed", b: "Alpha" },
          sort: "merchant",
        }).products
      )
    ).toEqual(["high", "middle", "low"])
    expect(ids(products)).toEqual(["high", "low", "middle"])
    expect(result.products[0]).toBe(products[0])
  })

  it("compares mixed supported currencies and keeps unavailable prices last in both directions", () => {
    const products = [
      entry("unavailable", "a", { price: 4, currency: "XYZ" }),
      entry("btc", "a", { price: 0.00002, currency: "BTC" }),
      entry("sats", "a", { price: 1000 }),
      entry("fiat", "a", { price: 3, currency: "USD" }),
    ]
    for (const [sort, expected] of [
      ["price-asc", ["sats", "btc", "fiat", "unavailable"]],
      ["price-desc", ["fiat", "btc", "sats", "unavailable"]],
    ] as [EventCatalogSort, string[]][]) {
      const result = browse(products, {
        sort,
        btcUsdRate: { rate: 100_000, fetchedAt: Date.now(), source: "mempool" },
      })
      expect(ids(result.products)).toEqual(expected)
      expect(result.hasUnavailablePriceForSort).toBe(true)
    }
    expect(browse(products).hasUnavailablePriceForSort).toBe(false)
    expect(
      browse(products, { sort: "price-asc", search: "sats" })
        .hasUnavailablePriceForSort
    ).toBe(false)
    expect(ids(browse(products, { sort: "price-desc" }).products)).toEqual([
      "btc",
      "sats",
      "fiat",
      "unavailable",
    ])
  })

  for (const [label, btcUsdRate] of [
    ["missing", null],
    ["without a timestamp", 100_000],
    ["stale", { rate: 100_000, fetchedAt: 1_000, source: "mempool" }],
    [
      "future-dated",
      { rate: 100_000, fetchedAt: Date.now() + 86_400_000, source: "mempool" },
    ],
  ] satisfies [string, PricingRateInput][]) {
    it(`puts rate-dependent prices last when the quote is ${label}`, () => {
      const fiat = entry("fiat", "a", { price: 0.5, currency: "USD" })
      const cachedFiat = entry("cached-fiat", "a", {
        price: 5_000,
        currency: "SAT",
        priceSats: 5_000,
        sourcePrice: { amount: 5, currency: "USD", normalizedCurrency: "USD" },
      })
      const native = entry("native", "a", { price: 1_000 })
      const bitcoin = entry("bitcoin", "a", { price: 0.00002, currency: "BTC" })
      const free = entry("free", "a", {
        price: 0,
        priceSats: 0,
        sourcePrice: { amount: 0, currency: "SAT", normalizedCurrency: "SAT" },
      })
      free.pickupFulfillment = pickup()
      const products = [fiat, native, cachedFiat, bitcoin, free]
      for (const [sort, expected] of [
        ["price-asc", ["free", "native", "bitcoin", "cached-fiat", "fiat"]],
        ["price-desc", ["bitcoin", "native", "free", "cached-fiat", "fiat"]],
      ] satisfies [EventCatalogSort, string[]][]) {
        const result = browse(products, { sort, btcUsdRate })
        expect(ids(result.products)).toEqual(expected)
        expect(result.hasUnavailablePriceForSort).toBe(true)
        expect(
          browse([native, bitcoin, free], { sort, btcUsdRate })
            .hasUnavailablePriceForSort
        ).toBe(false)
      }
      for (const product of [fiat.product, cachedFiat.product]) {
        expect(
          getShopperPriceDisplay(
            product,
            undefined,
            typeof btcUsdRate === "object" ? btcUsdRate : null
          ).sats
        ).toBeNull()
      }
    })
  }

  it("recomputes cached fiat prices from fresh or configured quotes, matching the card", () => {
    const fiat = entry("fiat", "a", {
      price: 5,
      currency: "USD",
      priceSats: 9_000,
      sourcePrice: { amount: 5, currency: "USD", normalizedCurrency: "USD" },
    })
    const native = entry("native", "a", { price: 4_000 })
    for (const btcUsdRate of [
      { rate: 200_000, fetchedAt: Date.now(), source: "mempool" },
      { rate: 200_000, fetchedAt: 1, source: "env" },
    ] as const) {
      expect(
        getShopperPriceDisplay(fiat.product, undefined, btcUsdRate).sats
      ).toBe(2_500)
      for (const [sort, expected] of [
        ["price-asc", ["fiat", "native"]],
        ["price-desc", ["native", "fiat"]],
      ] satisfies [EventCatalogSort, string[]][]) {
        const result = browse([native, fiat], { sort, btcUsdRate })
        expect(ids(result.products)).toEqual(expected)
        expect(result.hasUnavailablePriceForSort).toBe(false)
      }
    }
  })

  it("sorts variable products by the displayed family minimum", () => {
    const parent = entry("shirt", "a", { type: "variable", price: 100 })
    const child = entry("shirt-small", "a", {
      type: "variation",
      price: 3000,
      parentProductId: "shirt",
      specifications: [{ key: "size", value: "S" }],
      stock: 5,
    })
    const prepared = prepareProductCatalog(
      [parent, child].map(({ product }) => ({
        product,
        addressId: product.id,
        eventId: `${product.id}-event`,
        eventCreatedAt: product.createdAt,
        dTag: product.id,
      })),
      {
        source: "commerce",
        fetchedAt: 101,
        stale: false,
        degraded: false,
        capped: false,
      }
    ).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected a family")
    parent.family = prepared.family
    parent.familyPickupFulfillments = { [child.product.id]: pickup() }
    const sticker = entry("sticker", "a", { price: 2000 })
    expect(
      ids(browse([parent, sticker], { sort: "price-asc" }).products)
    ).toEqual(["sticker", "shirt"])
  })
  it("sorts by safe displayed variants without turning pending pickup into missing options", () => {
    const parent = entry("shirt", "a", { type: "variable", price: 100 })
    const cheap = entry("cheap", "a", {
      type: "variation",
      price: 500,
      parentProductId: "shirt",
      specifications: [{ key: "size", value: "S" }],
      stock: 5,
    })
    const costly = entry("costly", "a", {
      type: "variation",
      price: 3000,
      parentProductId: "shirt",
      specifications: [{ key: "size", value: "L" }],
      stock: 5,
    })
    const prepared = prepareProductCatalog(
      [parent, cheap, costly].map(({ product }) => ({
        product,
        addressId: product.id,
        eventId: `${product.id}-event`,
        eventCreatedAt: 100,
      })),
      {
        source: "commerce",
        fetchedAt: 101,
        stale: false,
        degraded: false,
        capped: false,
      }
    ).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected family")
    parent.family = prepared.family
    parent.familyPickupFulfillments = { cheap: null, costly: pickup() }
    const sticker = entry("sticker", "a", { price: 2000 })
    // The adapter has already removed unsafe/unlisted children. Pickup
    // readiness does not remove otherwise safe choices from the card.
    expect(
      ids(browse([parent, sticker], { sort: "price-asc" }).products)
    ).toEqual(["shirt", "sticker"])
    parent.evidenceState = "retained"
    parent.familyPickupFulfillments = { cheap: null, costly: null }
    parent.participation.purchaseReady = false
    const pending = browse([parent, sticker], { sort: "price-asc" })
    expect(ids(pending.products)).toEqual(["shirt", "sticker"])
    expect(pending.products[0]?.family).toBe(prepared.family)
    expect(pending.products[0]?.family?.children).toHaveLength(2)
    expect(pending.products[0]?.participation.purchaseReady).toBe(false)
    expect(pending.products[0]?.familyPickupFulfillments).toEqual({
      cheap: null,
      costly: null,
    })
    // Actual family removal still uses the price the card can display.
    parent.family = undefined
    expect(
      ids(browse([parent, sticker], { sort: "price-asc" }).products)
    ).toEqual(["shirt", "sticker"])
  })

  it("includes canonical free pickup products in price order only with pickup evidence", () => {
    const free = entry("free", "a", {
      price: 0,
      priceSats: 0,
      currency: "SAT",
      sourcePrice: { amount: 0, currency: "SAT", normalizedCurrency: "SAT" },
    })
    free.pickupFulfillment = pickup()
    const paid = entry("paid", "a", { price: 100 })
    const result = browse([paid, free], { sort: "price-asc" })
    expect(ids(result.products)).toEqual(["free", "paid"])
    expect(result.hasUnavailablePriceForSort).toBe(false)
    expect(ids(browse([free, paid], { sort: "price-desc" }).products)).toEqual([
      "paid",
      "free",
    ])
    free.pickupFulfillment = null
    const withoutEvidence = browse([free, paid], { sort: "price-asc" })
    expect(ids(withoutEvidence.products)).toEqual(["paid", "free"])
    expect(withoutEvidence.hasUnavailablePriceForSort).toBe(true)
  })
})
