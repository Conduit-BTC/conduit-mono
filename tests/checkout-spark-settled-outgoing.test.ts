import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"
import { DexieCheckoutSparkSettledRepository } from "../packages/core/src/protocol/checkout-spark-settled-router-repository"

import { CONDUIT_CHECKOUT_FEE_RECIPIENT } from "../packages/core/src/protocol/checkout-spark-router-obligations"
import {
  assertCheckoutSparkOutgoingPreProviderRetry,
  CheckoutSparkOutgoingNotAdmittedError,
  hasCheckoutSparkOutgoingPreProviderCancellation,
  runCheckoutSparkSettledOutgoingStep,
  type CheckoutSparkSettledOutgoingObservation,
  type CheckoutSparkSettledOutgoingProvider,
  type CheckoutSparkSettledOutgoingStateStore,
  type CheckoutSparkSettledOutgoingTarget,
} from "../packages/core/src/protocol/checkout-spark-settled-outgoing"
import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  type CheckoutSparkSettledReconciliation,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const CREATED_AT = 1_800_000_000_000
const MERCHANT = "a".repeat(64)

function invoice(
  amountSats: number,
  hashByte: number,
  createdAt = CREATED_AT / 1_000
): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function preparedState(
  payoutInvoice = invoice(995, 4)
): CheckoutSparkSettledReconciliation {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "checkout-1",
    orderId: "order-1",
    merchantPubkey: MERCHANT,
    walletId: "wallet-1",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 60_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:item`,
          productEventId: "b".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "receive-1",
      paymentRequest: invoice(1_113, 3),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"c".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: CREATED_AT / 1_000,
          },
        },
        weightSats: 1_000,
      },
      {
        kind: "conduit",
        recipientId: CONDUIT_CHECKOUT_FEE_RECIPIENT,
        destination: {
          type: "lightning_address",
          value: CONDUIT_CHECKOUT_FEE_RECIPIENT,
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: 111,
      },
    ],
  })
  const credited = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "funding-transfer-1",
      receiverIdentityPublicKey: `02${"c".repeat(64)}`,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: CREATED_AT + 1,
    }
  )
  const legId = plan.recipients[0]!.legId
  return prepareCheckoutSparkSettledLeg(credited, {
    legId,
    transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
    paymentRequest: payoutInvoice,
    paymentHash: "04".repeat(32),
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt: CREATED_AT + 2,
  })
}

function observation(
  target: CheckoutSparkSettledOutgoingTarget,
  status: CheckoutSparkSettledOutgoingObservation["status"],
  finalFeeSats = 4
): CheckoutSparkSettledOutgoingObservation {
  const identity = {
    legId: target.legId,
    transferId: target.intent.transferId,
    paymentRequest: target.intent.paymentRequest,
    paymentHash: target.intent.paymentHash,
    invoiceAmountSats: target.intent.invoiceAmountSats,
    maxFeeSats: target.intent.maxFeeSats,
  }
  return status === "paid"
    ? {
        ...identity,
        status,
        finalFeeSats,
        finalDebitSats: target.intent.invoiceAmountSats + finalFeeSats,
      }
    : { ...identity, status }
}

/**
 * Contract: an app-owned guard rejection raised before the SDK is entered is
 * the exported typed signal. A look-alike `{ preAdmission: true }` error is
 * deliberately not accepted as proof (see the safety control below).
 */
function preAdmissionGuardError(): Error {
  return new CheckoutSparkOutgoingNotAdmittedError(
    new Error("assertBeforeSend rejected before SDK entry")
  )
}

function harness(
  initial = preparedState(),
  hooks: {
    afterPreflight?: () => Promise<void>
    afterSave?: () => Promise<void>
    afterAcknowledgement?: (status: string) => Promise<void>
  } = {}
) {
  let state = structuredClone(initial)
  let revision = 1
  let failNextSave = false
  let lookup: CheckoutSparkSettledOutgoingObservation["status"] = "not_found"
  let send: CheckoutSparkSettledOutgoingObservation["status"] | "not_sent" =
    "paid"
  let preflight:
    "ready" | "fee_over_cap" | "insufficient_funds" | "unavailable" = "ready"
  let throwOnSend = false
  let preAdmissionGuardFailure = false
  let failHandoffAt: number | null = null
  const handoffs: string[] = []
  const lookups: CheckoutSparkSettledOutgoingTarget[] = []
  const preflights: CheckoutSparkSettledOutgoingTarget[] = []
  const sends: CheckoutSparkSettledOutgoingTarget[] = []
  const statusAtSend: string[] = []
  // Every snapshot the Merchant has ACKed, in order (full states, not labels).
  const acked: CheckoutSparkSettledReconciliation[] = []
  // Times the fake Spark SDK was actually entered (after app-owned guards).
  let sdkEntries = 0
  const store: CheckoutSparkSettledOutgoingStateStore = {
    outgoingAdmissionScope: Object.freeze({}),
    async saveOutgoingPreProviderRetry(next, expectedRevision, cancellation) {
      assertCheckoutSparkOutgoingPreProviderRetry(
        this.outgoingAdmissionScope!,
        state,
        next,
        expectedRevision,
        cancellation
      )
      return this.save(next, expectedRevision)
    },
    async load() {
      return { status: "active", revision, state: structuredClone(state) }
    },
    async save(next, expectedRevision) {
      if (failNextSave) throw new Error("durable save failed")
      if (expectedRevision !== revision) throw new Error("CAS conflict")
      state = structuredClone(next)
      revision += 1
      await hooks.afterSave?.()
      return { status: "active", revision, state: structuredClone(state) }
    },
  }
  const provider: CheckoutSparkSettledOutgoingProvider = {
    async reconcile(target) {
      lookups.push(target)
      return observation(target, lookup, Math.min(4, target.intent.maxFeeSats))
    },
    async preflight(target) {
      preflights.push(target)
      await hooks.afterPreflight?.()
      return preflight
    },
    async send(target) {
      sends.push(target)
      statusAtSend.push(state.legs[0]!.status)
      // App-owned guards (assertBeforeSend, reserve, dispatch authority) run
      // before the SDK; a throw here has not admitted any provider transfer.
      if (preAdmissionGuardFailure) throw preAdmissionGuardError()
      sdkEntries += 1
      if (throwOnSend) throw new Error("provider response lost")
      return send === "not_sent"
        ? { status: "not_sent" }
        : observation(target, send)
    },
  }
  const step = (
    actor: "shopper" | "merchant" = "shopper",
    now: number | (() => number) = CREATED_AT + 3,
    legId = initial.plan.recipients[0]!.legId,
    inspectionOnly = false
  ) =>
    runCheckoutSparkSettledOutgoingStep({
      checkoutId: initial.plan.checkoutId,
      planDigest: initial.plan.planDigest,
      legId,
      actor,
      ...(inspectionOnly ? { inspectionOnly: true } : {}),
      now: typeof now === "function" ? now : () => now,
      store,
      provider,
      acknowledgeRecoverySnapshot: async (snapshot) => {
        handoffs.push(snapshot.legs[0]!.status)
        acked.push(structuredClone(snapshot))
        if (handoffs.length === failHandoffAt) {
          throw new Error("recovery relay unavailable")
        }
        await hooks.afterAcknowledgement?.(snapshot.legs[0]!.status)
      },
    })
  return {
    step,
    store,
    provider,
    sends,
    lookups,
    preflights,
    statusAtSend,
    handoffs,
    acked,
    get sdkEntries() {
      return sdkEntries
    },
    get state() {
      return state
    },
    set lookup(value: typeof lookup) {
      lookup = value
    },
    set send(value: typeof send) {
      send = value
    },
    set preflight(value: typeof preflight) {
      preflight = value
    },
    set failNextSave(value: boolean) {
      failNextSave = value
    },
    set throwOnSend(value: boolean) {
      throwOnSend = value
    },
    set preAdmissionGuardFailure(value: boolean) {
      preAdmissionGuardFailure = value
    },
    set failHandoffAt(value: number | null) {
      failHandoffAt = value
    },
  }
}

describe("settled Spark outgoing step", () => {
  it("preserves conflicting exact history without attempting payment during inspection", async () => {
    const run = harness()
    run.lookup = "conflicting_evidence"
    const result = await run.step("shopper", CREATED_AT + 3, undefined, true)
    expect(result.reason).toBe("provider_evidence_conflicting")
    expect(result.state.legs[0]!.status).toBe("conflicting_evidence")
    expect(result.sendAttempted).toBe(false)
    expect(run.preflights).toHaveLength(0)
    expect(run.sends).toHaveLength(0)
  })

  it("blocks a send at the exact invoice window cutoff but permits the prior millisecond", async () => {
    const expiry = CREATED_AT + 59_000
    const cutoff = expiry
    const shortInvoice = invoice(995, 4, expiry / 1_000 - 3_600)
    const atCutoff = harness(preparedState(shortInvoice))
    const blocked = await atCutoff.step("shopper", cutoff)
    expect(blocked.reason).toBe("invoice_window_insufficient")
    expect(blocked.sendAttempted).toBe(false)
    expect(atCutoff.lookups).toHaveLength(1)
    expect(atCutoff.preflights).toHaveLength(0)
    expect(atCutoff.sends).toHaveLength(0)

    const beforeCutoff = harness(preparedState(shortInvoice))
    const paid = await beforeCutoff.step("shopper", cutoff - 1)
    expect(paid.outcome).toBe("paid")
    expect(beforeCutoff.preflights).toHaveLength(1)
    expect(beforeCutoff.sends).toHaveLength(1)
  })

  it("persists the exact possible-send marker before a bounded payment", async () => {
    const run = harness()
    const first = await run.step()
    expect(first.outcome).toBe("paid")
    expect(first.sendAttempted).toBe(true)
    expect(run.statusAtSend).toEqual(["submitted"])
    expect(run.handoffs).toEqual(["prepared", "submitted", "paid"])
    expect(run.state.legs[0]!.finalFeeSats).toBe(4)
    expect(run.state.legs[0]!.finalDebitSats).toBe(999)
    expect(
      run.sends[0]!.intent.invoiceAmountSats + run.sends[0]!.intent.maxFeeSats
    ).toBe(run.sends[0]!.allocationSats)
    expect((await run.step()).outcome).toBe("already_paid")
    expect(run.sends).toHaveLength(1)
  })

  it("never sends when the write-ahead durable save fails", async () => {
    const run = harness()
    run.failNextSave = true
    await expect(run.step()).rejects.toThrow("durable save failed")
    expect(run.sends).toHaveLength(0)
    expect(run.state.legs[0]!.status).toBe("prepared")
  })

  it("never sends if the submitted exact intent cannot reach Merchant", async () => {
    const run = harness()
    run.failHandoffAt = 2
    const outcome = await run.step()
    expect(outcome.reason).toBe("recovery_handoff_unavailable")
    expect(outcome.sendAttempted).toBe(false)
    expect(run.state.legs[0]!.status).toBe("terminal_failure")
    expect(run.sends).toHaveLength(0)
  })

  it("durably binds exact cancellation/retry to the real repository CAS", async () => {
    const initial = preparedState()
    const database = new ConduitDB(
      `outgoing-cancellation-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    try {
      await database.checkoutSparkPlanBindings.add({
        checkoutId: initial.plan.checkoutId,
        planDigest: initial.plan.planDigest,
      })
      await database.checkoutSparkReconciliations.add({
        checkoutId: initial.plan.checkoutId,
        revision: 1,
        state: initial,
      })
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const run = harness(initial)
      let acknowledgements = 0
      const step = (
        store: CheckoutSparkSettledOutgoingStateStore = repository
      ) =>
        runCheckoutSparkSettledOutgoingStep({
          checkoutId: initial.plan.checkoutId,
          planDigest: initial.plan.planDigest,
          legId: initial.legs[0]!.legId,
          actor: "shopper",
          now: () => CREATED_AT + 3,
          store,
          provider: run.provider,
          acknowledgeRecoverySnapshot: async () => {
            if (++acknowledgements === 2) throw new Error("Relay unavailable")
          },
        })
      expect((await step()).reason).toBe("recovery_handoff_unavailable")
      const cancelled = await repository.load(
        initial.plan.checkoutId,
        initial.plan.planDigest
      )
      if (cancelled.status !== "active")
        throw new Error("Fixture is not active")
      expect(cancelled.state.legs[0]!.status).toBe("terminal_failure")
      expect(
        hasCheckoutSparkOutgoingPreProviderCancellation(
          repository.outgoingAdmissionScope,
          cancelled.state,
          cancelled.revision,
          initial.legs[0]!.legId
        )
      ).toBe(true)
      const replay = {
        ...cancelled.state,
        legs: cancelled.state.legs.map((leg, index) =>
          index === 0
            ? {
                ...leg,
                status: "submitted" as const,
                observedAt: cancelled.state.updatedAt + 1,
              }
            : leg
        ),
        updatedAt: cancelled.state.updatedAt + 1,
      }
      await expect(
        repository.save(replay, cancelled.revision)
      ).rejects.toThrow()
      await expect(
        repository.saveOutgoingPreProviderRetry(
          replay,
          cancelled.revision,
          {} as never
        )
      ).rejects.toThrow()
      const store: CheckoutSparkSettledOutgoingStateStore = {
        outgoingAdmissionScope: repository.outgoingAdmissionScope,
        load: repository.load.bind(repository),
        save: repository.save.bind(repository),
        saveOutgoingPreProviderRetry: async (next, revision, capability) => {
          for (const [scope, state, expected] of [
            [{}, cancelled.state, revision],
            [repository.outgoingAdmissionScope, cancelled.state, revision + 1],
            [
              repository.outgoingAdmissionScope,
              { ...cancelled.state, updatedAt: cancelled.state.updatedAt + 1 },
              revision,
            ],
          ] as const)
            expect(() =>
              assertCheckoutSparkOutgoingPreProviderRetry(
                scope,
                state,
                next,
                expected,
                capability
              )
            ).toThrow()
          return repository.saveOutgoingPreProviderRetry(
            next,
            revision,
            capability
          )
        },
      }
      expect((await step(store)).outcome).toBe("paid")
      expect(run.sends).toHaveLength(1)
      expect(run.sends[0]!.intent).toEqual(initial.legs[0]!.intent)
      expect((await step()).outcome).toBe("already_paid")
      expect(run.sends).toHaveLength(1)
    } finally {
      await database.delete()
    }
  })

  it("keeps a possible send after a lost response and an empty later read", async () => {
    const run = harness()
    run.throwOnSend = true
    expect((await run.step()).outcome).toBe("send_ambiguous")
    expect(run.state.legs[0]!.status).toBe("submitted")
    run.throwOnSend = false
    expect((await run.step()).reason).toBe("prior_possible_send")
    expect(run.sends).toHaveLength(1)
  })

  it("treats a pending exact-history payment as possible-send before local send", async () => {
    const run = harness()
    run.lookup = "pending"
    expect((await run.step()).reason).toBe("prior_possible_send")
    expect(run.state.legs[0]!.status).toBe("ambiguous")
    run.lookup = "not_found"
    await run.step()
    expect(run.sends).toHaveLength(0)
  })

  it("pauses an over-budget fee without reserving another recipient's share", async () => {
    const run = harness()
    run.preflight = "fee_over_cap"
    const outcome = await run.step()
    expect(outcome.reason).toBe("fee_over_cap")
    expect(outcome.sendAttempted).toBe(false)
    expect(run.state.legs[0]!.status).toBe("prepared")
    expect(run.sends).toHaveLength(0)
  })

  it("blocks Conduit until required commerce payouts are conclusively paid", async () => {
    const initial = preparedState()
    const conduitLegId = initial.plan.recipients[1]!.legId
    const withConduit = prepareCheckoutSparkSettledLeg(initial, {
      legId: conduitLegId,
      transferId: deriveCheckoutSparkSettledTransferId(
        initial.plan,
        conduitLegId
      ),
      paymentRequest: invoice(110, 6),
      paymentHash: "06".repeat(32),
      invoiceAmountSats: 110,
      maxFeeSats: 1,
      preparedAt: CREATED_AT + 3,
    })
    const run = harness(withConduit)
    const result = await run.step("shopper", CREATED_AT + 4, conduitLegId)
    expect(result.reason).toBe("prerequisite_unpaid")
    expect(run.sends).toHaveLength(0)
  })

  it("does not let shopper and merchant both send across takeover", async () => {
    const run = harness()
    expect((await run.step("merchant")).reason).toBe("authority_not_started")
    expect((await run.step("shopper", CREATED_AT + 60_000)).reason).toBe(
      "authority_transferred"
    )
    expect(run.sends).toHaveLength(0)
  })

  it.each([false, true])(
    "rejects mismatched provider identity before sending (inspectionOnly=%s)",
    async (inspectionOnly) => {
      const initial = preparedState()
      const store: CheckoutSparkSettledOutgoingStateStore = {
        async load() {
          return { status: "active", revision: 1, state: initial }
        },
        async save() {
          throw new Error("should not save")
        },
      }
      let sends = 0
      let preflights = 0
      const provider: CheckoutSparkSettledOutgoingProvider = {
        async reconcile(target) {
          return { ...observation(target, "not_found"), transferId: "other" }
        },
        async preflight() {
          preflights += 1
          return "ready"
        },
        async send() {
          sends += 1
          throw new Error("should not send")
        },
      }
      await expect(
        runCheckoutSparkSettledOutgoingStep({
          checkoutId: initial.plan.checkoutId,
          planDigest: initial.plan.planDigest,
          legId: initial.plan.recipients[0]!.legId,
          actor: "shopper",
          inspectionOnly,
          now: () => CREATED_AT + 3,
          store,
          provider,
          acknowledgeRecoverySnapshot: async () => {},
        })
      ).rejects.toThrow("out of scope")
      expect(preflights).toBe(0)
      expect(sends).toBe(0)
    }
  )
})

