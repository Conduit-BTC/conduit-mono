import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GuestCheckoutPaymentJourneyPrototype } from "../apps/market/src/components/GuestCheckoutPaymentJourneyPrototype"
import {
  createGuestCheckoutPaymentJourneyFixture,
  guestCheckoutJourneyStates,
} from "../apps/market/src/test-fixtures/guest-checkout-payment-journey-harness"

function renderJourney(
  state: (typeof guestCheckoutJourneyStates)[number]
): string {
  return renderToStaticMarkup(
    <GuestCheckoutPaymentJourneyPrototype
      {...createGuestCheckoutPaymentJourneyFixture(state)}
    />
  )
}

describe("guest checkout payment journey prototype", () => {
  it("reviews the one-invoice plan without implying authorization or funding", () => {
    const markup = renderJourney("authorization")

    expect(markup).toContain('data-journey-state="authorization"')
    expect(markup).toContain(
      "Two merchant payments from one guest funding invoice"
    )
    expect(markup).toContain("Purchase plan for approval")
    expect(markup).toContain("Purchase plan ready for approval")
    expect(markup).toContain("No payment is authorized yet")
    expect(markup).not.toContain("Frozen purchase authorization")
    expect(markup).toContain("Maximum debit")
    expect(markup).toContain("1,150 sats")
    expect(markup).toContain("Maximum extra compensation")
    expect(markup).toContain("preformatted fixture copy")
    expect(markup).toContain("does not calculate fees")
    expect(markup).toContain("Save recovery receipt (proposed)")
    expect(markup).toContain("Recipient plan for review (fixture)")
    expect(markup).toContain("fixture-recipient:olive-grove-v1")
    expect(markup).toContain("fixture-recipient:north-loop-v1")
    expect(markup).toContain("fixture-recipient:conduit-fee-v1")
    expect(markup).not.toContain("Synthetic final settlement")
  })

  it("freezes approval before the funding invoice is paid", () => {
    const markup = renderJourney("approved")

    expect(markup).toContain('data-journey-state="approved"')
    expect(markup).toContain("Frozen purchase authorization")
    expect(markup).toContain("funding invoice has not been paid")
    expect(markup).toContain("Not funded")
    expect(markup).toContain("0 of 2 merchant payments complete")
    expect(markup).toContain("Frozen recipient plan (fixture)")
    expect(markup).toContain("fixture-recipient:olive-grove-v1")
    expect(markup).toContain("fixture-recipient:north-loop-v1")
    expect(markup).toContain("fixture-recipient:conduit-fee-v1")
    expect(markup).not.toContain("Synthetic final settlement")
  })

  it("keeps funding received distinct from merchant completion", () => {
    const markup = renderJourney("funded")

    expect(markup).toContain('data-journey-state="funded"')
    expect(markup).toContain("Funding received")
    expect(markup).toContain("0 of 2 merchant payments complete")
    expect(markup).toContain("Funding the invoice does not by itself mean")
    expect(markup).toContain("Olive Grove Supply")
    expect(markup).toContain("North Loop Roasters")
  })

  it("preserves completed merchants while one payment remains", () => {
    const markup = renderJourney("remaining_leg")

    expect(markup).toContain('data-journey-state="remaining_leg"')
    expect(markup).toContain("One payment remains")
    expect(markup).toContain("1 of 2 merchant payments complete")
    expect(markup).toContain("One remaining")
    expect(markup).toContain("510 sats")
  })

  it("makes recovery explicit without enabling an automatic retry", () => {
    const markup = renderJourney("recovery_needed")

    expect(markup).toContain('data-journey-state="recovery_needed"')
    expect(markup).toContain('role="alert"')
    expect(markup).toContain("illustrative fixture, funds remain recoverable")
    expect(markup).toContain("Automatic retry stays unavailable")
    expect(markup).toContain("Prepared before funding (fixture)")
    expect(markup).toContain("No production recovery design is approved")
    expect(markup).toContain("No recovery action is enabled")
    expect(markup).not.toContain("Save recovery receipt (proposed)")
    expect(markup).not.toContain("Synthetic final settlement")
  })

  it("settles illustrative fee and residual values only after merchant commerce", () => {
    const markup = renderJourney("settlement")

    expect(markup).toContain('data-journey-state="settlement"')
    expect(markup).toContain("2 of 2 merchant payments complete")
    expect(markup).toContain("Final fee and residual settlement")
    expect(markup).toContain("150 sats")
    expect(markup).toContain("Synthetic Conduit fee")
    expect(markup).toContain("Synthetic routing-cost example")
    expect(markup).toContain("30 sats (example)")
    expect(markup).toContain("Synthetic residual-compensation example")
    expect(markup).toContain("20 sats (example)")
    expect(markup).toContain("still-unapproved residual policy")
    expect(markup).toContain("not calculated, authorized, quoted, or promised")
  })

  it("retires the purchase wallet only after every obligation is resolved", () => {
    const markup = renderJourney("retired")

    expect(markup).toContain('data-journey-state="retired"')
    expect(markup).toContain("2 of 2 merchant payments complete")
    expect(markup).toContain("Purchase wallet retired")
    expect(markup).toContain("No routine wallet management is shown")
    expect(markup).toContain("Synthetic retirement resolution evidence")
    expect(markup).toContain("Fresh available balance")
    expect(markup).toContain("Fresh owned balance")
    expect(markup).toContain("Fresh incoming balance")
    expect(markup).toContain("0 sats (fixture)")
    expect(markup).toContain("Production must collect fresh provider evidence")
    expect(markup).not.toContain("Save recovery receipt (proposed)")
  })
})
