import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RefreshChip } from "../packages/ui/src/components/RefreshChip"
import { resolveRefreshChipPhase } from "../packages/ui/src/components/RefreshChipState"

function visibleLabelMarkup(markup: string, label: string): string {
  let index = markup.indexOf(`>${label}<`)
  while (index > 0) {
    const spanStart = markup.lastIndexOf("<span", index)
    const spanMarkup = markup.slice(spanStart, index)
    if (spanMarkup.includes("col-start-1 row-start-1")) return spanMarkup
    index = markup.indexOf(`>${label}<`, index + 1)
  }
  throw new Error(`No stacked phase span found for label: ${label}`)
}

describe("RefreshChip", () => {
  it("shows completion only when the refreshed data is current", () => {
    expect(
      resolveRefreshChipPhase({
        currentPhase: "refreshing",
        refreshCompleted: true,
        refreshing: false,
        stale: false,
      })
    ).toBe("done")
    expect(
      resolveRefreshChipPhase({
        currentPhase: "refreshing",
        refreshCompleted: true,
        refreshing: false,
        stale: true,
      })
    ).toBe("idle")
  })

  it("leaves completion immediately when data becomes stale", () => {
    expect(
      resolveRefreshChipPhase({
        currentPhase: "done",
        refreshCompleted: false,
        refreshing: false,
        stale: true,
      })
    ).toBe("idle")
    expect(
      resolveRefreshChipPhase({
        currentPhase: "idle",
        refreshCompleted: false,
        refreshing: true,
        stale: true,
      })
    ).toBe("refreshing")
  })

  it("renders an interactive refresh button while idle", () => {
    const markup = renderToStaticMarkup(
      createElement(RefreshChip, {
        refreshing: false,
        onRefresh: () => {},
      })
    )

    expect(markup).toContain("<button")
    expect(markup).not.toContain('disabled=""')
    expect(markup).toContain('aria-label="Refresh"')
    expect(visibleLabelMarkup(markup, "Refresh")).toContain("opacity-100")
    expect(visibleLabelMarkup(markup, "Refreshing...")).toContain("opacity-0")
    expect(visibleLabelMarkup(markup, "Updated")).toContain("opacity-0")
  })

  it("stays fully opaque and spins while a refresh runs", () => {
    const markup = renderToStaticMarkup(
      createElement(RefreshChip, {
        refreshing: true,
        onRefresh: () => {},
        refreshingLabel: "Updating listings...",
      })
    )

    // Not disabled: the Button's disabled:opacity-50 fade must not apply
    // while refreshing. The chip reports busy state and ignores clicks.
    expect(markup).not.toContain('disabled=""')
    expect(markup).toContain('aria-label="Updating listings..."')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain("animate-spin")
    expect(markup).not.toContain("animate-pulse")
    expect(visibleLabelMarkup(markup, "Updating listings...")).toContain(
      "opacity-100"
    )
    expect(visibleLabelMarkup(markup, "Refresh")).toContain("opacity-0")
  })

  it("swaps the idle label to a warning-toned stale label", () => {
    const markup = renderToStaticMarkup(
      createElement(RefreshChip, {
        refreshing: false,
        onRefresh: () => {},
        stale: true,
        staleLabel: "May be out of date",
      })
    )

    const staleSpan = visibleLabelMarkup(markup, "May be out of date")
    expect(markup).toContain('aria-label="May be out of date"')
    expect(staleSpan).toContain("opacity-100")
    expect(staleSpan).toContain("--warning")
  })

  it("stacks every phase label in one grid cell to stay shift-free", () => {
    const markup = renderToStaticMarkup(
      createElement(RefreshChip, {
        refreshing: false,
        onRefresh: () => {},
        refreshingLabel: "Refreshing the whole storefront...",
      })
    )

    expect(markup).toContain("inline-grid")
    for (const label of [
      "Refresh",
      "Refreshing the whole storefront...",
      "Updated",
    ]) {
      expect(visibleLabelMarkup(markup, label)).toContain(
        "col-start-1 row-start-1"
      )
    }
  })

  it("is the shared refresh control on Market and Merchant data surfaces", async () => {
    const surfaces = [
      "apps/market/src/routes/products/index.tsx",
      "apps/market/src/routes/products/$productId.tsx",
      "apps/market/src/routes/store/$pubkey.tsx",
      "apps/market/src/routes/orders.tsx",
      "apps/merchant/src/routes/products.tsx",
      "apps/merchant/src/routes/orders.tsx",
    ]
    for (const surface of surfaces) {
      const source = await readFile(surface, "utf8")
      expect(source).toContain("RefreshChip")
      expect(source).not.toContain("FreshnessChip")
    }
  })

  it("keeps empty Market surfaces visibly busy during refresh", async () => {
    const detailSource = await readFile(
      "apps/market/src/routes/products/$productId.tsx",
      "utf8"
    )
    const storefrontSource = await readFile(
      "apps/market/src/routes/store/$pubkey.tsx",
      "utf8"
    )

    expect(detailSource).toContain(
      "const productRefreshing = productQuery.isHydrating"
    )
    expect(detailSource).not.toContain(
      "const productRefreshing = !!product && productQuery.isHydrating"
    )
    expect(storefrontSource).toContain("refreshing={productsQuery.isHydrating}")
    expect(storefrontSource).not.toContain(
      "productsQuery.isHydrating && filteredProducts.length > 0"
    )
  })
})
