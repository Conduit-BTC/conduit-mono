import { describe, expect, it } from "bun:test"

import { getResultPresentation } from "@conduit/ui"

describe("result presentation", () => {
  it("stays silent when degraded evidence does not change a usable result", () => {
    expect(
      getResultPresentation({
        resultCount: 4,
        reliability: "degraded",
      })
    ).toEqual({ kind: "results", visibility: "silent" })
  })

  it("allows completeness-sensitive results to request one compact notice", () => {
    expect(
      getResultPresentation({
        resultCount: 4,
        reliability: "degraded",
        degradedResultsAreMaterial: true,
      })
    ).toEqual({ kind: "results", visibility: "compact" })
  })

  it("distinguishes filters from an actually empty result", () => {
    expect(
      getResultPresentation({
        resultCount: 3,
        visibleResultCount: 0,
        reliability: "complete",
      })
    ).toEqual({ kind: "filter_empty", visibility: "silent" })
  })

  it("keeps degraded filtered empties recoverable", () => {
    expect(
      getResultPresentation({
        resultCount: 3,
        visibleResultCount: 0,
        reliability: "degraded",
      })
    ).toEqual({ kind: "filter_empty", visibility: "compact" })
  })

  it("never promotes a degraded empty read to confirmed absence", () => {
    expect(
      getResultPresentation({
        resultCount: 0,
        reliability: "degraded",
      })
    ).toEqual({ kind: "degraded_empty", visibility: "compact" })

    expect(
      getResultPresentation({
        resultCount: 0,
        reliability: "complete",
      })
    ).toEqual({ kind: "complete_empty", visibility: "silent" })
  })

  it("keeps filtered recovery wired into product and storefront projections", async () => {
    const [products, storefront] = await Promise.all([
      Bun.file("apps/market/src/routes/products/index.tsx").text(),
      Bun.file("apps/market/src/routes/store/$pubkey.tsx").text(),
    ])

    for (const route of [products, storefront]) {
      expect(route).toContain('resultPresentation.kind === "filter_empty"')
      expect(route).toContain('resultPresentation.visibility === "compact"')
      expect(route).toContain("Discovery is incomplete")
      expect(route).toContain("Retry")
    }
  })
})
