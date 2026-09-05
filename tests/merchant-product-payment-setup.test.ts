import { describe, expect, it } from "bun:test"
import { getProductPaymentSetupState } from "../apps/merchant/src/lib/product-payment-setup"

describe("merchant product payment setup guidance", () => {
  it("waits for decentralized profile lookup before warning", () => {
    expect(
      getProductPaymentSetupState({ lookupSettled: false, lud16: undefined })
    ).toBe("checking")
  })

  it("does not infer missing setup from a failed profile read", () => {
    expect(
      getProductPaymentSetupState({
        lookupSettled: true,
        lud16: undefined,
        error: new Error("relay unavailable"),
      })
    ).toBe("unavailable")
  })

  it("warns after a settled lookup has no valid Lightning Address", () => {
    expect(
      getProductPaymentSetupState({ lookupSettled: true, lud16: undefined })
    ).toBe("missing")
    expect(
      getProductPaymentSetupState({ lookupSettled: true, lud16: "invalid" })
    ).toBe("missing")
  })

  it("accepts a valid profile Lightning Address", () => {
    expect(
      getProductPaymentSetupState({
        lookupSettled: true,
        lud16: "merchant@example.com",
      })
    ).toBe("ready")
  })

  it("shows the same non-blocking guidance in store and event authoring", async () => {
    const notice = await Bun.file(
      "apps/merchant/src/components/ProductPaymentSetupNotice.tsx"
    ).text()
    const products = await Bun.file(
      "apps/merchant/src/routes/products.tsx"
    ).text()
    const eventPublisher = await Bun.file(
      "apps/merchant/src/components/EventProductPublisherDialog.tsx"
    ).text()

    expect(products).toContain("<ProductPaymentSetupNotice")
    expect(eventPublisher).toContain("<ProductPaymentSetupNotice")
    expect(notice).toContain(
      "You can still publish and arrange payment manually"
    )
    expect(notice).toContain('<Link to="/payments">Set up payments</Link>')
    expect(notice).not.toContain("disabled")
  })
})
