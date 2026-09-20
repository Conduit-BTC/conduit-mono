import { describe, expect, it } from "bun:test"
import type { Product } from "@conduit/core"
import { buildEventCatalogBrowse } from "../apps/market/src/lib/event-catalog-browse"
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
    pickupReadiness: "terminal",
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
    ...overrides,
  })
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

  it("searches product and merchant names without case or accent sensitivity", () => {
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

  it("groups merchants and their products alphabetically without mutating evidence", () => {
    const products = [
      entry("zebra", "b", { title: "Zulu" }),
      entry("apple", "a", { title: "Apple" }),
      entry("amber", "b", { title: "Amber" }),
    ]
    const result = browse(products, {
      merchantNames: { a: "Zed", b: "Alpha" },
    })

    expect(
      result.groups.map(({ name, products }) => [name, ids(products)])
    ).toEqual([
      ["Alpha", ["amber", "zebra"]],
      ["Zed", ["apple"]],
    ])
    expect(ids(result.products)).toEqual(["amber", "apple", "zebra"])
    expect(ids(products)).toEqual(["zebra", "apple", "amber"])
    expect(result.groups[0]?.products[0]).toBe(products[2])
  })
})
