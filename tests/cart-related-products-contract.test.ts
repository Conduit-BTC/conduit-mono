import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("cart related-product stock guard", () => {
  it("preserves exact variation selection and stock when adding suggestions", async () => {
    const source = await readFile("apps/market/src/routes/cart.tsx", "utf8")

    expect(source).toMatch(
      /getProductAddAvailability\(\s*selectedProduct\.stock,\s*cartQuantity,\s*1\s*\)/
    )
    expect(source).toContain(
      "disabled={soldOut || atStockLimit || fulfillmentBlocked}"
    )
    expect(source).toMatch(
      /if\s*\(\s*!addAvailability\.canAdd\s*\|\|\s*fulfillmentBlocked/
    )
    expect(source).toContain("cart.addItem(cartCandidate)")
    expect(source).toContain(
      "useProductCartFulfillment(selectedProduct, btcUsdRate)"
    )
    expect(source).toContain("cartItemInputFromProductSelection(")
    expect(source).toContain("<ProductVariationSelector")

    const variations = await readFile(
      "apps/market/src/lib/productVariations.ts",
      "utf8"
    )
    expect(variations).toContain("familyProductId:")
    expect(variations).toContain("selectedSpecifications:")
  })
})
