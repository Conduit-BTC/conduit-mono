import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"

import { ConduitDB } from "@conduit/core/db"

import {
  applyCheckoutSparkEvidence,
  CheckoutSparkRepositoryConflictError,
  createCheckoutSparkReconciliation,
  DexieCheckoutSparkRepository,
  freezeCheckoutSparkPlan,
  getCheckoutSparkNextAction,
  runCheckoutSparkOutgoingStep,
  type CheckoutSparkKnownNotSent,
  type CheckoutSparkOutgoingObservation,
  type CheckoutSparkOutgoingProvider,
  type CheckoutSparkOutgoingStateStore,
  type CheckoutSparkOutgoingTarget,
  type CheckoutSparkReconciliation,
} from "@conduit/core"

const CREATED_AT = 1_800_000_000_000

async function withDatabase(
  run: (
    repository: DexieCheckoutSparkRepository,
    database: ConduitDB
  ) => Promise<void>
): Promise<void> {
  const database = new ConduitDB(
    `conduit-checkout-step-${crypto.randomUUID()}`,
    { indexedDB, IDBKeyRange }
  )
  try {
    await run(new DexieCheckoutSparkRepository(database), database)
  } finally {
    database.close()
    await database.delete()
  }
}

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

async function readyPreflight(): Promise<"ready"> {
  return "ready"
}

function memoryStore(initial: CheckoutSparkReconciliation) {
  let state = structuredClone(initial)
  let revision = 1
  let saves = 0
  let failSaveAt: number | null = null
  let afterSave: ((count: number) => void) | null = null
  const store: CheckoutSparkOutgoingStateStore = {
    async load(checkoutId, planDigest) {
      if (
        checkoutId !== state.plan.checkoutId ||
        planDigest !== state.plan.planDigest
      ) {
        throw new CheckoutSparkRepositoryConflictError()
      }
      return { status: "active", revision, state: structuredClone(state) }
    },
    async save(next, expectedRevision) {
      saves += 1
      if (saves === failSaveAt) throw new Error("local write failed")
      if (expectedRevision !== revision) {
        throw new CheckoutSparkRepositoryConflictError()
      }
      state = structuredClone(next)
      revision += 1
      afterSave?.(saves)
      return { status: "active", revision, state: structuredClone(state) }
    },
  }
  return {
    store,
    get state() {
      return state
    },
    get saves() {
      return saves
    },
    setFailSaveAt(value: number) {
      failSaveAt = value
    },
    onSave(callback: (count: number) => void) {
      afterSave = callback
    },
  }
}

