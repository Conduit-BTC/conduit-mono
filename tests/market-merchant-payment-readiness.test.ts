import { describe, expect, it } from "bun:test"
import { getMerchantPaymentReadiness } from "../apps/market/src/lib/merchant-payment-readiness"
import { getCheckoutEvidenceCheckingLabel } from "../apps/market/src/lib/checkout-validation"

describe("shopper merchant payment readiness", () => {
  it("does not infer missing setup while the profile is loading", () => {
    expect(
      getMerchantPaymentReadiness({
        paymentRequired: true,
        profileState: "loading",
        lud16: undefined,
        lnurlStatus: "no_address",
      })
    ).toBe("checking_profile")
  })

  it("distinguishes missing and unavailable merchant profiles", () => {
    expect(
      getMerchantPaymentReadiness({
        paymentRequired: true,
        profileState: "available",
        lud16: undefined,
        lnurlStatus: "no_address",
      })
    ).toBe("missing_address")
    expect(
      getMerchantPaymentReadiness({
        paymentRequired: true,
        profileState: "unavailable",
        lud16: undefined,
        lnurlStatus: "no_address",
      })
    ).toBe("profile_unavailable")
  })

  it("requires endpoint evidence after a Lightning Address is present", () => {
    const base = {
      paymentRequired: true,
      profileState: "available" as const,
      lud16: "merchant@example.com",
    }
    expect(
      getMerchantPaymentReadiness({ ...base, lnurlStatus: "pending" })
    ).toBe("checking_endpoint")
    expect(
      getMerchantPaymentReadiness({ ...base, lnurlStatus: "unavailable" })
    ).toBe("endpoint_unavailable")
    expect(getMerchantPaymentReadiness({ ...base, lnurlStatus: "ready" })).toBe(
      "ready"
    )
  })

  it("keeps free products independent of merchant payment setup", () => {
    expect(
      getMerchantPaymentReadiness({
        paymentRequired: false,
        profileState: "unavailable",
        lud16: undefined,
        lnurlStatus: "no_address",
      })
    ).toBe("not_required")
  })
})

describe("checkout evidence labels", () => {
  it("names the exact pending evidence instead of generic fulfillment", () => {
    expect(
      getCheckoutEvidenceCheckingLabel({
        availabilityChecking: true,
        eventPickupChecking: false,
        organizerInboxChecking: false,
      })
    ).toBe("Checking product availability")
    expect(
      getCheckoutEvidenceCheckingLabel({
        availabilityChecking: false,
        eventPickupChecking: true,
        organizerInboxChecking: false,
      })
    ).toBe("Checking signed event pickup")
    expect(
      getCheckoutEvidenceCheckingLabel({
        availabilityChecking: false,
        eventPickupChecking: false,
        organizerInboxChecking: true,
      })
    ).toBe("Checking organizer pickup inbox")
  })
})
