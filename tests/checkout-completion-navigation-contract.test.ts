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

    const payNowStart = checkoutRoute.indexOf("async function payNow(")
    const payNowEnd = checkoutRoute.indexOf(
      "// --- Full-screen transition states",
      payNowStart
    )
    const payNowSource = checkoutRoute.slice(payNowStart, payNowEnd)
    const paymentAvailability = payNowSource.indexOf(
      "await assertCheckoutItemsAvailable(requestedCheckoutMode)"
    )
    const signedOrderReady = payNowSource.indexOf(
      "const orderRumor = buildCheckoutOrderRumor({"
    )
    const orderPublish = payNowSource.indexOf("await publishBuyerOrderMessage(")
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
    expect(
      payNowSource.match(
        /await assertCheckoutItemsAvailable\(requestedCheckoutMode\)/g
      )
    ).toHaveLength(1)
    expect(signedOrderReady).toBeGreaterThan(-1)
    expect(paymentAvailability).toBeGreaterThan(-1)
    expect(orderPublish).toBeGreaterThan(-1)
    expect(paymentAvailability).toBeGreaterThan(signedOrderReady)
    expect(orderPublish).toBeGreaterThan(paymentAvailability)
    expect(paymentStarted).toBeGreaterThan(paymentAvailability)
    expect(paymentStartedTelemetry).toBeGreaterThan(paymentStarted)
    expect(paymentFailureGuard).toBeGreaterThan(paymentStartedTelemetry)
    expect(paymentFailure).toBeGreaterThan(paymentFailureGuard)
    expect(payNowSource).toContain(
      'status: directPaymentStarted ? "failed" : "blocked"'
    )

    const assertionStart = checkoutRoute.indexOf(
      "async function assertCheckoutItemsAvailable("
    )
    const assertionEnd = checkoutRoute.indexOf(
      "function updateShipping",
      assertionStart
    )
    const assertionSource = checkoutRoute.slice(assertionStart, assertionEnd)
    const termsCheck = assertionSource.indexOf(
      "if (!cartItemsMatchCurrentProducts("
    )
    const availabilitySuccess = assertionSource.lastIndexOf('status: "success"')
    expect(termsCheck).toBeGreaterThan(-1)
    expect(availabilitySuccess).toBeGreaterThan(termsCheck)
  })

  it("carries exact partial evidence through shared readiness into checkout", async () => {
    const readinessHook = await Bun.file(
      "apps/market/src/hooks/useCartReadiness.ts"
    ).text()
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()

    expect(readinessHook).toContain(
      "const readDecision = getCartAvailabilityReadDecision({"
    )
    expect(readinessHook).toContain(
      "const fresh = isCartAvailabilityReadComplete(readDecision)"
    )
    expect(readinessHook).toContain("readDecision,")
    expect(readinessHook).toContain("decision,")
    expect(checkoutRoute).toContain("selectedMerchantReadiness?.readDecision")
    expect(checkoutRoute).toContain(
      'checkoutAvailability.readDecision.coverage === "partial"'
    )
    expect(checkoutRoute).toContain(
      'if (refreshResult.decision.status === "unverified")'
    )
    expect(checkoutRoute).toContain("<CheckoutAvailabilityNotice")
  })

  it("keeps every payment rail behind final availability and durable order delivery", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const checkoutOrder = await Bun.file(
      "apps/market/src/lib/checkout-order.ts"
    ).text()
    const payNowIndex = checkoutRoute.indexOf("async function payNow(")
    const payNowEnd = checkoutRoute.indexOf(
      "// --- Full-screen transition states",
      payNowIndex
    )
    const payNowSource = checkoutRoute.slice(payNowIndex, payNowEnd)
    const availabilityIndex = payNowSource.indexOf(
      "await assertCheckoutItemsAvailable(requestedCheckoutMode)"
    )
    const authorizationIndex = payNowSource.indexOf(
      "assertClaimedZapAuthorization(",
      availabilityIndex
    )
    const orderPublishIndex = payNowSource.indexOf(
      "await publishBuyerOrderMessage(",
      authorizationIndex
    )
    const lifecycleIndex = payNowSource.indexOf(
      "await createOrderLifecycle(",
      orderPublishIndex
    )
    const sparkFeeApprovalIndex = payNowSource.indexOf(
      "sparkFeeApproval.requestApproval",
      lifecycleIndex
    )
    const sparkPaymentIndex = payNowSource.indexOf(
      "await runOrderPayment(serviceCtx)",
      sparkFeeApprovalIndex
    )
    const otherPaymentIndex = payNowSource.indexOf(
      "void runOrderPayment(serviceCtx)",
      sparkPaymentIndex
    )

    expect(payNowIndex).toBeGreaterThan(-1)
    expect(payNowEnd).toBeGreaterThan(payNowIndex)
    expect(authorizationIndex).toBeGreaterThan(availabilityIndex)
    expect(orderPublishIndex).toBeGreaterThan(authorizationIndex)
    expect(lifecycleIndex).toBeGreaterThan(orderPublishIndex)
    expect(sparkFeeApprovalIndex).toBeGreaterThan(lifecycleIndex)
    expect(sparkPaymentIndex).toBeGreaterThan(sparkFeeApprovalIndex)
    expect(otherPaymentIndex).toBeGreaterThan(sparkPaymentIndex)
    expect(checkoutRoute).not.toContain("prepareAnonZapCheckout")
    expect(checkoutRoute).not.toContain("pendingAnonAuthorization")
    expect(checkoutRoute).toContain("buildCheckoutOrderRumor({")
    expect(checkoutRoute).toContain("pricing: checkoutPricing")
    expect(checkoutOrder).toContain("for (const item of input.pricing.items)")
    expect(checkoutRoute).toContain(
      "items: buildLifecycleItems(checkoutPricing.items)"
    )
  })

  it("preflights and snapshots the authenticated signer before checkout work", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const payNowIndex = checkoutRoute.indexOf("async function payNow(")
    const payNowPreflightIndex = checkoutRoute.indexOf(
      "getCheckoutBuyerIdentity()",
      payNowIndex
    )
    const payNowInFlightIndex = checkoutRoute.indexOf(
      "paymentInFlightRef.current = true",
      payNowIndex
    )
    const placeOrderIndex = checkoutRoute.indexOf(
      "async function placeOrder(): Promise<void>"
    )
    const placeOrderPreflightIndex = checkoutRoute.indexOf(
      "getCheckoutBuyerIdentity()",
      placeOrderIndex
    )
    const placeOrderInFlightIndex = checkoutRoute.indexOf(
      "paymentInFlightRef.current = true",
      placeOrderIndex
    )

    expect(checkoutRoute).toContain(
      "const { pubkey, signer, capabilities, status: authStatus } = useAuth()"
    )
    expect(payNowIndex).toBeGreaterThan(-1)
    expect(payNowPreflightIndex).toBeGreaterThan(payNowIndex)
    expect(payNowPreflightIndex).toBeLessThan(payNowInFlightIndex)
    expect(placeOrderPreflightIndex).toBeGreaterThan(placeOrderIndex)
    expect(placeOrderPreflightIndex).toBeLessThan(placeOrderInFlightIndex)
    expect(checkoutRoute).toContain(
      'kind: "signed_in", pubkey: signedBuyerPubkey, signer'
    )
  })

  it("offers guest shoppers a signer path when invoice checkout is unavailable", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()

    expect(checkoutRoute).toContain("!guestManualInvoiceEligible && (")
    expect(checkoutRoute).toContain("Connect signer to send order")
    expect(checkoutRoute).toContain("Send order and show invoice")
    expect(checkoutRoute).toContain(
      "walletPayCapable: !isGuestCheckout && canAttemptLightningPayment"
    )
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
    expect(ordersRoute).toContain("disabled={!activeBuyerPubkey}")
  })
})
