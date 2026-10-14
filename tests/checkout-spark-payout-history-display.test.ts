import { describe, expect, it } from "bun:test"
import { formatMerchantCheckoutSparkPayoutHistory } from "../apps/merchant/src/lib/checkout-spark-payout-history-display"
import type { MerchantCheckoutSparkPayoutHistory } from "../apps/merchant/src/lib/checkout-spark-settled-recovery"

describe("Merchant exact payout history display", () => {
  it("shows receiver completion pending without inventing a receipt or wallet outage", () => {
    const notice = formatMerchantCheckoutSparkPayoutHistory({
      status: "inspected",
      checkedLegs: 3,
      newlyConfirmedLegs: 0,
      unresolvedLegs: 1,
      withoutIntentLegs: 0,
      alreadyPaidLegs: 2,
      nativeSummary: {
        savedStatus: "submitted",
        hasProviderTransferId: false,
        providerObservation: "pending",
        receiptProof: "not_checked",
        pendingPhase: "receiver",
      },
    })
    expect(notice).toContain("Receiver completion pending.")
    expect(notice).toContain("Receipt proof: not checked.")
    expect(notice).toContain("No payout was sent by this check.")
    expect(notice).not.toContain("offline")
    expect(notice).not.toContain("claimed")
  })

  it.each([
    {
      observation: "pending",
      phase: "sender",
      label: "Sender completion pending.",
    },
    { observation: "pending", phase: undefined, label: undefined },
    { observation: "paid", phase: "receiver", label: undefined },
    { observation: "terminal_failure", phase: "sender", label: undefined },
    { observation: "pending", phase: "private-phase", label: undefined },
    { observation: "pending", phase: "constructor", label: undefined },
    { observation: "pending", phase: "toString", label: undefined },
    { observation: "pending", phase: "__proto__", label: undefined },
    {
      observation: "pending",
      phase: {
        toString: () => {
          throw new Error("No diagnostic coercion")
        },
      },
      label: undefined,
    },
  ])(
    "renders only typed pending phase $phase for $observation",
    ({ observation, phase, label }) => {
      const history = {
        status: "inspected",
        checkedLegs: 3,
        newlyConfirmedLegs: 0,
        unresolvedLegs: 1,
        withoutIntentLegs: 0,
        alreadyPaidLegs: 2,
        nativeSummary: {
          savedStatus: "submitted",
          hasProviderTransferId: false,
          providerObservation: observation,
          receiptProof: "not_checked",
          pendingPhase: phase,
        },
      } as unknown as MerchantCheckoutSparkPayoutHistory
      const notice = formatMerchantCheckoutSparkPayoutHistory(history)
      if (label) expect(notice).toContain(label)
      else expect(notice).not.toContain("completion pending")
      expect(notice).not.toContain("private-phase")
      expect(notice).not.toContain("constructor")
      expect(notice).not.toContain("toString")
      expect(notice).not.toContain("__proto__")
      expect(notice).not.toContain("function")
      expect(notice).toContain("Receipt proof: not checked.")
    }
  )

  it("shows a failed final fee truthfully without exposing payment contents", () => {
    const notice = formatMerchantCheckoutSparkPayoutHistory({
      status: "inspected",
      checkedLegs: 3,
      newlyConfirmedLegs: 0,
      unresolvedLegs: 1,
      withoutIntentLegs: 0,
      alreadyPaidLegs: 2,
      nativeSummary: {
        savedStatus: "terminal_failure",
        hasProviderTransferId: true,
        providerObservation: "terminal_failure",
        receiptProof: "not_checked",
      },
    })
    expect(notice).toContain("3 exact payout transfers")
    expect(notice).toContain("1 unresolved")
    expect(notice).toContain("Saved fee status before this check: failed.")
    expect(notice).toContain("Transfer reference before this check: saved.")
    expect(notice).toContain("Exact provider check: failed.")
    expect(notice).toContain("Receipt proof: not checked.")
    expect(notice).toContain("No payout was sent by this check.")
    expect(notice).not.toContain("still processing")
  })

  it("does not turn provider completion into verified receipt or absent reference into no send", () => {
    const notice = formatMerchantCheckoutSparkPayoutHistory({
      status: "inspected",
      checkedLegs: 3,
      newlyConfirmedLegs: 0,
      unresolvedLegs: 1,
      withoutIntentLegs: 0,
      alreadyPaidLegs: 2,
      nativeSummary: {
        savedStatus: "ambiguous",
        hasProviderTransferId: false,
        providerObservation: "paid",
        receiptProof: "unavailable",
      },
    })
    expect(notice).toContain("Saved fee status before this check: uncertain.")
    expect(notice).toContain("Transfer reference before this check: not saved.")
    expect(notice).toContain("Exact provider check: reported complete.")
    expect(notice).toContain("Receipt proof: incomplete.")
    expect(notice).not.toContain("Saved fee status before this check: verified")
    expect(notice).not.toContain("transfer was not sent")
  })

  it("retains ordinary history text when there is no native fee summary", () => {
    expect(
      formatMerchantCheckoutSparkPayoutHistory({
        status: "inspected",
        checkedLegs: 1,
        newlyConfirmedLegs: 0,
        unresolvedLegs: 0,
        withoutIntentLegs: 0,
        alreadyPaidLegs: 1,
      })
    ).toBe(
      "Checked 1 exact payout transfer: 0 newly confirmed, 0 unresolved. 0 legs still lack a frozen invoice. No payout was sent by this check."
    )
  })

  it("does not call an imported paid claim independently verified", () => {
    const notice = formatMerchantCheckoutSparkPayoutHistory({
      status: "inspected",
      checkedLegs: 3,
      newlyConfirmedLegs: 0,
      unresolvedLegs: 1,
      withoutIntentLegs: 0,
      alreadyPaidLegs: 2,
      nativeSummary: {
        savedStatus: "paid",
        hasProviderTransferId: true,
        providerObservation: "lookup_unavailable",
        receiptProof: "not_checked",
      },
    })
    expect(notice).toContain(
      "Saved fee status before this check: recorded complete."
    )
    expect(notice).not.toContain("verified")
  })

  it("never renders arbitrary status values or extra private payment fields", () => {
    const recoverySentinel = crypto.randomUUID()
    const history = {
      status: "inspected",
      checkedLegs: 3,
      newlyConfirmedLegs: 0,
      unresolvedLegs: 1,
      withoutIntentLegs: 0,
      alreadyPaidLegs: 2,
      nativeSummary: {
        savedStatus: "private-saved-status-sentinel",
        hasProviderTransferId: true,
        providerObservation: "private-provider-sentinel",
        receiptProof: "private-receipt-sentinel",
        providerTransferId: "private-reference-sentinel",
        invoiceRequest: "private-invoice-sentinel",
        mnemonic: recoverySentinel,
      },
    } as unknown as MerchantCheckoutSparkPayoutHistory
    const notice = formatMerchantCheckoutSparkPayoutHistory(history)
    expect(notice).toContain("Saved fee status before this check: unavailable.")
    expect(notice).toContain("Exact provider check: unavailable.")
    expect(notice).toContain("Receipt proof: incomplete.")
    expect(notice).not.toContain("private-")
    expect(notice).not.toContain(recoverySentinel)
  })

  it("uses fixed fallbacks for status names inherited from object prototypes", () => {
    const history = {
      status: "inspected",
      checkedLegs: 3,
      newlyConfirmedLegs: 0,
      unresolvedLegs: 1,
      withoutIntentLegs: 0,
      alreadyPaidLegs: 2,
      nativeSummary: {
        savedStatus: "constructor",
        hasProviderTransferId: false,
        providerObservation: "toString",
        receiptProof: "valueOf",
      },
    } as unknown as MerchantCheckoutSparkPayoutHistory
    const notice = formatMerchantCheckoutSparkPayoutHistory(history)
    expect(notice).toContain("Saved fee status before this check: unavailable.")
    expect(notice).toContain("Exact provider check: unavailable.")
    expect(notice).toContain("Receipt proof: incomplete.")
    expect(notice).not.toContain("function")
  })
})
