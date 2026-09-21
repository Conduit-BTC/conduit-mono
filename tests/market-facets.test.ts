import { describe, expect, it } from "bun:test"
import type { Product } from "@conduit/core"
import {
  filterProductsByFacets,
  getCategoryFacetOptions,
  getCategorySuggestionOptions,
  getStoreFacetOptions,
  normalizeFacetValues,
} from "../apps/market/src/lib/facets"

function product(
  id: string,
  pubkey: string,
  tags: string[],
  title = id
): Product {
  return {
    id,
    pubkey,
    title,
    price: 1,
    currency: "SAT",
    priceSats: 1,
    type: "simple",
    visibility: "public",
    images: [],
    tags,
    createdAt: 1,
    updatedAt: 1,
  }
}

const products = [
  product("a", "merchant-a", ["bitcoin", "food"], "Apple"),
  product("b", "merchant-a", ["bitcoin"], "Bolt"),
  product("c", "merchant-b", ["art"], "Canvas"),
  product("d", "merchant-c", ["food"], "Dates"),
]

describe("Market facet helpers", () => {
  it("normalizes repeated and comma-separated search values", () => {
    expect(
      normalizeFacetValues(["merchant-a,merchant-b", "merchant-a"])
    ).toEqual(["merchant-a", "merchant-b"])
  })

  it("filters with OR inside a facet and AND across facets", () => {
    const filtered = filterProductsByFacets(products, {
      merchants: ["merchant-a", "merchant-b"],
      tags: ["bitcoin", "art"],
    })

    expect(filtered.map((item) => item.id)).toEqual(["a", "b", "c"])
  })

  it("collapses mixed-case product tags into canonical facets", () => {
    const mixedProducts = [
      product("mixed", "merchant-a", [
        " Bitcoin ",
        "bitcoin",
        "BITCOIN",
        "Food",
      ]),
    ]

    expect(
      getCategoryFacetOptions(mixedProducts, {}).map((facet) => [
        facet.value,
        facet.count,
      ])
    ).toEqual([
      ["bitcoin", 1],
      ["food", 1],
    ])
    expect(
      filterProductsByFacets(mixedProducts, { tags: [" BITCOIN "] }).map(
        (item) => item.id
      )
    ).toEqual(["mixed"])
  })

  it("sorts category counts by usage then label", () => {
    const facets = getCategoryFacetOptions(products, {})

    expect(facets.map((facet) => [facet.value, facet.count])).toEqual([
      ["bitcoin", 2],
      ["food", 2],
      ["art", 1],
    ])
  })

  it("ranks category suggestions by match quality before facet order", () => {
    const rankedProducts = [
      product("exact", "merchant-a", ["art"]),
      product("prefix-1", "merchant-a", ["artisan goods"]),
      product("prefix-2", "merchant-b", ["artisan goods"]),
      product("word-1", "merchant-a", ["fine art"]),
      product("word-2", "merchant-b", ["fine art"]),
      product("word-3", "merchant-c", ["fine art"]),
      product("substring-1", "merchant-a", ["smart goods"]),
      product("substring-2", "merchant-b", ["smart goods"]),
      product("substring-3", "merchant-c", ["smart goods"]),
      product("substring-4", "merchant-d", ["smart goods"]),
    ]

    expect(
      getCategorySuggestionOptions(rankedProducts, { query: "art" }).map(
        (option) => option.value
      )
    ).toEqual(["art", "artisan goods", "fine art", "smart goods"])
  })

  it("uses count and label as deterministic category suggestion tie-breakers", () => {
    const suggestionProducts = [
      product("a1", "merchant-a", ["apricot"]),
      product("a2", "merchant-b", ["apricot"]),
      product("b", "merchant-a", ["apple"]),
      product("c", "merchant-a", ["appliance"]),
    ]

    expect(
      getCategorySuggestionOptions(suggestionProducts, {
        query: "ap",
        limit: 2,
      }).map((option) => option.value)
    ).toEqual(["apricot", "apple"])
  })

  it("matches normalized category text inside the selected merchant scope", () => {
    const suggestionProducts = [
      product("a", "merchant-a", ["Café goods"]),
      product("b", "merchant-b", ["Cafe supplies"]),
    ]

    expect(
      getCategorySuggestionOptions(suggestionProducts, {
        query: "cafe",
        merchants: ["merchant-a"],
      }).map((option) => option.value)
    ).toEqual(["café goods"])
    expect(
      getCategorySuggestionOptions(suggestionProducts, { query: "  " })
    ).toEqual([])
  })

  it("computes category counts from search and store filters only", () => {
    const facets = getCategoryFacetOptions(products, {
      merchants: ["merchant-a"],
      tags: ["food"],
    })

    expect(facets.map((facet) => [facet.value, facet.count])).toEqual([
      ["bitcoin", 2],
      ["food", 1],
    ])
  })

  it("keeps selected zero-count categories visible", () => {
    const facets = getCategoryFacetOptions(products, {
      merchants: ["merchant-c"],
      tags: ["art"],
    })

    expect(
      facets.map((facet) => [facet.value, facet.count, facet.selected])
    ).toEqual([
      ["food", 1, false],
      ["art", 0, true],
    ])
  })

  it("computes store counts from search and category filters only", () => {
    const facets = getStoreFacetOptions(
      products,
      {
        merchants: ["merchant-c"],
        tags: ["bitcoin"],
      },
      (pubkey) => pubkey.replace("merchant-", "")
    )

    expect(facets.map((facet) => [facet.value, facet.count])).toEqual([
      ["merchant-a", 2],
      ["merchant-c", 0],
    ])
  })
})
