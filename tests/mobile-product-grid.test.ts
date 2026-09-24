import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("Market product grid layout", () => {
  it("keeps browse grids dense on mobile while stretching each catalog row", async () => {
    const expectedGridClasses = new Map([
      [
        "apps/market/src/routes/products/index.tsx",
        "grid list-none grid-cols-2 gap-3 p-0 sm:gap-4 md:grid-cols-3 lg:grid-cols-4",
      ],
      [
        "apps/market/src/routes/store/$pubkey.tsx",
        "grid min-w-0 max-w-full list-none grid-cols-2 gap-3 p-0 sm:gap-4 md:grid-cols-3 lg:grid-cols-4",
      ],
      [
        "apps/market/src/routes/products/$productId.tsx",
        "grid list-none grid-cols-2 gap-3 p-0 md:grid-cols-3 lg:grid-cols-4",
      ],
    ])

    for (const [file, expectedGridClass] of expectedGridClasses) {
      const content = await readFile(file, "utf8")
      if (file.endsWith("routes/products/index.tsx")) {
        const cardSource = await readFile(
          "apps/market/src/components/ProductGridCard.tsx",
          "utf8"
        )
        expect(content).toContain("PRODUCT_GRID_CLASS_NAME")
        expect(cardSource).toContain(expectedGridClass)
      } else {
        expect(content).toContain(expectedGridClass)
      }
      expect(content).not.toContain("auto-rows-fr")
      expect(content).not.toContain("auto-fit")
      expect(content).not.toContain(
        "grid auto-rows-fr list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2"
      )
    }
  })

  it("stretches catalog cards while allowing natural event-card height", async () => {
    const content = await readFile(
      "apps/market/src/components/ProductGridCard.tsx",
      "utf8"
    )

    const eventRoute = await readFile(
      "apps/market/src/routes/events/$collectionRef.tsx",
      "utf8"
    )
    const resolvedCard = await readFile(
      "apps/market/src/components/ResolvedProductGridCard.tsx",
      "utf8"
    )

    expect(content).toContain('className ?? "h-full"')
    expect(resolvedCard).toContain("notice={")
    expect(resolvedCard).toContain("{...props}")
    expect(resolvedCard).not.toContain('className="h-full space-y-2"')
    expect(eventRoute).toContain('className="h-auto"')
    const eventBrowser = await readFile(
      "apps/market/src/components/EventCatalogBrowser.tsx",
      "utf8"
    )
    expect(eventBrowser).toContain("`${PRODUCT_GRID_CLASS_NAME} items-start`")
  })

  it("keeps product grid cards out of paint containment and storefront clipping", async () => {
    const [products, storefront] = await Promise.all([
      readFile("apps/market/src/routes/products/index.tsx", "utf8"),
      readFile("apps/market/src/routes/store/$pubkey.tsx", "utf8"),
    ])
    const desktopHoverMedia = "[@media(min-width:768px)_and_(hover:hover)]"

    expect(products).not.toContain("content-visibility")
    expect(products).not.toContain("contain-intrinsic-size")
    expect(products).toContain('className="h-full"')
    expect(storefront).toContain(
      `className="min-w-0 max-w-full self-start overflow-hidden ${desktopHoverMedia}:overflow-visible"`
    )
  })
})
