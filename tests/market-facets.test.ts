import { describe, expect, it } from "bun:test"
import type { Product } from "@conduit/core"
import {
  filterProductsByFacets,
  getCategoryFacetOptions,
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

  it("sorts category counts by usage then label", () => {
    const facets = getCategoryFacetOptions(products, {})

    expect(facets.map((facet) => [facet.value, facet.count])).toEqual([
      ["bitcoin", 2],
      ["food", 2],
      ["art", 1],
    ])
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
