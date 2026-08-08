import { describe, expect, it, spyOn } from "bun:test"
import {
  cachePublishedMerchantOrderMessage,
  type ParsedOrderMessage,
} from "@conduit/core"

describe("merchant order publish", () => {
  it("does not turn a post-delivery cache failure into a publish retry", async () => {
    const message = {} as ParsedOrderMessage
    const warning = spyOn(console, "warn").mockImplementation(() => {})

    expect(
      await cachePublishedMerchantOrderMessage(message, async () => {})
    ).toBe(true)
    expect(
      await cachePublishedMerchantOrderMessage(message, async () => {
        throw new Error("storage unavailable")
      })
    ).toBe(false)
    expect(warning).toHaveBeenCalledTimes(1)
    warning.mockRestore()
  })
})
