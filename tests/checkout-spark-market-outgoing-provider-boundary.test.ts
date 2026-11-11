import { describe, expect, it } from "bun:test"
import {
  CheckoutSparkInvoiceOriginUnavailableError,
  CheckoutSparkOutgoingNotAdmittedError,
} from "@conduit/core"
import { createCheckoutSparkSettledOutgoingProvider } from "../apps/market/src/lib/checkout-spark-settled-outgoing-provider"
import {
  outgoingTargetFor,
  preparedSettledLegState,
} from "./support/checkout-spark-settled-leg-fixture"

/**
 * Offline boundary proof for the market provider adapter over a fake Spark
 * manager. The manager stands in for the audited adapter: it invokes the
 * `assertBeforeSend` it is handed (as the real adapter does before the SDK
 * call) and then either returns or throws.
 */

type Manager = Parameters<
  typeof createCheckoutSparkSettledOutgoingProvider
>[0]["manager"]

function build(input: {
  availableSats?: () => Promise<number>
  assertBeforeSend?: () => Promise<void>
  send: (request: {
    assertBeforeSend?: () => Promise<void>
  }) => Promise<unknown>
}) {
  const state = preparedSettledLegState()
  const target = outgoingTargetFor(state)
  const calls = { send: 0, guard: 0 }
  const manager = {
    reconcileInvoiceAttempt: async () => {
      throw new Error("not used")
    },
    preflightCheckoutLightningObligation: async () => "ready",
    getFundsState: async () => ({
      availableSats: await (input.availableSats?.() ?? 1_000),
    }),
    sendCheckoutLightningObligation: async (
      _walletId: string,
      request: { assertBeforeSend?: () => Promise<void> }
    ) => {
      calls.send += 1
      return input.send(request)
    },
  } as unknown as Manager
  const provider = createCheckoutSparkSettledOutgoingProvider({
    plan: state.plan,
    manager,
    assertBeforeSend: async () => {
      calls.guard += 1
      await input.assertBeforeSend?.()
    },
  })
  return { provider, target, calls }
}

const settle = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined as unknown, error })
  )

describe("market settled outgoing provider send boundary", () => {
  it("preserves a NotAdmitted error (and its cause) when the guard is not a known not-sent reason", async () => {
    const cause = new Error("authority ended")
    const { provider, target } = build({
      assertBeforeSend: async () => {
        throw cause
      },
      send: async (request) => {
        // The adapter runs the guard before the SDK and types any rejection.
        try {
          await request.assertBeforeSend?.()
        } catch (error) {
          throw new CheckoutSparkOutgoingNotAdmittedError(error)
        }
        throw new Error("must not reach the SDK")
      },
    })
    const { value, error } = await settle(provider.send(target))
    expect(value).toBeUndefined()
    expect(error).toBeInstanceOf(CheckoutSparkOutgoingNotAdmittedError)
    expect((error as Error).cause).toBe(cause)
  })

  it("keeps invoice-origin rejection as not_sent, typed or not", async () => {
    for (const wrap of [true, false]) {
      const { provider, target } = build({
        assertBeforeSend: async () => {
          throw new CheckoutSparkInvoiceOriginUnavailableError()
        },
        send: async (request) => {
          try {
            await request.assertBeforeSend?.()
          } catch (error) {
            throw wrap
              ? new CheckoutSparkOutgoingNotAdmittedError(error)
              : error
          }
          return { status: "ambiguous" }
        },
      })
      const { value, error } = await settle(provider.send(target))
      expect(error).toBeUndefined()
      expect(value).toEqual({ status: "not_sent" })
    }
  })

  it("keeps a depleted reserve at the final boundary as not_sent", async () => {
    const { provider, target } = build({
      // A sibling share depleted the spendable balance after preflight.
      availableSats: async () => 10,
      send: async (request) => {
        try {
          await request.assertBeforeSend?.()
        } catch (error) {
          throw new CheckoutSparkOutgoingNotAdmittedError(error)
        }
        return { status: "ambiguous" }
      },
    })
    const { value, error } = await settle(provider.send(target))
    expect(error).toBeUndefined()
    expect(value).toEqual({ status: "not_sent" })
  })

  it("keeps an unavailable reserve read at the final boundary as not_sent", async () => {
    const { provider, target } = build({
      availableSats: async () => {
        throw new Error("funds state unavailable")
      },
      send: async (request) => {
        try {
          await request.assertBeforeSend?.()
        } catch (error) {
          throw new CheckoutSparkOutgoingNotAdmittedError(error)
        }
        return { status: "ambiguous" }
      },
    })
    const { value, error } = await settle(provider.send(target))
    expect(error).toBeUndefined()
    expect(value).toEqual({ status: "not_sent" })
  })

  it("propagates an untyped (post-SDK-entry) error unchanged, never not_sent", async () => {
    const failure = new Error("sdk failed after entry")
    const { provider, target, calls } = build({
      send: async () => {
        throw failure
      },
    })
    const { value, error } = await settle(provider.send(target))
    expect(calls.send).toBe(1)
    expect(value).toBeUndefined()
    expect(error).toBe(failure)
    expect(error).not.toBeInstanceOf(CheckoutSparkOutgoingNotAdmittedError)
  })

  it("does not downgrade an untyped error that merely carries a known not-sent cause", async () => {
    // A raw post-entry throw wrapping an origin error is NOT a guard rejection:
    // only a NotAdmitted wrapper or the bare guard error is a known pre-send.
    const failure = new Error("post-entry", {
      cause: new CheckoutSparkInvoiceOriginUnavailableError(),
    })
    const { provider, target } = build({
      send: async () => {
        throw failure
      },
    })
    const { value, error } = await settle(provider.send(target))
    expect(value).toBeUndefined()
    expect(error).toBe(failure)
  })

  it("never treats a not_found/ambiguous send result as not sent", async () => {
    const { provider, target } = build({
      send: async () => ({ status: "ambiguous" }),
    })
    // `ambiguous` routes through reconcile (not stubbed): it must surface as a
    // failure rather than collapse into not_sent.
    const { value, error } = await settle(provider.send(target))
    expect(value).not.toEqual({ status: "not_sent" })
    expect(error).toBeInstanceOf(Error)
  })

  it("passes an adapter not_sent through as not_sent", async () => {
    const { provider, target } = build({
      send: async () => ({ status: "not_sent", reason: "fee_over_cap" }),
    })
    const { value, error } = await settle(provider.send(target))
    expect(error).toBeUndefined()
    expect(value).toEqual({ status: "not_sent" })
  })
})
