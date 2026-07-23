import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import {
  getCartHudCheckoutCapability,
  getCartHudRouteMode,
  reconcileCartHudMerchant,
} from "../apps/market/src/lib/cart-hud"

describe("Market cart HUD policy", () => {
  it("matches the Merchant navigation selected and hover palette", () => {
    const source = readFileSync(
      new URL(
        "../apps/market/src/components/MarketCartHud.tsx",
        import.meta.url
      ),
      "utf8"
    )

    expect(source).toContain("var(--primary-500)_15%,transparent")
    expect(source).toContain("var(--primary-500)_9%,transparent")
    expect(source).toContain("var(--primary-500)_10%,transparent")
    expect(source).toContain("var(--primary-500)_5%,transparent")
    expect(source).toContain("shadow-[var(--shadow-glass-inset)]")
    expect(source).toContain("var(--warning)_1%,var(--surface)")
    expect(source).toContain("var(--primary-500)_4%,var(--surface)")
    expect(source).toContain("var(--primary-500)_8%,var(--surface)")
    expect(
      source.match(/var\(--primary-500\)_15%,transparent/g)?.length
    ).toBeGreaterThanOrEqual(3)
    expect(source).toContain('aria-label="Cart products"')
    expect(source).toContain("linear-gradient(to right")
    expect(source).toContain("rounded-xl border-0 p-1 pr-8")
    expect(source.match(/max-w-60/g)?.length).toBe(2)
    expect(source).toContain('className="mr-auto min-w-0 flex-1"')
    expect(source.match(/<StatusPill/g)?.length).toBe(2)
    expect(source).toContain('variant="neutral"')
    expect(source).toContain("selected && expanded")
  })

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
