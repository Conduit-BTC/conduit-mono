import { describe, expect, it } from "bun:test"

import {
  getCartHudCheckoutCapability,
  getCartHudCheckoutFallbackMessage,
  getCartHudRouteMode,
  reconcileCartHudMerchant,
} from "../apps/market/src/lib/cart-hud"
import { pubkeyToNpub } from "@conduit/core"

describe("Market cart HUD policy", () => {
  it("expands on browse surfaces, compacts product detail, and suppresses workflows", () => {
    expect(getCartHudRouteMode("/products")).toBe("expanded")
    expect(getCartHudRouteMode("/store/merchant")).toBe("expanded")
    expect(getCartHudRouteMode(`/${pubkeyToNpub("a".repeat(64))}`)).toBe(
      "expanded"
    )
    expect(getCartHudRouteMode("/events")).toBe("expanded")
    expect(getCartHudRouteMode("/events/")).toBe("expanded")
    expect(getCartHudRouteMode("/events/naddr1example")).toBe("expanded")
    expect(getCartHudRouteMode("/products/30402:merchant:item")).toBe("compact")
    for (const pathname of [
      "/eventsettings",
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

  it("arms zap out only when every HUD eligibility input is ready", () => {
    expect(
      getCartHudCheckoutCapability({
        listingFresh: true,
        shopperPresetReady: true,
        walletReady: true,
        itemPricesAvailable: true,
        shippingReady: true,
        merchantLightningReady: true,
      })
    ).toEqual({
      state: "zap_ready",
      blockers: [],
    })
  })

  it("reports every unavailable HUD checkout input", () => {
    expect(
      getCartHudCheckoutCapability({
        listingFresh: false,
        shopperPresetReady: false,
        walletReady: false,
        itemPricesAvailable: false,
        shippingReady: false,
        merchantLightningReady: false,
      })
    ).toEqual({
      state: "route_to_checkout",
      blockers: [
        "listing_freshness_unavailable",
        "shopper_preset_unavailable",
        "wallet_unavailable",
        "price_unavailable",
        "shipping_unavailable",
        "merchant_lightning_unavailable",
      ],
    })
  })

  it("explains why the HUD routes through checkout", () => {
    expect(
      getCartHudCheckoutFallbackMessage({
        state: "zap_ready",
        blockers: [],
      })
    ).toBe(
      "Ready to zap out. Checkout confirms the merchant payment endpoint before paying."
    )
    expect(
      getCartHudCheckoutFallbackMessage({
        state: "route_to_checkout",
        blockers: ["price_unavailable"],
      })
    ).toBe("Checkout is needed to refresh the cart total.")
    expect(
      getCartHudCheckoutFallbackMessage({
        state: "route_to_checkout",
        blockers: ["listing_freshness_unavailable"],
      })
    ).toBe("Checkout is needed to confirm shipping and payment readiness.")
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
