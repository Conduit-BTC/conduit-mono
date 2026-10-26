import { describe, expect, it } from "bun:test"
import {
  formatMerchantCheckoutSparkPayoutHistory,
  formatMerchantCheckoutSparkPayoutObservation,
} from "../apps/merchant/src/lib/checkout-spark-payout-history-display"
import type { MerchantCheckoutSparkPayoutHistory } from "../apps/merchant/src/lib/checkout-spark-settled-recovery"

describe("Merchant finite payout observation display", () => {
  it.each([
    ["fee_over_cap", "The provider fee exceeded this payout's approved cap."],
    [
      "insufficient_funds",
      "The provider reported insufficient available checkout funds.",
    ],
    [
      "fee_unavailable",
      "The provider fee could not be verified for this payout.",
    ],
    [
      "recovery_handoff_unavailable",
      "The required recovery handoff could not be confirmed.",
    ],
    [
      "provider_evidence_unavailable",
      "The required provider proof could not be confirmed.",
    ],
    [
      "prerequisite_unpaid",
      "Earlier recipient payments still need verified proof.",
    ],
  ] as const)("explains only the finite %s blocker", (reason, message) => {
    for (const outcome of ["wait", "send_ambiguous"]) {
      for (const sendAttempted of [false, true]) {
        expect(
          formatMerchantCheckoutSparkPayoutObservation({
            outcome,
            reason,
            sendAttempted,
          })
        ).toBe(
          `${message} ${sendAttempted ? "Funds may have moved; inspect exact history." : "No new provider send was entered by that check."}`
        )
      }
    }
  })

  it("clears the hint for ordinary outcomes and unknown reasons", () => {
    for (const outcome of [
      "paid",
      "already_paid",
      "invoice_needed",
      "funding_wait",
      "terminal_failure",
      "private-outcome-sentinel",
      "constructor",
      "toString",
      "__proto__",
    ])
      expect(
        formatMerchantCheckoutSparkPayoutObservation({
          outcome,
          reason: "fee_over_cap",
          sendAttempted: false,
        })
      ).toBeNull()
    for (const reason of [
      undefined,
      null,
      "private-reason-sentinel",
      "constructor",
      "toString",
      "__proto__",
    ])
      expect(
        formatMerchantCheckoutSparkPayoutObservation({
          outcome: "wait",
          reason,
          sendAttempted: false,
        })
      ).toBeNull()
    expect(formatMerchantCheckoutSparkPayoutObservation(null)).toBeNull()
  })

  it("ignores malformed and inherited observation fields without coercion", () => {
    const unsafe = {
      toString: () => {
        throw new Error("No observation coercion")
      },
      valueOf: () => {
        throw new Error("No observation coercion")
      },
    }
    const valid = {
      outcome: "wait",
      reason: "fee_over_cap",
      sendAttempted: false,
    }
    for (const observation of [
      undefined,
      false,
      "private-result-sentinel",
      [],
      {},
      { ...valid, outcome: unsafe },
      { ...valid, reason: unsafe },
      { ...valid, sendAttempted: unsafe },
      { ...valid, sendAttempted: undefined },
      { ...valid, sendAttempted: 0 },
      { ...valid, sendAttempted: 1 },
      { ...valid, sendAttempted: "false" },
      Object.assign(Object.create({ outcome: "wait" }), {
        reason: "fee_over_cap",
        sendAttempted: false,
      }),
      Object.assign(Object.create({ reason: "fee_over_cap" }), {
        outcome: "wait",
        sendAttempted: false,
      }),
      Object.assign(Object.create({ sendAttempted: false }), {
        outcome: "wait",
        reason: "fee_over_cap",
      }),
    ])
      expect(
        formatMerchantCheckoutSparkPayoutObservation(observation)
      ).toBeNull()
    for (const field of ["outcome", "reason", "sendAttempted"]) {
      const observation = { ...valid }
      Object.defineProperty(observation, field, {
        get() {
          throw new Error("No observation getter access")
        },
      })
      expect(
        formatMerchantCheckoutSparkPayoutObservation(observation)
      ).toBeNull()
    }
  })

  it("ignores extra private fields and raw errors rather than rendering or reading them", () => {
    const observation = {
      outcome: "send_ambiguous",
      reason: "fee_unavailable",
      sendAttempted: true,
      providerTransferId: "private-reference-sentinel",
      paymentRequest: "private-invoice-sentinel",
      get error() {
        throw new Error("No private error access")
      },
      get message() {
        throw new Error("No private message access")
      },
    }
    expect(formatMerchantCheckoutSparkPayoutObservation(observation)).toBe(
      "The provider fee could not be verified for this payout. Funds may have moved; inspect exact history."
    )
    expect(
      formatMerchantCheckoutSparkPayoutObservation(
        new Error("private-error-sentinel")
      )
    ).toBeNull()
  })
})

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