function legEvidence(
  state: CheckoutSparkSettledReconciliation,
  status: "submitted" | "terminal_failure",
  observedAt: number
) {
  const leg = state.legs[0]!
  return {
    legId: leg.legId,
    transferId: leg.intent!.transferId,
    paymentHash: leg.intent!.paymentHash,
    status,
    observedAt,
  }
}

/**
 * Pre-admission contract (funded-checkout bug).
 *
 * The Merchant restores whatever recovery snapshot the Buyer last ACKed, and a
 * provider `not_found` never clears `submitted`. Therefore, once core knows no
 * provider call can have happened, the cancellation must reach the Merchant
 * (the LAST ACKed snapshot must equal the durable state), or the order is
 * stuck at `prior_possible_send` for a transfer that was never created.
 */
describe("settled Spark outgoing pre-admission cancellation", () => {
  const SHORT_INVOICE_EXPIRY = CREATED_AT + 59_000
  const shortInvoice = invoice(995, 4, SHORT_INVOICE_EXPIRY / 1_000 - 3_600)

  // D1: the clock crosses the authority/invoice boundary between the
  // `submitted` ACK and provider.send.
  it.each([
    {
      name: "Buyer takeover time passes",
      initial: () => preparedState(),
      lateAt: CREATED_AT + 60_000,
    },
    {
      name: "invoice send window closes",
      initial: () => preparedState(shortInvoice),
      lateAt: SHORT_INVOICE_EXPIRY,
    },
  ])(
    "D1: when the $name after the submitted ACK, the Merchant is not left holding a stale submitted snapshot",
    async ({ initial, lateAt }) => {
      let clock = CREATED_AT + 3
      const run = harness(initial(), {
        afterAcknowledgement: async (status) => {
          if (status === "submitted") clock = lateAt
        },
      })
      const outcome = await run.step("shopper", () => clock)

      // Scenario really reached the post-ACK window.
      expect(run.handoffs[0]).toBe("prepared")
      expect(run.handoffs[1]).toBe("submitted")
      // No provider call was ever made.
      expect(run.sends).toHaveLength(0)
      expect(run.sdkEntries).toBe(0)
      expect(outcome.sendAttempted).toBe(false)
      expect(outcome.outcome).toBe("wait")

      const durable = run.state.legs[0]!.status
      expect(durable).not.toBe("submitted")
      const lastAck = run.acked.at(-1)!
      // The Merchant must not restore `submitted` for a never-created transfer.
      expect(lastAck.legs[0]!.status).toBe(durable)
      expect(lastAck).toEqual(run.state)
    }
  )

  // D2: app-owned guard throws before the SDK is entered.
  it("D2: an app guard rejection before SDK entry is not classified send_ambiguous / sendAttempted", async () => {
    const run = harness()
    run.preAdmissionGuardFailure = true
    const outcome = await run.step()

    expect(run.sdkEntries).toBe(0)
    expect(outcome.outcome).not.toBe("send_ambiguous")
    expect(outcome.sendAttempted).toBe(false)

    const durable = run.state.legs[0]!.status
    expect(durable).not.toBe("submitted")
    // Merchant must not be left restoring `submitted` either.
    expect(run.acked.at(-1)!.legs[0]!.status).toBe(durable)
    expect(run.acked.at(-1)).toEqual(run.state)
  })

  // D3: the cancellation write itself fails (e.g. automatic session revoked
  // after `submitted` was saved).
  //
  // CORRECT CONTRACT (documented): if core knows no send happened but cannot
  // persist the cancellation, it can never silently leave an ACKed `submitted`
  // behind a generic error. It must either (a) end non-submitted, or (b)
  // surface a typed, non-ambiguous pre-admission failure: a returned result
  // with sendAttempted === false and outcome !== "send_ambiguous", or a thrown
  // error with `preAdmission === true` (see preAdmissionGuardError()). A raw
  // `Error("durable save failed")` is unacceptable because callers treat
  // untyped throws as unknown.
  it("D3: a failing cancellation write never leaves an ACKed submitted behind an untyped error with zero sends", async () => {
    let clock = CREATED_AT + 3
    const run = harness(preparedState(), {
      afterAcknowledgement: async (status) => {
        if (status === "submitted") {
          clock = CREATED_AT + 60_000 // takeover passes
          run.failNextSave = true // session revoked: cancellation save throws
        }
      },
    })
    let thrown: unknown
    let outcome: Awaited<ReturnType<typeof run.step>> | undefined
    try {
      outcome = await run.step("shopper", () => clock)
    } catch (error) {
      thrown = error
    }
    expect(run.sends).toHaveLength(0)
    expect(run.sdkEntries).toBe(0)
    expect(run.handoffs).toContain("submitted")

    const durable = run.state.legs[0]!.status
    if (durable === "submitted") {
      // Branch (b): an unavoidable leftover must be typed and non-ambiguous.
      if (outcome) {
        expect(outcome.outcome).not.toBe("send_ambiguous")
        expect(outcome.sendAttempted).toBe(false)
      } else {
        expect((thrown as { preAdmission?: boolean }).preAdmission).toBe(true)
      }
    } else {
      // Branch (a): durable state moved off `submitted` and the Merchant knows.
      expect(run.acked.at(-1)!.legs[0]!.status).toBe(durable)
    }
  })
})

