import { describe, expect, it } from "bun:test"

import {
  applyCheckoutSparkEvidence,
  createCheckoutSparkReconciliation,
  freezeCheckoutSparkPlan,
  getCheckoutSparkNextAction,
  runCheckoutSparkOutgoingStep,
  type CheckoutSparkOutgoingObservation,
  type CheckoutSparkOutgoingProvider,
  type CheckoutSparkOutgoingStateStore,
  type CheckoutSparkOutgoingTarget,
  type CheckoutSparkReconciliation,
} from "@conduit/core"

const CREATED_AT = 1_800_000_000_000

function fundedState(): CheckoutSparkReconciliation {
  const plan = freezeCheckoutSparkPlan({
    checkoutId: "checkout-1",
    orderId: "order-1",
    merchantPubkey: "a".repeat(64),
    walletId: "wallet-1",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 100,
    funding: {
      requestId: "receive-1",
      paymentRequest: "lnbc-funding",
      paymentHash: "b".repeat(64),
      requiredNetSats: 1_235,
      grossFundingSats: 1_240,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 60_000,
    },
    obligations: [
      {
        kind: "merchant",
        recipientId: "a".repeat(64),
        paymentRequest: "lnbc-merchant",
        amountSats: 1_000,
        maxFeeSats: 100,
      },
      {
        kind: "conduit",
        recipientId: "conduit-test-recipient",
        paymentRequest: "lnbc-conduit",
        amountSats: 111,
        maxFeeSats: 24,
      },
    ],
  })
  return applyCheckoutSparkEvidence(createCheckoutSparkReconciliation(plan), {
    type: "funding",
    requestId: plan.funding.requestId,
    paymentRequest: plan.funding.paymentRequest,
    paymentHash: plan.funding.paymentHash,
    walletId: plan.walletId,
    network: plan.network,
    requiredNetSats: plan.funding.requiredNetSats,
    grossFundingSats: plan.funding.grossFundingSats,
    state: "spendable",
    observedAt: CREATED_AT + 1,
  })
}

function observation(
  target: CheckoutSparkOutgoingTarget,
  state: CheckoutSparkOutgoingObservation["state"]
): CheckoutSparkOutgoingObservation {
  return {
    obligationId: target.obligation.obligationId,
    outgoingId: target.obligation.outgoingId,
    paymentRequest: target.obligation.paymentRequest,
    amountSats: target.obligation.amountSats,
    maxFeeSats: target.obligation.maxFeeSats,
    state,
  }
}

function harness(initial = fundedState()) {
  let state = structuredClone(initial)
  let saves = 0
  let failSaveAt: number | null = null
  const store: CheckoutSparkOutgoingStateStore = {
    async load() {
      return structuredClone(state)
    },
    async save(next) {
      saves += 1
      if (saves === failSaveAt) throw new Error("local write failed")
      state = structuredClone(next)
    },
  }
  let now = CREATED_AT + 10
  const reads: CheckoutSparkOutgoingTarget[] = []
  const sends: CheckoutSparkOutgoingTarget[] = []
  let lookupState: CheckoutSparkOutgoingObservation["state"] = "not_found"
  let sendState: CheckoutSparkOutgoingObservation["state"] = "paid"
  let lookupFailure = false
  let sendFailure = false
  let onLookup: (() => void) | null = null
  const provider: CheckoutSparkOutgoingProvider = {
    async reconcile(target) {
      reads.push(target)
      onLookup?.()
      if (lookupFailure) throw new Error("provider unavailable")
      return observation(target, lookupState)
    },
    async send(target) {
      sends.push(target)
      if (sendFailure) throw new Error("response lost")
      return observation(target, sendState)
    },
  }
  const step = (actor: "shopper" | "merchant" = "shopper") =>
    runCheckoutSparkOutgoingStep({
      planDigest: initial.plan.planDigest,
      actor,
      now: () => now,
      store,
      provider,
    })
  return {
    step,
    reads,
    sends,
    get state() {
      return state
    },
    get saves() {
      return saves
    },
    setNow(value: number) {
      now = value
    },
    setLookupState(value: CheckoutSparkOutgoingObservation["state"]) {
      lookupState = value
    },
    setSendState(value: CheckoutSparkOutgoingObservation["state"]) {
      sendState = value
    },
    failLookup() {
      lookupFailure = true
    },
    restoreLookup() {
      lookupFailure = false
    },
    failSend() {
      sendFailure = true
    },
    failSaveAt(value: number) {
      failSaveAt = value
    },
    onLookup(callback: () => void) {
      onLookup = callback
    },
  }
}

