import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return Bun.file(path).text()
}

describe("Market verified zero-cost pickup route contract", () => {
  it("opts into Free / 0 sats only after exact pickup resolution", async () => {
    const [card, resolvedCard, eventRoute, detail, cart, checkout, orders] =
      await Promise.all([
        source("apps/market/src/components/ProductGridCard.tsx"),
        source("apps/market/src/components/ResolvedProductGridCard.tsx"),
        source("apps/market/src/routes/events/$collectionRef.tsx"),
        source("apps/market/src/routes/products/$productId.tsx"),
        source("apps/market/src/routes/cart.tsx"),
        source("apps/market/src/routes/checkout.tsx"),
        source("apps/market/src/routes/orders.tsx"),
      ])

    expect(card).toContain("allowZeroPrice = false")
    expect(card).toContain("{ allowZero: allowZeroPrice }")
    expect(resolvedCard).toContain(
      'allowZeroPrice={resolution?.status === "pickup"}'
    )
    expect(eventRoute).toContain("allowZeroPrice={pickupFulfillment !== null}")
    expect(detail).toContain(
      'allowZero: productCartResolution?.status === "pickup"'
    )
    expect(cart).toContain("{ allowZero: !pricing.paymentRequired }")
    expect(checkout).toContain("{ allowZero: !pricing.paymentRequired }")
    expect(orders).toContain("allowZero: zeroCostPickupOrder")
    expect(orders).toContain('"Free · 0 sats"')
  })

  it("routes signed-in and guest free pickup through merchant-only order-first", async () => {
    const checkout = await source("apps/market/src/routes/checkout.tsx")
    const placeOrderStart = checkout.indexOf(
      "async function placeOrder(): Promise<void>"
    )
    const payNowStart = checkout.indexOf("async function payNow(")
    const placeOrder = checkout.slice(placeOrderStart, payNowStart)

    expect(placeOrderStart).toBeGreaterThan(-1)
    expect(placeOrder).toContain(
      "!signedBuyerIdentity && !(isGuestCheckout && verifiedZeroCostPickup)"
    )
    expect(placeOrder).toContain("createSessionGuestOrderSigningIdentity(")
    expect(placeOrder).toContain("guestIdentity ?? signedBuyerIdentity")
    expect(placeOrder).toContain("guestContact")
    expect(placeOrder).toContain('checkoutMode: "pay_later"')
    expect(placeOrder).not.toContain("runOrderPayment")
    expect(checkout).toContain('"Send order"')
    expect(checkout).toContain(
      "No payment is required. The merchant reviews the order and coordinates pickup."
    )
  })

  it("suppresses Lightning discovery and fails closed before any zero payment", async () => {
    const checkout = await source("apps/market/src/routes/checkout.tsx")
    const payNowStart = checkout.indexOf("async function payNow(")
    const payNow = checkout.slice(payNowStart)
    const freshZeroGuard = payNow.indexOf("if (!pricingIntent.paymentRequired)")
    const orderIdentity = payNow.indexOf("const orderId = crypto.randomUUID()")
    const paymentService = payNow.indexOf("void runOrderPayment(serviceCtx)")

    expect(checkout).toContain("const paymentPathEnabled =")
    expect(checkout).toMatch(
      /const canAttemptLightningPayment =\s+paymentPathEnabled &&/
    )
    expect(checkout).toMatch(
      /const allowsManualLightningFallback =\s+paymentPathEnabled &&/
    )
    expect(checkout).toContain(
      "const fastEligible =\n    paymentPathEnabled &&"
    )
    expect(payNow).toContain(
      'if (pricingPreview.status === "ok" && !pricingPreview.paymentRequired)'
    )
    expect(freshZeroGuard).toBeGreaterThan(-1)
    expect(freshZeroGuard).toBeLessThan(orderIdentity)
    expect(orderIdentity).toBeLessThan(paymentService)
    expect(checkout).toContain(
      "This free pickup order must be sent without starting payment."
    )
  })

  it("keeps order history free of invoice, retry, and wallet actions", async () => {
    const [view, orders] = await Promise.all([
      source("apps/market/src/lib/order-view.ts"),
      source("apps/market/src/routes/orders.tsx"),
    ])

    expect(view).toContain("export function isZeroCostPickupOrder")
    expect(view).toContain('return "No payment required"')
    expect(view).toContain(
      '["order_sent", "merchant_confirmation", "fulfillment", "complete"]'
    )
    expect(orders).toContain("if (zeroCostPickupOrder) return null")
    expect(orders).toContain(
      "const paymentActionAllowed = canOfferOrderPaymentAction(vm)"
    )
    expect(orders).toContain("const wallets = useWallets()")
    expect(orders).toMatch(
      /const showRetryPayment =\s+!zeroCostPickupOrder &&\s+paymentActionAllowed &&\s+vm\.paymentStatus === "failed"/
    )
  })

  it("does not reinterpret generic or shipped zero listings as free pickup", async () => {
    const [card, checkoutPricing] = await Promise.all([
      source("apps/market/src/components/ProductGridCard.tsx"),
      source("apps/market/src/lib/checkout-payment.ts"),
    ])

    expect(card).toContain("allowZeroPrice = false")
    expect(checkoutPricing).toContain('code: "invalid_total"')
    expect(checkoutPricing).toContain('item.fulfillment?.type === "pickup"')
  })
})
