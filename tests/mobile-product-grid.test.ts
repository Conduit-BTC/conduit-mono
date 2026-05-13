import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("mobile product grid density", () => {
  it("keeps Market browse and storefront product grids two-column on mobile", async () => {
    const files = [
      "apps/market/src/routes/products/index.tsx",
      "apps/market/src/routes/store/$pubkey.tsx",
    ]

    for (const file of files) {
      const content = await readFile(file, "utf8")
      expect(content).toContain(
        "grid auto-rows-fr list-none grid-cols-2 gap-3 p-0 sm:gap-4 lg:grid-cols-4"
      )
      expect(content).not.toContain(
        "grid auto-rows-fr list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2"
      )
    }
  })
})
