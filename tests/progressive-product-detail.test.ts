import { describe, expect, it } from "bun:test"
import { isProductDetailInitialLoading } from "../apps/market/src/hooks/useProgressiveProducts"

describe("progressive product detail loading state", () => {
  it("keeps the detail route loading while a relay lookup is still fetching", () => {
    expect(
      isProductDetailInitialLoading({
        product: null,
        cacheLoading: false,
        networkLoading: false,
        networkFetching: true,
      })
    ).toBe(true)
  })

  it("allows the not-found state after cache and relay lookups settle empty", () => {
    expect(
      isProductDetailInitialLoading({
        product: null,
        cacheLoading: false,
        networkLoading: false,
        networkFetching: false,
      })
    ).toBe(false)
  })

  it("does not cover a product that is already available", () => {
    expect(
      isProductDetailInitialLoading({
        product: {
          id: "30402:merchant:item",
          pubkey: "merchant",
          title: "Item",
          summary: "",
          price: 1,
          currency: "USD",
          type: "simple",
          format: "physical",
          visibility: "public",
          images: [],
          tags: [],
          createdAt: 1,
          updatedAt: 1,
        },
        cacheLoading: false,
        networkLoading: false,
        networkFetching: true,
      })
    ).toBe(false)
  })
})
