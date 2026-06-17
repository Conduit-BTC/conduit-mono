import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("mobile product grid density", () => {
  it("keeps Market browse and storefront product grids two-column on mobile", async () => {
    const expectedGridClasses = new Map([
      [
        "apps/market/src/routes/products/index.tsx",
        "grid auto-rows-fr list-none grid-cols-2 gap-3 p-0 sm:gap-4 md:grid-cols-3 lg:grid-cols-4",
      ],
      [
        "apps/market/src/routes/store/$pubkey.tsx",
        "grid min-w-0 max-w-full auto-rows-fr list-none grid-cols-2 gap-3 p-0 sm:gap-4 md:grid-cols-3 lg:grid-cols-4",
      ],
    ])

    for (const [file, expectedGridClass] of expectedGridClasses) {
      const content = await readFile(file, "utf8")
      expect(content).toContain(expectedGridClass)
      expect(content).not.toContain("auto-fit")
      expect(content).not.toContain(
        "grid auto-rows-fr list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2"
      )
    }
  })
})
