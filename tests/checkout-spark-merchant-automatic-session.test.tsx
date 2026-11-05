import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  captureMerchantCheckoutSparkRecoveryAction,
  createMerchantCheckoutSparkAutomaticSession,
} from "../apps/merchant/src/lib/checkout-spark-automatic-session"
import { CheckoutSparkRecoveryPanel } from "../apps/merchant/src/components/CheckoutSparkRecoveryPanel"
import { createMerchantCheckoutSparkPayoutReviewSelection } from "../apps/merchant/src/lib/checkout-spark-payout-review-selection"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

describe("Merchant automatic recovery session activation", () => {
  it("keeps background recovery hidden until an order is selected", () => {
    const base = {
      principalPubkey: "a".repeat(64),
      isSessionCurrent: () => true,
    }
    const automatic = renderToStaticMarkup(
      <CheckoutSparkRecoveryPanel
        {...base}
        allowAutomaticPayouts
        startAutomatically
      />
    )
    expect(automatic).toBe("")
    const disabled = renderToStaticMarkup(
      <CheckoutSparkRecoveryPanel
        {...base}
        selectedOrderId="fixture-order"
        startAutomatically
      />
    )
    expect(disabled).toContain("Checking payment")
    expect(disabled).not.toContain("Verify recovery key")
  })

  it("starts off without starting a drain or consulting storage", () => {
    let drains = 0
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: async () => {
        drains += 1
      },
    })
    expect(session.capture()).toThrow("session changed")
    expect(drains).toBe(0)
  })

  it("grants a new phase only after Start drains existing work", async () => {
    const held = deferred()
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: () => held.promise,
    })
    const starting = session.change(true)
    expect(session.capture()).toThrow("session changed")
    held.resolve()
    expect(await starting).toBe(true)
    expect(session.capture()).not.toThrow()
  })

  it("Pause synchronously invalidates captured authority and waits for cleanup", async () => {
    let drain = Promise.resolve()
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: () => drain,
    })
    await session.change(true)
    const assertHeldCurrent = session.capture()
    assertHeldCurrent()
    const held = deferred()
    drain = held.promise
    let finished = false
    const pausing = session.change(false).then((enabled) => {
      finished = true
      return enabled
    })
    expect(assertHeldCurrent).toThrow("session changed")
    await Promise.resolve()
    expect(finished).toBe(false)
    held.resolve()
    expect(await pausing).toBe(false)
    expect(session.capture()).toThrow("session changed")
    await session.change(true)
    expect(session.capture()).not.toThrow()
    expect(assertHeldCurrent).toThrow("session changed")
  })

  it("Pause cancels a pending Start without a stale completion enabling it", async () => {
    const held = deferred()
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: () => held.promise,
    })
    const starting = session.change(true)
    const pausing = session.change(false)
    held.resolve()
    expect(await starting).toBe(false)
    expect(await pausing).toBe(false)
    expect(session.capture()).toThrow("session changed")
  })

  it.each(["account", "signer", "unmount", "manual"] as const)(
    "does not grant late activation after %s revocation",
    async (reason) => {
      let current = true
      const held = deferred()
      const session = createMerchantCheckoutSparkAutomaticSession({
        isCurrent: () => current,
        stopAndDrain: () => held.promise,
      })
      const starting = session.change(true)
      if (reason === "account" || reason === "signer") current = false
      else session.revoke()
      held.resolve()
      expect(await starting).toBe(false)
      expect(session.capture()).toThrow("session changed")
    }
  )

  it("a changed account immediately invalidates enabled work and a new session is off", async () => {
    let current = true
    const input = {
      isCurrent: () => current,
      stopAndDrain: async () => {},
    }
    const session = createMerchantCheckoutSparkAutomaticSession(input)
    await session.change(true)
    const assertCurrent = session.capture()
    current = false
    expect(assertCurrent).toThrow("session changed")
    current = true
    const remounted = createMerchantCheckoutSparkAutomaticSession(input)
    expect(remounted.capture()).toThrow("session changed")
  })

  it("failed drain or throwing authority cannot enable automatic work", async () => {
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: async () => {
        throw new Error("cleanup unresolved")
      },
    })
    await expect(session.change(true)).rejects.toThrow("cleanup unresolved")
    expect(session.capture()).toThrow("session changed")
    const unavailable = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => {
        throw new Error("session unavailable")
      },
      stopAndDrain: async () => {},
    })
    expect(await unavailable.change(true)).toBe(false)
    expect(unavailable.capture()).toThrow("session changed")
  })

  it("a live auth revocation during a held drain prevents an admitted manual action", async () => {
    let current = true
    const held = deferred()
    const action = captureMerchantCheckoutSparkRecoveryAction({
      generation: () => 1,
      isCurrent: () => current,
    })
    let opened = false
    const attempt = (async () => {
      await held.promise
      action.assertCurrent()
      opened = true
    })()
    current = false
    held.resolve()
    await expect(attempt).rejects.toThrow("session changed")
    expect(opened).toBe(false)
  })

  it("execution revocation invalidates held manual work without revoking a local display read", async () => {
    let executionEnabled = true
    let executionRevision = 1
    const capturedRevision = executionRevision
    const held = deferred()
    const display = captureMerchantCheckoutSparkRecoveryAction({
      generation: () => 1,
      isCurrent: () => true,
    })
    const action = captureMerchantCheckoutSparkRecoveryAction({
      generation: () => 1,
      isCurrent: () =>
        executionEnabled && executionRevision === capturedRevision,
    })
    let providerCalls = 0
    const attempt = (async () => {
      await held.promise
      action.assertCurrent()
      providerCalls += 1
    })()
    void attempt.catch(() => undefined)
    executionEnabled = false
    executionRevision += 1
    executionEnabled = true
    held.resolve()
    await expect(attempt).rejects.toThrow("session changed")
    expect(providerCalls).toBe(0)
    expect(display.isCurrent()).toBe(true)
    expect(action.isCurrent()).toBe(false)
  })

  it("execution revocation prevents late automatic activation and an already captured phase", async () => {
    let executionEnabled = true
    let drain = Promise.resolve()
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => executionEnabled,
      stopAndDrain: () => drain,
    })
    await session.change(true)
    const captured = session.capture()
    const held = deferred()
    drain = held.promise
    const starting = session.change(true)
    executionEnabled = false
    expect(captured).toThrow("session changed")
    held.resolve()
    expect(await starting).toBe(false)
    expect(session.capture()).toThrow("session changed")
  })

  it("changing the selected order during a manual drain revokes execution even when the original order is reselected", async () => {
    const selection = createMerchantCheckoutSparkPayoutReviewSelection()
    selection.select("original-order")
    const isOrderCurrent = selection.capture("original-order")
    const action = captureMerchantCheckoutSparkRecoveryAction({
      generation: () => 1,
      isCurrent: () => isOrderCurrent(),
    })
    const held = deferred()
    let walletOperations = 0
    const pending = (async () => {
      await held.promise
      action.assertCurrent()
      walletOperations += 1
    })()
    void pending.catch(() => undefined)
    selection.select("different-order")
    selection.select("original-order")
    held.resolve()
    await expect(pending).rejects.toThrow("session changed")
    expect(walletOperations).toBe(0)
  })

  it.each(["auth", "generation"] as const)(
    "suppresses held local read results after %s revocation",
    async (reason) => {
      let current = true
      let generation = 1
      const action = captureMerchantCheckoutSparkRecoveryAction({
        generation: () => generation,
        isCurrent: () => current,
      })
      const held = deferred()
      let displayed = false
      const read = (async () => {
        await held.promise
        if (!action.isCurrent()) return
        displayed = true
      })()
      if (reason === "auth") current = false
      else generation += 1
      held.resolve()
      await read
      expect(displayed).toBe(false)
      expect(action.assertCurrent).toThrow("session changed")
    }
  )

  it("fails closed when manual session authority becomes unavailable", () => {
    const action = captureMerchantCheckoutSparkRecoveryAction({
      generation: () => 1,
      isCurrent: () => {
        throw new Error("unavailable")
      },
    })
    expect(action.isCurrent()).toBe(false)
    expect(action.assertCurrent).toThrow("session changed")
  })

  it("renders availability without activating or restoring a prior preference", () => {
    const base = {
      principalPubkey: "a".repeat(64),
      isSessionCurrent: () => true,
      selectedOrderId: "fixture-order",
    }
    const unavailable = renderToStaticMarkup(
      <CheckoutSparkRecoveryPanel {...base} />
    )
    expect(unavailable).not.toContain("Resume payment processing")
    expect(unavailable).not.toContain("Continue this order")
    const available = renderToStaticMarkup(
      <CheckoutSparkRecoveryPanel {...base} allowAutomaticPayouts />
    )
    expect(available).toContain("Continue this order")
    expect(available).toContain("only this order")
    expect(available).not.toContain("all loaded orders")
    expect(available).not.toContain(">Pause<")
    expect(available).toContain("Checking payment")
    expect(available).not.toContain("Verify recovery key")
  })

  it.each(["complete", "partial", "fee_only"] as const)(
    "renders saved %s facts with execution disabled and no automatic continuation control",
    (status) => {
      const projection = {
        creditVerified: true,
        merchantVerified: true,
        commerceVerified: status !== "partial",
        feePending: status !== "complete",
        recipientUnverified: false,
      }
      const html = renderToStaticMarkup(
        <CheckoutSparkRecoveryPanel
          principalPubkey={"a".repeat(64)}
          selectedOrderId="saved-order"
          selectedOrderSettlement={{ orderId: "saved-order", projection }}
          allowAutomaticPayouts
          executionEnabled={false}
          startAutomatically
          isSessionCurrent={() => true}
        />
      )
      expect(html).toContain(
        status === "partial" ? "Processing payment" : "Payment verified"
      )
      expect(html).not.toContain("Resume payment processing")
      expect(html).not.toContain("Resume coordination fee")
      expect(html).not.toContain("Pause coordination fee")
      expect(html).not.toContain(">Pause<")
      if (status !== "complete") {
        expect(html).toContain("Processing is paused in this build")
        expect(html).toContain("do not request another payment")
      }
      if (status !== "partial")
        expect(html).toContain("Continue with fulfillment")
    }
  )

  it("permits an existing bound fee to resume when execution is available independently of checkout admission", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkRecoveryPanel
        principalPubkey={"a".repeat(64)}
        selectedOrderId="saved-order"
        selectedOrderSettlement={{
          orderId: "saved-order",
          projection: {
            creditVerified: true,
            merchantVerified: true,
            commerceVerified: true,
            feePending: true,
          },
        }}
        allowAutomaticPayouts
        executionEnabled
        isSessionCurrent={() => true}
      />
    )
    expect(html).toContain("Payment verified")
    expect(html).toContain("Continue this order")
    expect(html).toContain("only this order")
    expect(html).not.toContain("Pay for order")
  })
})