function harness(initial = fundedState()) {
  const memory = memoryStore(initial)
  let now = CREATED_AT + 10
  const reads: CheckoutSparkOutgoingTarget[] = []
  const preflights: CheckoutSparkOutgoingTarget[] = []
  const sends: CheckoutSparkOutgoingTarget[] = []
  let lookupState: CheckoutSparkOutgoingObservation["state"] = "not_found"
  let sendState: CheckoutSparkOutgoingObservation["state"] = "paid"
  let knownNotSent: CheckoutSparkKnownNotSent | null = null
  let lookupFailure = false
  let sendFailure = false
  let preflightState: "ready" | "fee_over_cap" | "unavailable" = "ready"
  let onLookup: (() => void) | null = null
  let onPreflight: (() => void) | null = null
  const provider: CheckoutSparkOutgoingProvider = {
    async reconcile(target) {
      reads.push(target)
      onLookup?.()
      if (lookupFailure) throw new Error("provider unavailable")
      return observation(target, lookupState)
    },
    async preflight(target) {
      preflights.push(target)
      onPreflight?.()
      return preflightState
    },
    async send(target) {
      sends.push(target)
      if (sendFailure) throw new Error("response lost")
      if (knownNotSent) return knownNotSent
      return observation(target, sendState)
    },
  }
  const step = (actor: "shopper" | "merchant" = "shopper") =>
    runCheckoutSparkOutgoingStep({
      planDigest: initial.plan.planDigest,
      checkoutId: initial.plan.checkoutId,
      actor,
      now: () => now,
      store: memory.store,
      provider,
    })
  return {
    step,
    reads,
    preflights,
    sends,
    get state() {
      return memory.state
    },
    get saves() {
      return memory.saves
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
    setKnownNotSent(value: CheckoutSparkKnownNotSent | null) {
      knownNotSent = value
    },
    setPreflightState(value: typeof preflightState) {
      preflightState = value
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
      memory.setFailSaveAt(value)
    },
    onLookup(callback: () => void) {
      onLookup = callback
    },
    onPreflight(callback: () => void) {
      onPreflight = callback
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
        checkoutId: state.plan.checkoutId,
        planDigest: state.plan.planDigest,
        actor: "unexpected" as "shopper",
        now: () => CREATED_AT + 10,
        store: {
          async load() {
            accessed = true
            return { status: "active" as const, revision: 1, state }
          },
          async save() {
            accessed = true
            return { status: "active" as const, revision: 2, state }
          },
        },
        provider: {
          preflight: readyPreflight,
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

  it.each(["fee_over_cap", "unavailable"] as const)(
    "keeps an unpaid obligation retryable when fee preflight is %s",
    async (preflightState) => {
      const run = harness()
      run.setPreflightState(preflightState)
      const blocked = await run.step()
      expect(blocked.sendAttempted).toBe(false)
      expect(blocked.nextAction).toEqual({
        type: "wait",
        reason:
          preflightState === "fee_over_cap"
            ? "fee_exceeds_frozen_limit"
            : "fee_preflight_unavailable",
      })
      expect(blocked.state.obligations[0]!.state).toBe("not_found")
      expect(run.saves).toBe(1)
      expect(run.preflights).toHaveLength(1)
      expect(run.sends).toHaveLength(0)

      run.setPreflightState("ready")
      const completed = await run.step()
      expect(completed.state.obligations[0]!.state).toBe("paid")
      expect(run.preflights).toHaveLength(2)
      expect(run.sends.map((target) => target.idempotencyKey)).toEqual([
        blocked.state.plan.obligations[0]!.outgoingId,
      ])
    }
  )

  it.each(["fee_over_cap", "fee_unavailable"] as const)(
    "clears only a proven %s no-send after the possible-send save",
    async (reason) => {
      const run = harness()
      run.setKnownNotSent({ status: "not_sent", reason })
      const blocked = await run.step()
      expect(blocked.sendAttempted).toBe(false)
      expect(blocked.state.obligations[0]!.state).toBe("not_found")
      expect(blocked.nextAction).toEqual({
        type: "wait",
        reason:
          reason === "fee_over_cap"
            ? "fee_exceeds_frozen_limit"
            : "fee_preflight_unavailable",
      })
      expect(run.saves).toBe(3)

      run.setKnownNotSent(null)
      const completed = await run.step()
      expect(completed.state.obligations[0]!.state).toBe("paid")
      expect(run.sends.map((target) => target.idempotencyKey)).toEqual([
        blocked.state.plan.obligations[0]!.outgoingId,
        blocked.state.plan.obligations[0]!.outgoingId,
      ])
    }
  )

  it("does not clear possible-send for a malformed no-send claim", async () => {
    const run = harness()
    run.setKnownNotSent({ status: "not_sent", reason: "unknown" } as never)
    const result = await run.step()
    expect(result.sendAttempted).toBe(true)
    expect(result.state.obligations[0]!.state).toBe("ambiguous")
    expect(run.saves).toBe(2)
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

  it("does not write possible-send if shopper authority expires during fee preflight", async () => {
    const run = harness()
    run.onPreflight(() => run.setNow(CREATED_AT + 100))
    const shopper = await run.step("shopper")
    expect(shopper.sendAttempted).toBe(false)
    expect(shopper.state.obligations[0]!.state).toBe("not_found")
    expect(run.saves).toBe(1)
    expect(run.sends).toHaveLength(0)
  })

  it("clears its own unsent marker if takeover occurs during the durable save", async () => {
    const initial = fundedState()
    const memory = memoryStore(initial)
    let now = initial.plan.takeoverAt - 1
    let sends = 0
    memory.onSave((count) => {
      if (count === 2) now = initial.plan.takeoverAt
    })
    const base = {
      checkoutId: initial.plan.checkoutId,
      planDigest: initial.plan.planDigest,
      now: () => now,
      store: memory.store,
      provider: {
        preflight: readyPreflight,
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
    expect(memory.saves).toBe(3)
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
    const memory = memoryStore(state)
    let sent = false
    await expect(
      runCheckoutSparkOutgoingStep({
        checkoutId: state.plan.checkoutId,
        planDigest: state.plan.planDigest,
        actor: "shopper",
        now: () => CREATED_AT + 10,
        store: memory.store,
        provider: {
          preflight: readyPreflight,
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
    const memory = memoryStore(state)
    let sent = false
    await expect(
      runCheckoutSparkOutgoingStep({
        checkoutId: state.plan.checkoutId,
        planDigest: state.plan.planDigest,
        actor: "shopper",
        now: () => CREATED_AT + 10,
        store: memory.store,
        provider: {
          preflight: readyPreflight,
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
    expect(memory.saves).toBe(0)
    expect(sent).toBe(false)
    expect(state.obligations[1]!.state).toBe("unreconciled")
  })

  it("keeps the possible-send marker when send returns another planned obligation", async () => {
    const state = fundedState()
    const memory = memoryStore(state)
    let sends = 0
    const input = {
      checkoutId: state.plan.checkoutId,
      planDigest: state.plan.planDigest,
      actor: "shopper" as const,
      now: () => CREATED_AT + 10,
      store: memory.store,
      provider: {
        preflight: readyPreflight,
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
    const memory = memoryStore(state)
    let sends = 0
    const input = {
      checkoutId: state.plan.checkoutId,
      planDigest: state.plan.planDigest,
      actor: "shopper" as const,
      now: () => CREATED_AT + 10,
      store: memory.store,
      provider: {
        preflight: readyPreflight,
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
    const memory = memoryStore(state)
    let providerCalled = false
    await expect(
      runCheckoutSparkOutgoingStep({
        checkoutId: state.plan.checkoutId,
        planDigest: state.plan.planDigest,
        actor: "merchant",
        now: () => CREATED_AT + 101,
        store: memory.store,
        provider: {
          preflight: readyPreflight,
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

  it("lets only one competing invocation cross the durable write-ahead boundary", async () => {
    await withDatabase(async (repository) => {
      const initial = fundedState()
      await repository.create(initial.plan)
      await repository.save(initial, 1)
      let lookups = 0
      let releaseLookups!: () => void
      const bothLoaded = new Promise<void>((resolve) => {
        releaseLookups = resolve
      })
      const sends: string[] = []
      const provider: CheckoutSparkOutgoingProvider = {
        preflight: readyPreflight,
        async reconcile(target) {
          lookups += 1
          if (lookups === 2) releaseLookups()
          await bothLoaded
          return observation(target, "not_found")
        },
        async send(target) {
          sends.push(target.idempotencyKey)
          return observation(target, "paid")
        },
      }
      const input = {
        checkoutId: initial.plan.checkoutId,
        planDigest: initial.plan.planDigest,
        actor: "shopper" as const,
        now: () => CREATED_AT + 10,
        store: repository,
        provider,
      }
      const results = await Promise.allSettled([
        runCheckoutSparkOutgoingStep(input),
        runCheckoutSparkOutgoingStep(input),
      ])
      expect(lookups).toBe(2)
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1)
      expect(
        results.filter((result) => result.status === "rejected")
      ).toHaveLength(1)
      const rejected = results.find((result) => result.status === "rejected")
      expect(rejected?.status).toBe("rejected")
      if (rejected?.status === "rejected") {
        expect(rejected.reason).toBeInstanceOf(
          CheckoutSparkRepositoryConflictError
        )
      }
      expect(sends).toEqual([initial.plan.obligations[0]!.outgoingId])
      const latest = await repository.load(
        initial.plan.checkoutId,
        initial.plan.planDigest
      )
      expect(latest.status).toBe("active")
      if (latest.status === "active") {
        expect(latest.state.obligations[0]!.state).toBe("paid")
      }
    })
  })

  it("rejects a stale write-ahead revision before calling the provider send", async () => {
    await withDatabase(async (repository) => {
      const initial = fundedState()
      await repository.create(initial.plan)
      await repository.save(initial, 1)
      let raced = false
      let sends = 0
      const store: CheckoutSparkOutgoingStateStore = {
        load: (checkoutId, planDigest) =>
          repository.load(checkoutId, planDigest),
        async save(next, expectedRevision) {
          if (!raced && next.obligations[0]?.state === "ambiguous") {
            raced = true
            const current = await repository.load(
              initial.plan.checkoutId,
              initial.plan.planDigest
            )
            expect(current.status).toBe("active")
            if (current.status !== "active") {
              throw new Error("active state was retired before the test race")
            }
            const obligation = initial.plan.obligations[0]!
            await repository.save(
              applyCheckoutSparkEvidence(current.state, {
                type: "obligation",
                ...observation(
                  {
                    walletId: initial.plan.walletId,
                    network: initial.plan.network,
                    obligation,
                    idempotencyKey: obligation.outgoingId,
                  },
                  "pending"
                ),
                observedAt: CREATED_AT + 20,
              }),
              current.revision
            )
          }
          return repository.save(next, expectedRevision)
        },
      }
      await expect(
        runCheckoutSparkOutgoingStep({
          checkoutId: initial.plan.checkoutId,
          planDigest: initial.plan.planDigest,
          actor: "shopper",
          now: () => CREATED_AT + 10,
          store,
          provider: {
            preflight: readyPreflight,
            async reconcile(target) {
              return observation(target, "not_found")
            },
            async send(target) {
              sends += 1
              return observation(target, "paid")
            },
          },
        })
      ).rejects.toBeInstanceOf(CheckoutSparkRepositoryConflictError)
      expect(raced).toBe(true)
      expect(sends).toBe(0)
      const latest = await repository.load(
        initial.plan.checkoutId,
        initial.plan.planDigest
      )
      expect(latest.status).toBe("active")
      if (latest.status === "active") {
        expect(latest.state.obligations[0]!.state).toBe("pending")
      }
    })
  })

  it("keeps ambiguous recovery after a post-send CAS conflict and reconciles exact history", async () => {
    await withDatabase(async (repository, database) => {
      const initial = fundedState()
      await repository.create(initial.plan)
      await repository.save(initial, 1)
      let raced = false
      let sends = 0
      let providerState: CheckoutSparkOutgoingObservation["state"] = "not_found"
      const store: CheckoutSparkOutgoingStateStore = {
        load: (checkoutId, planDigest) =>
          repository.load(checkoutId, planDigest),
        async save(next, expectedRevision) {
          if (!raced && next.obligations[0]?.state === "paid") {
            raced = true
            const current = await repository.load(
              initial.plan.checkoutId,
              initial.plan.planDigest
            )
            expect(current.status).toBe("active")
            if (current.status !== "active") {
              throw new Error("possible-send marker was not persisted")
            }
            expect(current.state.obligations[0]!.state).toBe("ambiguous")
            await repository.save(current.state, current.revision)
          }
          return repository.save(next, expectedRevision)
        },
      }
      const input = {
        checkoutId: initial.plan.checkoutId,
        planDigest: initial.plan.planDigest,
        actor: "shopper" as const,
        now: () => CREATED_AT + 10,
        store,
        provider: {
          preflight: readyPreflight,
          async reconcile(target: CheckoutSparkOutgoingTarget) {
            return observation(target, providerState)
          },
          async send(target: CheckoutSparkOutgoingTarget) {
            sends += 1
            providerState = "paid"
            return observation(target, "paid")
          },
        },
      }
      await expect(runCheckoutSparkOutgoingStep(input)).rejects.toBeInstanceOf(
        CheckoutSparkRepositoryConflictError
      )
      expect(raced).toBe(true)
      expect(sends).toBe(1)
      const afterConflict = await repository.load(
        initial.plan.checkoutId,
        initial.plan.planDigest
      )
      expect(afterConflict.status).toBe("active")
      if (afterConflict.status === "active") {
        expect(afterConflict.state.obligations[0]!.state).toBe("ambiguous")
      }

      const reopened = new DexieCheckoutSparkRepository(database)
      const recovered = await runCheckoutSparkOutgoingStep({
        ...input,
        store: reopened,
      })
      expect(recovered.sendAttempted).toBe(false)
      expect(recovered.state.obligations[0]!.state).toBe("paid")
      expect(sends).toBe(1)
    })
  })

  it("reloads a cleared no-send marker and retries only the same outgoing ID", async () => {
    await withDatabase(async (repository, database) => {
      const initial = fundedState()
      await repository.create(initial.plan)
      await repository.save(initial, 1)
      const sentIds: string[] = []
      let feeOverCap = true
      const input = {
        checkoutId: initial.plan.checkoutId,
        planDigest: initial.plan.planDigest,
        actor: "shopper" as const,
        now: () => CREATED_AT + 10,
        store: repository,
        provider: {
          preflight: readyPreflight,
          async reconcile(target: CheckoutSparkOutgoingTarget) {
            return observation(target, "not_found")
          },
          async send(target: CheckoutSparkOutgoingTarget) {
            if (feeOverCap) {
              return {
                status: "not_sent" as const,
                reason: "fee_over_cap" as const,
              }
            }
            sentIds.push(target.idempotencyKey)
            return observation(target, "paid")
          },
        },
      }
      const first = await runCheckoutSparkOutgoingStep(input)
      expect(first.sendAttempted).toBe(false)
      expect(first.state.obligations[0]!.state).toBe("not_found")
      expect(sentIds).toHaveLength(0)

      feeOverCap = false
      const reopened = new DexieCheckoutSparkRepository(database)
      const second = await runCheckoutSparkOutgoingStep({
        ...input,
        store: reopened,
      })
      expect(second.state.obligations[0]!.state).toBe("paid")
      expect(sentIds).toEqual([initial.plan.obligations[0]!.outgoingId])
    })
  })

  it("retains ambiguity if clearing a proven no-send marker loses the revision race", async () => {
    await withDatabase(async (repository) => {
      const initial = fundedState()
      await repository.create(initial.plan)
      await repository.save(initial, 1)
      let saves = 0
      const store: CheckoutSparkOutgoingStateStore = {
        load: (checkoutId, planDigest) =>
          repository.load(checkoutId, planDigest),
        async save(next, expectedRevision) {
          saves += 1
          if (saves === 3) {
            const current = await repository.load(
              initial.plan.checkoutId,
              initial.plan.planDigest
            )
            expect(current.status).toBe("active")
            if (current.status !== "active") {
              throw new Error("possible-send marker was not persisted")
            }
            expect(current.state.obligations[0]!.state).toBe("ambiguous")
            await repository.save(current.state, current.revision)
          }
          return repository.save(next, expectedRevision)
        },
      }
      await expect(
        runCheckoutSparkOutgoingStep({
          checkoutId: initial.plan.checkoutId,
          planDigest: initial.plan.planDigest,
          actor: "shopper",
          now: () => CREATED_AT + 10,
          store,
          provider: {
            preflight: readyPreflight,
            async reconcile(target) {
              return observation(target, "not_found")
            },
            async send() {
              return { status: "not_sent", reason: "fee_over_cap" }
            },
          },
        })
      ).rejects.toBeInstanceOf(CheckoutSparkRepositoryConflictError)
      const retained = await repository.load(
        initial.plan.checkoutId,
        initial.plan.planDigest
      )
      expect(retained.status).toBe("active")
      if (retained.status === "active") {
        expect(retained.state.obligations[0]!.state).toBe("ambiguous")
      }
    })
  })

  it("reloads the durable ambiguous marker after a lost send response without resending", async () => {
    await withDatabase(async (repository, database) => {
      const initial = fundedState()
      await repository.create(initial.plan)
      await repository.save(initial, 1)
      let sends = 0
      const input = {
        checkoutId: initial.plan.checkoutId,
        planDigest: initial.plan.planDigest,
        actor: "shopper" as const,
        now: () => CREATED_AT + 10,
        store: repository,
        provider: {
          preflight: readyPreflight,
          async reconcile(target: CheckoutSparkOutgoingTarget) {
            return observation(target, "not_found")
          },
          async send() {
            sends += 1
            throw new Error("response lost")
          },
        },
      }
      const first = await runCheckoutSparkOutgoingStep(input)
      expect(first.sendAttempted).toBe(true)
      expect(first.state.obligations[0]!.state).toBe("ambiguous")

      const reopened = new DexieCheckoutSparkRepository(database)
      const second = await runCheckoutSparkOutgoingStep({
        ...input,
        store: reopened,
      })
      expect(second.sendAttempted).toBe(false)
      expect(second.nextAction).toEqual({
        type: "wait",
        reason: "obligation_ambiguous",
      })
      expect(sends).toBe(1)
    })
  })
})
