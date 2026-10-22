import { describe, expect, it } from "bun:test"
import { formatMerchantCheckoutSparkPayoutHistory } from "../apps/merchant/src/lib/checkout-spark-payout-history-display"
import type { MerchantCheckoutSparkPayoutHistory } from "../apps/merchant/src/lib/checkout-spark-settled-recovery"

describe("Merchant exact payout history display", () => {
  it("separates saved commerce statuses from this check's exact provider observations", () => {
    const history = {
      status: "inspected",
      checkedLegs: 1,
      newlyConfirmedLegs: 0,
      unresolvedLegs: 1,
      withoutIntentLegs: 1,
      alreadyPaidLegs: 0,
      commerceSummary: {
        savedStatusCounts: { unprepared: 1, prepared: 1 },
        providerObservationCounts: { pending: 1 },
      },
    } as unknown as MerchantCheckoutSparkPayoutHistory
    expect(formatMerchantCheckoutSparkPayoutHistory(history)).toBe(
      "Checked 1 exact payout transfer: 0 newly confirmed, 1 unresolved. 1 leg still lack a frozen invoice. No payout was sent by this check. Saved commerce statuses before this check: 1 not prepared, 1 prepared. Exact commerce provider checks: 1 pending."
    )
  })

  it("says commerce providers were not checked when there are no valid observations", () => {
    const history = {
      status: "inspected",
      checkedLegs: 0,
      newlyConfirmedLegs: 0,
      unresolvedLegs: 0,
      withoutIntentLegs: 1,
      alreadyPaidLegs: 0,
      commerceSummary: {
        savedStatusCounts: { unprepared: 1 },
        providerObservationCounts: {},
      },
    } as unknown as MerchantCheckoutSparkPayoutHistory
    const notice = formatMerchantCheckoutSparkPayoutHistory(history)
    expect(notice).toContain(
      "Saved commerce statuses before this check: 1 not prepared."
    )
    expect(notice).toContain("Exact commerce provider checks: not checked.")
  })

  it("uses finite labels for every commerce status without promoting saved or provider completion to receipt proof", () => {
    const history = {
      status: "inspected",
      checkedLegs: 6,
      newlyConfirmedLegs: 0,
      unresolvedLegs: 6,
      withoutIntentLegs: 1,
      alreadyPaidLegs: 0,
      commerceSummary: {
        savedStatusCounts: {
          unprepared: 1,
          prepared: 1,
          submitted: 1,
          ambiguous: 1,
          lookup_unavailable: 1,
          conflicting_evidence: 1,
          paid: 1,
          terminal_failure: 1,
        },
        providerObservationCounts: {
          not_found: 1,
          lookup_unavailable: 1,
          conflicting_evidence: 1,
          pending: 1,
          terminal_failure: 1,
          paid: 1,
        },
      },
    } as unknown as MerchantCheckoutSparkPayoutHistory
    const notice = formatMerchantCheckoutSparkPayoutHistory(history)
    expect(notice).toContain(
      "Saved commerce statuses before this check: 1 not prepared, 1 prepared, 1 submitted, 1 uncertain, 1 verification unavailable, 1 conflicting evidence, 1 recorded complete, 1 failed."
    )
    expect(notice).toContain(
      "Exact commerce provider checks: 1 not found, 1 unavailable, 1 conflicting evidence, 1 pending, 1 failed, 1 reported complete."
    )
    expect(notice).not.toContain("verified")
    expect(notice).not.toContain("Receipt proof")
    expect(notice).toContain("No payout was sent by this check.")
  })

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    1n,
    "1",
    null,
    undefined,
    {
      toString: () => {
        throw new Error("No count coercion")
      },
    },
  ])("ignores invalid commerce counts without coercion", (count) => {
    const history = {
      status: "inspected",
      checkedLegs: 0,
      newlyConfirmedLegs: 0,
      unresolvedLegs: 0,
      withoutIntentLegs: 0,
      alreadyPaidLegs: 0,
      commerceSummary: {
        savedStatusCounts: { prepared: count },
        providerObservationCounts: { pending: count },
      },
    } as unknown as MerchantCheckoutSparkPayoutHistory
    const notice = formatMerchantCheckoutSparkPayoutHistory(history)
    expect(notice).toContain(
      "Saved commerce statuses before this check: none recorded. Exact commerce provider checks: not checked."
    )
    expect(notice).not.toContain("function")
    expect(notice).not.toContain("[object")
  })

  it("ignores unknown, inherited and accessor commerce counts and extra private fields", () => {
    const savedStatusCounts = Object.assign(Object.create({ paid: 7 }), {
      prepared: 1,
      constructor: 8,
      toString: 9,
      "private-status-sentinel": 10,
    })
    Object.defineProperty(savedStatusCounts, "ambiguous", {
      get() {
        throw new Error("No count getter access")
      },
    })
    const providerObservationCounts = Object.assign(
      Object.create({ paid: 7 }),
      {
        pending: 2,
        not_checked: 3,
        constructor: 8,
        toString: 9,
        "private-observation-sentinel": 10,
      }
    )
    const history = {
      status: "inspected",
      checkedLegs: 2,
      newlyConfirmedLegs: 0,
      unresolvedLegs: 2,
      withoutIntentLegs: 0,
      alreadyPaidLegs: 0,
      commerceSummary: {
        savedStatusCounts,
        providerObservationCounts,
        providerTransferId: "private-reference-sentinel",
        invoiceRequest: "private-invoice-sentinel",
      },
    } as unknown as MerchantCheckoutSparkPayoutHistory
    const notice = formatMerchantCheckoutSparkPayoutHistory(history)
    expect(notice).toContain(
      "Saved commerce statuses before this check: 1 prepared. Exact commerce provider checks: 2 pending."
    )
    expect(notice).not.toContain("private-")
    expect(notice).not.toContain("7 recorded complete")
    expect(notice).not.toContain("7 reported complete")
    expect(notice).not.toContain("constructor")
    expect(notice).not.toContain("toString")
  })

  it("accepts the largest positive safe-integer commerce count", () => {
    const history = {
      status: "inspected",
      checkedLegs: 0,
      newlyConfirmedLegs: 0,
      unresolvedLegs: 0,
      withoutIntentLegs: 0,
      alreadyPaidLegs: 0,
      commerceSummary: {
        savedStatusCounts: { unprepared: Number.MAX_SAFE_INTEGER },
        providerObservationCounts: {},
      },
    } as unknown as MerchantCheckoutSparkPayoutHistory
    expect(formatMerchantCheckoutSparkPayoutHistory(history)).toContain(
      `Saved commerce statuses before this check: ${Number.MAX_SAFE_INTEGER} not prepared.`
    )
  })

  it("retains byte-exact native details when commerce counts are absent", () => {
    expect(
      formatMerchantCheckoutSparkPayoutHistory({
        status: "inspected",
        checkedLegs: 1,
        newlyConfirmedLegs: 0,
        unresolvedLegs: 1,
        withoutIntentLegs: 0,
        alreadyPaidLegs: 0,
        nativeSummary: {
          savedStatus: "submitted",
          hasProviderTransferId: false,
          providerObservation: "pending",
          receiptProof: "not_checked",
          pendingPhase: "sender",
        },
      })
    ).toBe(
      "Checked 1 exact payout transfer: 0 newly confirmed, 1 unresolved. 0 legs still lack a frozen invoice. No payout was sent by this check. Saved fee status before this check: submitted. Transfer reference before this check: not saved. Exact provider check: pending. Sender completion pending. Receipt proof: not checked."
    )
  })

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
