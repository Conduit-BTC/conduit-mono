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
    expect(checkoutRoute).toContain("const orderLifecycle:")
    expect(checkoutRoute).toContain("orderLifecycle,")
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
    const orderAvailability = placeOrderSource.search(
      /await assertCheckoutItemsAvailable\(\s*"order_first",\s*freshPricingRate,\s*refreshedAvailability\s*\)/
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
      /await assertCheckoutItemsAvailable\(\s*requestedCheckoutMode,\s*freshPricingRate,\s*refreshedAvailability\s*\)/
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
        /await assertCheckoutItemsAvailable\(\s*requestedCheckoutMode,\s*freshPricingRate,\s*refreshedAvailability\s*\)/g
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
    const payNowIndex = checkoutRoute.indexOf("async function payNow(")
    const payNowEnd = checkoutRoute.indexOf(
      "// --- Full-screen transition states",
      payNowIndex
    )
    const payNowSource = checkoutRoute.slice(payNowIndex, payNowEnd)
    const availabilityIndex = payNowSource.search(
      /await assertCheckoutItemsAvailable\(\s*requestedCheckoutMode,\s*freshPricingRate,\s*refreshedAvailability\s*\)/
    )
    const authorizationIndex = payNowSource.indexOf(
      "assertClaimedZapAuthorization(",
      availabilityIndex
    )
    const orderPublishIndex = payNowSource.indexOf(
      "await publishBuyerOrderMessage(",
      authorizationIndex
    )
    const lifecycleIndex = payNowSource.indexOf("const orderLifecycle:")
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
    expect(lifecycleIndex).toBeGreaterThan(authorizationIndex)
    expect(lifecycleIndex).toBeLessThan(orderPublishIndex)
    expect(payNowSource).toContain("orderLifecycle,")
    expect(sparkFeeApprovalIndex).toBeGreaterThan(orderPublishIndex)
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

  it("overlaps independent submit reads without weakening final authorization", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const messaging = await Bun.file(
      "packages/core/src/protocol/messaging.ts"
    ).text()
    const placeOrder = checkoutRoute.slice(
      checkoutRoute.indexOf("async function placeOrder(): Promise<void>"),
      checkoutRoute.indexOf("// ─── Fast zap path")
    )
    const payNow = checkoutRoute.slice(
      checkoutRoute.indexOf("async function payNow("),
      checkoutRoute.indexOf("// --- Full-screen transition states")
    )
    const placeOrderWarm = placeOrder.indexOf(
      "startOrderRouteEvidenceWarm(selectedMerchant)"
    )
    const placeOrderParallelReads = placeOrder.indexOf("await Promise.all([")
    const payNowWarm = payNow.indexOf(
      "startOrderRouteEvidenceWarm(selectedMerchant)"
    )
    const payNowParallelReads = payNow.indexOf("await Promise.all([")
    const placeOrderCancel = placeOrder.indexOf(
      "await cancelOrderRouteEvidenceWarms()"
    )
    const placeOrderDeliveryTiming = placeOrder.indexOf(
      "orderDeliveryStartedAt = performance.now()"
    )
    const placeOrderPublish = placeOrder.indexOf(
      "await publishBuyerOrderMessage("
    )
    const payNowCancel = payNow.indexOf("await cancelOrderRouteEvidenceWarms()")
    const payNowDeliveryTiming = payNow.indexOf(
      "orderDeliveryStartedAt = performance.now()"
    )
    const payNowPublish = payNow.indexOf("await publishBuyerOrderMessage(")

    expect(placeOrder).toContain(
      "const [freshPricingRate, refreshedAvailability] = await Promise.all(["
    )
    expect(placeOrder).toContain("checkoutAvailability.refresh(),")
    expect(payNow).toContain(
      "getFreshMerchantPaymentEvidence(selectedMerchant)"
    )
    expect(payNow).toContain("getFreshPricingRateInput(checkoutItems)")
    expect(payNow).toContain("checkoutAvailability.refresh(),")
    expect(placeOrderWarm).toBeGreaterThan(-1)
    expect(placeOrderWarm).toBeLessThan(placeOrderParallelReads)
    expect(payNowWarm).toBeGreaterThan(-1)
    expect(payNowWarm).toBeLessThan(payNowParallelReads)
    expect(placeOrder).not.toContain(
      "await startOrderRouteEvidenceWarm(selectedMerchant)"
    )
    expect(payNow).not.toContain(
      "await startOrderRouteEvidenceWarm(selectedMerchant)"
    )
    expect(placeOrderDeliveryTiming).toBeLessThan(placeOrderCancel)
    expect(placeOrderCancel).toBeGreaterThan(placeOrderParallelReads)
    expect(placeOrderCancel).toBeLessThan(placeOrderPublish)
    expect(payNowDeliveryTiming).toBeLessThan(payNowCancel)
    expect(payNowCancel).toBeGreaterThan(payNowParallelReads)
    expect(payNowCancel).toBeLessThan(payNowPublish)
    expect(checkoutRoute).toContain(
      "if (!config.checkoutOrderRoutePrefetchEnabled) return"
    )
    expect(checkoutRoute).toContain(
      "await cancelMerchantOrderRoutePreflights(queryClient)"
    )
    expect(checkoutRoute).toContain(
      "preparedRefreshResult ?? (await checkoutAvailability.refresh())"
    )
    expect(checkoutRoute).toContain("bounded: false")
    expect(checkoutRoute).toContain("staleTime: 0")
    expect(messaging).toContain(
      "const resolvedRecipientDeclaration = await resolveDeclarationForSend("
    )
  })

  it("preserves exact-order recovery on ambiguous reads and resumes direct payment without republishing", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const ordersRoute = await Bun.file(
      "apps/market/src/routes/orders.tsx"
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
      'row.lifecycle.paymentStatus === "not_started"'
    )
    expect(ordersRoute).toContain(
      'row.lifecycle.invoiceStatus === "not_requested"'
    )
    expect(ordersRoute).toContain("await retryPayment()")
    expect(ordersRoute).toContain("await finishAcceptedOrderRecovery(current)")
    expect(ordersRoute).toContain("continuing will not send")
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
      'const isGuestCheckout = !authPending && authSignerReadiness === "disconnected"'
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

    const invoicePanel = await Bun.file(
      "apps/market/src/components/ExternalWalletPanel.tsx"
    ).text()

    expect(checkoutRoute).toContain(
      "Keep this tab open until the payment is reported"
    )
    expect(invoicePanel).toContain("Closing it ends")
    expect(invoicePanel).toContain("local access to this guest order")
    expect(invoicePanel).toContain(
      "merchant can use the private recovery contact"
    )
    expect(ordersRoute).toContain("disabled={!activeBuyerPubkey}")
  })
})
