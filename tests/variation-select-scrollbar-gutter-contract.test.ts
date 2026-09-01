import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

const SITE_STYLES = "packages/ui/src/styles/site.css"

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
})
