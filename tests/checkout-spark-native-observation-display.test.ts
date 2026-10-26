import { describe, expect, it } from "bun:test"
import { formatMerchantCheckoutSparkNativeObservation } from "../apps/merchant/src/lib/checkout-spark-payout-history-display"

describe("Merchant native preparation details", () => {
  it("distinguishes draining earlier work from opening the wallet", () => {
    expect(
      formatMerchantCheckoutSparkNativeObservation({
        phase: "waiting_for_current_check",
        status: "not_verified",
      })
    ).toBe("Last Conduit check: waiting for the previous check (checking).")
    expect(
      formatMerchantCheckoutSparkNativeObservation({
        phase: "wallet_open",
        status: "not_verified",
      })
    ).toBe("Last Conduit check: wallet opening (checking).")
  })

  it("shows finite proof comparisons without balances or payment authority", () => {
    const text = formatMerchantCheckoutSparkNativeObservation({
      phase: "funds_read",
      status: "not_verified",
      availableMatchesAuthorized: true,
      ownedMatchesAvailable: false,
      pendingEmpty: false,
      providerError: "private-error-sentinel",
      balance: "private-balance-sentinel",
    })
    expect(text).toBe(
      "Last Conduit check: remaining funds (checking). Approved remainder match: confirmed. Ownership match: not confirmed. No pending transfers confirmed: not confirmed."
    )
    expect(text).not.toContain("private-")
    expect(text).not.toContain("paid")
    expect(text).not.toContain("successful")
  })

  it("does not call a completed proof a completed payment", () => {
    expect(
      formatMerchantCheckoutSparkNativeObservation({
        phase: "complete",
        status: "verified",
      })
    ).toBe("Last Conduit check: remaining-funds proof (passed).")
  })

  it("ignores unknown phases, inherited values and accessors without coercion", () => {
    const getter = Object.defineProperty({}, "phase", {
      get() {
        throw new Error("Must not read accessor")
      },
    })
    for (const observation of [
      null,
      [],
      { phase: "private-phase-sentinel", status: "verified" },
      { phase: "wallet_open", status: "private-status-sentinel" },
      Object.create({ phase: "wallet_open", status: "verified" }),
      getter,
      { phase: { toString: () => "wallet_open" }, status: "verified" },
    ])
      expect(
        formatMerchantCheckoutSparkNativeObservation(observation)
      ).toBeNull()
    expect(
      formatMerchantCheckoutSparkNativeObservation({
        phase: "funds_read",
        status: "not_verified",
        availableMatchesAuthorized: "private-value-sentinel",
      })
    ).toBe("Last Conduit check: remaining funds (checking).")
  })
})
