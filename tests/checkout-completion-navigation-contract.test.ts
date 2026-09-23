import { describe, expect, it } from "bun:test"

describe("checkout completion navigation contracts", () => {
  it("routes completed checkout flows to Orders instead of stale cart state", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    // CND-122: completed checkout flows navigate to the selected durable order.
    // Payment checkout asks Orders to put the payment action first.
    const ordersNavigations =
      checkoutRoute.match(
        /navigate\(\{\s*to: "\/orders",\s*search: \{ order: orderId(?:, focus: "payment")? \},\s*replace: true,?\s*\}\)/g
      ) ?? []

    expect(checkoutRoute).toContain("const navigate = useNavigate()")
    expect(ordersNavigations.length).toBeGreaterThanOrEqual(2)
    expect(checkoutRoute).toContain(
      'search: { order: orderId, focus: "payment" }'
    )
    expect(checkoutRoute).toContain("publishBuyerOrderMessage(")
    expect(checkoutRoute).toContain("orderLifecycle,")
    expect(checkoutRoute).toContain("resolveCheckoutOrderAttempt(orderId)")
  })

  it("does not offer cart as a terminal paid-checkout action", async () => {
    const paymentTracker = await Bun.file(
      "apps/market/src/components/PaymentTracker.tsx"
    ).text()

    expect(paymentTracker).toContain('<Link to="/orders">View orders</Link>')
    expect(paymentTracker).not.toContain('<Link to="/cart">Back to cart</Link>')
  })

  it("opens payment checkout on a focused Orders surface", async () => {
    const ordersRoute = await Bun.file(
      "apps/market/src/routes/orders.tsx"
    ).text()

    expect(ordersRoute).toContain('focus?: "payment"')
    expect(ordersRoute).toContain(
      'const paymentFocused = focus === "payment" && !!selectedFromUrl'
    )
    expect(ordersRoute).toContain('"mx-auto max-w-3xl"')
    expect(ordersRoute).toContain("paymentFocused={paymentFocused}")
    expect(ordersRoute).toContain("View full order details")
  })

  it("does not fall back from a missing focused order while reads are pending or unavailable", async () => {
    const ordersRoute = await Bun.file(
      "apps/market/src/routes/orders.tsx"
    ).text()

    expect(ordersRoute).toContain("if (paymentFocused && selectedFromUrl) {")
    expect(ordersRoute).toContain(
      "return orders.some((order) => order.orderId === selectedFromUrl)"
    )
    expect(ordersRoute).toMatch(
      /lifecyclesQuery\.isPending\s*\|\|\s*\(signerConnected\s*&&\s*\(messagesQuery\.isPending\s*\|\|\s*protectedOrdersReadState === "pending"\)\)/
    )
    expect(ordersRoute).toContain('{selected ? "Complete payment" : "Orders"}')
    expect(ordersRoute).toContain('title="Order unavailable"')
    expect(ordersRoute).toContain('<Link to="/orders">View all orders</Link>')
    expect(ordersRoute).toContain('"Guest order not found"')
    expect(ordersRoute).toContain('"Guest order session not found"')
    expect(ordersRoute).toContain(
      "(!paymentFocused || selected.orderId === selectedFromUrl)"
    )
    expect(ordersRoute).toMatch(
      /!lifecyclesQuery\.isPending\s*&&\s*!hasOrders\s*&&\s*\(!signerConnected\s*\|\|\s*\(!paymentFocused\s*&&\s*protectedOrdersReadState\s*===\s*"complete"\)\)/
    )
  })

  it("scopes relay authentication to both foreground signed order sends", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const relayAuthForOrder =
      checkoutRoute.match(
        /authMethod \? \{ relayAuthMethod: authMethod \} : \{\}/g
      ) ?? []

    expect(checkoutRoute).toContain("method: authMethod")
    expect(relayAuthForOrder).toHaveLength(2)
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
      'await assertCheckoutItemsAvailable(\n        "order_first",\n        freshPricingRate\n      )'
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
    const paymentAvailability = payNowSource.search(
      /await assertCheckoutItemsAvailable\(\s*requestedCheckoutMode,\s*freshPricingRate\s*\)/
    )
    const signedOrderReady = payNowSource.indexOf(
      "orderRumor.content = JSON.stringify(orderPayload)"
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
        /await assertCheckoutItemsAvailable\(\s*requestedCheckoutMode,\s*freshPricingRate\s*\)/g
      )
    ).toHaveLength(1)
    expect(signedOrderReady).toBeGreaterThan(paymentAvailability)
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
      "await authorizeCurrentCheckoutItems({"
    )
    const availabilitySuccess = assertionSource.lastIndexOf('status: "success"')
    expect(termsCheck).toBeGreaterThan(-1)
    expect(assertionSource).toMatch(
      /mode:\s*checkoutMode === "order_first"\s*\? "order_first"\s*:\s*"direct_payment"/
    )
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
    expect(readinessHook).toContain(
      "decision: getCartAvailabilityReadDecision({"
    )
    expect(checkoutRoute).toContain("selectedMerchantReadiness?.readDecision")
    expect(checkoutRoute).toContain(
      'if (refreshResult.decision.status === "unverified")'
    )
    expect(checkoutRoute).not.toContain("<CheckoutAvailabilityNotice")
    expect(checkoutRoute).not.toContain("Availability may still change")
  })

  it("keeps every payment rail behind final availability and durable order delivery", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const payNowIndex = checkoutRoute.indexOf("async function payNow(")
    const payNowEnd = checkoutRoute.indexOf(
      "// --- Full-screen transition states",
      payNowIndex
    )
    const payNowSource = checkoutRoute.slice(payNowIndex, payNowEnd)
    const availabilityIndex = payNowSource.search(
      /await assertCheckoutItemsAvailable\(\s*requestedCheckoutMode,\s*freshPricingRate\s*\)/
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
      "orderDelivered = true",
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
    expect(checkoutRoute).toContain("for (const item of checkoutPricing.items)")
    expect(checkoutRoute).toContain(
      "items: buildLifecycleItems(checkoutPricing.items)"
    )
  })

  it("uses durable first-ACK completion without the former checkout delay floor", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const orderPublish = await Bun.file(
      "apps/market/src/lib/order-publish.ts"
    ).text()

    expect(checkoutRoute).not.toContain(
      "new Promise((resolve) => window.setTimeout(resolve, 900))"
    )
    expect(orderPublish).toContain('recipientDeliveryBoundary: "accepted"')
    expect(orderPublish).toContain("onRecipientPublishAccepted:")
    expect(orderPublish).toContain("ackOnly: true, releaseLease: false")
    expect(orderPublish).toContain("ackOnly: false,")
    expect(orderPublish).toContain("releaseLease: true")
    expect(orderPublish).toContain("pending.has(relayUrl)")
    expect(checkoutRoute).toContain("delivery.startPostAcceptanceWork ?? null")
    expect(checkoutRoute).toContain(".finally(() => {")
    expect(checkoutRoute).toContain("isAuthGenerationCurrent(authGeneration)")
    expect(checkoutRoute).toContain(
      "resolveCheckoutOrderAttemptAfterPaymentProgress(orderId)"
    )
    expect(checkoutRoute).toContain("hasCheckoutPaymentProgress(current)")
    expect(checkoutRoute).toContain("beforeBackgroundProofDelivery:")
    expect(checkoutRoute).not.toContain(
      ".then(() => resolveCheckoutOrderAttempt(orderId))"
    )
  })

  it("keeps Orders receipt observation behind active checkout payment work", async () => {
    const ordersRoute = await Bun.file(
      "apps/market/src/routes/orders.tsx"
    ).text()
    const observerLoop = ordersRoute.slice(
      ordersRoute.indexOf("const resumeReceiptObservers = () =>"),
      ordersRoute.indexOf("resumeReceiptObservers()")
    )
    const runningGuard = observerLoop.indexOf(
      "isOrderPaymentRunning(lifecycle.orderId)"
    )
    const observerStart = observerLoop.indexOf("observeOrderPublicZapReceipt(")

    expect(runningGuard).toBeGreaterThan(-1)
    expect(observerStart).toBeGreaterThan(runningGuard)
  })

  it("preserves exact-order recovery on ambiguous reads and resumes direct payment without republishing", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const ordersRoute = await Bun.file(
      "apps/market/src/routes/orders.tsx"
    ).text()
    const recovery = await Bun.file(
      "apps/market/src/lib/checkout-order-attempt.ts"
    ).text()

    expect(checkoutRoute.match(/stagedOrderReadFailed = true/g)).toHaveLength(2)
    expect(
      checkoutRoute.match(/shouldPreserveCheckoutOrderAttempt\(e\)/g)
    ).toHaveLength(2)
    expect(checkoutRoute).toContain("!preserveExactOrderAttempt &&")
    expect(checkoutRoute).toContain(
      "The staged order remains fenced for exact recovery; do not create another order."
    )
    expect(ordersRoute).toContain("const showContinueAcceptedCheckout =")
    expect(ordersRoute).toContain(
      "requiresAcceptedOrderPaymentContinuation(row.lifecycle)"
    )
    expect(recovery).toContain('input.paymentStatus === "not_started"')
    expect(recovery).toContain('input.invoiceStatus === "not_requested"')
    expect(ordersRoute).toContain("await retryPayment()")
    expect(ordersRoute).toContain("await finishAcceptedOrderRecovery(current)")
    expect(ordersRoute).toContain("continuing will not send")
  })

  it("retains direct-payment recovery after exact delivery retry", async () => {
    const ordersRoute = await Bun.file(
      "apps/market/src/routes/orders.tsx"
    ).text()
    const delivery = await Bun.file(
      "packages/core/src/protocol/order-relay-delivery.ts"
    ).text()
    const retryStart = ordersRoute.indexOf(
      "async function retryStagedOrderDelivery(): Promise<void>"
    )
    const paymentStart = ordersRoute.indexOf(
      "async function continueAcceptedCheckoutPayment(): Promise<void>",
      retryStart
    )
    const retry = ordersRoute.slice(retryStart, paymentStart)
    const continuePayment = ordersRoute.slice(
      paymentStart,
      ordersRoute.indexOf(
        "async function confirmPaymentAddressUpdate()",
        paymentStart
      )
    )

    expect(delivery).toContain(
      "checkoutRecoveryPending: current.checkoutRecoveryPending"
    )
    expect(retry).toContain(
      "if (requiresAcceptedOrderPaymentContinuation(retried)) return"
    )
    expect(retry).toContain("await finishAcceptedOrderRecovery(retried)")
    expect(continuePayment).toContain("await retryPayment()")
    expect(continuePayment).not.toContain("publishBuyerOrderMessage(")
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

    expect(checkoutRoute).toContain("restorePendingPubkey,")
    expect(checkoutRoute).toContain("signer,")
    expect(checkoutRoute).toContain("status: authStatus,")
    expect(payNowIndex).toBeGreaterThan(-1)
    expect(payNowPreflightIndex).toBeGreaterThan(payNowIndex)
    expect(payNowPreflightIndex).toBeLessThan(payNowInFlightIndex)
    expect(placeOrderPreflightIndex).toBeGreaterThan(placeOrderIndex)
    expect(placeOrderPreflightIndex).toBeLessThan(placeOrderInFlightIndex)
    expect(checkoutRoute).toContain(
      'kind: "signed_in", pubkey: signedBuyerPubkey, signer'
    )
  })

  it("does not classify an interactively connecting signer as a guest checkout", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()

    expect(checkoutRoute).toContain(
      'authSignerReadiness === "pending" || restorePendingPubkey !== null'
    )
    expect(checkoutRoute).toContain(
      '!authPending && !accountPubkey && authSignerReadiness === "disconnected"'
    )
  })

  it("offers guest shoppers a signer path when invoice checkout is unavailable", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()

    expect(checkoutRoute).toContain("{isGuestCheckout &&")
    expect(checkoutRoute).toContain("!fastEligible &&")
    expect(checkoutRoute).toContain("verifiedZeroCostPickup ? (")
    expect(checkoutRoute).toContain("onClick={placeOrder}")
    expect(checkoutRoute).toContain('"Send order"')
    expect(checkoutRoute).toContain("!manualInvoiceEligible")
    expect(checkoutRoute).toContain("Connect signer to send order")
    expect(checkoutRoute).toContain("manualInvoiceEligible &&")
    expect(checkoutRoute).toContain(
      "walletPayCapable: !isGuestCheckout && canAttemptLightningPayment"
    )
    expect(checkoutRoute).toContain("<SignerSwitch")
  })

  it("keeps guest checkout on one concise review and contact screen", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()

    const summary = checkoutRoute.indexOf("<OrderSummary")
    const details = checkoutRoute.indexOf("<section", summary)

    expect(summary).toBeGreaterThan(-1)
    expect(details).toBeGreaterThan(summary)
    expect(checkoutRoute).toContain("validateCheckoutDetailsForSubmit()")
    expect(checkoutRoute).toContain("Phone and email are required")
    expect(checkoutRoute).not.toContain("Pickup recovery")
    expect(checkoutRoute).not.toContain("Merchant-only recovery")
    expect(checkoutRoute).not.toContain("Continue to Send Order")
    expect(checkoutRoute).not.toContain("Keep this tab open")
  })
})
