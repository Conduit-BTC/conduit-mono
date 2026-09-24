import { describe, expect, it } from "bun:test"

describe("merchant invoice route contract", () => {
  it("retains bound-invoice reporting and order-status guards", async () => {
    const source = await Bun.file("apps/market/src/routes/orders.tsx").text()
    const panel = await Bun.file(
      "apps/market/src/components/ExternalWalletPanel.tsx"
    ).text()
    const prepareGate = panel.indexOf("if (requiresPreparation)")
    const invoiceControls = panel.indexOf("<InvoicePayment")

    expect(source).toContain("prepareMerchantInvoicePaymentAction")
    expect(source).toContain("runOrderPaymentWithRenewedInvoice")
    expect(source).not.toContain("releaseExpiredOrderInvoiceForRetry")
    expect(source).toContain("onRenewExpiredInvoice")
    expect(source).toContain("pricing={shopperPricing}")
    expect(source).not.toContain("function ExternalWalletPanel")
    expect(prepareGate).toBeGreaterThan(-1)
    expect(invoiceControls).toBeGreaterThan(prepareGate)
    expect(panel).toContain("onBeforeInvoiceUse={canUseInvoice}")
    expect(panel).toContain("return onBeforeInvoiceUse()")
    expect(source).toContain("Do not pay this invoice.")
    expect(source).toContain('manualInvoiceAccess !== "closed"')
    expect(source).toContain('manualInvoiceAccess !== "report_only"')
    expect(source).toContain('manualInvoiceAccess !== "receipt_only"')
    expect(source).toContain(
      'action?.status === "blocked" && action.canReport ? action : undefined'
    )
    expect(source).toContain("const merchantInvoiceReopenEvidence =")
    expect(source).toContain("reopenEvidence: merchantInvoiceReopenEvidence")
    expect(source).toContain(
      "action,\n      merchantInvoiceReopenEvidence\n    )"
    )
    expect(source).not.toContain("allowCancelled")
    expect(source).not.toContain("vm.merchantInvoiceAction ?? undefined")
  })

  it("renews only the current manual invoice with a live account and view", async () => {
    const source = await Bun.file("apps/market/src/routes/orders.tsx").text()
    const renewal = source.slice(
      source.indexOf("async function renewExpiredInvoice()"),
      source.indexOf("async function runRetryPayment(")
    )

    expect(source).toContain("const expectedInvoice = vm.invoice")
    expect(source).toContain("currentViewRef.current.invoice?.toLowerCase()")
    expect(source).toContain("lifecycle.updatedAt")
    expect(source).toContain("shouldContinue: shouldContinueBuyerSession")
    expect(source).toContain("shouldContinueBeforePaymentClaim")
    expect(source).toContain(
      'currentViewRef.current = { ...currentViewRef.current, orderId: "" }'
    )
    expect(source).toContain('current.phase !== "cancelled"')
    expect(source).toContain(
      "isGeneralPaymentRetryEligible(currentViewRef.current)"
    )
    expect(source).toContain('lifecycle.paymentTarget?.type !== "manual"')
    expect(source).toContain('retryTarget?.type !== "manual"')
    expect(renewal).toContain("const ctx = buildServiceCtx()")
    expect(renewal).not.toContain("persistTargetAndBuildServiceCtx")
    expect(renewal).not.toContain("replaceOrderPaymentTarget")
    expect(source).toContain('ctx.zapMode === "private_checkout"')
    expect(source).toContain(
      'row.lifecycle?.checkoutMode === "external_wallet"'
    )
    expect(source).toContain("row.lifecycle.publicZapSigner === undefined")
  })

  it("offers prior-invoice reporting only for unpaid, unconfirmed recovery", async () => {
    const source = await Bun.file("apps/market/src/routes/orders.tsx").text()
    const report = source.slice(
      source.indexOf("async function reportPriorExpiredInvoice()"),
      source.indexOf("const merchantInvoicePrepared")
    )

    expect(report).toContain("shouldContinueBuyerSession")
    expect(report).not.toContain('manualInvoiceAccess === "closed"')
    expect(report).toContain("currentViewRef.current.invoice === undefined")
    expect(report).toContain('lifecycle.paymentStatus === "manual_required"')
    expect(source).toMatch(
      /Do not pay the new invoice if your wallet already paid an earlier(?:\s|<[^>]+>)+one\./
    )
    expect(report).not.toContain('lifecycle.phase !== "cancelled"')
    expect(
      source.slice(
        source.indexOf("async function renewExpiredInvoice()"),
        source.indexOf("async function runRetryPayment(")
      )
    ).toContain("assertGeneralPaymentRetryEligible()")
    expect(source).toContain("showPriorExpiredInvoiceReport")
    expect(source).toContain('title="Payment report not sent"')
    expect(source).toContain('vm.merchantStatus === "refund_requested"')
    expect(source).toContain("isBuyerOrderPaid(vm)")
  })

  it("gates general retries on current merchant payment eligibility", async () => {
    const source = await Bun.file("apps/market/src/routes/orders.tsx").text()
    const retry = source.slice(
      source.indexOf("async function retryPayment()"),
      source.indexOf("async function renewExpiredInvoice()")
    )

    expect(retry).toContain("assertGeneralPaymentRetryEligible()")
    expect(source).toContain("const generalPaymentRetryEligible =")
    expect(source).toContain('current.merchantStatus !== "refund_requested"')
    expect(source).toContain('current.merchantStatus !== "cancelled"')
    expect(source).toContain("isBuyerOrderPaid(current)")
    expect(source).toContain('current.phase !== "cancelled"')
    expect(source).toContain('current.phase !== "completed"')
    expect(source).toContain("async function reportPriorExpiredInvoice()")
    expect(source).toContain("shouldContinueBeforePaymentClaim: () =>")
    expect(source).toContain("async function confirmPaymentAddressUpdate()")
    expect(source).toContain("async function continuePrivateFallback()")
  })

  it("rechecks retry eligibility immediately before persisting the selected target", async () => {
    const source = await Bun.file("apps/market/src/routes/orders.tsx").text()
    const persist = source.slice(
      source.indexOf("async function persistTargetAndBuildServiceCtx()"),
      source.indexOf("const withBusy")
    )
    const retry = source.slice(
      source.indexOf("async function retryPayment()"),
      source.indexOf("async function renewExpiredInvoice()")
    )

    expect(
      persist.indexOf("assertGeneralPaymentRetryEligible()")
    ).toBeGreaterThan(-1)
    expect(persist.indexOf("assertGeneralPaymentRetryEligible()")).toBeLessThan(
      persist.indexOf("replaceOrderPaymentTarget(")
    )
    expect(retry).toContain("await verifyRetryFreshness()")
    expect(retry).toContain("assertGeneralPaymentRetryEligible()")
    expect(source).toContain("shouldContinuePaymentAuthority: () =>")
    expect(source).toContain("viewMountedRef.current &&")
    expect(persist).toContain("shouldContinueAccountRead()")
    expect(persist).toContain(
      "isGeneralPaymentRetryEligible(currentViewRef.current)"
    )
  })

  it("keeps the profile destination default and wallet sources explicit", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("createDefaultMerchantInvoiceModule")
    expect(source).toContain(
      'useState<MerchantInvoiceActionSource>("profile_lud16")'
    )
    expect(source).toMatch(/<SelectItem\s+value="profile_lud16"/)
    expect(source).toMatch(/<SelectItem\s+value="webln"/)
    expect(source).toMatch(/<SelectItem\s+value="nwc"/)
    expect(source).toMatch(/<SelectItem\s+value="manual"/)
    expect(source).not.toContain("else if (weblnAvailable)")
  })

  it("keeps saved-invoice retry local and manual paste available", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("merchantInvoiceModule.getStatus")
    expect(source).toContain("merchantInvoiceModule.retryDelivery")
    expect(source).toContain("Retry saved invoice")
    expect(source).toContain("Resend same invoice")
    expect(source).toContain("BOLT11 (paste manually)")
    expect(source).toContain("throw safeInvoiceActionError(source)")
    expect(source).not.toContain("Invoice history is incomplete")
  })

  it("keeps private order identity out of the invoice query cache key", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain(
      'queryKey: ["merchant-pending-invoice", pendingInvoiceQueryToken]'
    )
    expect(source).not.toMatch(
      /queryKey:\s*\[\s*"merchant-pending-invoice",\s*pubkey/
    )
  })

  it("guards every merchant payment confirmation before publishing", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain('if (action.action === "confirm_payment")')
    expect(source).toContain("captureMerchantPaymentConfirmationTarget")
    expect(source).toContain("resolveMerchantPaymentConfirmationSelection")
    expect(source).toContain("open={paymentConfirmationSelection !== null}")
    expect(source).toContain("checking your wallet")
    expect(source).toContain("notifies the buyer")
    expect(source).toContain("confirmMerchantPayment")
    expect(source).toContain('id="release-with-payment"')
    expect(source).toContain("Confirm payment and authorize pickup")
    expect(source).toContain("Do not request another payment")
    expect(source).toContain(': "Payment confirmed."')
    expect(source).not.toContain(
      "Payment confirmed. Prepare the order before authorizing pickup."
    )
    expect(source).not.toMatch(
      /action\.action === "confirm_payment"\s*&&\s*canRequestPaymentOutOfBand/
    )
  })
})
