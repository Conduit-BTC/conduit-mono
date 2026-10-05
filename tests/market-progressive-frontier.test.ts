import { describe, expect, it } from "bun:test"

import {
  hasAuthoritativeQuerySnapshot,
  selectProgressiveProductFrontier,
} from "../apps/market/src/lib/progressiveProductFrontier"

describe("Market progressive product frontier", () => {
  it("keeps an authoritative empty snapshot instead of resurrecting stale cache", () => {
    const staleProduct = { id: "stale" }

    expect(
      selectProgressiveProductFrontier({
        hasAuthoritativeProgressiveSnapshot: true,
        hasAuthoritativeNetworkSnapshot: false,
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
        hasAuthoritativeProgressiveSnapshot: false,
        hasAuthoritativeNetworkSnapshot: false,
        progressiveProducts: [],
        networkProducts: [],
        cachedProducts: [cachedProduct],
      })
    ).toEqual([cachedProduct])
  })

  it("replaces a stale storefront accumulator with a completed empty network read", () => {
    const staleProduct = { id: "stale-storefront" }
    expect(
      selectProgressiveProductFrontier({
        hasAuthoritativeProgressiveSnapshot: false,
        hasAuthoritativeNetworkSnapshot: true,
        progressiveProducts: [staleProduct],
        networkProducts: [],
        cachedProducts: [staleProduct],
      })
    ).toEqual([])
  })

  it("keeps a settled empty query authoritative during a same-key refetch", () => {
    expect(
      hasAuthoritativeQuerySnapshot({
        hasData: true,
        isPlaceholderData: false,
      })
    ).toBe(true)
  })

  it("does not render previous-key placeholder data while the new query is paused", () => {
    expect(
      hasAuthoritativeQuerySnapshot({
        hasData: true,
        isPlaceholderData: true,
      })
    ).toBe(false)
  })
})
