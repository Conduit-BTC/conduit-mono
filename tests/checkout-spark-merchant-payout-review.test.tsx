import { describe, expect, it } from "bun:test"
import { checkoutSparkProviderSendWindowEndsAt } from "@conduit/core/protocol"
import { renderToStaticMarkup } from "react-dom/server"
import { CheckoutSparkMerchantPayoutReview } from "../apps/merchant/src/components/CheckoutSparkMerchantPayoutReview"
import type { MerchantCheckoutSparkPayoutReview } from "../apps/merchant/src/lib/checkout-spark-settled-continuation"
import { makeSignedBolt11Fixture } from "./support/signed-bolt11-fixture"

const invoice = makeSignedBolt11Fixture()
const cutoff = checkoutSparkProviderSendWindowEndsAt(invoice)
if (cutoff === null)
  throw new Error("Signed invoice fixture lacks a safe cutoff")

const review: MerchantCheckoutSparkPayoutReview = {
  checkoutId: "private-checkout-id",
  planDigest: "private-plan-digest",
  legId: "merchant-leg",
  recipientId: "private-recipient-id",
  destination: "merchant@example.test",
  allocationSats: 1000,
  intent: {
    legId: "merchant-leg",
    transferId: "private-transfer-id",
    paymentHash: "private-payment-hash",
    paymentRequest: invoice,
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt: 1_800_000_000_000,
  },
}

function renderReview(nowMs: number, currentReview = review): string {
  return renderToStaticMarkup(
    <CheckoutSparkMerchantPayoutReview review={currentReview} nowMs={nowMs} />
  )
}

describe("Merchant saved payout confirmation", () => {
  it("shows the exact destination, amount and full allocation limit without recovery material", () => {
    const markup = renderReview(cutoff - 10 * 60_000)
    expect(markup).toContain("merchant@example.test")
    expect(markup).toContain("995 sats")
    expect(markup).toContain("5 sats")
    expect(markup).toContain("1,000 sats")
    expect(markup).toContain("not a new buyer payment")
    expect(markup).toContain("payout stays paused")
    expect(markup).toContain("Payout send cutoff")
    expect(markup).toContain(`dateTime="${new Date(cutoff).toISOString()}"`)
    expect(markup).toContain("Time remaining: 10m 00s")
    expect(markup).toContain("order and recovery record remain saved")
    expect(markup).toContain("history separately")
    expect(markup).not.toContain(invoice)
    expect(markup).not.toContain("private-")
  })

  it("explains missing saved recipient evidence separately from budget fit and live payment truth", () => {
    const markup = renderReview(cutoff - 10 * 60_000, {
      ...review,
      inspection: {
        recipientAttribution: "missing",
        savedStatus: "prepared",
        allocationBudget: "fits",
      },
    })
    expect(markup).toContain(
      "No matching recipient evidence found in this device’s saved records"
    )
    expect(markup).toContain("Prepared; no submission recorded here")
    expect(markup).toContain(
      "Saved invoice plus fee cap fits this recipient’s allocation"
    )
    expect(markup).toContain(
      "Live wallet balance and provider history were not checked"
    )
    expect(markup).toContain("fresh checks still run before sending")
    expect(markup).not.toContain(invoice)
    expect(markup).not.toContain("private-")
  })

  it.each([
    ["local_origin", "Matching local invoice origin found"],
    ["recipient_verified", "Saved recipient evidence found"],
    ["unavailable", "Saved recipient evidence could not be checked"],
  ] as const)(
    "describes %s as saved evidence, not live settlement",
    (recipientAttribution, label) => {
      const markup = renderReview(cutoff - 10 * 60_000, {
        ...review,
        inspection: {
          recipientAttribution,
          savedStatus: "ambiguous",
          allocationBudget: "fits",
        },
      })
      expect(markup).toContain(label)
      expect(markup).toContain("Outcome uncertain")
      expect(markup).toContain("Saved-state snapshot only")
      expect(markup).toContain("history were not checked")
      expect(markup).not.toContain("never sent")
      expect(markup).not.toContain("unpaid")
    }
  )

  it.each([
    [
      "exceeds",
      "Saved invoice plus fee cap exceeds this recipient’s allocation",
    ],
    ["unavailable", "Saved allocation budget could not be checked"],
  ] as const)(
    "keeps the %s saved budget separate from live balance",
    (allocationBudget, label) => {
      const markup = renderReview(cutoff - 10 * 60_000, {
        ...review,
        inspection: {
          recipientAttribution: "unavailable",
          savedStatus: "lookup_unavailable",
          allocationBudget,
        },
      })
      expect(markup).toContain(label)
      expect(markup).toContain("Prior lookup unavailable; outcome uncertain")
      expect(markup).toContain(
        "Live wallet balance and provider history were not checked"
      )
    }
  )

  it("does not invent saved classifications when a legacy review has no inspection snapshot", () => {
    const markup = renderReview(cutoff - 10 * 60_000)
    expect(markup).toContain("Saved recipient evidence could not be checked")
    expect(markup).toContain("Saved payment status unavailable")
    expect(markup).toContain("Saved allocation budget could not be checked")
    expect(markup).not.toContain("no submission recorded here")
  })

  it("updates the countdown from the supplied clock and warns when little time remains", () => {
    const earlier = renderReview(cutoff - 90_000)
    const later = renderReview(cutoff - 1_000)
    expect(earlier).toContain("Time remaining: 1m 30s")
    expect(earlier).toContain("Less than two minutes remain")
    expect(later).toContain("Time remaining: 0m 01s")
    expect(later).toContain("not be enough time")
  })

  it("shows an ended safe send window at the exact cutoff", () => {
    const markup = renderReview(cutoff)
    expect(markup).toContain("safe payout window has ended")
    expect(markup).toContain("cannot be sent or replaced here")
    expect(markup).toContain("order and recovery record remain saved")
    expect(markup).not.toContain("Time remaining:")
  })

  it("fails closed in its wording when invoice or clock is invalid", () => {
    const invalidInvoice = renderReview(cutoff - 10_000, {
      ...review,
      intent: { ...review.intent, paymentRequest: "not-an-invoice" },
    })
    const invalidClock = renderReview(Number.NaN)
    for (const markup of [invalidInvoice, invalidClock]) {
      expect(markup).toContain("safe payout deadline cannot be verified")
      expect(markup).toContain("Do not continue this payout")
      expect(markup).toContain("history separately")
      expect(markup).not.toContain("Time remaining:")
    }
  })
})
