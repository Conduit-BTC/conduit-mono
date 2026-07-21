import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

const SHOPPER_PRICE_ROUTES = [
  "apps/market/src/routes/products/index.tsx",
  "apps/market/src/routes/products/$productId.tsx",
  "apps/market/src/routes/store/$pubkey.tsx",
  "apps/market/src/routes/cart.tsx",
  "apps/market/src/routes/checkout.tsx",
  "apps/market/src/routes/orders.tsx",
  "apps/market/src/routes/messages.tsx",
  "apps/market/src/routes/wallet.tsx",
  "apps/market/src/routes/zapouts.tsx",
] as const

describe("Market shopper price display contract", () => {
  it("uses the shared shopper formatter across shopper and payment routes", async () => {
    const contents = await Promise.all(
      SHOPPER_PRICE_ROUTES.map((path) => readFile(path, "utf8"))
    )

    for (const content of contents) {
      expect(content).toContain("useShopperPricing")
    }
  })

  it("offers connected shoppers the constrained currency and sats controls", async () => {
    const wallet = await readFile("apps/market/src/routes/wallet.tsx", "utf8")

    expect(wallet).toContain("SUPPORTED_SHOPPER_DISPLAY_CURRENCIES")
    expect(wallet).toContain("Preferred currency")
    expect(wallet).toContain("Sats the standard")
    expect(wallet).toContain("₿10,000 equals 10,000 sats")
    expect(wallet).toContain(
      "never changes a listing, order, invoice, or payment"
    )
  })

  it("keeps checkout conversion freshness on the shared Core policy", async () => {
    const checkoutPricing = await readFile(
      "apps/market/src/lib/checkout-payment.ts",
      "utf8"
    )

    expect(checkoutPricing).toContain("isPricingRateQuoteFresh")
    expect(checkoutPricing).toContain("DEFAULT_PRICING_RATE_MAX_AGE_MS")
  })

  it("resolves fresh pricing before publishing order-first checkout", async () => {
    const checkout = await readFile(
      "apps/market/src/routes/checkout.tsx",
      "utf8"
    )
    const placeOrder = checkout.indexOf("async function placeOrder")
    const freshPricing = checkout.indexOf(
      "await getFreshPricingIntent()",
      placeOrder
    )
    const orderEvent = checkout.indexOf("new NDKEvent(ndk)", placeOrder)

    expect(placeOrder).toBeGreaterThan(-1)
    expect(freshPricing).toBeGreaterThan(placeOrder)
    expect(orderEvent).toBeGreaterThan(freshPricing)
  })

  it("formats the Orders message widget with shopper preferences", async () => {
    const orders = await readFile("apps/market/src/routes/orders.tsx", "utf8")
    const widget = orders.slice(orders.indexOf("<OrderMessagesWidget"))

    expect(widget).toContain("formatAmount=")
    expect(widget).toContain("settledSatsAreAuthoritative: true")
  })
})
