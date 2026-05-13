import { describe, expect, it } from "bun:test"
import type { Product, Profile } from "@conduit/core"
import {
  filterProductsByFacets,
  getStoreFacetOptions,
} from "../apps/market/src/lib/facets"
import {
  getMerchantIdentityView,
  sortStoreFacetOptionsByRecentPublisher,
} from "../apps/market/src/lib/marketBrowseModel"

function product(
  id: string,
  pubkey: string,
  tags: string[],
  createdAt: number
): Product {
  return {
    id,
    pubkey,
    title: id,
    price: 1,
    currency: "SAT",
    priceSats: 1,
    type: "simple",
    visibility: "public",
    images: [],
    tags,
    createdAt,
    updatedAt: createdAt,
  }
}

const products = [
  product("new-b", "merchant-b", ["bitcoin"], 400),
  product("new-a", "merchant-a", ["bitcoin"], 300),
  product("old-a", "merchant-a", ["art"], 200),
  product("new-c", "merchant-c", ["art"], 100),
]

describe("market browse model helpers", () => {
  it("sorts store options by recent publisher while preserving counts", () => {
    const storeOptions = getStoreFacetOptions(products, {}, (pubkey) => pubkey)

    expect(storeOptions.map((option) => [option.value, option.count])).toEqual([
      ["merchant-a", 2],
      ["merchant-b", 1],
      ["merchant-c", 1],
    ])

    const sorted = sortStoreFacetOptionsByRecentPublisher(
      storeOptions,
      products
    )

    expect(sorted.map((option) => [option.value, option.count])).toEqual([
      ["merchant-b", 1],
      ["merchant-a", 2],
      ["merchant-c", 1],
    ])
  })

  it("does not let store-menu sorting affect product result counts", () => {
    const filteredProducts = filterProductsByFacets(products, {
      tags: ["bitcoin"],
    })
    const storeOptions = getStoreFacetOptions(
      products,
      { tags: ["bitcoin"] },
      (pubkey) => pubkey
    )
    const sortedStores = sortStoreFacetOptionsByRecentPublisher(
      storeOptions,
      filteredProducts
    )

    expect(filteredProducts.map((item) => item.id)).toEqual(["new-b", "new-a"])
    expect(filteredProducts).toHaveLength(2)
    expect(sortedStores.map((option) => [option.value, option.count])).toEqual([
      ["merchant-b", 1],
      ["merchant-a", 1],
    ])
  })

  it("treats pending merchant fallback as unresolved identity", () => {
    const pending = getMerchantIdentityView("merchant-a", undefined, [
      "wss://relay.example",
    ])

    expect(pending.displayName).toBe("Store merchant-a")
    expect(pending.status).toBe("pending")
    expect(pending.relayHints).toEqual(["wss://relay.example"])
  })

  it("treats profile names as resolved merchant identity", () => {
    const profile: Profile = {
      pubkey: "merchant-a",
      displayName: "Alice Market",
    }
    const resolved = getMerchantIdentityView("merchant-a", profile, undefined)

    expect(resolved.displayName).toBe("Alice Market")
    expect(resolved.status).toBe("resolved")
    expect(resolved.relayHints).toEqual([])
  })
})
