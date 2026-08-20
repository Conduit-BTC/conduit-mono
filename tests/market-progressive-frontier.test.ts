import { describe, expect, it } from "bun:test"

import {
  canCarryAuthoritativeProgressiveSnapshot,
  hasAuthoritativeQuerySnapshot,
  replaceProgressiveProductFrontier,
  runProgressiveReadPass,
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

  it("replaces a visible product with an authoritative empty snapshot", () => {
    const visibleProduct = { id: "visible-before-tombstone" }

    expect(replaceProgressiveProductFrontier([visibleProduct], [])).toEqual([])
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

  it("commits the fast frontier before a broader completion read can fail", async () => {
    type TestProduct = { id: string }
    const committed: Array<{
      products: TestProduct[]
      fetching: boolean
    }> = []

    await expect(
      runProgressiveReadPass({
        readFast: async () => [],
        readCompletion: async () => {
          throw new Error("completion unavailable")
        },
        commitResult: (products, fetching) => {
          committed.push({ products, fetching })
        },
      })
    ).rejects.toThrow("completion unavailable")

    expect(committed).toEqual([{ products: [], fetching: true }])
  })

  it("does not start completion after a progressive pass is cancelled", async () => {
    let resolveFast: ((products: string[]) => void) | undefined
    let active = true
    let completionCalls = 0
    const pass = runProgressiveReadPass({
      readFast: () =>
        new Promise<string[]>((resolve) => {
          resolveFast = resolve
        }),
      readCompletion: async () => {
        completionCalls += 1
        return []
      },
      commitResult: () => {
        throw new Error("cancelled passes must not commit")
      },
      shouldContinue: () => active,
    })

    active = false
    resolveFast?.([])
    await pass

    expect(completionCalls).toBe(0)
  })

  it("carries an authoritative progressive frontier only across the same catalog scope", () => {
    const oldCatalogProduct = { id: "old-author-product" }
    const carriesSameCatalog = canCarryAuthoritativeProgressiveSnapshot({
      previousCatalogKey: "authors:a",
      nextCatalogKey: "authors:a",
      hasSnapshot: true,
    })
    const carriesChangedCatalog = canCarryAuthoritativeProgressiveSnapshot({
      previousCatalogKey: "authors:a",
      nextCatalogKey: "authors:b",
      hasSnapshot: true,
    })

    expect(carriesSameCatalog).toBe(true)
    expect(carriesChangedCatalog).toBe(false)
    expect(
      selectProgressiveProductFrontier({
        hasAuthoritativeProgressiveSnapshot: false,
        hasAuthoritativeNetworkSnapshot: false,
        progressiveProducts: carriesChangedCatalog ? [oldCatalogProduct] : [],
        networkProducts: [],
        cachedProducts: [],
      })
    ).toEqual([])
  })
})
