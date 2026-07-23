import { describe, expect, it } from "bun:test"
import {
  getCartHudCheckoutCapability,
  getCartHudRouteMode,
  reconcileCartHudMerchant,
} from "../apps/market/src/lib/cart-hud"

describe("Market cart HUD policy", () => {
  it("expands on browse surfaces, compacts product detail, and suppresses workflows", () => {
    expect(getCartHudRouteMode("/products")).toBe("expanded")
    expect(getCartHudRouteMode("/store/merchant")).toBe("expanded")
    expect(getCartHudRouteMode("/products/30402:merchant:item")).toBe("compact")
    for (const pathname of [
      "/cart",
      "/checkout",
      "/orders",
      "/messages",
      "/wallet",
      "/network",
      "/profile",
      "/about",
      "/zapouts",
      "/u/profile",
    ]) {
      expect(getCartHudRouteMode(pathname)).toBe("suppressed")
    }
  })

  it("routes to checkout while freshness and shopper presets are unavailable", () => {
    expect(
      getCartHudCheckoutCapability({
        itemPricesAvailable: true,
        shippingReady: true,
        merchantLightningReady: true,
      })
    ).toEqual({
      state: "route_to_checkout",
      blockers: ["listing_freshness_unavailable", "shopper_preset_unavailable"],
    })
  })

  it("reports additional blockers without claiming direct-payment eligibility", () => {
    expect(
      getCartHudCheckoutCapability({
        itemPricesAvailable: false,
        shippingReady: false,
        merchantLightningReady: false,
      })
    ).toEqual({
      state: "route_to_checkout",
      blockers: [
        "listing_freshness_unavailable",
        "shopper_preset_unavailable",
        "price_unavailable",
        "shipping_unavailable",
        "merchant_lightning_unavailable",
      ],
    })
  })

  it("keeps a valid merchant selection and otherwise chooses the newest group", () => {
    expect(
      reconcileCartHudMerchant("merchant-b", ["merchant-a", "merchant-b"])
    ).toBe("merchant-b")
    expect(
      reconcileCartHudMerchant("removed", ["merchant-a", "merchant-b"])
    ).toBe("merchant-a")
    expect(reconcileCartHudMerchant(null, [])).toBeNull()
  })
})
