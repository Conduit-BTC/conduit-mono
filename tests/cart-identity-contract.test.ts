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
      "item.merchantPubkey === selectedProduct.pubkey"
    )
    expect(resolvedCard).toContain("item.productId === selectedProduct.id")
    expect(resolvedCard).toContain(
      "isSameCartLineFulfillment(item, cartCandidate)"
    )
    expect(resolvedCard).toContain("cartItemInputFromProductSelection(")
    expect(resolvedCard).toContain("cart.addItem(cartCandidate, 1)")
    expect(resolvedCard).not.toContain("cart.incrementItem(existing")
    expect(resolvedCard).toContain("cart.removeItem(existing)")
    expect(resolvedCard).toContain("cart.decrementItem(existing)")
  })

  it("persists a versioned canonical cart and keeps its fallback explicit", () => {
    const repository = readFileSync(
      new URL("../apps/market/src/lib/cart-repository.ts", import.meta.url),
      "utf8"
    )
    expect(repository).toContain("export const CART_RECORD_VERSION = 1")
    expect(repository).toContain('db.transaction(\n        "rw"')
    expect(repository).toContain("parseStoredRecord(stored)")
    expect(repository).toContain('publishRecord(record, "memory")')
  })
})
