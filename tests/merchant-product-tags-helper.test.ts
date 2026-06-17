import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("merchant product tag helper", () => {
  it("explains comma-separated product tags and wires the input description", async () => {
    const content = await readFile(
      "apps/merchant/src/routes/products.tsx",
      "utf8"
    )

    expect(content).toContain('id="product-tags"')
    expect(content).toContain('aria-describedby="product-tags-help"')
    expect(content).toContain('id="product-tags-help"')
    expect(content).toContain("Separate tags with commas.")
    expect(content).toContain("help buyers")
    expect(content).toContain("filter listings")
  })
})
