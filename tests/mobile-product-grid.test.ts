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

  it("stretches catalog cards while retaining natural event-card disclosure height", async () => {
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
    expect(resolvedCard).toContain('className="flex h-full flex-col space-y-2"')
    expect(resolvedCard).toContain(
      'className={["h-auto flex-1", className].filter(Boolean).join(" ")}'
    )
    expect(eventRoute).toContain('className="h-auto"')
    expect(eventRoute).toContain(
      "`mt-6 ${PRODUCT_GRID_CLASS_NAME} items-start`"
    )
  })

  it("floats variable controls only for desktop pointers while retaining touch flow", async () => {
    const content = await readFile(
      "apps/market/src/components/ProductGridCard.tsx",
      "utf8"
    )
    const selector = await readFile(
      "apps/market/src/components/ProductVariationSelector.tsx",
      "utf8"
    )
    const desktopHoverMedia = "[@media(min-width:768px)_and_(hover:hover)]"

    expect(content).toContain(`${desktopHoverMedia}:absolute`)
    expect(content).toContain(`${desktopHoverMedia}:top-full`)
    expect(content).not.toContain(`${desktopHoverMedia}:translate-y-2`)
    expect(content).toContain(
      `${desktopHoverMedia}:transition-[opacity,visibility]`
    )
    expect(content).toContain(`${desktopHoverMedia}:pointer-events-none`)
    expect(content).toContain(`${desktopHoverMedia}:invisible`)
    expect(content).toContain(`${desktopHoverMedia}:group-hover:visible`)
    expect(content).toContain(
      `${desktopHoverMedia}:group-focus-within:pointer-events-auto`
    )
    expect(content).toContain(`${desktopHoverMedia}:group-focus-within:visible`)
    expect(content).toContain(
      `${desktopHoverMedia}:group-focus-within:opacity-100`
    )
    expect(content).toContain("motion-reduce:transition-none")
    expect(content).toContain(`${desktopHoverMedia}:overflow-visible`)
    expect(content).toContain(`${desktopHoverMedia}:hover:z-20`)
    expect(content).toContain(`${desktopHoverMedia}:focus-within:z-20`)
    expect(content).toContain("isVariationMenuOpen &&")
    expect(content).toContain("onOpenChange={setIsVariationMenuOpen}")
    expect(content).toContain("hasVariations || showVariationSkeleton")
    expect(selector).toContain("onOpenChange?: (open: boolean) => void")
    expect(selector).toContain("onOpenChangeRef.current?.(hasModel && isOpen)")
    expect(selector).toContain("onOpenChangeRef.current?.(false)")
    expect(selector).toContain("onOpenChange={(open) =>")
  })

  it("keeps floating controls out of paint containment and storefront clipping", async () => {
    const [products, storefront] = await Promise.all([
      readFile("apps/market/src/routes/products/index.tsx", "utf8"),
      readFile("apps/market/src/routes/store/$pubkey.tsx", "utf8"),
    ])
    const desktopHoverMedia = "[@media(min-width:768px)_and_(hover:hover)]"

    expect(products).toContain(
      'index >= PAGE_SIZE && product.type === "simple"'
    )
    expect(products).toContain("[content-visibility:auto]")
    expect(storefront).toContain(
      `className="min-w-0 max-w-full self-start overflow-hidden ${desktopHoverMedia}:overflow-visible"`
    )
  })
})
