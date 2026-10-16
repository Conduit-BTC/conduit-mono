import { describe, expect, test } from "bun:test"
import { getCheckoutSparkSettledOutcomeMessage } from "../apps/market/src/lib/checkout-spark-settled-outcome-message"

describe("buyer router pause explanation", () => {
  test("distinguishes revoked foreground/session approval without guessing visibility", () => {
    const message = getCheckoutSparkSettledOutcomeMessage({
      status: "paused",
      reason: "paused",
    })
    expect(message).toContain("active buyer session stopped")
    expect(message).toContain("do not pay again")
    expect(message).not.toContain("you hid")
  })

  test("identifies uncertain prior submissions without authorizing a replay", () => {
    for (const reason of [
      "prior_possible_send",
      "sibling_possible_send",
    ] as const) {
      const message = getCheckoutSparkSettledOutcomeMessage({
        status: "paused",
        reason,
      })
      expect(message).toContain("may have been submitted")
      expect(message).toContain("no second payment")
    }
  })

  test("does not disguise missing or conflicting provider proof as a safe retry", () => {
    expect(
      getCheckoutSparkSettledOutcomeMessage({
        status: "paused",
        reason: "provider_evidence_unavailable",
      })
    ).toContain("could not be checked")
    expect(
      getCheckoutSparkSettledOutcomeMessage({
        status: "paused",
        reason: "provider_evidence_conflicting",
      })
    ).toContain("conflicts")
    expect(
      getCheckoutSparkSettledOutcomeMessage({
        status: "paused",
        reason: "terminal_failure",
      })
    ).toContain("cannot continue automatically")
  })

  test("preserves completion, funding confirmation, and zero-credit language", () => {
    expect(getCheckoutSparkSettledOutcomeMessage({ status: "complete" })).toBe(
      "Your payment is recorded. Check the order status for confirmation."
    )
    expect(
      getCheckoutSparkSettledOutcomeMessage({ status: "funding_pending" })
    ).toContain("never pay it again")
    expect(
      getCheckoutSparkSettledOutcomeMessage({
        status: "paused",
        reason: "zero_remainder",
      })
    ).toContain("No additional payment was sent")
  })

  test("unknown runtime values never become free-text explanations", () => {
    const message = getCheckoutSparkSettledOutcomeMessage({
      status: "paused",
      // @ts-expect-error Deliberately invalid runtime input at the presentation edge.
      reason: "provider-secret-and-invoice-sentinel",
    })
    expect(message).not.toContain("sentinel")
    expect(message).toContain("do not pay separately")
  })
})
