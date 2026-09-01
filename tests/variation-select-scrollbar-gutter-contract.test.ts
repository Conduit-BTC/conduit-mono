import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

const SITE_STYLES = "packages/ui/src/styles/site.css"
const MARKET_ENTRYPOINT = "apps/market/src/main.tsx"
const VARIATION_SELECTOR = "apps/market/src/components/ProductVariationSelector.tsx"
const SHARED_SELECT = "packages/ui/src/components/Select.tsx"

describe("variation Select scrollbar gutter contract", () => {
  it("reserves the viewport scrollbar gutter when the browser supports it", async () => {
    const styles = await readFile(SITE_STYLES, "utf8")

    expect(styles).toMatch(
      /@supports\s*\(scrollbar-gutter:\s*stable\)\s*\{\s*html\s*\{\s*scrollbar-gutter:\s*stable;\s*\}/
    )
  })

  it("neutralizes duplicate scroll lock compensation only with stable gutter support", async () => {
    const styles = await readFile(SITE_STYLES, "utf8")

    expect(styles).toMatch(
      /@supports\s*\(scrollbar-gutter:\s*stable\)[\s\S]*html\s+body\[data-scroll-locked\]\s*\{\s*margin-right:\s*0\s*!important;\s*--removed-body-scroll-bar-size:\s*0px\s*!important;\s*\}/
    )
  })

  it("loads the shared style in Market rather than adding route-local compensation", async () => {
    const [entrypoint, variationSelector] = await Promise.all([
      readFile(MARKET_ENTRYPOINT, "utf8"),
      readFile(VARIATION_SELECTOR, "utf8"),
    ])

    expect(entrypoint).toContain('import "@conduit/ui/styles/site.css"')
    expect(variationSelector).not.toContain("scrollbar-gutter")
    expect(variationSelector).not.toContain("overflow-hidden")
  })

  it("keeps variation selection on the shared accessible, portal-based Select", async () => {
    const [variationSelector, select] = await Promise.all([
      readFile(VARIATION_SELECTOR, "utf8"),
      readFile(SHARED_SELECT, "utf8"),
    ])

    expect(variationSelector).toContain("<SelectContent>")
    expect(variationSelector).toContain("aria-label={`Choose ${axis.label.toLowerCase()}`}")
    expect(select).toContain("<SelectPrimitive.Portal>")
  })
})
