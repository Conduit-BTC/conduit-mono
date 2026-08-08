import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RefreshChip } from "../packages/ui/src/components/RefreshChip"

function visibleLabelMarkup(markup: string, label: string): string {
  let index = markup.indexOf(`>${label}<`)
  while (index > 0) {
    const spanStart = markup.lastIndexOf("<span", index)
    const spanMarkup = markup.slice(spanStart, index)
    if (spanMarkup.includes("absolute")) return spanMarkup
    index = markup.indexOf(`>${label}<`, index + 1)
  }
  throw new Error(`No stacked phase span found for label: ${label}`)
}

describe("RefreshChip", () => {
  it("renders an interactive refresh button while idle", () => {
    const markup = renderToStaticMarkup(
      createElement(RefreshChip, {
        refreshing: false,
        onRefresh: () => {},
      })
    )

    expect(markup).toContain("<button")
    expect(markup).not.toContain('disabled=""')
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
    expect(staleSpan).toContain("opacity-100")
    expect(staleSpan).toContain("--warning")
  })

  it("reserves the width of the longest label to stay shift-free", () => {
    const markup = renderToStaticMarkup(
      createElement(RefreshChip, {
        refreshing: false,
        onRefresh: () => {},
        refreshingLabel: "Refreshing the whole storefront...",
      })
    )

    const sizingIndex = markup.indexOf("invisible whitespace-nowrap")
    expect(sizingIndex).toBeGreaterThan(0)
    expect(
      markup.slice(sizingIndex, markup.indexOf("</span>", sizingIndex))
    ).toContain("Refreshing the whole storefront...")
  })

  it("is the shared refresh control on Market and Merchant data surfaces", async () => {
    const surfaces = [
      "apps/market/src/routes/products/index.tsx",
      "apps/market/src/routes/products/$productId.tsx",
      "apps/market/src/routes/store/$pubkey.tsx",
      "apps/merchant/src/routes/products.tsx",
      "apps/merchant/src/routes/orders.tsx",
    ]
    for (const surface of surfaces) {
      const source = await readFile(surface, "utf8")
      expect(source).toContain("RefreshChip")
      expect(source).not.toContain("FreshnessChip")
    }
  })
})
