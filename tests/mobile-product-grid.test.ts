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

    expect(content).toContain('className={className ?? "h-full"}')
    expect(resolvedCard).toContain('className="flex h-full flex-col space-y-2"')
    expect(resolvedCard).toContain(
      'className={["h-auto flex-1", className].filter(Boolean).join(" ")}'
    )
    expect(eventRoute).toContain('className="h-auto"')
    expect(eventRoute).toContain(
      "`mt-6 ${PRODUCT_GRID_CLASS_NAME} items-start`"
    )
  })
})
