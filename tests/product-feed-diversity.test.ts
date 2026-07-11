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
  it("caps publisher runs while another merchant still has inventory", () => {
    const ordered = diversifyMerchantProductOrder([
      product("a1", "merchant-a", 100),
      product("a2", "merchant-a", 99),
      product("a3", "merchant-a", 98),
      product("b1", "merchant-b", 97),
      product("c1", "merchant-c", 96),
      product("a4", "merchant-a", 95),
    ])

    expect(ordered.map((item) => item.id)).toEqual([
      "a1",
      "a2",
      "b1",
      "a3",
      "c1",
      "a4",
    ])
  })

  it("breaks up a bulk publisher even when alternatives fall outside the old window", () => {
    const dominant = Array.from({ length: 144 }, (_, index) =>
      product(`a${index + 1}`, "merchant-a", 1_000 - index)
    )
    const ordered = diversifyMerchantProductOrder([
      ...dominant,
      product("b1", "merchant-b", 100),
      product("c1", "merchant-c", 99),
      product("d1", "merchant-d", 98),
    ])

    expect(ordered.slice(0, 9).map((item) => item.pubkey)).toEqual([
      "merchant-a",
      "merchant-a",
      "merchant-b",
      "merchant-a",
      "merchant-a",
      "merchant-c",
      "merchant-a",
      "merchant-a",
      "merchant-d",
    ])
    expect(ordered).toHaveLength(147)
    expect(new Set(ordered.map((item) => item.id)).size).toBe(147)

    let runLength = 0
    let runMerchant = ""
    for (const [index, item] of ordered.entries()) {
      if (item.pubkey === runMerchant) {
        runLength += 1
      } else {
        runMerchant = item.pubkey
        runLength = 1
      }

      if (runLength > 2) {
        expect(
          ordered.slice(index + 1).some((later) => later.pubkey !== item.pubkey)
        ).toBe(false)
      }
    }
  })

  it("keeps monomerchant feeds in newest order", () => {
    const ordered = diversifyMerchantProductOrder([
      product("a1", "merchant-a", 100),
      product("a2", "merchant-a", 99),
      product("a3", "merchant-a", 98),
    ])

    expect(ordered.map((item) => item.id)).toEqual(["a1", "a2", "a3"])
  })

  it("preserves newest order when the input already satisfies the cap", () => {
    const ordered = diversifyMerchantProductOrder([
      product("a1", "merchant-a", 100),
      product("b1", "merchant-b", 99),
      product("a2", "merchant-a", 98),
      product("c1", "merchant-c", 97),
    ])

    expect(ordered.map((item) => item.id)).toEqual(["a1", "b1", "a2", "c1"])
  })

  it("handles one early cap violation in a wide catalog without re-sorting every merchant", () => {
    const products = [
      product("a1", "merchant-a", 10_000),
      product("a2", "merchant-a", 9_999),
      product("a3", "merchant-a", 9_998),
      ...Array.from({ length: 9_997 }, (_, index) =>
        product(`u${index}`, `merchant-${index}`, 9_997 - index)
      ),
    ]

    const startedAt = performance.now()
    const ordered = diversifyMerchantProductOrder(products)
    const durationMs = performance.now() - startedAt

    expect(ordered.slice(0, 5).map((item) => item.id)).toEqual([
      "a1",
      "a2",
      "u0",
      "a3",
      "u1",
    ])
    expect(ordered).toHaveLength(products.length)
    expect(new Set(ordered.map((item) => item.id)).size).toBe(products.length)
    expect(durationMs).toBeLessThan(500)
  })
})
