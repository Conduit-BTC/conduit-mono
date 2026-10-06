import * as messaging from "../packages/core/src/protocol/messaging"
import * as commerce from "../packages/core/src/protocol/commerce"
import { publishMerchantOrderMessage } from "../packages/core/src/protocol/merchant-order-publish"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { getEventHash } from "nostr-tools"
import {
  setTestAccountSigner,
  removeTestAccountSigner,
} from "./helpers/plain-signer"
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
    rumor.created_at = 100
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

it.each([
  {
    type: "payment_request" as const,
    payload: { invoice: "synthetic-invoice", amount: 200, currency: "SATS" },
  },
  { type: "status_update" as const, payload: { status: "confirmed" } },
  {
    type: "shipping_update" as const,
    payload: { carrier: "synthetic", trackingNumber: "synthetic-tracking" },
  },
])(
  "publishes merchant $type with the deployed named grammar",
  async ({ type, payload }) => {
    const merchantSigner = NDKPrivateKeySigner.generate()
    const lease = setTestAccountSigner(merchantSigner)
    const pubkey = (await merchantSigner.user()).pubkey
    const cache = spyOn(commerce, "cacheParsedOrderMessage").mockResolvedValue()
    const publish = spyOn(
      messaging,
      "publishPrivateMessage"
    ).mockImplementation(async ({ rumor }) => {
      expect(rumor.tags.find((tag) => tag[0] === "type")?.[1]).toBe(type)
      expect(rumor.tags.some((tag) => tag[0] === "conduit")).toBe(false)
      expect(JSON.parse(rumor.content)).toMatchObject(payload)
      expect(rumor.id).toBe(
        getEventHash({ ...rumor, kind: 16, created_at: rumor.created_at! })
      )
      return { selfCopyError: null, deliveryRoute: "declared_inbox" } as never
    })
    try {
      await publishMerchantOrderMessage({
        merchantPubkey: pubkey,
        buyerPubkey: "b".repeat(64),
        orderId: "legacy-order",
        type,
        payload,
        delivery: "buyer_and_self",
      })
      expect(publish).toHaveBeenCalledTimes(1)
      expect(cache).toHaveBeenCalledTimes(1)
    } finally {
      publish.mockRestore()
      cache.mockRestore()
      removeTestAccountSigner(lease)
    }
  }
)
