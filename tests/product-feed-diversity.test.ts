import { describe, expect, it } from "bun:test"
import { diversifyMerchantProductOrder } from "../apps/market/src/lib/productFeedDiversity"
import type { Product } from "@conduit/core"

function product(id: string, pubkey: string, createdAt: number): Product {
  return {
    id,
    pubkey,
    title: id,
    price: 1,
    currency: "USD",
    type: "simple",
    visibility: "public",
    images: [],
    tags: [],
    createdAt,
    updatedAt: createdAt,
  }
}

describe("merchant feed diversity", () => {
  it("round-robins merchants inside a recent window", () => {
    const ordered = diversifyMerchantProductOrder(
      [
        product("a1", "merchant-a", 100),
        product("a2", "merchant-a", 99),
        product("a3", "merchant-a", 98),
        product("b1", "merchant-b", 97),
        product("c1", "merchant-c", 96),
        product("a4", "merchant-a", 95),
      ],
      { windowSize: 6 }
    )

    expect(ordered.map((item) => item.id)).toEqual([
      "a1",
      "b1",
      "c1",
      "a2",
      "a3",
      "a4",
    ])
  })

  it("does not pull old merchants from outside the current window", () => {
    const ordered = diversifyMerchantProductOrder(
      [
        product("a1", "merchant-a", 100),
        product("a2", "merchant-a", 99),
        product("b1", "merchant-b", 98),
        product("old1", "merchant-old", 1),
      ],
      { windowSize: 3 }
    )

    expect(ordered.map((item) => item.id)).toEqual(["a1", "b1", "a2", "old1"])
  })

  it("keeps monomerchant feeds in newest order", () => {
    const ordered = diversifyMerchantProductOrder(
      [
        product("a1", "merchant-a", 100),
        product("a2", "merchant-a", 99),
        product("a3", "merchant-a", 98),
      ],
      { windowSize: 3 }
    )

    expect(ordered.map((item) => item.id)).toEqual(["a1", "a2", "a3"])
  })
})
