import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("cart related-product stock guard", () => {
  it("prevents suggestions from adding beyond tracked stock", async () => {
    const source = await readFile("apps/market/src/routes/cart.tsx", "utf8")

    expect(source).toMatch(
      /getProductAddAvailability\(\s*product\.stock,\s*cartQuantity,\s*1\s*\)/
    )
    expect(source).toContain("disabled={soldOut || atStockLimit}")
    expect(source).toContain("if (!addAvailability.canAdd) return")
  })
})
