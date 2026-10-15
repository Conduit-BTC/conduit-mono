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
  it.each([
    ["progress_pending", "Saving final payment progress"],
    ["retirement_pending", "Cleanup evidence pending"],
    ["unavailable", "Check unavailable"],
  ] as const)(
    "keeps paid-order cleanup evidence visible when the worker reports %s",
    (outcome, expected) => {
      const observation = {
        phase: "native_evidence",
        status: "not_verified",
        native: {
          phase: "funds_read",
          status: "not_verified",
          availableZero: true,
          ownedZero: false,
          pendingEmpty: true,
        },
        rawError: "private-provider-value-must-not-be-rendered",
      } as const
      const html = renderToStaticMarkup(
        <CheckoutSparkMerchantPaymentCard
          {...base}
          recoveryPending
          automaticProcessing
          outcome={outcome}
          retirementObservation={observation}
          lastCheckedAt={base.nowMs - 1_000}
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
      expect(html).toContain("Recovery check details")
      expect(html).toContain(expected)
      expect(html).toContain("Terminal funds and pending transfers")
      expect(html).toContain("Zero owned funds")
      expect(html).toContain("Not confirmed")
      expect(html).toContain("Within the last minute")
      expect(html).not.toContain("private-provider-value")
      expect(html).not.toContain("Payment needs attention")
      expect(html).not.toContain("Recovery cleanup complete")
      expect(html).not.toContain("Prepare next payout")
    }
  )

  it("does not attribute a prior native check to a later unavailable worker attempt", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        recoveryPending
        automaticProcessing
        outcome="unavailable"
        lastCheckedAt={base.nowMs - 1_000}
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
    expect(html).toContain("Check unavailable")
    expect(html).toContain("Within the last minute")
    expect(html).not.toContain("Cleanup step")
    expect(html).not.toContain("Provider check")
    expect(html).not.toContain("Zero owned funds")
  })

  it("shows completed recovery without stale continue controls or resumed notices", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        paused
        processingScope="order"
        recoveryPending
        automaticProcessing
        outcome="retired"
        notice="This order's payment processing has resumed. Keep Orders open."
        projection={{
          creditVerified: true,
          merchantVerified: true,
          commerceVerified: true,
          feePending: false,
          recipientUnverified: false,
        }}
      />
    )
    expect(html).toContain("Recovery cleanup complete")
    expect(html).toContain("Payment verified")
    expect(html).toContain("Continue with fulfillment")
    expect(html).not.toContain("Finish recovery")
    expect(html).not.toContain("Continue this order")
    expect(html).not.toContain("Pause")
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain("has resumed")
    expect(html).not.toContain("Keep Orders open")
    expect(html).not.toContain("Recovery check details")
  })

  it("shows playful indeterminate progress only while this order is automatically processing", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        processingScope="order"
        automaticProcessing
        projection={{
          creditVerified: true,
          merchantVerified: false,
          commerceVerified: false,
          feePending: true,
          recipientUnverified: false,
        }}
      />
    )
    expect(html).toContain("Completing this order…")
    expect(html).toContain('role="progressbar"')
    expect(html).not.toContain("aria-valuenow")
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain("motion-reduce:animate-none")
    expect(html).toContain("only this order")
    expect(html).not.toContain("all loaded orders")
  })

  it("offers only this order's remaining recovery after all its payments are verified", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        paused
        processingScope="order"
        recoveryPending
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
    expect(html).toContain("Continue with fulfillment")
    expect(html).toContain("Finish recovery")
    expect(html).toContain("only this order")
    expect(html).not.toContain("Resume")
    expect(html).not.toContain("all loaded orders")
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain("Payment needs attention")
  })

  it("does not flash Finish recovery while checking an already-paid order's local cleanup status", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        paused
        processingScope="order"
        recoveryPending
        recoveryStatusRefreshing
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
    expect(html).toContain("Checking recovery cleanup…")
    expect(html).not.toContain("Finish recovery")
    expect(html).not.toContain("Recovery cleanup complete")
    expect(html).not.toContain('role="progressbar"')
  })

  it.each([false, true])(
    "continues the selected order without globally resuming pending payment when fee-only is %s",
    (commerceVerified) => {
      const html = renderToStaticMarkup(
        <CheckoutSparkMerchantPaymentCard
          {...base}
          paused
          processingScope="order"
          recoveryPending
          projection={{
            creditVerified: true,
            merchantVerified: commerceVerified,
            commerceVerified,
            feePending: true,
            recipientUnverified: false,
          }}
        />
      )
      expect(html).toContain("Continue this order")
      expect(html).toContain("only this order")
      expect(html).not.toContain("Resume")
      expect(html).not.toContain("all loaded orders")
      expect(html).not.toContain("Finish recovery")
      expect(html).not.toContain('role="progressbar"')
    }
  )

  it.each(["paused", "attention", "complete", "inactive"] as const)(
    "never shows playful active progress for a %s order",
    (scenario) => {
      const complete = scenario === "complete"
      const html = renderToStaticMarkup(
        <CheckoutSparkMerchantPaymentCard
          {...base}
          processingScope="order"
          automaticProcessing={scenario !== "inactive"}
          paused={scenario === "paused"}
          outcome={scenario === "attention" ? "needs_attention" : undefined}
          projection={{
            creditVerified: true,
            merchantVerified: complete,
            commerceVerified: complete,
            feePending: !complete,
            recipientUnverified: false,
          }}
        />
      )
      expect(html).not.toContain('role="progressbar"')
      expect(html).not.toContain("Completing this order…")
      expect(html).not.toContain("Finishing recovery…")
    }
  )

  it("shows completed payments without active routing progress while recovery is retained", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        processingScope="order"
        recoveryPending
        automaticProcessing
        notice="This order's payment processing has resumed. Keep Orders open."
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
    expect(html).toContain("Continue with fulfillment")
    expect(html).toContain("Payment complete. Recovery remains saved.")
    expect(html).not.toContain("Finishing recovery…")
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain(">Pause<")
    expect(html).not.toContain("has resumed")
    expect(html).not.toContain("Keep Orders open")
    expect(html).not.toContain("Recovery cleanup complete")
    expect(html).not.toContain("Completing this order…")
    expect(html).not.toContain("Payment needs attention")
  })

  it("does not call a missing payment record unpaid or verified", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard {...base} />
    )
    expect(html).toContain("Checking payment")
    expect(html).not.toContain("Payment verified")
    expect(html).not.toContain("unpaid")
    expect(html).not.toContain("Continue with fulfillment")
    expect(html).not.toContain("Payment complete.")
  })

  it.each([
    { feePending: true, recipientUnverified: false },
    { feePending: false, recipientUnverified: true },
  ])(
    "does not show completion while the fee or recipient proof is unresolved: %j",
    (fee) => {
      const html = renderToStaticMarkup(
        <CheckoutSparkMerchantPaymentCard
          {...base}
          processingScope="order"
          recoveryPending
          automaticProcessing
          projection={{
            creditVerified: true,
            merchantVerified: true,
            commerceVerified: true,
            ...fee,
          }}
        />
      )
      expect(html).toContain("Payment verified")
      expect(html).toContain("Pause coordination fee")
      expect(html).not.toContain("Payment complete.")
      if (fee.feePending) {
        expect(html).toContain("Completing this order…")
        expect(html).toContain('role="progressbar"')
      } else {
        expect(html).toContain("The coordination fee needs attention")
      }
    }
  )

  it("does not show completion without an explicit recipient verification result", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        recoveryPending
        automaticProcessing
        projection={{
          creditVerified: true,
          merchantVerified: true,
          commerceVerified: true,
          feePending: false,
        }}
      />
    )
    expect(html).toContain("Payment verified")
    expect(html).not.toContain("Payment complete.")
  })

  it("keeps manual cleanup feedback available without reopening completed payments", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        paused
        processingScope="order"
        recoveryPending
        notice="Recovery cleanup could not finish. Saved recovery is retained."
        projection={{
          creditVerified: true,
          merchantVerified: true,
          commerceVerified: true,
          feePending: false,
          recipientUnverified: false,
        }}
      />
    )
    expect(html).toContain("Payment complete. Recovery remains saved.")
    expect(html).toContain("Finish recovery")
    expect(html).toContain("Recovery cleanup could not finish")
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain("Recovery cleanup complete")
    expect(html).not.toContain("Resume coordination fee")
  })

  it.each([false, true])(
    "keeps merchant settlement separate from supplier completion and funding proof %s",
    (creditVerified) => {
      const html = renderToStaticMarkup(
        <CheckoutSparkMerchantPaymentCard
          {...base}
          projection={{
            creditVerified,
            merchantVerified: true,
            commerceVerified: false,
            feePending: true,
            recipientUnverified: false,
            receiverSettlementObserved: true,
          }}
        />
      )
      expect(html).toContain("Processing payment")
      expect(html).not.toContain("Payment verified")
      expect(html).not.toContain("Continue with fulfillment")
      if (creditVerified)
        expect(html).toContain("finishing this order&#x27;s payments")
      else {
        expect(html).toContain("exact wallet payment history")
        expect(html).toContain("Do not request another payment")
      }
    }
  )

  it("keeps receiver-only receipts informational until exact checkout wallet history is verified", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        projection={{
          creditVerified: false,
          merchantVerified: false,
          commerceVerified: false,
          feePending: false,
          recipientUnverified: false,
          receiverSettlementObserved: true,
          receiverCommerceObserved: true,
        }}
      />
    )
    expect(html).toContain("Processing payment")
    expect(html).toContain("A recipient receipt was observed")
    expect(html).toContain("exact wallet payment history")
    expect(html).toContain("Do not request another payment")
    expect(html).not.toContain("Payment verified")
    expect(html).not.toContain("Continue with fulfillment")
  })

  it.each([false, true])(
    "explains expired-payout return proof without requesting more buyer funding when commerce is verified %s",
    (commerceVerified) => {
      const html = renderToStaticMarkup(
        <CheckoutSparkMerchantPaymentCard
          {...base}
          checking
          settlementRefreshing
          paused
          outcome="renewal_wait"
          projection={{
            creditVerified: true,
            merchantVerified: commerceVerified,
            commerceVerified,
            feePending: true,
            recipientUnverified: false,
          }}
        >
          <button>Review saved payout</button>
        </CheckoutSparkMerchantPaymentCard>
      )
      expect(html).toContain("The saved payout invoice has expired")
      expect(html).toContain("confirmed returned and spendable")
      expect(html).toContain("Do not request another buyer payment")
      expect(html).not.toContain("Awaiting payment")
      expect(html).not.toContain("Refreshing saved payment status")
      expect(html).toContain("<details")
      if (commerceVerified) {
        expect(html).toContain("Payment verified")
        expect(html).toContain(
          "This order remains paid and fulfillment can continue"
        )
      } else {
        expect(html).toContain("Payment needs attention")
        expect(html).not.toContain("Checking this order")
      }
    }
  )

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

  it("keeps a routine status refresh quiet without reversing verified commerce", () => {
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
    expect(html).not.toContain("Refreshing saved payment status…")
    expect(html).not.toContain("Payment needs attention")
    expect(html).not.toContain("Resume")
  })

  it("keeps a saved attention result visible without routine checking copy", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        checking
        settlementRefreshing
        outcome="recipient_unverified"
      />
    )
    expect(html).toContain("Payment needs attention")
    expect(html).toContain(
      "The recipient for a saved payment could not be verified."
    )
    expect(html).not.toContain("Checking this order")
    expect(html).not.toContain("Refreshing saved payment status…")
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

  it.each([false, true])(
    "exposes only collapsed per-order recovery when funded processing is paused and global continuation is %s",
    (canContinue) => {
      const html = renderToStaticMarkup(
        <CheckoutSparkMerchantPaymentCard
          {...base}
          paused
          canContinue={canContinue}
          projection={{
            creditVerified: true,
            merchantVerified: false,
            commerceVerified: false,
            feePending: true,
            recipientUnverified: false,
          }}
        >
          <button>Review this order's saved payout</button>
        </CheckoutSparkMerchantPaymentCard>
      )
      expect(html).toContain("Processing payment")
      expect(html).toContain("Automatic payments are paused")
      expect(html).toContain("The buyer&#x27;s payment has arrived.")
      expect(html).not.toContain(
        "finishing this order&#x27;s payments automatically"
      )
      expect(html).toContain("Payment details")
      expect(html).toContain("Review this order&#x27;s saved payout")
      expect(html).toContain("<details")
      expect(html).not.toContain("<details open")
      expect(html).not.toContain("Check payment again")
      expect(html).not.toContain("Payment needs attention")
      expect(html).not.toContain("Continue with fulfillment")
      expect(html.includes("Resume payment processing")).toBe(canContinue)
    }
  )

  it("keeps funded automatic processing clean until the merchant pauses", () => {
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
      >
        <button>Review this order's saved payout</button>
      </CheckoutSparkMerchantPaymentCard>
    )
    expect(html).toContain("Processing payment")
    expect(html).not.toContain("Payment details")
    expect(html).not.toContain("Review this order&#x27;s saved payout")
    expect(html).not.toContain("<details")
  })

  it("does not add empty payment details to a paused order without recovery actions", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantPaymentCard
        {...base}
        paused
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
    expect(html).not.toContain("Payment details")
    expect(html).not.toContain("<details")
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

  it("allows inspecting a paused unresolved fee without running a payment check", () => {
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
      >
        <button>Review saved payout</button>
      </CheckoutSparkMerchantPaymentCard>
    )
    expect(html).toContain("Payment verified")
    expect(html).toContain("Coordination fee processing is paused")
    expect(html).toContain("Coordination fee details")
    expect(html).toContain("Review saved payout")
    expect(html).not.toContain("<details open")
    expect(html).not.toContain("Check coordination fee again")
    expect(html).not.toContain("needs attention")
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
