import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CheckoutSparkMerchantPaymentCard } from "../apps/merchant/src/components/CheckoutSparkMerchantPaymentCard"
import { CheckoutSparkRecoveryPanel } from "../apps/merchant/src/components/CheckoutSparkRecoveryPanel"

const base = {
  projection: null,
  checking: false,
  paused: false,
  canContinue: true,
  transitioning: false,
  handoffAt: 1_800_000_180_000,
  nowMs: 1_800_000_200_000,
  onRetry() {},
  onPause() {},
  onContinue() {},
}

describe("Merchant order payment presentation", () => {
  it.each([false, true])(
    "clarifies the session-wide processing controls when paused is %s",
    (paused) => {
      for (const commerceVerified of [false, true]) {
        const html = renderToStaticMarkup(
          <CheckoutSparkMerchantPaymentCard
            {...base}
            paused={paused}
            projection={{
              creditVerified: true,
              merchantVerified: commerceVerified,
              commerceVerified,
              feePending: true,
              recipientUnverified: false,
            }}
          />
        )
        expect(html).toContain(
          "Pause and Resume affect automatic payment processing for all loaded orders."
        )
        expect(html).toContain("aria-describedby=")
      }
    }
  )

  it("labels a local status refresh without reversing verified commerce", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        settlementRefreshing
        projection={{
          creditVerified: true,
          merchantVerified: true,
          commerceVerified: true,
          feePending: false,
          recipientUnverified: false,
        }}
      />
    )
    expect(html).toContain("Payment verified")
    expect(html).toContain("Refreshing saved payment status…")
    expect(html).not.toContain("Payment needs attention")
    expect(html).not.toContain("Resume")
  })

  it("does not describe unavailable local evidence as an invalid recipient", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        settlementReadUnavailable
        recoveryLookupIncomplete
      />
    )
    expect(html).toContain("Saved payment status is temporarily unavailable")
    expect(html).toContain("Do not request another payment")
    expect(html).not.toContain(
      "recipient for a saved payment could not be verified"
    )
    expect(html).not.toContain("Awaiting payment")
  })

  it("keeps durable selected-order payment verified before recovery discovery finishes", () => {
    const projection = {
      creditVerified: true,
      merchantVerified: true,
      commerceVerified: true,
      feePending: true,
      recipientUnverified: false,
    }
    const renderOrder = (selectedOrderId: string) =>
      renderToStaticMarkup(
        <CheckoutSparkRecoveryPanel
          principalPubkey={"a".repeat(64)}
          selectedOrderId={selectedOrderId}
          selectedOrderSettlement={{ orderId: "order-a", projection }}
          isSessionCurrent={() => true}
        />
      )
    expect(renderOrder("order-a")).toContain("Payment verified")
    expect(renderOrder("order-a")).not.toContain("Checking payment")
    expect(renderOrder("order-b")).not.toContain("Payment verified")
    expect(renderOrder("order-b")).toContain("Checking payment")
  })

  it("offers a retry when the order is absent from incomplete discovery, without claiming unpaid", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard {...base} recoveryLookupIncomplete />
    )
    expect(html).toContain("Check payment again")
    expect(html).toContain("have not been found")
    expect(html).toContain("Do not request another payment")
    expect(html).not.toContain("Awaiting payment")
  })

  it("hides recovery machinery while ordinary checks continue", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard {...base} checking>
        <button>Verify recovery key</button>
      </CheckoutSparkMerchantPaymentCard>
    )
    expect(html).toContain("Checking payment")
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-atomic="true"')
    expect(html).toContain("<h2")
    expect(html).toContain("Pause")
    expect(html).not.toContain("Verify recovery key")
    expect(html).not.toContain("Payment details")
  })

  it("offers an exception action with its feedback at the affected order", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        outcome="unavailable"
        notice="Still checking the original payment."
      >
        <button>Inspect exact payout history</button>
      </CheckoutSparkMerchantPaymentCard>
    )
    expect(html).toContain("Payment needs attention")
    expect(html).toContain("Check payment again")
    expect(html).toContain("<details")
    expect(html).not.toContain("<details open")
    expect(html).toContain("Still checking the original payment.")
  })

  it("describes missing recipient verification without claiming an unsent saved payment was paid", () => {
    for (const viaProjection of [false, true]) {
      const html = renderToStaticMarkup(
        <CheckoutSparkMerchantPaymentCard
          {...base}
          outcome={viaProjection ? "pending" : "recipient_unverified"}
          projection={
            viaProjection
              ? {
                  creditVerified: true,
                  merchantVerified: false,
                  commerceVerified: false,
                  feePending: true,
                  recipientUnverified: true,
                }
              : null
          }
        >
          <button>Inspect exact payout history</button>
        </CheckoutSparkMerchantPaymentCard>
      )
      expect(html).toContain("Payment needs attention")
      expect(html).toContain(
        "The recipient for a saved payment could not be verified."
      )
      expect(html).toContain("Do not request another payment.")
      expect(html).not.toContain("A payment was found")
      expect(html).not.toContain("Continue with fulfillment")
      expect(html).toContain('aria-live="polite"')
      expect(html).toContain('aria-atomic="true"')
      expect(html).toContain("Check payment again")
      expect(html).toContain("Payment details")
      expect(html).not.toContain("<details open")
    }
  })

  it("keeps retry and pause disabled during a guarded transition with a polite status", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        outcome="recipient_unverified"
        transitioning
      />
    )
    expect(html.match(/<button\b[^>]*\bdisabled=""/g)).toHaveLength(2)
    expect(html).toContain("Finishing current check…")
    expect(html).toContain('role="status"')
    expect(html).toContain(
      "Waiting for the current operation to finish safely."
    )
    expect(html).not.toContain("autofocus")
  })

  it("keeps verified commerce paid while exposing a fee-only failure separately", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        outcome="unavailable"
        projection={{
          creditVerified: true,
          merchantVerified: true,
          commerceVerified: true,
          feePending: true,
          recipientUnverified: false,
        }}
      >
        <button>Prepare next payout</button>
      </CheckoutSparkMerchantPaymentCard>
    )
    expect(html).toContain("Payment verified")
    expect(html).toContain("This order remains paid")
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-atomic="true"')
    expect(html).toContain("fulfillment can continue")
    expect(html).toContain("Check coordination fee again")
    expect(html).toContain("Coordination fee details")
    expect(html).toContain("Pause coordination fee")
    expect(html).not.toContain("Check payment again")
    expect(html).toContain("Prepare next payout")
    expect(html).not.toContain("<details open")
    expect(html).not.toContain(">Pause<")
  })

  it("allows resuming a paused coordination fee after commerce becomes paid", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        paused
        projection={{
          creditVerified: true,
          merchantVerified: true,
          commerceVerified: true,
          feePending: true,
          recipientUnverified: false,
        }}
      />
    )
    expect(html).toContain("Payment verified")
    expect(html).toContain("Resume coordination fee")
    expect(html).toContain("Coordination fee processing is paused")
    expect(html).not.toContain("The coordination fee is still processing")
  })

  it("keeps fulfillment available while a paid fee's recipient still needs verification", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        outcome="recipient_unverified"
        projection={{
          creditVerified: true,
          merchantVerified: true,
          commerceVerified: true,
          feePending: false,
          recipientUnverified: true,
        }}
      >
        <button>Inspect exact payout history</button>
      </CheckoutSparkMerchantPaymentCard>
    )
    expect(html).toContain("Payment verified")
    expect(html).toContain("Continue with fulfillment")
    expect(html).toContain("The coordination fee needs attention")
    expect(html).toContain("This order remains paid")
    expect(html).toContain("Check coordination fee again")
    expect(html).toContain("Coordination fee details")
    expect(html).toContain("Pause coordination fee")
    expect(html).toContain("Inspect exact payout history")
    expect(html).not.toContain("<details open")
    expect(html).not.toContain("Payment needs attention")
    expect(html).not.toContain("Check payment again")
    expect(html).not.toContain("Pay again")
    expect(html).not.toContain("Pay invoice")
    expect(html).not.toContain("Continue to payment")
    expect(html).not.toContain("Route one payout")
  })

  it("hides recovery controls when commerce and coordination fee are verified", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        paused
        outcome="unavailable"
        projection={{
          creditVerified: true,
          merchantVerified: true,
          commerceVerified: true,
          feePending: false,
          recipientUnverified: false,
        }}
      >
        <button>Prepare next payout</button>
      </CheckoutSparkMerchantPaymentCard>
    )
    expect(html).toContain("Payment verified")
    expect(html).not.toContain("Resume")
    expect(html).not.toContain("Check coordination fee")
    expect(html).not.toContain("Prepare next payout")
    expect(html).not.toContain("Payment needs attention")
    expect(html).not.toContain("all loaded orders")
  })

  it("does not equate funding with paid commerce", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        projection={{
          creditVerified: true,
          merchantVerified: false,
          commerceVerified: false,
          feePending: true,
          recipientUnverified: false,
        }}
      />
    )
    expect(html).toContain("Processing payment")
    expect(html).not.toContain("Continue with fulfillment")
  })

  it("labels the future handoff as a recovery time and exposes resume after Pause", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        paused
        nowMs={base.handoffAt - 1}
      />
    )
    expect(html).toContain("Resume payment processing")
    expect(html).toContain("not the payment time")
    expect(html).toContain("dateTime=")
  })
})
