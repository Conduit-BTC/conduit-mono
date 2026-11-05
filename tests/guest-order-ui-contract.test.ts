import { describe, expect, it } from "bun:test"
import {
  buildMerchantOrderRumorTags,
  getMerchantOrderDeliveryRecipients,
} from "@conduit/core"

describe("guest order UI contracts", () => {
  it("publishes guest operations to the merchant self-copy only", () => {
    expect(
      getMerchantOrderDeliveryRecipients({
        merchantPubkey: "merchant",
        buyerPubkey: "ephemeral-guest",
        delivery: "self_only",
      })
    ).toEqual(["merchant"])
    expect(
      getMerchantOrderDeliveryRecipients({
        merchantPubkey: "merchant",
        buyerPubkey: "buyer",
        delivery: "buyer_and_self",
      })
    ).toEqual(["buyer", "merchant"])
    expect(
      buildMerchantOrderRumorTags({
        buyerPubkey: "ephemeral-guest",
        orderId: "guest-order",
        type: "shipping_update",
      })
    ).toContainEqual(["p", "ephemeral-guest"])
  })
})
