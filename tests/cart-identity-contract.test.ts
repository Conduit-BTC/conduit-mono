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
    const resolvedCard = readFileSync(
      new URL(
        "../apps/market/src/components/ResolvedProductGridCard.tsx",
        import.meta.url
      ),
      "utf8"
    )
    expect(sources.join("\n")).not.toContain("item.productId === product.id")
    expect(sources[0]).toContain("<ResolvedProductGridCard")
    expect(sources[2]).toContain("<ResolvedProductGridCard")
    expect(resolvedCard).toContain(
      "selectCartItem(cart.items, selectedIdentity)"
    )
    expect(resolvedCard).toContain("cartItemInputFromProductSelection(")
    expect(resolvedCard).toContain("cart.removeItem(selectedIdentity)")
    expect(resolvedCard).toContain("cart.setQuantity(selectedIdentity")
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
