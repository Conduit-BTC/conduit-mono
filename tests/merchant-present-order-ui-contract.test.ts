import { describe, expect, it } from "bun:test"

describe("merchant-present buyer Orders UI contract", () => {
  it("keeps signed-in and guest confirmation reads exact-order scoped", async () => {
    const [orders, authorization] = await Promise.all([
      Bun.file("apps/market/src/routes/orders.tsx").text(),
      Bun.file(
        "apps/market/src/lib/merchant-present-order-authorization.ts"
      ).text(),
    ])

    expect(orders).toContain("resolveMerchantPresentOrderContext({")
    expect(orders).toContain("messages: conversationMessages")
    expect(authorization).toContain('message.type === "order"')
    expect(authorization).toContain(
      'message.type === "merchant_present_sale_authorization"'
    )
    expect(authorization).toContain(
      "validateMerchantPresentSaleAuthorization({"
    )
    expect(orders).toContain("receiveMerchantPresentSaleDirectAuthorization({")
    expect(orders).toContain("event,")
    expect(orders).not.toContain("createMerchantPresentSaleDirectDecrypt")
    expect(orders).not.toContain("guestIdentity.signer.decrypt")
    expect(orders).not.toContain("fetchGuestMerchantPresentAuthorization")
  })

  it("reserves the one-time capability immediately before every payment path", async () => {
    const orders = await Bun.file("apps/market/src/routes/orders.tsx").text()
    const retryStart = orders.indexOf("async function retryPayment()")
    const fallbackStart = orders.indexOf(
      "async function continuePrivateFallback()"
    )
    const invoiceStart = orders.indexOf(
      "const manualInvoiceAccess = deriveManualInvoiceAccess("
    )
    const retry = orders.slice(retryStart, fallbackStart)
    const fallback = orders.slice(fallbackStart, invoiceStart)

    expect(
      retry.match(/await reserveMerchantPresentPayment\(\)/g)
    ).toHaveLength(2)
    expect(retry.indexOf("await reserveMerchantPresentPayment() ")).toBe(-1)
    expect(
      retry.indexOf("await reserveMerchantPresentPayment()")
    ).toBeGreaterThan(retry.indexOf("verifyPickupCartFreshness("))
    expect(
      retry.lastIndexOf("await reserveMerchantPresentPayment()")
    ).toBeLessThan(retry.lastIndexOf("await run({"))
    expect(
      fallback.indexOf("await reserveMerchantPresentPayment()")
    ).toBeGreaterThan(fallback.indexOf("verifyPickupCartFreshness("))
    expect(
      fallback.indexOf("await reserveMerchantPresentPayment()")
    ).toBeLessThan(fallback.indexOf("await runOrderPrivateFallback(ctx)"))
  })

  it("rechecks the signed merchant payment destination before consuming booth confirmation", async () => {
    const orders = await Bun.file("apps/market/src/routes/orders.tsx").text()
    const reserveStart = orders.indexOf(
      "async function reserveMerchantPresentPayment()"
    )
    const importStart = orders.indexOf(
      "async function importDirectMerchantPresentAuthorization()"
    )
    const reserve = orders.slice(reserveStart, importStart)

    expect(reserve).toContain("getProfiles({")
    expect(reserve).toContain('evidenceScope: "payment"')
    expect(reserve).toContain("requireCompleteEvidence: true")
    expect(reserve).toContain("assertMerchantPresentSalePaymentReview({")
    expect(reserve.indexOf("getProfiles({")).toBeLessThan(
      reserve.indexOf("consumeReadyMerchantPresentAuthorization(")
    )
  })

  it("does not expose an invoice until booth confirmation is reserved", async () => {
    const orders = await Bun.file("apps/market/src/routes/orders.tsx").text()

    expect(orders).toContain(
      '(merchantPresentAuthorizationState.status === "remote" ||\n          merchantPresentPaymentActive)'
    )
    expect(orders).toContain("Confirm items and show payment")
    expect(orders).toContain("Payment remains locked")
    expect(orders).toContain("Waiting for merchant confirmation")
    expect(orders).toContain("Merchant confirmation needs renewal")
    expect(orders).toContain("Ready to pay")
    expect(orders).not.toContain("Availability may still change")
  })

  it("persists only opaque use references under an exclusive browser lock", async () => {
    const authorization = await Bun.file(
      "apps/market/src/lib/merchant-present-order-authorization.ts"
    ).text()

    expect(authorization).toContain("USE_LOCK_NAME")
    expect(authorization).toContain(
      'locks.request(USE_LOCK_NAME, { mode: "exclusive" }'
    )
    expect(authorization).toContain("registry[use.useRef] = use.expiresAt")
    expect(authorization).toContain(
      "There is deliberately no non-atomic fallback"
    )
  })
})
