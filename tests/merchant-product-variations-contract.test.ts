import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("Merchant external variation safety", () => {
  it("keeps Gamma variable and variation records read-only", async () => {
    const source = (
      await readFile("apps/merchant/src/routes/products.tsx", "utf8")
    ).replace(/\r\n/g, "\n")

    expect(source).toContain(
      'const isExternallyManaged = item.product.type !== "simple"'
    )
    expect(source).toContain("if (isExternallyManaged)")
    expect(source).toContain(
      "This Gamma {item.product.type} listing is read-only"
    )
    expect(source).toContain("variation-aware publisher")
    expect(source).toContain(
      'item.product.type === "simple"\n                      ? () => openEditDialog(item)\n                      : undefined'
    )
  })
})