describe("checkout Spark one-obligation step", () => {
  it("rejects an invalid runtime actor before store or provider access", async () => {
    const state = fundedState()
    expect(() =>
      getCheckoutSparkNextAction(state, {
        actor: "unexpected" as "shopper",
        now: CREATED_AT + 10,
      })
    ).toThrow("actor is invalid")

    let accessed = false
    await expect(
      runCheckoutSparkOutgoingStep({
        planDigest: state.plan.planDigest,
        actor: "unexpected" as "shopper",
        now: () => CREATED_AT + 10,
        store: {
          async load() {
            accessed = true
            return state
          },
          async save() {
            accessed = true
          },
        },
        provider: {
          async reconcile(target) {
            accessed = true
            return observation(target, "not_found")
          },
          async send(target) {
            accessed = true
            return observation(target, "paid")
          },
        },
      })
    ).rejects.toThrow("actor is invalid")
    expect(accessed).toBe(false)
  })

  it("queries exact provider history and persists possible send before paying one obligation", async () => {
    const run = harness()
    const result = await run.step()

    expect(result.sendAttempted).toBe(true)
    expect(result.state.obligations.map((item) => item.state)).toEqual([
      "paid",
      "unreconciled",
    ])
    expect(result.nextAction).toEqual({
      type: "reconcile_obligation",
      obligationId: result.state.plan.obligations[1]!.obligationId,
    })
    expect(run.reads).toHaveLength(1)
    expect(run.sends).toHaveLength(1)
    expect(run.sends[0]!.idempotencyKey).toBe(
      result.state.plan.obligations[0]!.outgoingId
    )
    expect(run.saves).toBe(3)
  })

  it("never sends twice after a lost response and reload with an empty lookup", async () => {
    const run = harness()
    run.failSend()
    const first = await run.step()
    expect(first.sendAttempted).toBe(true)
    expect(first.state.obligations[0]!.state).toBe("ambiguous")

    const second = await run.step()
    expect(second.sendAttempted).toBe(false)
    expect(second.nextAction).toEqual({
      type: "wait",
      reason: "obligation_ambiguous",
    })
    expect(run.sends).toHaveLength(1)

    run.setLookupState("paid")
    const recovered = await run.step()
    expect(recovered.state.obligations[0]!.state).toBe("paid")
    expect(run.sends).toHaveLength(1)
  })

  it("fails closed on lookup outage, then allows a conclusive unpaid lookup", async () => {
    const run = harness()
    run.failLookup()
    const blocked = await run.step()
    expect(blocked.nextAction).toEqual({
      type: "wait",
      reason: "evidence_unavailable",
    })
    expect(run.sends).toHaveLength(0)

    run.restoreLookup()
    const resolved = await run.step()
    expect(resolved.state.obligations[0]!.state).toBe("paid")
    expect(run.sends).toHaveLength(1)
  })

  it("does not turn a prior pending or conflicting outcome into a fresh send", async () => {
    for (const prior of [
      "pending",
      "ambiguous",
      "conflicting_evidence",
    ] as const) {
      const funded = fundedState()
      const obligation = funded.plan.obligations[0]!
      const state = applyCheckoutSparkEvidence(funded, {
        ...observation(
          {
            walletId: funded.plan.walletId,
            network: funded.plan.network,
            obligation,
            idempotencyKey: obligation.outgoingId,
          },
          prior
        ),
        type: "obligation",
        observedAt: CREATED_AT + 2,
      })
      const run = harness(state)
      const result = await run.step()
      expect(result.state.obligations[0]!.state).toBe(prior)
      expect(run.sends).toHaveLength(0)
    }
  })

  it("hands send authority to Merchant at the frozen boundary", async () => {
    const run = harness()
    run.onLookup(() => run.setNow(CREATED_AT + 100))
    const shopper = await run.step("shopper")
    expect(shopper.sendAttempted).toBe(false)
    expect(shopper.state.obligations[0]!.state).toBe("not_found")
    expect(run.sends).toHaveLength(0)

    const merchant = await run.step("merchant")
    expect(merchant.sendAttempted).toBe(true)
    expect(merchant.state.obligations[0]!.state).toBe("paid")
    expect(run.sends).toHaveLength(1)
  })

  it("clears its own unsent marker if takeover occurs during the durable save", async () => {
    const initial = fundedState()
    let persisted = initial
    let now = initial.plan.takeoverAt - 1
    let saves = 0
    let sends = 0
    const base = {
      planDigest: initial.plan.planDigest,
      now: () => now,
      store: {
        async load() {
          return persisted
        },
        async save(state: CheckoutSparkReconciliation) {
          persisted = state
          saves += 1
          if (saves === 2) now = initial.plan.takeoverAt
        },
      },
      provider: {
        async reconcile(target: CheckoutSparkOutgoingTarget) {
          return observation(target, "not_found")
        },
        async send(target: CheckoutSparkOutgoingTarget) {
          sends += 1
          return observation(target, "paid")
        },
      },
    }
    const shopper = await runCheckoutSparkOutgoingStep({
      ...base,
      actor: "shopper",
    })
    expect(shopper.sendAttempted).toBe(false)
    expect(shopper.state.obligations[0]!.state).toBe("not_found")
    expect(saves).toBe(3)
    expect(sends).toBe(0)

    const merchant = await runCheckoutSparkOutgoingStep({
      ...base,
      actor: "merchant",
    })
    expect(merchant.state.obligations[0]!.state).toBe("paid")
    expect(sends).toBe(1)
  })

  it("does not call the provider send when durable write-ahead persistence fails", async () => {
    const run = harness()
    run.failSaveAt(2)
    await expect(run.step()).rejects.toThrow("local write failed")
    expect(run.state.obligations[0]!.state).toBe("not_found")
    expect(run.sends).toHaveLength(0)
  })

  it("restores paid from exact provider history if saving the send result fails", async () => {
    const run = harness()
    run.failSaveAt(3)
    await expect(run.step()).rejects.toThrow("local write failed")
    expect(run.state.obligations[0]!.state).toBe("ambiguous")
    expect(run.sends).toHaveLength(1)

    run.setLookupState("paid")
    const recovered = await run.step()
    expect(recovered.state.obligations[0]!.state).toBe("paid")
    expect(run.sends).toHaveLength(1)
  })

  it("rejects an out-of-scope provider lookup before send", async () => {
    const state = fundedState()
    let sent = false
    await expect(
      runCheckoutSparkOutgoingStep({
        planDigest: state.plan.planDigest,
        actor: "shopper",
        now: () => CREATED_AT + 10,
        store: {
          async load() {
            return state
          },
          async save() {
            throw new Error("unreachable")
          },
        },
        provider: {
          async reconcile(target) {
            return { ...observation(target, "not_found"), outgoingId: "wrong" }
          },
          async send(target) {
            sent = true
            return observation(target, "paid")
          },
        },
      })
    ).rejects.toThrow("out of scope")
    expect(sent).toBe(false)
  })

  it("rejects a lookup for another obligation in the same plan", async () => {
    const state = fundedState()
    let saved = false
    let sent = false
    await expect(
      runCheckoutSparkOutgoingStep({
        planDigest: state.plan.planDigest,
        actor: "shopper",
        now: () => CREATED_AT + 10,
        store: {
          async load() {
            return state
          },
          async save() {
            saved = true
          },
        },
        provider: {
          async reconcile(target) {
            const other = state.plan.obligations[1]!
            return observation({ ...target, obligation: other }, "paid")
          },
          async send(target) {
            sent = true
            return observation(target, "paid")
          },
        },
      })
    ).rejects.toThrow("out of scope")
    expect(saved).toBe(false)
    expect(sent).toBe(false)
    expect(state.obligations[1]!.state).toBe("unreconciled")
  })

  it("keeps the possible-send marker when send returns another planned obligation", async () => {
    const state = fundedState()
    let persisted = state
    let sends = 0
    const input = {
      planDigest: state.plan.planDigest,
      actor: "shopper" as const,
      now: () => CREATED_AT + 10,
      store: {
        async load() {
          return persisted
        },
        async save(next: CheckoutSparkReconciliation) {
          persisted = next
        },
      },
      provider: {
        async reconcile(target: CheckoutSparkOutgoingTarget) {
          return observation(target, "not_found")
        },
        async send(target: CheckoutSparkOutgoingTarget) {
          sends += 1
          const other = state.plan.obligations[1]!
          return observation({ ...target, obligation: other }, "paid")
        },
      },
    }
    const first = await runCheckoutSparkOutgoingStep(input)
    expect(first.state.obligations.map((item) => item.state)).toEqual([
      "ambiguous",
      "unreconciled",
    ])
    const second = await runCheckoutSparkOutgoingStep(input)
    expect(second.state.obligations[0]!.state).toBe("ambiguous")
    expect(sends).toBe(1)
  })

  it("keeps the durable marker when a send response has conflicting terms", async () => {
    const state = fundedState()
    let persisted = state
    let sends = 0
    const input = {
      planDigest: state.plan.planDigest,
      actor: "shopper" as const,
      now: () => CREATED_AT + 10,
      store: {
        async load() {
          return persisted
        },
        async save(next: CheckoutSparkReconciliation) {
          persisted = next
        },
      },
      provider: {
        async reconcile(target: CheckoutSparkOutgoingTarget) {
          return observation(target, "not_found")
        },
        async send(target: CheckoutSparkOutgoingTarget) {
          sends += 1
          return {
            ...observation(target, "paid"),
            paymentRequest: "different-invoice",
          }
        },
      },
    }
    const first = await runCheckoutSparkOutgoingStep(input)
    expect(first.state.obligations[0]!.state).toBe("ambiguous")
    const second = await runCheckoutSparkOutgoingStep(input)
    expect(second.state.obligations[0]!.state).toBe("ambiguous")
    expect(sends).toBe(1)
  })

  it("does not send from Merchant when another local tab owns recovery", async () => {
    const state = fundedState()
    let providerCalled = false
    await expect(
      runCheckoutSparkOutgoingStep({
        planDigest: state.plan.planDigest,
        actor: "merchant",
        now: () => CREATED_AT + 101,
        store: {
          async load() {
            return state
          },
          async save() {
            throw new Error("unreachable")
          },
        },
        provider: {
          async reconcile(target) {
            providerCalled = true
            return observation(target, "not_found")
          },
          async send(target) {
            providerCalled = true
            return observation(target, "paid")
          },
        },
        merchantLockManager: {
          async request(_name, _options, callback) {
            return callback(null)
          },
        },
      })
    ).rejects.toThrow("already active")
    expect(providerCalled).toBe(false)
  })
})
