import { describe, expect, it } from "bun:test"
import { getMerchantProfileState } from "../apps/merchant/src/lib/event-market-participation-identity"

describe("merchant event participation identity", () => {
  it("prefers resolved profile content over lookup diagnostics", () => {
    expect(
      getMerchantProfileState({
        hasProfile: true,
        lookupSettled: false,
        error: new Error("relay unavailable"),
      })
    ).toBe("available")
  })

  it("keeps an unresolved lookup visibly loading", () => {
    expect(
      getMerchantProfileState({
        hasProfile: false,
        lookupSettled: false,
        error: null,
      })
    ).toBe("loading")
  })

  it("distinguishes a missing public profile from an unavailable lookup", () => {
    expect(
      getMerchantProfileState({
        hasProfile: false,
        lookupSettled: true,
        error: null,
      })
    ).toBe("missing")
    expect(
      getMerchantProfileState({
        hasProfile: false,
        lookupSettled: true,
        error: new Error("relay unavailable"),
      })
    ).toBe("unavailable")
  })
})
