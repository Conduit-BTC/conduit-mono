import { describe, expect, it } from "bun:test"

describe("checkout completion navigation contracts", () => {
  it("routes completed checkout flows to Orders instead of stale cart state", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    // CND-122: completed checkout flows navigate to the status-first Orders
    // tracker via a deep link (`?order=<id>`), so Orders can render the order
    // immediately from durable local lifecycle state.
    const ordersNavigations =
      checkoutRoute.match(
        /navigate\(\{\s*to: "\/orders",\s*search: \{ order: orderId \},\s*replace: true,?\s*\}\)/g
      ) ?? []

    expect(checkoutRoute).toContain("const navigate = useNavigate()")
    expect(ordersNavigations.length).toBeGreaterThanOrEqual(2)
    expect(checkoutRoute).toContain("createOrderLifecycle(")
  })

  it("does not offer cart as a terminal paid-checkout action", async () => {
    const paymentTracker = await Bun.file(
      "apps/market/src/components/PaymentTracker.tsx"
    ).text()

    expect(paymentTracker).toContain('<Link to="/orders">View orders</Link>')
    expect(paymentTracker).not.toContain('<Link to="/cart">Back to cart</Link>')
  })

  it("uses the published fast-checkout total for degraded success telemetry", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()

    expect(checkoutRoute).toContain(
      "let publishedTotalSats: number | null = null"
    )
    expect(checkoutRoute).toContain(
      "publishedTotalSats = checkoutPricing.totalSats"
    )
    expect(checkoutRoute).toContain(
      "const deliveredAmountSats = publishedTotalSats ?? total"
    )
    expect(checkoutRoute).toContain("amountSats: deliveredAmountSats")
  })

  it("does not report downstream checkout failures before those steps start", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const placeOrderStart = checkoutRoute.indexOf(
      "async function placeOrder(): Promise<void>"
    )
    const placeOrderEnd = checkoutRoute.indexOf(
      "// ─── Fast zap path",
      placeOrderStart
    )
    const placeOrderSource = checkoutRoute.slice(placeOrderStart, placeOrderEnd)
    const orderAvailability = placeOrderSource.indexOf(
      'await assertCheckoutItemsAvailable("order_first")'
    )
    const orderStarted = placeOrderSource.indexOf("orderSubmitStarted = true")
    const orderStartedTelemetry = placeOrderSource.indexOf(
      'status: "started"',
      orderStarted
    )
    const orderFailureGuard = placeOrderSource.indexOf(
      "if (orderSubmitStarted) {"
    )
    const orderFailure = placeOrderSource.indexOf(
      'stepName: "order_submit"',
      orderFailureGuard
    )

    expect(placeOrderStart).toBeGreaterThan(-1)
    expect(placeOrderEnd).toBeGreaterThan(placeOrderStart)
    expect(placeOrderSource).toContain("let orderSubmitStarted = false")
    expect(orderStarted).toBeGreaterThan(orderAvailability)
    expect(orderStartedTelemetry).toBeGreaterThan(orderStarted)
    expect(orderFailureGuard).toBeGreaterThan(orderStartedTelemetry)
    expect(orderFailure).toBeGreaterThan(orderFailureGuard)
    expect(placeOrderSource).toContain(
      'status: orderSubmitStarted ? "failed" : "blocked"'
    )

    const payNowStart = checkoutRoute.indexOf(
      "async function payNow(): Promise<void>"
    )
    const payNowEnd = checkoutRoute.indexOf(
      "// --- Full-screen transition states",
      payNowStart
    )
    const payNowSource = checkoutRoute.slice(payNowStart, payNowEnd)
    const paymentAvailability = payNowSource.indexOf(
      "await assertCheckoutItemsAvailable(requestedCheckoutMode)"
    )
    const paymentStarted = payNowSource.indexOf("directPaymentStarted = true")
    const paymentStartedTelemetry = payNowSource.indexOf(
      'stepName: "direct_payment"',
      paymentStarted
    )
    const paymentFailureGuard = payNowSource.indexOf(
      "if (directPaymentStarted) {"
    )
    const paymentFailure = payNowSource.indexOf(
      'stepName: "direct_payment"',
      paymentFailureGuard
    )

    expect(payNowStart).toBeGreaterThan(-1)
    expect(payNowEnd).toBeGreaterThan(payNowStart)
    expect(payNowSource).toContain("let directPaymentStarted = false")
    expect(paymentStarted).toBeGreaterThan(paymentAvailability)
    expect(paymentStartedTelemetry).toBeGreaterThan(paymentStarted)
    expect(paymentFailureGuard).toBeGreaterThan(paymentStartedTelemetry)
    expect(paymentFailure).toBeGreaterThan(paymentFailureGuard)
    expect(payNowSource).toContain(
      'status: directPaymentStarted ? "failed" : "blocked"'
    )
  })

  it("keeps anonymous zap preparation behind durable order delivery", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const payNowIndex = checkoutRoute.indexOf(
      "async function payNow(): Promise<void>"
    )
    const orderPublishIndex = checkoutRoute.indexOf(
      "await publishBuyerOrderMessage(",
      payNowIndex
    )
    const lifecycleIndex = checkoutRoute.indexOf(
      "await createOrderLifecycle(",
      orderPublishIndex
    )
    const paymentServiceIndex = checkoutRoute.indexOf(
      "void runOrderPayment(serviceCtx)",
      lifecycleIndex
    )

    expect(payNowIndex).toBeGreaterThan(-1)
    expect(orderPublishIndex).toBeGreaterThan(-1)
    expect(lifecycleIndex).toBeGreaterThan(orderPublishIndex)
    expect(paymentServiceIndex).toBeGreaterThan(lifecycleIndex)
    expect(checkoutRoute).not.toContain("prepareAnonZapCheckout")
    expect(checkoutRoute).not.toContain("pendingAnonAuthorization")
    expect(checkoutRoute).toContain("for (const item of checkoutPricing.items)")
    expect(checkoutRoute).toContain(
      "items: buildLifecycleItems(checkoutPricing.items)"
    )
  })

  it("offers guest shoppers a signer path when invoice checkout is unavailable", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()

    expect(checkoutRoute).toContain("{isGuestCheckout && !fastEligible && (")
    expect(checkoutRoute).toContain("Connect signer to send order")
    expect(checkoutRoute).toContain("<SignerSwitch")
  })

  it("warns guests about tab-scoped recovery before and during payment", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const ordersRoute = await Bun.file(
      "apps/market/src/routes/orders.tsx"
    ).text()

    expect(checkoutRoute).toContain(
      "Keep this tab open until the payment is reported"
    )
    expect(ordersRoute).toContain("Closing it ends")
    expect(ordersRoute).toContain("local access to this guest order")
    expect(ordersRoute).toContain("merchant will follow up")
    expect(ordersRoute).toContain("disabled={!activeBuyerPubkey || isFetching}")
  })
})
