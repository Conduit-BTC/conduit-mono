import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("product variation navigation", () => {
  it("carries the selected child coordinate from a card into product detail", async () => {
    const [cardSource, detailSource] = await Promise.all([
      readFile("apps/market/src/components/ProductGridCard.tsx", "utf8"),
      readFile("apps/market/src/routes/products/$productId.tsx", "utf8"),
    ])

    expect(cardSource.replace(/\r\n/g, "\n")).toContain(
      "params: { productId: selectedProduct.id }"
    )
    expect(detailSource.replace(/\r\n/g, "\n")).toContain(
      "getProductSelection(product, productId)"
    )
  })
})
