import { describe, expect, it } from "bun:test"
import {
  NDKEvent,
  NDKPrivateKeySigner,
  NDKUser,
  giftWrap,
} from "@nostr-dev-kit/ndk"

import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  EVENT_KINDS,
  getNdk,
  inspectCheckoutSparkRecoveryWrap,
  type OrderSchema,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import { plainTestSigner } from "./helpers/plain-signer"

describe("authenticated checkout Spark order discovery", () => {
  it("unwraps a real router order without consulting NDK's decrypted-event cache", async () => {
    const buyer = NDKPrivateKeySigner.generate()
    const merchant = plainTestSigner(NDKPrivateKeySigner.generate())
    const order: OrderSchema = {
      id: "fresh-unwrap-order",
      buyerPubkey: buyer.pubkey,
      buyerIdentityKind: "signed_in",
      merchantPubkey: merchant.pubkey,
      items: [
        {
          productId: `30402:${merchant.pubkey}:digital-item`,
          format: "digital",
          fulfillment: { type: "digital" },
          quantity: 1,
          priceAtPurchase: 1_000,
          currency: "SATS",
          shippingCostSats: 0,
        },
      ],
      subtotal: 1_000,
      currency: "SATS",
      shippingCostSats: 0,
      shippingCostStatus: "not_required",
      createdAt: 1_800_000_000_000,
    }
    const ndk = getNdk()
    const rumor = new NDKEvent(ndk)
    rumor.kind = EVENT_KINDS.ORDER
    rumor.pubkey = buyer.pubkey
    rumor.created_at = order.createdAt / 1_000
    rumor.content = JSON.stringify(order)
    rumor.tags = [
      ["p", merchant.pubkey],
      ["type", "order"],
      ["order", order.id],
      ["amount", "1000"],
      ["currency", "SATS"],
      ["item", order.items[0]!.productId, "1"],
      [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
    ]
    rumor.id = rumor.getEventHash()
    const wrap = await giftWrap(
      rumor,
      new NDKUser({ pubkey: merchant.pubkey }),
      buyer
    )

    const previousCache = ndk.cacheAdapter
    let cacheReads = 0
    ndk.cacheAdapter = {
      getDecryptedEvent: async () => {
        cacheReads += 1
        return null
      },
    } as unknown as NonNullable<typeof ndk.cacheAdapter>
    try {
      const opened = await inspectCheckoutSparkRecoveryWrap({
        signedRecipientWrap: wrap.rawEvent() as SignedPublicNostrEvent,
        signer: merchant,
      })
      expect(opened.status).toBe("ignored")
      if (opened.status !== "ignored") {
        throw new Error("Expected an authenticated ordinary router order.")
      }
      expect(opened.orderEvidence).toMatchObject({
        buyerPubkey: buyer.pubkey,
        merchantPubkey: merchant.pubkey,
        orderId: order.id,
        rumorId: rumor.id,
        commerceTotalSats: order.subtotal,
      })
      expect(cacheReads).toBe(0)
    } finally {
      ndk.cacheAdapter = previousCache
    }
  })
})
