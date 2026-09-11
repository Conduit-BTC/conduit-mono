import { describe, expect, it } from "bun:test"

const routePaths = [
  "apps/market/src/routes/network.tsx",
  "apps/merchant/src/routes/network.tsx",
] as const

describe("Network settings navigation guard", () => {
  it("discards only a present legacy relay draft before leaving", async () => {
    for (const routePath of routePaths) {
      const source = await Bun.file(routePath).text()
      const handler = source.match(
        /const leaveAndDiscard = useCallback\(async \(\) => \{([\s\S]*?)\n\s{2}\}, \[blocker, networkSettings\]\)/
      )?.[1]

      if (!handler) {
        throw new Error(`Missing leave-and-discard guard in ${routePath}`)
      }
      expect(handler).toContain('if (blocker.status !== "blocked") return')
      expect(handler).toContain(
        "if (networkSettings.legacyDraftReviewAvailable)"
      )
      expect(handler).toContain("await networkSettings.discardLegacyDraft()")
      expect(handler).toMatch(/catch \{\s+blocker\.reset\(\)\s+return\s+\}/)
      expect(handler.indexOf("discardLegacyDraft")).toBeLessThan(
        handler.lastIndexOf("blocker.proceed")
      )
      expect(source).toContain("onLeave={() => void leaveAndDiscard()}")
    }
  })
})
