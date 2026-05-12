import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("not found shell contract", () => {
  it("does not wrap app navigation inside root not-found fallbacks", async () => {
    const files = [
      "apps/market/src/routes/__root.tsx",
      "apps/merchant/src/routes/__root.tsx",
    ]

    for (const file of files) {
      const content = await readFile(file, "utf8")
      const rootNotFound = content.slice(
        content.indexOf("function RootNotFound")
      )

      expect(rootNotFound).toContain("<NotFoundPage")
      expect(rootNotFound).not.toContain("<RootShell>")
    }
  })
})
