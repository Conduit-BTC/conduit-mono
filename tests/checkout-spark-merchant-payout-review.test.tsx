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
  it("keeps automatic payout advancement opt-in and requests discovery without self-draining", async () => {
    const source = await Bun.file(
      "apps/merchant/src/components/CheckoutSparkRecoveryPanel.tsx"
    ).text()
    const worker = source.slice(
      source.indexOf("provider = startMerchantCheckoutSparkReconciliation"),
      source.indexOf("reconciliationController.current = provider")
    )
    expect(source.match(/allowAutomaticPayouts = false/g)).toHaveLength(2)
    expect(source).toContain(
      "const [automaticPayouts, setAutomaticPayouts] = useState(false)"
    )
    expect(worker).toContain("if (automaticPayouts)")
    expect(worker).toContain("await advanceMerchantCheckoutSparkOrder")
    expect(worker).toContain("controller?.requestRescan()")
    expect(worker).toContain("await reconcileMerchantCheckoutSparkOrder")
    expect(worker).not.toContain("stopDiscovery")
    expect(worker).not.toContain("stopAndDrain")
    expect(source).toContain("CheckoutSparkMerchantPaymentCard")
    expect(source).toContain("selectedOrderId")
    const route = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    const mounted = route.slice(
      route.indexOf("<CheckoutSparkRecoveryPanel"),
      route.indexOf("/>", route.indexOf("<CheckoutSparkRecoveryPanel"))
    )
    expect(mounted).not.toContain("automaticPayouts=")
    expect(mounted).toContain(
      "allowAutomaticPayouts={checkoutSparkRehearsalEnabled}"
    )
  })

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

  it("separates local preview from confirm and cancels authority on unmount", async () => {
    const source = await Bun.file(
      "apps/merchant/src/components/CheckoutSparkRecoveryPanel.tsx"
    ).text()
    const preview = source.slice(
      source.indexOf("async function reviewPayout"),
      source.indexOf("async function confirmPayout")
    )
    expect(preview).toContain("reviewMerchantCheckoutSparkSettledPayout")
    expect(preview).not.toContain("continueMerchantCheckoutSparkSettledPayout")
    expect(source).toContain("shouldContinue: current.isCurrent")
    expect(source).toContain("if (!open && !busy) setConfirmation(null)")
    expect(source).toContain(
      "busy || !confirmationHasTime || !confirmationSelectionCurrent"
    )
    expect(source).toContain("nowMs={confirmationNowMs}")
    expect(source).toContain("window.clearInterval(timer)")
    const confirm = source.slice(source.indexOf("async function confirmPayout"))
    expect(confirm.indexOf("const clickedAt = Date.now()")).toBeLessThan(
      confirm.indexOf("await continueMerchantCheckoutSparkSettledPayout")
    )
    expect(confirm.indexOf("nowMs: clickedAt")).toBeLessThan(
      confirm.indexOf("await continueMerchantCheckoutSparkSettledPayout")
    )
    expect(source).toContain("Confirm payout")
    expect(source).toContain("Funds may have moved")
  })

  it("wires explicit preparation through worker drain and refreshes signed discovery before a separate review", async () => {
    const source = await Bun.file(
      "apps/merchant/src/components/CheckoutSparkRecoveryPanel.tsx"
    ).text()
    const preparation = source.slice(
      source.indexOf("async function preparePayout"),
      source.indexOf("async function reviewPayout")
    )
    expect(preparation).toContain("if (busy || confirmation) return")
    expect(preparation).toContain(
      "await prepareNextMerchantCheckoutSparkSettledPayout"
    )
    expect(preparation).toContain("stopAndDrain: stopDiscovery")
    expect(preparation).toContain("shouldContinue: current.isCurrent")
    expect(preparation).toContain("setResult(null)")
    expect(preparation).toContain(
      "setDiscoveryRefresh((previous) => previous + 1)"
    )
    expect(preparation).toContain("refreshVerifiedStatus([candidate], current)")
    expect(preparation).not.toContain("continueMerchantCheckoutSpark")
    expect(preparation).not.toContain("reviewMerchantCheckoutSpark")
    expect(preparation).not.toContain("setConfirmation(")
    expect(source).toContain("Prepare next payout")
    expect(source).toContain("onClick={() => void preparePayout(candidate)}")
    expect(source).toContain(
      "disabled={manualControlsDisabled || confirmation !== null}"
    )
    expect(source).toContain("recovery_pending:")
    expect(source).toContain("do not assume a recovery copy reached your inbox")
    expect(source).toContain("existing_intent:")
    expect(source).toContain("existing payout invoice was kept unchanged")
  })
})
