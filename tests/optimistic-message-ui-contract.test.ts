import { describe, expect, it } from "bun:test"

const routePaths = [
  "apps/market/src/routes/messages.tsx",
  "apps/merchant/src/routes/messages.tsx",
]

describe("shared optimistic message route contract", () => {
  for (const routePath of routePaths) {
    it(`${routePath} uses the shared optimistic queue and bubble states`, async () => {
      const source = await Bun.file(routePath).text()

      expect(source).toContain("useOptimisticConversationMessages()")
      expect(source).toContain("deliveryState={message.deliveryState}")
      expect(source).toContain("optimistic")
      expect(source).toContain("markPublished(message.localId)")
      expect(source).toContain("markFailed(message.localId)")
      expect(source).toContain("Retry from the message")
    })
  }
})
