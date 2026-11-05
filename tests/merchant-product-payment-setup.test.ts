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

  it("does not infer missing setup from stale or partial profile evidence", () => {
    expect(
      getProductPaymentSetupState({
        lookupSettled: true,
        lud16: "cached@example.com",
        evidenceIncomplete: true,
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
})
