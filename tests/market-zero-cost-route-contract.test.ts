import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return Bun.file(path).text()
}

describe("Market verified zero-cost pickup route contract", () => {
  it("keeps zero-price display separate from exact purchase authority", async () => {
    const [
      card,
      resolvedCard,
      eventRoute,
      eventPage,
      detail,
      cart,
      checkout,
      orders,
    ] = await Promise.all([
      source("apps/market/src/components/ProductGridCard.tsx"),
      source("apps/market/src/components/ResolvedProductGridCard.tsx"),
      source("apps/market/src/routes/events/$collectionRef.tsx"),
      source("apps/market/src/components/FutureEventMarketPage.tsx"),
      source("apps/market/src/routes/products/$productId.tsx"),
      source("apps/market/src/routes/cart.tsx"),
      source("apps/market/src/routes/checkout.tsx"),
      source("apps/market/src/routes/orders.tsx"),
    ])

    expect(card).toContain("allowZeroPrice = false")
    expect(card).toContain("{ allowZero: allowZeroPrice }")
    expect(resolvedCard).toContain('resolution?.status === "standard"')
    expect(resolvedCard).not.toContain("allowZeroPrice=")
    expect(eventRoute).toContain("<FutureEventMarketPage")
    expect(eventRoute).toContain(
      "decodeEventMarketReference(collectionRef, [30409])"
    )
    expect(eventPage).toContain(
      'allowZeroPrice={choice === "event_market_pickup" && canPurchase}'
    )
    expect(eventPage).toContain("cartActionDisabled={checking || !canAdd}")
    expect(eventPage).toContain(
      'choice === "shipping" ? hasEventShippingChoice(product) : canPurchase'
    )
    expect(eventPage).toContain('productRead.resolution.state !== "eligible"')
    expect(eventPage).toContain("!productRead.actionable")
    expect(eventPage).toContain("createEventMarketPickupSnapshot({")
    expect(
      eventPage.indexOf("const productRead = await readEventMarketProduct({")
    ).toBeLessThan(eventPage.lastIndexOf("await cart.addItem("))
    expect(detail).toContain(
      'productCartCandidate?.fulfillment?.type === "event_market_pickup"'
    )
    expect(cart).toMatch(
      /allowZero:\s*allowZeroPrice && futurePickup !== undefined/
    )
    expect(checkout).toContain(
      'item.fulfillment?.type === "event_market_pickup"'
    )
    expect(checkout).toContain("{ allowZero: !pricing.paymentRequired }")
    expect(orders).toContain("allowZero: zeroCostPickupOrder")
    expect(orders).toContain('"Free · 0 sats"')
  })

  it("routes signed-in and guest free pickup through merchant-only order-first", async () => {
    const checkout = await source("apps/market/src/routes/checkout.tsx")
    const routerAdmission = checkout.slice(
      checkout.indexOf("const routerBranchTargetCheckout ="),
      checkout.indexOf("const paymentRequired =")
    )
    expect(routerAdmission).toContain("isQuantumRouterEnabled()")
    expect(routerAdmission).toContain("!verifiedZeroCostPickup")
    expect(routerAdmission).toContain(
      "isCheckoutSparkSettledCart(rawCheckoutItems)"
    )
    expect(checkout.indexOf("const verifiedZeroCostPickup =")).toBeLessThan(
      checkout.indexOf("const routerBranchTargetCheckout =")
    )
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
    expect(placeOrder).toContain('["p", selectedMerchant]')
    expect(placeOrder).not.toContain('["p", pickupHandoff')
    expect(placeOrder).not.toContain("runOrderPayment")
    expect(checkout).toContain('"Send order"')
    expect(checkout).not.toContain("What happens next")
    expect(checkout).not.toContain("No payment is required")
  })

  it("suppresses Lightning discovery and fails closed before any zero payment", async () => {
    const checkout = await source("apps/market/src/routes/checkout.tsx")
    const payNowStart = checkout.indexOf("async function payNow(")
    const payNow = checkout.slice(payNowStart)
    const freshZeroGuard = payNow.indexOf("if (!pricingIntent.paymentRequired)")
    const orderIdentity = payNow.indexOf("const orderId =")
    const paymentService = payNow.indexOf("void runOrderPayment(serviceCtx)")

    expect(checkout).toContain("const paymentPathEnabled =")
    expect(checkout).toMatch(
      /const canAttemptLightningPayment =\s+paymentPathEnabled &&/
    )
    expect(checkout).toMatch(
      /const manualInvoiceEligible =\s+paymentPathEnabled &&/
    )
    expect(checkout).toContain(
      "const fastEligible =\n    paymentPathEnabled &&"
    )
    expect(payNow).toContain(
      'if (pricingPreview.status === "ok" && !pricingPreview.paymentRequired)'
    )
    expect(freshZeroGuard).toBeGreaterThan(-1)
    expect(orderIdentity).toBeGreaterThan(-1)
    expect(paymentService).toBeGreaterThan(-1)
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
    expect(orders).toMatch(
      /!zeroCostPickupOrder &&\s+vm\.paymentStatus === "failed" &&\s+generalPaymentRetryEligible/
    )
    expect(orders).toContain("const wallets = useWallets()")
    expect(orders).toMatch(
      /const showRetryPayment =\s+!zeroCostPickupOrder &&\s+vm\.paymentStatus === "failed" &&\s+generalPaymentRetryEligible/
    )
  })

  it("does not reinterpret generic or shipped zero listings as free pickup", async () => {
    const [card, checkoutPricing] = await Promise.all([
      source("apps/market/src/components/ProductGridCard.tsx"),
      source("apps/market/src/lib/checkout-payment.ts"),
    ])

    expect(card).toContain("allowZeroPrice = false")
    expect(checkoutPricing).toContain('code: "invalid_total"')
    expect(checkoutPricing).toContain(
      'item.fulfillment?.type === "event_market_pickup"'
    )
  })
})
