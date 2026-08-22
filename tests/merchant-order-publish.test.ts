import { describe, expect, it, spyOn } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  buildMerchantOrderRumorTags,
  cachePublishedMerchantOrderMessage,
  EVENT_KINDS,
  getMerchantOrderPublishTarget,
  type ParsedOrderMessage,
} from "@conduit/core"

describe("merchant order publish", () => {
  it("targets the merchant for a guest-only operational record", () => {
    const rumor = new NDKEvent()
    rumor.id = "guest-status-rumor"
    rumor.kind = EVENT_KINDS.ORDER
    rumor.pubkey = "merchant"
    rumor.tags = buildMerchantOrderRumorTags({
      buyerPubkey: "guest",
      orderId: "guest-order",
      type: "status_update",
      tags: [["status", "paid"]],
    })
    rumor.content = JSON.stringify({ status: "paid" })

    const target = getMerchantOrderPublishTarget(
      {
        merchantPubkey: "merchant",
        buyerPubkey: "guest",
        orderId: "guest-order",
        delivery: "self_only",
      },
      rumor
    )

    expect(rumor.tags).toContainEqual(["p", "guest"])
    expect(target.recipientPubkey).toBe("merchant")
    expect(target.selfCopy).toBe(false)
  })

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
