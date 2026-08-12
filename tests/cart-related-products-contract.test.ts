import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("cart related-product stock guard", () => {
  it("preserves exact variation selection and stock when adding suggestions", async () => {
    const source = await readFile("apps/market/src/routes/cart.tsx", "utf8")

    expect(source).toMatch(
      /getProductAddAvailability\(\s*selectedProduct\.stock,\s*cartQuantity,\s*1\s*\)/
    )
    expect(source).toContain("disabled={soldOut || atStockLimit}")
    expect(source).toContain("if (!addAvailability.canAdd) return")
    expect(source).toContain("onAdd(selectedProduct)")
    expect(source).toContain("cartItemInputFromProductSelection(")
    expect(source).toContain("<ProductVariationSelector")
    expect(source).toContain("familyProductId")
  })
})
