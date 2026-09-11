import { describe, expect, it } from "bun:test"

const routePaths = [
  "apps/market/src/routes/network.tsx",
  "apps/merchant/src/routes/network.tsx",
] as const

describe("Network settings navigation guard", () => {
  it("leaves after confirmation without persisting or migrating local edits", async () => {
    for (const routePath of routePaths) {
      const source = await Bun.file(routePath).text()
      const handler = source.match(
        /const leaveAndDiscard = useCallback\(\(\) => \{([\s\S]*?)\n\s{2}\}, \[blocker\]\)/
      )?.[1]

      if (!handler) {
        throw new Error(`Missing leave-and-discard guard in ${routePath}`)
      }
      expect(handler).toContain('if (blocker.status !== "blocked") return')
      expect(handler).toContain("blocker.proceed()")
      expect(handler).not.toContain("networkSettings")
      expect(source).toContain("onLeave={leaveAndDiscard}")
    }
  })
})
