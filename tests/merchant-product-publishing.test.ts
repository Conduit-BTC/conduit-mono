import { describe, expect, it } from "bun:test"
import { EVENT_KINDS } from "@conduit/core"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import { isDeliverableMerchantProductEvent } from "../apps/merchant/src/lib/product-publishing"

const MERCHANT_SECRET = new Uint8Array(32).fill(4)
const OTHER_MERCHANT_SECRET = new Uint8Array(32).fill(5)
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)

function makeSignedEvent(kind: number) {
  return finalizeEvent(
    {
      kind,
      created_at: 1_700_000_100,
      content: kind === EVENT_KINDS.DELETION ? "Listing removed" : "Listing",
      tags:
        kind === EVENT_KINDS.DELETION
          ? [["a", `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:listing`]]
          : [["d", "listing"]],
    },
    MERCHANT_SECRET
  )
}

describe("merchant product event delivery", () => {
  it("accepts signed product listings and NIP-09 deletion events", () => {
    expect(
      isDeliverableMerchantProductEvent(
        makeSignedEvent(EVENT_KINDS.PRODUCT),
        MERCHANT_PUBKEY
      )
    ).toBe(true)
    expect(
      isDeliverableMerchantProductEvent(
        makeSignedEvent(EVENT_KINDS.DELETION),
        MERCHANT_PUBKEY
      )
    ).toBe(true)
  })

  it("rejects unsupported kinds and a different merchant identity", () => {
    expect(
      isDeliverableMerchantProductEvent(makeSignedEvent(1), MERCHANT_PUBKEY)
    ).toBe(false)
    expect(
      isDeliverableMerchantProductEvent(
        makeSignedEvent(EVENT_KINDS.PRODUCT),
        getPublicKey(OTHER_MERCHANT_SECRET)
      )
    ).toBe(false)
  })
})
