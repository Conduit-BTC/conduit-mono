import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("merchant product tag helper", () => {
  it("wires the product tag chip editor without an eager minimum-tag field error", async () => {
    const content = await readFile(
      "apps/merchant/src/routes/products.tsx",
      "utf8"
    )

    expect(content).toContain("<ProductTagEditor")
    expect(content).toContain('id="product-tags"')
    expect(content).toContain("productTagFieldError")
    expect(content).toContain("MAX_PRODUCT_TAG_COUNT")
    expect(content).toContain("MAX_PRODUCT_TAG_LENGTH")
    expect(content).not.toContain('id="product-tags-help"')
  })

  it("keeps chip editor keyboard and paste affordances in place", async () => {
    const content = await readFile(
      "apps/merchant/src/components/ProductTagEditor.tsx",
      "utf8"
    )

    expect(content).toContain('event.key === "Enter"')
    expect(content).toContain('event.key === ","')
    expect(content).toContain('event.key === "Backspace"')
    expect(content).toContain("commitTags(draft)")
    expect(content).toContain("Add")
    expect(content).toContain("Press comma, Enter, or Add.")
    expect(content).toContain("handlePaste")
    expect(content).toContain("clipboardData")
    expect(content).toContain("Remove ${tag} tag")
  })
})
