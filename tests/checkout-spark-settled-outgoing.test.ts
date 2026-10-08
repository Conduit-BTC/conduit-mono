import { describe, expect, it } from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"
import { DexieCheckoutSparkSettledRepository } from "../packages/core/src/protocol/checkout-spark-settled-router-repository"

import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  type CheckoutSparkSettledReconciliation,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import { CONDUIT_CHECKOUT_FEE_RECIPIENT } from "../packages/core/src/protocol/checkout-spark-router-obligations"
import {
  runCheckoutSparkSettledOutgoingStep,
  assertCheckoutSparkOutgoingPreProviderRetry,
  hasCheckoutSparkOutgoingPreProviderCancellation,
  type CheckoutSparkSettledOutgoingObservation,
  type CheckoutSparkSettledOutgoingProvider,
  type CheckoutSparkSettledOutgoingStateStore,
  type CheckoutSparkSettledOutgoingTarget,
} from "../packages/core/src/protocol/checkout-spark-settled-outgoing"
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

function preparedStateWithUncertainSibling(
  status:
    "submitted" | "ambiguous" | "lookup_unavailable" | "conflicting_evidence"
): CheckoutSparkSettledReconciliation {
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
  return recordCheckoutSparkSettledLegStatus(withConduit, {
    legId: conduitLegId,
    transferId: withConduit.legs[1]!.intent!.transferId,
    paymentHash: "06".repeat(32),
    status,
    observedAt: CREATED_AT + 4,
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
  let failHandoffAt: number | null = null
  const handoffs: string[] = []
  const lookups: CheckoutSparkSettledOutgoingTarget[] = []
  const preflights: CheckoutSparkSettledOutgoingTarget[] = []
  const sends: CheckoutSparkSettledOutgoingTarget[] = []
  const statusAtSend: string[] = []
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
    set failHandoffAt(value: number | null) {
      failHandoffAt = value
    },
  }
}

describe("settled Spark outgoing step", () => {
  it("inspects exact not-found history without preflighting or sending", async () => {
    const run = harness()
    const result = await run.step("shopper", CREATED_AT + 3, undefined, true)
    expect(result.outcome).toBe("wait")
    expect(result.reason).toBe("inspection_only")
    expect(result.sendAttempted).toBe(false)
    expect(result.state.legs[0]!.status).toBe("prepared")
    expect(run.lookups).toHaveLength(1)
    expect(run.handoffs).toEqual([])
    expect(run.preflights).toHaveLength(0)
    expect(run.sends).toHaveLength(0)
  })

  it("can inspect exact paid history when a failed recovery ACK blocks a normal send", async () => {
    const run = harness()
    run.failHandoffAt = 1
    const blocked = await run.step()
    expect(blocked.reason).toBe("recovery_handoff_unavailable")
    expect(blocked.sendAttempted).toBe(false)
    expect(run.lookups).toHaveLength(0)
    expect(run.preflights).toHaveLength(0)
    expect(run.sends).toHaveLength(0)

    run.lookup = "paid"
    run.failHandoffAt = 2
    const inspected = await run.step("shopper", CREATED_AT + 3, undefined, true)
    expect(inspected.outcome).toBe("paid")
    expect(inspected.sendAttempted).toBe(false)
    expect(inspected.state.legs[0]!.status).toBe("paid")
    expect(run.lookups).toHaveLength(1)
    expect(run.handoffs).toEqual(["prepared"])
    expect(run.preflights).toHaveLength(0)
    expect(run.sends).toHaveLength(0)
  })

  it("records exact paid history during inspection without a new payment", async () => {
    const run = harness()
    run.lookup = "paid"
    const result = await run.step("shopper", CREATED_AT + 3, undefined, true)
    expect(result.outcome).toBe("paid")
    expect(result.sendAttempted).toBe(false)
    expect(result.state.legs[0]!.status).toBe("paid")
    expect(result.state.legs[0]!.finalDebitSats).toBe(999)
    expect(run.lookups).toHaveLength(1)
    expect(run.preflights).toHaveLength(0)
    expect(run.sends).toHaveLength(0)
  })

  it("keeps pending exact history ambiguous during inspection", async () => {
    const run = harness()
    run.lookup = "pending"
    const result = await run.step("shopper", CREATED_AT + 3, undefined, true)
    expect(result.reason).toBe("prior_possible_send")
    expect(result.state.legs[0]!.status).toBe("ambiguous")
    expect(result.sendAttempted).toBe(false)
    expect(run.preflights).toHaveLength(0)
    expect(run.sends).toHaveLength(0)
  })

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

  it("can inspect a short-window invoice without crossing a send boundary", async () => {
    const expiry = CREATED_AT + 59_000
    const cutoff = expiry
    const shortInvoice = invoice(995, 4, expiry / 1_000 - 3_600)
    const run = harness(preparedState(shortInvoice))
    const result = await run.step("shopper", cutoff, undefined, true)
    expect(result.reason).toBe("inspection_only")
    expect(run.lookups).toHaveLength(1)
    expect(run.preflights).toHaveLength(0)
    expect(run.sends).toHaveLength(0)
  })

  for (const seam of [
    "prepared_delivery",
    "preflight",
    "save",
    "submitted_delivery",
  ] as const) {
    it(`never sends when the short invoice expires during ${seam}, durably cancelling live admission`, async () => {
      const deadline = CREATED_AT + 59_000
      let now = CREATED_AT + 3
      const initial = preparedState(invoice(995, 4, deadline / 1_000 - 3_600))
      const expire = async () => {
        now = deadline
      }
      const run = harness(initial, {
        ...(seam === "preflight" ? { afterPreflight: expire } : {}),
        ...(seam === "save" ? { afterSave: expire } : {}),
        afterAcknowledgement: async (status) => {
          if (
            (seam === "prepared_delivery" && status === "prepared") ||
            (seam === "submitted_delivery" && status === "submitted")
          )
            await expire()
        },
      })
      const marked = seam === "save" || seam === "submitted_delivery"
      const result = await run.step("shopper", () => now)
      expect(result.reason).toBe("invoice_window_insufficient")
      expect(result.sendAttempted).toBe(false)
      expect(run.sends).toHaveLength(0)
      expect(run.state.legs[0]!.intent).toEqual(initial.legs[0]!.intent)
      expect(run.state.legs[0]!.status).toBe(
        marked ? "terminal_failure" : "prepared"
      )
      await run.step("shopper", () => now)
      expect(run.sends).toHaveLength(0)
    })
  }

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

  it("durably cancels a live submitted ACK failure before provider invocation", async () => {
    const initial = preparedState()
    const run = harness(initial)
    run.failHandoffAt = 2
    const blocked = await run.step()
    expect(blocked.reason).toBe("recovery_handoff_unavailable")
    expect(blocked.sendAttempted).toBe(false)
    expect(run.sends).toHaveLength(0)
    expect(run.state.legs[0]!.intent).toEqual(initial.legs[0]!.intent)
    expect(run.state.legs[0]!.status).toBe("terminal_failure")
    const originalIntent = run.state.legs[0]!.intent
    const resumed = await run.step()
    expect(resumed.outcome).toBe("paid")
    expect(run.sends).toHaveLength(1)
    expect(run.sends[0]!.intent).toEqual(originalIntent)
    expect(run.statusAtSend).toEqual(["submitted"])
    expect(run.handoffs).toEqual(["prepared", "submitted", "submitted", "paid"])
  })

  it("never recreates retry authority from cold or imported cancellation labels", async () => {
    const live = harness()
    live.failHandoffAt = 2
    await live.step()
    const cold = harness(structuredClone(live.state))
    expect((await cold.step()).reason).toBe("prior_possible_send")
    expect(cold.sends).toHaveLength(0)
    const initial = preparedState()
    const forged = harness(
      recordCheckoutSparkSettledLegStatus(initial, {
        legId: initial.legs[0]!.legId,
        transferId: initial.legs[0]!.intent!.transferId,
        paymentHash: initial.legs[0]!.intent!.paymentHash,
        status: "terminal_failure",
        observedAt: CREATED_AT + 3,
      })
    )
    expect((await forged.step()).reason).toBe("prior_possible_send")
    expect(forged.sends).toHaveLength(0)
  })

  it("inspects a live cancellation without preflight/send and preserves exact retry authority", async () => {
    const run = harness()
    run.failHandoffAt = 2
    await run.step()
    const preflights = run.preflights.length
    const handoffs = run.handoffs.length
    const inspected = await run.step("shopper", CREATED_AT + 4, undefined, true)
    expect(inspected.reason).toBe("prior_possible_send")
    expect(run.preflights).toHaveLength(preflights)
    expect(run.handoffs).toHaveLength(handoffs)
    expect(run.sends).toHaveLength(0)
    expect((await run.step()).outcome).toBe("paid")
    expect(run.sends).toHaveLength(1)
  })

  it.each(["before", "after", "readback"] as const)(
    "mints no authority after interrupted cancellation %s",
    async (seam) => {
      const run = harness()
      const save = run.store.save.bind(run.store)
      const load = run.store.load.bind(run.store)
      let interrupted = false
      run.store.save = async (next, revision) => {
        if (
          !interrupted &&
          next.legs[0]!.status === "terminal_failure" &&
          seam !== "readback"
        ) {
          interrupted = true
          if (seam === "after") await save(next, revision)
          throw new Error("Cancellation write interrupted")
        }
        return save(next, revision)
      }
      run.store.load = async (...args) => {
        const current = await load(...args)
        if (
          !interrupted &&
          seam === "readback" &&
          current.status === "active" &&
          current.state.legs[0]!.status === "terminal_failure"
        ) {
          interrupted = true
          throw new Error("Cancellation readback interrupted")
        }
        return current
      }
      run.failHandoffAt = 2
      await expect(run.step()).rejects.toThrow("interrupted")
      expect((await run.step()).reason).toBe("prior_possible_send")
      expect(run.sends).toHaveLength(0)
    }
  )

  it.each(["before", "after"] as const)(
    "never sends across an interrupted retry CAS %s",
    async (seam) => {
      const run = harness()
      run.failHandoffAt = 2
      await run.step()
      const retry = run.store.saveOutgoingPreProviderRetry!.bind(run.store)
      let interrupted = false
      run.store.saveOutgoingPreProviderRetry = async (...args) => {
        if (!interrupted) {
          interrupted = true
          if (seam === "after") await retry(...args)
          throw new Error("Retry admission interrupted")
        }
        return retry(...args)
      }
      await expect(run.step()).rejects.toThrow("interrupted")
      expect(run.sends).toHaveLength(0)
      const next = await run.step()
      expect(next.outcome).toBe(seam === "before" ? "paid" : "wait")
      expect(run.sends).toHaveLength(seam === "before" ? 1 : 0)
    }
  )

  it("invalidates live cancellation after a concurrent repository revision", async () => {
    const run = harness()
    run.failHandoffAt = 2
    await run.step()
    const current = await run.store.load(
      run.state.plan.checkoutId,
      run.state.plan.planDigest
    )
    if (current.status !== "active") throw new Error("Fixture is not active")
    await run.store.save(
      { ...current.state, updatedAt: current.state.updatedAt + 1 },
      current.revision
    )
    expect((await run.step()).reason).toBe("prior_possible_send")
    expect(run.sends).toHaveLength(0)
  })

  it("does not mint cancellation from an unreadable final submitted state", async () => {
    const run = harness()
    const load = run.store.load.bind(run.store)
    let unreadable = true
    run.store.load = async (...args) => {
      const current = await load(...args)
      if (
        unreadable &&
        current.status === "active" &&
        current.state.legs[0]!.status === "submitted"
      ) {
        unreadable = false
        throw new Error("Final state unavailable")
      }
      return current
    }
    await expect(run.step()).rejects.toThrow("unavailable")
    expect(run.state.legs[0]!.status).toBe("submitted")
    expect((await run.step()).reason).toBe("prior_possible_send")
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

  it("reports a depleted temporary wallet without attempting a payout", async () => {
    const run = harness()
    run.preflight = "insufficient_funds"
    const result = await run.step()
    expect(result.reason).toBe("insufficient_funds")
    expect(result.sendAttempted).toBe(false)
    expect(run.sends).toHaveLength(0)
  })

  it("keeps an invoked provider's not-sent label query-only for its frozen invoice", async () => {
    const run = harness()
    run.send = "not_sent"
    const first = await run.step()
    expect(first.reason).toBe("terminal_failure")
    expect(first.sendAttempted).toBe(true)
    expect(run.state.legs[0]!.status).toBe("terminal_failure")
    expect(run.statusAtSend).toEqual(["submitted"])

    run.send = "paid"
    const second = await run.step()
    expect(second.reason).toBe("prior_possible_send")
    expect(run.sends).toHaveLength(1)
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

  it("inspects Conduit exact history without relaxing merchant-first sends", async () => {
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
    run.lookup = "paid"
    const inspected = await run.step(
      "merchant",
      CREATED_AT + 60_001,
      conduitLegId,
      true
    )
    expect(inspected.outcome).toBe("paid")
    expect(inspected.sendAttempted).toBe(false)
    expect(run.lookups).toHaveLength(1)
    expect(run.handoffs).toHaveLength(0)
    expect(run.preflights).toHaveLength(0)
    expect(run.sends).toHaveLength(0)
    expect(run.state.legs[0]!.status).toBe("prepared")
    expect(run.state.legs[1]!.status).toBe("paid")
  })

  it("routes a credited checkout merchant-first without replaying an ambiguous transfer", async () => {
    const merchantPrepared = preparedState()
    const merchantLegId = merchantPrepared.plan.recipients[0]!.legId
    const conduitLegId = merchantPrepared.plan.recipients[1]!.legId
    let state = prepareCheckoutSparkSettledLeg(merchantPrepared, {
      legId: conduitLegId,
      transferId: deriveCheckoutSparkSettledTransferId(
        merchantPrepared.plan,
        conduitLegId
      ),
      paymentRequest: invoice(110, 6),
      paymentHash: "06".repeat(32),
      invoiceAmountSats: 110,
      maxFeeSats: 1,
      preparedAt: CREATED_AT + 3,
    })
    let revision = 1
    let merchantHistory: CheckoutSparkSettledOutgoingObservation["status"] =
      "not_found"
    const sends: string[] = []
    const handoffs: string[] = []
    const store: CheckoutSparkSettledOutgoingStateStore = {
      async load() {
        return { status: "active", revision, state: structuredClone(state) }
      },
      async save(next, expectedRevision) {
        expect(expectedRevision).toBe(revision)
        state = structuredClone(next)
        revision += 1
        return { status: "active", revision, state: structuredClone(state) }
      },
    }
    const provider: CheckoutSparkSettledOutgoingProvider = {
      async reconcile(target) {
        return observation(
          target,
          target.legId === merchantLegId ? merchantHistory : "not_found",
          target.legId === merchantLegId ? 4 : 1
        )
      },
      async preflight() {
        return "ready"
      },
      async send(target) {
        sends.push(target.legId)
        expect(handoffs.at(-1)).toBe("submitted")
        if (target.legId === merchantLegId) {
          throw new Error("merchant provider response lost")
        }
        expect(state.legs[0]!.status).toBe("paid")
        return observation(target, "paid", 1)
      },
    }
    const step = (legId: string) =>
      runCheckoutSparkSettledOutgoingStep({
        checkoutId: state.plan.checkoutId,
        planDigest: state.plan.planDigest,
        legId,
        actor: "shopper",
        now: () => CREATED_AT + 4,
        store,
        provider,
        acknowledgeRecoverySnapshot: async (snapshot) => {
          handoffs.push(
            snapshot.legs.find((leg) => leg.legId === legId)!.status
          )
        },
      })

    expect(state.credit?.creditedSats).toBe(1_111)
    expect((await step(conduitLegId)).reason).toBe("prerequisite_unpaid")
    expect((await step(merchantLegId)).outcome).toBe("send_ambiguous")
    expect(state.legs[0]!.status).toBe("submitted")
    expect((await step(conduitLegId)).reason).toBe("prerequisite_unpaid")
    expect((await step(merchantLegId)).reason).toBe("prior_possible_send")
    expect(sends).toEqual([merchantLegId])

    merchantHistory = "paid"
    expect((await step(merchantLegId)).outcome).toBe("paid")
    expect((await step(conduitLegId)).outcome).toBe("paid")
    expect(sends).toEqual([merchantLegId, conduitLegId])
    expect(state.legs.map((leg) => leg.status)).toEqual(["paid", "paid"])
  })

  it.each([
    "submitted",
    "ambiguous",
    "lookup_unavailable",
    "conflicting_evidence",
  ] as const)(
    "blocks ordinary payout before provider calls while a sibling is %s",
    async (siblingStatus) => {
      const run = harness(preparedStateWithUncertainSibling(siblingStatus))
      const result = await run.step("shopper", CREATED_AT + 5)
      expect(result.reason).toBe("sibling_possible_send")
      expect(result.sendAttempted).toBe(false)
      expect(run.lookups).toHaveLength(0)
      expect(run.handoffs).toHaveLength(0)
      expect(run.preflights).toHaveLength(0)
      expect(run.sends).toHaveLength(0)
    }
  )

  it.each([
    "submitted",
    "ambiguous",
    "lookup_unavailable",
    "conflicting_evidence",
  ] as const)(
    "inspects exact not-found history without a send when a sibling is %s",
    async (siblingStatus) => {
      const run = harness(preparedStateWithUncertainSibling(siblingStatus))
      const result = await run.step("shopper", CREATED_AT + 5, undefined, true)
      expect(result.outcome).toBe("wait")
      expect(result.reason).toBe("inspection_only")
      expect(result.sendAttempted).toBe(false)
      expect(result.state.legs[0]!.status).toBe("prepared")
      expect(result.state.legs[1]!.status).toBe(siblingStatus)
      expect(run.lookups).toHaveLength(1)
      expect(run.handoffs).toHaveLength(0)
      expect(run.preflights).toHaveLength(0)
      expect(run.sends).toHaveLength(0)
    }
  )

  it.each(["paid", "pending"] as const)(
    "reconciles exact %s history during inspection despite an uncertain sibling",
    async (history) => {
      const run = harness(preparedStateWithUncertainSibling("submitted"))
      run.lookup = history
      const result = await run.step("shopper", CREATED_AT + 5, undefined, true)
      expect(result.outcome).toBe(history === "paid" ? "paid" : "wait")
      expect(result.reason).toBe(
        history === "paid" ? undefined : "prior_possible_send"
      )
      expect(result.state.legs[0]!.status).toBe(
        history === "paid" ? "paid" : "ambiguous"
      )
      expect(result.state.legs[1]!.status).toBe("submitted")
      expect(result.sendAttempted).toBe(false)
      expect(run.lookups).toHaveLength(1)
      expect(run.handoffs).toHaveLength(0)
      expect(run.preflights).toHaveLength(0)
      expect(run.sends).toHaveLength(0)
    }
  )

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
