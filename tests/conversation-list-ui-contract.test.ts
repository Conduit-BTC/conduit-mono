import { describe, expect, it } from "bun:test"
import { matchesConversationSearch } from "@conduit/ui"

const routePaths = [
  "apps/market/src/routes/messages.tsx",
  "apps/merchant/src/routes/messages.tsx",
]

describe("conversation list search", () => {
  it("matches names, npubs, and previews case-insensitively", () => {
    const values = [
      "Alice's Shop",
      "npub1merchant",
      "Your order is ready for pickup",
    ]

    expect(matchesConversationSearch(" alice ", values)).toBe(true)
    expect(matchesConversationSearch("NPUB1MERCHANT", values)).toBe(true)
    expect(matchesConversationSearch("ready for pickup", values)).toBe(true)
    expect(matchesConversationSearch("wholesale", values)).toBe(false)
    expect(matchesConversationSearch("  ", values)).toBe(true)
  })

  for (const routePath of routePaths) {
    it(`${routePath} exposes desktop search and a mobile scroller`, async () => {
      const source = await Bun.file(routePath).text()

      expect(source).toContain('aria-label="Search conversations"')
      expect(source).toContain("matchesConversationSearch")
      expect(source).toContain("<ConversationCardScroller>")
      expect(source).toContain("<SheetTrigger asChild>")
      expect(source).toContain("<SheetTitle>Your conversations</SheetTitle>")
      expect(source).toContain("Search\n")
      expect(source).toContain("xl:hidden")
      expect(source).toContain("hidden min-w-0")
      expect(source).toContain(
        "rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface"
      )
      expect(source).toContain("min-h-[36rem]")
      expect(source).toContain(
        "flex min-h-[36rem] min-w-0 flex-col overflow-hidden"
      )
      expect(source).toContain("min-h-0 flex-1 space-y-")
      expect(source).not.toContain("Filter conversations")
    })
  }
})
