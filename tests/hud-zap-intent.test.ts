import { describe, expect, it } from "bun:test"
import {
  armHudZapIntent,
  consumeHudZapIntent,
  getHudZapAuthorizationBindingMismatch,
  getHudZapAuthorizationRejection,
} from "../apps/market/src/lib/hud-zap-intent"
import {
  getCartCommerceFingerprint,
  type CartItem,
} from "../apps/market/src/lib/cart-model"

const items: CartItem[] = [
  {
    merchantPubkey: "merchant-a",
    productId: "30402:merchant-a:item",
    title: "Item",
    price: 1_000,
    priceSats: 1_000,
    currency: "SATS",
    format: "digital",
    quantity: 1,
  },
]

function authorization(createdAt = 1_000) {
  return {
    merchantPubkey: "merchant-a",
    buyerPubkey: "buyer-a",
    cartFingerprint: getCartCommerceFingerprint(items),
    totalMsats: 1_000_000,
    createdAt,
  }
}

describe("HUD zap intent", () => {
  it("can be consumed once by the matching merchant", () => {
    armHudZapIntent(authorization())
    expect(consumeHudZapIntent("merchant-a", 2_000)).toEqual(authorization())
    expect(consumeHudZapIntent("merchant-a", 2_000)).toBeNull()
  })

  it("rejects mismatched and expired handoffs", () => {
    armHudZapIntent(authorization())
    expect(consumeHudZapIntent("merchant-b", 2_000)).toBeNull()
    armHudZapIntent(authorization())
    expect(consumeHudZapIntent("merchant-a", 31_001)).toBeNull()
  })

  it("binds authorization to buyer, cart terms, quantity, and total", () => {
    const intent = authorization()
    expect(
      getHudZapAuthorizationRejection(intent, {
        merchantPubkey: "merchant-a",
        buyerPubkey: "buyer-a",
        items,
        totalMsats: 1_000_000,
        nowMs: 2_000,
      })
    ).toBeNull()

    for (const input of [
      { buyerPubkey: "buyer-b", items, totalMsats: 1_000_000 },
      {
        buyerPubkey: "buyer-a",
        items: [{ ...items[0]!, quantity: 2 }],
        totalMsats: 1_000_000,
      },
      { buyerPubkey: "buyer-a", items, totalMsats: 2_000_000 },
    ]) {
      expect(
        getHudZapAuthorizationRejection(intent, {
          merchantPubkey: "merchant-a",
          nowMs: 2_000,
          ...input,
        })
      ).toBe("changed")
    }
  })

  it("separates a slow checkout confirmation from a changed cart", () => {
    const intent = authorization()
    expect(
      getHudZapAuthorizationRejection(intent, {
        merchantPubkey: "merchant-a",
        buyerPubkey: "buyer-a",
        items,
        totalMsats: 1_000_000,
        nowMs: 31_001,
      })
    ).toBe("expired")
    expect(
      getHudZapAuthorizationRejection(intent, {
        merchantPubkey: "merchant-a",
        buyerPubkey: "buyer-a",
        items,
        totalMsats: 2_000_000,
        nowMs: 2_000,
      })
    ).toBe("changed")
    expect(
      getHudZapAuthorizationRejection(intent, {
        merchantPubkey: "merchant-a",
        buyerPubkey: "buyer-a",
        items,
        totalMsats: 1_000_000,
        nowMs: 2_000,
      })
    ).toBeNull()
  })
})

describe("claimed HUD zap authorization", () => {
  it("keeps a claimed attempt valid past the arm-time TTL", () => {
    const intent = authorization()
    expect(
      getHudZapAuthorizationBindingMismatch(intent, {
        merchantPubkey: "merchant-a",
        buyerPubkey: "buyer-a",
        items,
        totalMsats: 1_000_000,
      })
    ).toBeNull()
  })

  it("still aborts a claimed attempt when commerce terms change", () => {
    const intent = authorization()
    expect(
      getHudZapAuthorizationBindingMismatch(intent, {
        merchantPubkey: "merchant-a",
        buyerPubkey: "buyer-a",
        items,
        totalMsats: 2_000_000,
      })
    ).toBe("changed")
    expect(
      getHudZapAuthorizationBindingMismatch(intent, {
        merchantPubkey: "merchant-a",
        buyerPubkey: "buyer-b",
        items,
        totalMsats: 1_000_000,
      })
    ).toBe("changed")
  })
})
