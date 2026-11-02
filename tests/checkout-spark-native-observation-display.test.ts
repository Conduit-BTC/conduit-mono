import { describe, expect, it } from "bun:test"
import { formatMerchantCheckoutSparkNativeObservation } from "../apps/merchant/src/lib/checkout-spark-payout-history-display"

describe("Merchant native preparation details", () => {
  it.each([
    ["saved_progress", "saved progress retry"],
    ["prepared_snapshot", "prepared snapshot acknowledgement"],
    ["submitted_snapshot", "submitted snapshot acknowledgement"],
  ] as const)(
    "distinguishes the finite %s recovery checkpoint",
    (checkpoint, label) => {
      expect(
        formatMerchantCheckoutSparkNativeObservation({
          phase: "recovery_delivery",
          status: "not_verified",
          recoveryCheckpoint: checkpoint,
        })
      ).toBe(`Last Conduit check: recovery delivery / ${label} (checking).`)
    }
  )

  it("does not read or coerce unknown checkpoint details", () => {
    const base = { phase: "recovery_delivery", status: "not_verified" }
    const expected = "Last Conduit check: recovery delivery (checking)."
    for (const value of [
      "private-checkpoint-sentinel",
      "constructor",
      {},
      null,
    ])
      expect(
        formatMerchantCheckoutSparkNativeObservation({
          ...base,
          recoveryCheckpoint: value,
        })
      ).toBe(expected)
    expect(
      formatMerchantCheckoutSparkNativeObservation(
        Object.defineProperty({ ...base }, "recoveryCheckpoint", {
          get() {
            throw new Error("No checkpoint getter access")
          },
        })
      )
    ).toBe(expected)
    expect(
      formatMerchantCheckoutSparkNativeObservation({
        phase: "wallet_open",
        status: "not_verified",
        recoveryCheckpoint: "submitted_snapshot",
      })
    ).toBe("Last Conduit check: wallet opening (checking).")
  })

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
