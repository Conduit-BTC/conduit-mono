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

  it("scales desktop cards without changing layout while joining variable controls", async () => {
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
    expect(content).toContain("origin-center")
    expect(content).toContain(`${desktopHoverMedia}:hover:scale-[1.12]`)
    expect(content).toContain(`${desktopHoverMedia}:focus-within:scale-[1.12]`)
    expect(content).toContain(
      `${desktopHoverMedia}:hover:bg-[var(--surface-overlay)]`
    )
    expect(content).toContain(
      `${desktopHoverMedia}:focus-within:bg-[var(--surface-overlay)]`
    )
    expect(content).toContain("disableImageHoverZoom")
    expect(content).toContain("mediaClassName")
    expect(content).toContain(
      `${desktopHoverMedia}:rounded-t-[calc(0.75rem-1px)]`
    )
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
    expect(content).toContain(`${desktopHoverMedia}:hover:rounded-b-none`)
    expect(content).toContain(`${desktopHoverMedia}:hover:border-b-0`)
    expect(content).toContain(`${desktopHoverMedia}:rounded-b-xl`)
    expect(content).toContain(`${desktopHoverMedia}:border-x`)
    expect(content).toContain(`${desktopHoverMedia}:border-b`)
    expect(content).toContain(
      `${desktopHoverMedia}:bg-[var(--surface-overlay)]`
    )
    const variationPanelSource = content.slice(
      content.indexOf("const variationPanelClassName"),
      content.indexOf(
        "return (",
        content.indexOf("const variationPanelClassName")
      )
    )
    expect(variationPanelSource).not.toContain(
      `${desktopHoverMedia}:shadow-[var(--shadow-lg)]`
    )
    expect(variationPanelSource).not.toContain(
      `${desktopHoverMedia}:bg-[var(--surface-elevated)]`
    )
    const variationMenuOpenSource = content.slice(
      content.indexOf("isVariationMenuOpen &&"),
      content.indexOf("\n       )}", content.indexOf("isVariationMenuOpen &&"))
    )
    expect(variationMenuOpenSource).toContain(
      `${desktopHoverMedia}:bg-[var(--surface-overlay)]`
    )
    expect(content).toContain(`${desktopHoverMedia}:rounded-b-none`)
    expect(content).toContain(`${desktopHoverMedia}:border-b-0`)
    expect(content).toContain("onOpenChange={setIsVariationMenuOpen}")
    expect(content).toContain(
      "const hasVariationControls = hasVariations || showVariationSkeleton"
    )
    expect(content).toContain("hasVariationControls &&")
    expect(content).toContain(
      "hasVariationControls ? variationPanelClassName : undefined"
    )
    expect(content).toContain(
      'className="space-y-2 animate-pulse motion-reduce:animate-none"'
    )
    expect(selector).toContain("onOpenChange?: (open: boolean) => void")
    expect(selector).toContain("onOpenChangeRef.current?.(hasModel && isOpen)")
    expect(selector).toContain("onOpenChangeRef.current?.(false)")
    expect(selector).toContain("onOpenChange={(open) =>")
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
