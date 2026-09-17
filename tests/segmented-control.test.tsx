import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SegmentedControl, SegmentedControlItem } from "@conduit/ui"

describe("SegmentedControl", () => {
  it("renders a native button item with selection, pressed, and disabled state", () => {
    const html = renderToStaticMarkup(
      <SegmentedControl role="group" aria-label="Perspective">
        <SegmentedControlItem selected aria-pressed>
          Following
        </SegmentedControlItem>
        <SegmentedControlItem selected={false} disabled aria-pressed={false}>
          Conduit
        </SegmentedControlItem>
      </SegmentedControl>
    )

    expect(html).toMatch(
      /^<div class="inline-flex[^>]*role="group" aria-label="Perspective"/
    )
    expect(html).toMatch(
      /<button type="button"[^>]*bg-\[var\(--surface-elevated\)\][^>]*aria-pressed="true"/
    )
    expect(html).toMatch(/<button type="button" disabled=""[^>]*opacity-45/)
  })

  it("renders through a child element without adding button attributes", () => {
    const html = renderToStaticMarkup(
      <SegmentedControl asChild>
        <nav aria-label="Browse">
          <SegmentedControlItem asChild selected>
            <a href="/products" aria-current="page">
              Catalog
            </a>
          </SegmentedControlItem>
        </nav>
      </SegmentedControl>
    )

    expect(html).toMatch(/^<nav aria-label="Browse" class="inline-flex/)
    expect(html).toContain(
      '<a href="/products" aria-current="page" class="inline-flex h-9'
    )
    expect(html).not.toContain("<button")
    expect(html).not.toContain("type=")
  })
})