describe("settled Spark outgoing pre-admission cancellation store", () => {
  it("D1: records and ACKs the cancellation through the session-only view when the authority-fenced store rejects after takeover", async () => {
    let clock = CREATED_AT + 3
    let dispatchEnded = false
    const run = harness(preparedState(), {
      afterAcknowledgement: async (status) => {
        if (status === "submitted") {
          clock = CREATED_AT + 60_000
          dispatchEnded = true
        }
      },
    })
    const raw = {
      load: run.store.load.bind(run.store),
      save: run.store.save.bind(run.store),
    }
    const fenced =
      <A extends unknown[], R>(operation: (...args: A) => R) =>
      (...args: A): R => {
        if (dispatchEnded) throw new Error("dispatch authority ended")
        return operation(...args)
      }
    Object.assign(run.store, {
      load: fenced(raw.load),
      save: fenced(raw.save),
      preProviderCancellation: raw,
    })
    const outcome = await run.step("shopper", () => clock)
    expect(run.sends).toHaveLength(0)
    expect(outcome.sendAttempted).toBe(false)
    expect(outcome.reason).toBe("authority_transferred")
    expect(run.state.legs[0]!.status).toBe("terminal_failure")
    expect(run.acked.at(-1)).toEqual(run.state)
  })
})

/** SAFETY CONTROLS: must pass both before and after the fix. */
describe("settled Spark outgoing possible-send safety controls", () => {
  it("control (d): a look-alike preAdmission error that is not the typed signal stays send_ambiguous", async () => {
    const run = harness()
    run.provider.send = async () => {
      throw Object.assign(new Error("untyped guard"), { preAdmission: true })
    }
    const outcome = await run.step()
    expect(outcome.outcome).toBe("send_ambiguous")
    expect(outcome.sendAttempted).toBe(true)
    expect(run.state.legs[0]!.status).toBe("submitted")
  })

  it("control (a): a provider failure AFTER SDK entry stays send_ambiguous, sendAttempted and submitted", async () => {
    const run = harness()
    run.throwOnSend = true
    const outcome = await run.step()
    expect(run.sdkEntries).toBe(1)
    expect(outcome.outcome).toBe("send_ambiguous")
    expect(outcome.sendAttempted).toBe(true)
    expect(run.state.legs[0]!.status).toBe("submitted")
    // The ACKed snapshot is the same possible-send marker.
    expect(run.acked.at(-1)!.legs[0]!.status).toBe("submitted")
    run.throwOnSend = false
    expect((await run.step()).reason).toBe("prior_possible_send")
    expect(run.sends).toHaveLength(1)
  })

  it.each([
    ["shopper", CREATED_AT + 3],
    ["merchant", CREATED_AT + 60_001],
  ] as const)(
    "control (b): submitted + provider not_found is still prior_possible_send with zero resend (%s)",
    async (actor, now) => {
      const prepared = preparedState()
      const submitted = recordCheckoutSparkSettledLegStatus(
        prepared,
        legEvidence(prepared, "submitted", CREATED_AT + 10)
      )
      const run = harness(submitted)
      run.lookup = "not_found"
      const outcome = await run.step(actor, now)
      expect(outcome.reason).toBe("prior_possible_send")
      expect(outcome.sendAttempted).toBe(false)
      expect(run.lookups).toHaveLength(1)
      expect(run.preflights).toHaveLength(0)
      expect(run.sends).toHaveLength(0)
      expect(run.state.legs[0]!.status).toBe("submitted")
    }
  )

  it("control (c): a pre-admission cancelled leg is not re-sent without a live cancellation token", async () => {
    const first = harness()
    first.failHandoffAt = 2 // pre-admission cancellation (ACK of submitted fails)
    expect((await first.step()).reason).toBe("recovery_handoff_unavailable")
    expect(first.state.legs[0]!.status).toBe("terminal_failure")
    expect(first.sends).toHaveLength(0)

    // Simulated process restart / other origin: same durable state, but a
    // brand-new admission scope, so no cancellation capability exists.
    const restarted = harness(first.state)
    restarted.lookup = "not_found"
    for (const [actor, now] of [
      ["shopper", CREATED_AT + 4],
      ["merchant", CREATED_AT + 60_001],
    ] as const) {
      const outcome = await restarted.step(actor, now)
      expect(outcome.reason).toBe("prior_possible_send")
      expect(outcome.sendAttempted).toBe(false)
    }
    expect(restarted.preflights).toHaveLength(0)
    expect(restarted.sends).toHaveLength(0)
    expect(restarted.state.legs[0]!.status).toBe("terminal_failure")
  })
})
