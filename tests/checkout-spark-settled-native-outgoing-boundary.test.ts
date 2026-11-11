import { describe, expect, it } from "bun:test"
import { CheckoutSparkInvoiceOriginUnavailableError } from "../packages/core/src/protocol/checkout-spark-lnurl-invoice"
import { CheckoutSparkOutgoingNotAdmittedError } from "../packages/core/src/protocol/checkout-spark-outgoing-admission"
import { createCheckoutSparkSettledNativeOutgoingProvider } from "../packages/core/src/protocol/checkout-spark-settled-native-outgoing"
import type {
  CheckoutSparkSettledOutgoingObservation,
  CheckoutSparkSettledOutgoingTarget,
} from "../packages/core/src/protocol/checkout-spark-settled-outgoing"
import {
  LEG_FIXTURE_CREATED_AT,
  outgoingTargetFor,
  preparedSettledLegState,
} from "./support/checkout-spark-settled-leg-fixture"

/**
 * Offline boundary proof for the actor-neutral native outgoing provider: every
 * app-owned guard failure BEFORE `sendFrozen` is typed as not admitted with zero
 * sends; a `sendFrozen` throw is never typed and never proves "not sent".
 */

const NOW = LEG_FIXTURE_CREATED_AT + 3

function notFound(
  target: CheckoutSparkSettledOutgoingTarget
): CheckoutSparkSettledOutgoingObservation {
  return {
    legId: target.legId,
    transferId: target.intent.transferId,
    paymentRequest: target.intent.paymentRequest,
    paymentHash: target.intent.paymentHash,
    invoiceAmountSats: target.intent.invoiceAmountSats,
    maxFeeSats: target.intent.maxFeeSats,
    status: "not_found",
  }
}

function build(
  overrides: {
    assertBeforeSend?: () => void | Promise<void>
    getAvailableSats?: () => Promise<bigint>
    estimateFee?: () => Promise<number>
    sendFrozen?: () => Promise<unknown>
    reconcile?: (
      target: CheckoutSparkSettledOutgoingTarget
    ) => Promise<CheckoutSparkSettledOutgoingObservation>
  } = {}
) {
  const state = preparedSettledLegState()
  const target = outgoingTargetFor(state)
  const calls = { send: 0, guard: 0, reconcile: 0 }
  const provider = createCheckoutSparkSettledNativeOutgoingProvider({
    plan: state.plan,
    wallet: {
      getAvailableSats: overrides.getAvailableSats ?? (async () => 1_000n),
      estimateFee: overrides.estimateFee ?? (async () => 1),
      async sendFrozen() {
        calls.send += 1
        return overrides.sendFrozen?.()
      },
    },
    async reconcile(t) {
      calls.reconcile += 1
      return overrides.reconcile ? overrides.reconcile(t) : notFound(t)
    },
    async assertBeforeSend() {
      calls.guard += 1
      await overrides.assertBeforeSend?.()
    },
    now: () => NOW,
  })
  return { provider, target, calls }
}

const settle = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined as unknown, error })
  )

describe("native settled outgoing provider pre-admission boundary", () => {
  it("sends once and keeps a clean run un-typed (control)", async () => {
    const { provider, target, calls } = build()
    const { value, error } = await settle(provider.send(target))
    expect(error).toBeUndefined()
    expect(calls.send).toBe(1)
    // A returned SDK value and empty history is pending, never a receipt.
    expect((value as { status: string }).status).toBe("pending")
  })

  it("types an assertBeforeSend rejection as not admitted with zero sends", async () => {
    const failure = new Error("authority ended")
    const { provider, target, calls } = build({
      assertBeforeSend: () => {
        throw failure
      },
    })
    const { error } = await settle(provider.send(target))
    expect(error).toBeInstanceOf(CheckoutSparkOutgoingNotAdmittedError)
    expect((error as Error).cause).toBe(failure)
    expect(calls.send).toBe(0)
  })

  it("types a final-boundary guard rejection (after fee and history reads) as not admitted", async () => {
    // Two guard calls per currentSafety, three currentSafety calls before
    // sendFrozen: the sixth guard call is the last one before the SDK send.
    let guards = 0
    const failure = new Error("authority ended at final boundary")
    const { provider, target, calls } = build({
      assertBeforeSend: () => {
        guards += 1
        if (guards === 6) throw failure
      },
    })
    const { error } = await settle(provider.send(target))
    expect(guards).toBe(6)
    expect(error).toBeInstanceOf(CheckoutSparkOutgoingNotAdmittedError)
    expect((error as Error).cause).toBe(failure)
    expect(calls.send).toBe(0)
  })

  it("types a balance/fee-reading guard failure after reconcile as not admitted", async () => {
    // estimateFee itself is caught as "unavailable" (not_sent); a non-Error
    // authority throw thrown from the guard is still typed, never swallowed.
    const { provider, target, calls } = build({
      assertBeforeSend: () => {
        throw "string failure" as unknown as Error
      },
    })
    const { error } = await settle(provider.send(target))
    expect(error).toBeInstanceOf(CheckoutSparkOutgoingNotAdmittedError)
    expect(calls.send).toBe(0)
  })

  it("preserves an already-typed not-admitted error without re-wrapping", async () => {
    const typed = new CheckoutSparkOutgoingNotAdmittedError(new Error("x"))
    const { provider, target, calls } = build({
      assertBeforeSend: () => {
        throw typed
      },
    })
    const { error } = await settle(provider.send(target))
    expect(error).toBe(typed)
    expect(calls.send).toBe(0)
  })

  it("keeps an unverified-recipient guard as not_sent with zero sends (no typed throw)", async () => {
    const { provider, target, calls } = build({
      assertBeforeSend: () => {
        throw new CheckoutSparkInvoiceOriginUnavailableError()
      },
    })
    const { value, error } = await settle(provider.send(target))
    expect(error).toBeUndefined()
    expect(value).toEqual({ status: "not_sent" })
    expect(calls.send).toBe(0)
  })

  it("never types a sendFrozen throw: it stays possible-send and resolves pending", async () => {
    const { provider, target, calls } = build({
      sendFrozen: async () => {
        throw new Error("provider response lost")
      },
    })
    const { value, error } = await settle(provider.send(target))
    expect(calls.send).toBe(1)
    expect(error).toBeUndefined() // swallowed into a possible-send state, not a typed throw
    expect(value).not.toEqual({ status: "not_sent" })
    expect((value as { status: string }).status).toBe("pending")
  })

  it("never types a sendFrozen throw even if it throws a not-admitted look-alike field", async () => {
    // A look-alike object carrying `preAdmission: true` is not the typed signal.
    const lookAlike = Object.assign(new Error("lookalike"), {
      preAdmission: true,
    })
    const { provider, target, calls } = build({
      sendFrozen: async () => {
        throw lookAlike
      },
    })
    const { value, error } = await settle(provider.send(target))
    expect(calls.send).toBe(1)
    expect(error).toBeUndefined()
    expect(value).not.toEqual({ status: "not_sent" })
  })

  it("keeps post-send history unavailable as pending, never not_sent", async () => {
    let reads = 0
    const { provider, target, calls } = build({
      reconcile: async (t) => {
        reads += 1
        // Pre-send reads are clean; the post-send readback fails.
        if (sent()) throw new Error("history unavailable")
        return notFound(t)
      },
    })
    function sent() {
      return calls.send > 0
    }
    const { value, error } = await settle(provider.send(target))
    expect(reads).toBeGreaterThanOrEqual(3)
    expect(error).toBeUndefined()
    expect(calls.send).toBe(1)
    expect((value as { status: string }).status).toBe("pending")
  })
})
