import {
  hasFreshProfilePaymentAddress,
  type SelectedProfileContext,
} from "@conduit/core"
import { describe, expect, it } from "bun:test"
import {
  getMerchantPaymentLud16,
  getMerchantPaymentProfileState,
  getMerchantPaymentReadiness,
} from "../apps/market/src/lib/merchant-payment-readiness"
import { getCheckoutEvidenceCheckingLabel } from "../apps/market/src/lib/checkout-validation"

const checkoutSource = Bun.file("apps/market/src/routes/checkout.tsx").text()

function paymentContext(
  lud16: string,
  freshness: SelectedProfileContext["freshness"]
): SelectedProfileContext {
  return {
    profile: { pubkey: "a".repeat(64), lud16 },
    frontier: {
      eventId: "b".repeat(64),
      eventCreatedAt: 1,
      rawContent: JSON.stringify({ lud16 }),
      validity: "valid",
    },
    freshness,
    persistence: "durable",
    readComplete: false,
  }
}

describe("shopper merchant payment readiness", () => {
  it("uses strict profile evidence for checkout blockers despite richer cached display data", async () => {
    const source = await checkoutSource

    expect(source).toMatch(
      /merchantProfileLoading:\s*merchantTrust\.profileEvidenceState === "loading"/
    )
    expect(source).toMatch(
      /merchantProfileUnavailable:\s*merchantTrust\.profileEvidenceState === "unavailable"/
    )
    expect(source).not.toContain(
      'merchantProfileUnavailable: merchantTrust.profileState === "limited"'
    )
    expect(source).toContain("getMerchantPaymentLud16({")
    expect(source).toContain("lud16: merchantTrust.profileEvidenceLud16")
    expect(source).toContain(
      'merchantTrust.profileEvidenceState !== "available"'
    )
  })

  it("revalidates the signed payment destination immediately before invoice work", async () => {
    const source = await checkoutSource

    expect(source).toContain(
      "const refreshedProfileResult = await getProfiles({"
    )
    expect(source).toContain("skipCache: true")
    expect(source).toContain("requireCompleteEvidence: true")
    expect(source).toContain('evidenceScope: "payment"')
    expect(source).toContain(
      "refreshedProfileResult.profileContexts[selectedMerchant]"
    )
    expect(source).toMatch(
      /getFreshLnurlMetadata\(\s*currentMerchantLud16\s*\)/
    )
    expect(source).toContain("merchantLightningAddress: currentMerchantLud16")
    expect(source).toContain("merchantLud16: currentMerchantLud16")
    expect(source).not.toContain("getFreshLnurlMetadata(merchantLud16)")
    expect(source).not.toContain("merchantLightningAddress: merchantLud16")
  })

  it("requires complete current profile evidence before reporting absence", () => {
    expect(
      getMerchantPaymentProfileState({
        isLoading: false,
        isFetching: true,
        lookupSettled: false,
        evidenceIncomplete: true,
        positiveAddressEvidence: true,
      })
    ).toBe("loading")
    expect(
      getMerchantPaymentProfileState({
        isLoading: false,
        isFetching: false,
        lookupSettled: true,
        evidenceIncomplete: true,
        positiveAddressEvidence: false,
      })
    ).toBe("unavailable")
    expect(
      getMerchantPaymentProfileState({
        isLoading: false,
        isFetching: false,
        lookupSettled: true,
        evidenceIncomplete: false,
        positiveAddressEvidence: false,
      })
    ).toBe("available")
  })

  it("accepts a live positive address without treating partial coverage as absence", () => {
    const lud16 = "merchant@wallet.example"
    const positiveAddressEvidence = hasFreshProfilePaymentAddress(
      paymentContext(lud16, "observed")
    )

    expect(positiveAddressEvidence).toBe(true)
    expect(
      getMerchantPaymentProfileState({
        isLoading: false,
        isFetching: false,
        lookupSettled: true,
        evidenceIncomplete: true,
        positiveAddressEvidence,
      })
    ).toBe("available")
    expect(getMerchantPaymentLud16({ profileState: "available", lud16 })).toBe(
      lud16
    )
  })

  it("rejects cache-only or stale addresses as positive payment evidence", () => {
    for (const freshness of ["retained", "unobserved"] as const) {
      expect(
        hasFreshProfilePaymentAddress(
          paymentContext("cached@wallet.example", freshness)
        )
      ).toBe(false)
    }
  })

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
        lud16: "cached@wallet.example",
        lnurlStatus: "ready",
      })
    ).toBe("profile_unavailable")
  })

  it("exposes a payment destination only from authoritative current evidence", () => {
    expect(
      getMerchantPaymentLud16({
        profileState: "unavailable",
        lud16: "cached@wallet.example",
      })
    ).toBeUndefined()
    expect(
      getMerchantPaymentLud16({
        profileState: "loading",
        lud16: "cached@wallet.example",
      })
    ).toBeUndefined()
    expect(
      getMerchantPaymentLud16({
        profileState: "available",
        lud16: " current@wallet.example ",
      })
    ).toBe("current@wallet.example")
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
  it("uses ordinary product availability while the order is reviewed", () => {
    expect(
      getCheckoutEvidenceCheckingLabel({ availabilityChecking: true })
    ).toBe("Checking product availability")
    expect(
      getCheckoutEvidenceCheckingLabel({ availabilityChecking: false })
    ).toBeNull()
  })
})
