import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

const routePaths = [
  "../apps/market/src/routes/products/index.tsx",
  "../apps/market/src/routes/products/$productId.tsx",
  "../apps/market/src/routes/store/$pubkey.tsx",
  "../apps/market/src/routes/cart.tsx",
]

describe("Market cart identity contract", () => {
  it("uses shared product mapping and merchant-scoped selectors", () => {
    const sources = routePaths.map((path) =>
      readFileSync(new URL(path, import.meta.url), "utf8")
    )
    expect(sources.join("\n")).not.toContain("item.productId === product.id")
    expect(
      sources.filter((source) => source.includes("selectCartItem"))
    ).toHaveLength(4)
    expect(
      sources.filter((source) => source.includes("cartItemInputFromProduct"))
    ).toHaveLength(4)
  })

  it("persists a versioned cart and protects unsupported future versions", () => {
    const hook = readFileSync(
      new URL("../apps/market/src/hooks/useCart.ts", import.meta.url),
      "utf8"
    )
    expect(hook).toContain("serializeCartState")
    expect(hook).toContain("storageWritable = result.writable")
    expect(hook).toContain("&& storageWritable")
  })
})
