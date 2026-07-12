import { describe, expect, it } from "bun:test"
import type { Product } from "@conduit/core"
import { diversifyMerchantProductOrder } from "../apps/market/src/lib/productFeedDiversity"

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
  const DAY_MS = 24 * 60 * 60 * 1_000
  const NOW_MS = 1_800_000_000_000

  it("gives every recent merchant one product before any merchant repeats", () => {
    const dominant = Array.from({ length: 300 }, (_, index) =>
      product(`a${index + 1}`, "merchant-a", NOW_MS - index * 60_000)
    )
    const otherMerchants = Array.from({ length: 59 }, (_, index) =>
      product(
        `m${index + 1}`,
        `merchant-${index + 1}`,
        NOW_MS - (index + 1) * DAY_MS
      )
    )
    const products = [...dominant, ...otherMerchants].sort(
      (a, b) => b.createdAt - a.createdAt
    )

    const ordered = diversifyMerchantProductOrder(products, {
      nowMs: NOW_MS,
    })
    const firstRound = ordered.slice(0, 60)

    expect(firstRound.map((item) => item.pubkey)).toEqual([
      "merchant-a",
      ...Array.from({ length: 59 }, (_, index) => `merchant-${index + 1}`),
    ])
    expect(
      firstRound.filter((item) => item.pubkey === "merchant-a")
    ).toHaveLength(1)
    expect(new Set(ordered.slice(0, 12).map((item) => item.pubkey)).size).toBe(
      12
    )
    expect(ordered[60]?.pubkey).toBe("merchant-a")
  })

  it("emits one product per merchant in each recent round", () => {
    const products = [
      product("a1", "merchant-a", NOW_MS),
      product("a2", "merchant-a", NOW_MS - 1),
      product("a3", "merchant-a", NOW_MS - 2),
      product("b1", "merchant-b", NOW_MS - 3),
      product("b2", "merchant-b", NOW_MS - 4),
      product("c1", "merchant-c", NOW_MS - 5),
    ]

    const ordered = diversifyMerchantProductOrder(products, {
      nowMs: NOW_MS,
    })

    expect(ordered.map((item) => item.id)).toEqual([
      "a1",
      "b1",
      "c1",
      "a2",
      "b2",
      "a3",
    ])
  })

  it("uses a bounded 60-day window and leaves other products in the tail", () => {
    const products = [
      product("future", "merchant-future", NOW_MS + 1),
      product("a1", "merchant-a", NOW_MS),
      product("a2", "merchant-a", NOW_MS - DAY_MS),
      product("b1", "merchant-b", NOW_MS - 60 * DAY_MS),
      product("stale-c", "merchant-c", NOW_MS - 60 * DAY_MS - 1),
      product("stale-d", "merchant-d", NOW_MS - 61 * DAY_MS),
    ]

    const ordered = diversifyMerchantProductOrder(products, {
      nowMs: NOW_MS,
    })

    expect(ordered.map((item) => item.id)).toEqual([
      "a1",
      "b1",
      "a2",
      "future",
      "stale-c",
      "stale-d",
    ])
  })

  it("does not let future-dated bulk inventory bypass the recent round", () => {
    const futureProducts = Array.from({ length: 300 }, (_, index) =>
      product(`future-${index}`, "merchant-future", NOW_MS + 300 - index)
    )
    const current = product("current", "merchant-current", NOW_MS)

    const ordered = diversifyMerchantProductOrder(
      [...futureProducts, current],
      { nowMs: NOW_MS }
    )

    expect(ordered[0]).toBe(current)
    expect(ordered.slice(1)).toEqual(futureProducts)
  })

  it("does not promote an active merchant's stale inventory into recent rounds", () => {
    const staleA = product("stale-a", "merchant-a", NOW_MS - 61 * DAY_MS)
    const products = [
      product("a1", "merchant-a", NOW_MS),
      product("b1", "merchant-b", NOW_MS - 1),
      product("b2", "merchant-b", NOW_MS - 2),
      staleA,
    ]

    const ordered = diversifyMerchantProductOrder(products, {
      nowMs: NOW_MS,
    })

    expect(ordered.map((item) => item.id)).toEqual([
      "a1",
      "b1",
      "b2",
      "stale-a",
    ])
    expect(ordered[3]).toBe(staleA)
  })

  it("keeps feeds with no recent products in their original order", () => {
    const products = [
      product("a1", "merchant-a", NOW_MS - 61 * DAY_MS),
      product("b1", "merchant-b", NOW_MS - 62 * DAY_MS),
    ]

    const ordered = diversifyMerchantProductOrder(products, {
      nowMs: NOW_MS,
    })

    expect(ordered).not.toBe(products)
    expect(ordered).toEqual(products)
  })

  it("keeps monomerchant feeds in newest order", () => {
    const products = [
      product("a1", "merchant-a", NOW_MS),
      product("a2", "merchant-a", NOW_MS - 1),
      product("a3", "merchant-a", NOW_MS - 2),
    ]

    const ordered = diversifyMerchantProductOrder(products, {
      nowMs: NOW_MS,
    })

    expect(ordered).toEqual(products)
  })

  it("uses first appearance as the stable tie order", () => {
    const products = [
      product("a1", "merchant-a", NOW_MS),
      product("a2", "merchant-a", NOW_MS),
      product("b1", "merchant-b", NOW_MS),
      product("c1", "merchant-c", NOW_MS),
    ]

    const ordered = diversifyMerchantProductOrder(products, {
      nowMs: NOW_MS,
    })

    expect(ordered.map((item) => item.id)).toEqual(["a1", "b1", "c1", "a2"])
  })

  it("preserves every object without mutating a wide input", () => {
    const products = [
      ...Array.from({ length: 5_000 }, (_, index) =>
        product(`a${index}`, "merchant-a", NOW_MS - index)
      ),
      ...Array.from({ length: 5_000 }, (_, index) =>
        product(`u${index}`, `merchant-${index}`, NOW_MS - 10_000 - index)
      ),
    ]
    const original = [...products]

    const startedAt = performance.now()
    const ordered = diversifyMerchantProductOrder(products, {
      nowMs: NOW_MS,
    })
    const durationMs = performance.now() - startedAt

    expect(products).toEqual(original)
    expect(ordered).toHaveLength(products.length)
    expect(new Set(ordered).size).toBe(products.length)
    expect(new Set(ordered)).toEqual(new Set(products))
    expect(
      new Set(ordered.slice(0, 5_001).map((item) => item.pubkey)).size
    ).toBe(5_001)
    expect(durationMs).toBeLessThan(500)
  })
})
