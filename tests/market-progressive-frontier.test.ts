import { describe, expect, it } from "bun:test"

import {
  hasAuthoritativeProductFrontier,
  replaceProgressiveProductFrontier,
  selectProgressiveProductFrontier,
} from "../apps/market/src/lib/progressiveProductFrontier"

describe("Market progressive product frontier", () => {
  it("keeps an authoritative empty snapshot instead of resurrecting stale cache", () => {
    const staleProduct = { id: "stale" }

    expect(
      selectProgressiveProductFrontier({
        hasAuthoritativeSnapshot: true,
        progressiveProducts: [],
        networkProducts: [staleProduct],
        cachedProducts: [staleProduct],
      })
    ).toEqual([])
  })

  it("uses cache only before an authoritative progressive snapshot exists", () => {
    const cachedProduct = { id: "cached" }

    expect(
      selectProgressiveProductFrontier({
        hasAuthoritativeSnapshot: false,
        progressiveProducts: [],
        networkProducts: [],
        cachedProducts: [cachedProduct],
      })
    ).toEqual([cachedProduct])
  })

  it("replaces a visible product with an authoritative empty snapshot", () => {
    const visibleProduct = { id: "visible-before-tombstone" }

    expect(replaceProgressiveProductFrontier([visibleProduct], [])).toEqual([])
  })

  it("treats a completed storefront network read as authoritative", () => {
    expect(
      hasAuthoritativeProductFrontier({
        hasProgressiveSnapshot: false,
        hasCompletedNetworkResult: true,
      })
    ).toBe(true)
  })
})
