import { describe, expect, it } from "bun:test"
import {
  runCheckoutSparkFinancialWorkflow,
  type CheckoutSparkFinancialWorkflowPorts,
} from "../packages/core/src/protocol/checkout-spark-financial-workflow"
import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  restoreCheckoutSparkSettledReconciliation,
  retireCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledReconciliation,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import {
  CheckoutSparkSettledRepositoryConflictError,
  type CheckoutSparkSettledRepositorySnapshot,
} from "../packages/core/src/protocol/checkout-spark-settled-router-repository"
import type {
  CheckoutSparkSettledOutgoingObservation,
  CheckoutSparkSettledOutgoingTarget,
} from "../packages/core/src/protocol/checkout-spark-settled-outgoing"
import { requireCheckoutSparkSettledExactOutgoingRequest } from "../packages/core/src/protocol/checkout-spark-settled-outgoing-history"
import { allocateCheckoutSparkSettledSats } from "../packages/core/src/protocol/checkout-spark-settled-allocation"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"
import { qualifiedReceiverInvoiceFixture } from "./support/checkout-spark-qualified-receiver-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW = 1_800_000_000_000
const MERCHANT = "a".repeat(64)
function invoice(amount: number, hashByte: number) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amount * 10}n`,
    createdAt: NOW / 1000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}
function fixture(extraSupplier = false) {
  const recipients = [
    {
      kind: "merchant" as const,
      recipientId: MERCHANT,
      weightSats: extraSupplier ? 500 : 750,
    },
    { kind: "supplier" as const, recipientId: "b".repeat(64), weightSats: 250 },
    ...(extraSupplier
      ? [
          {
            kind: "supplier" as const,
            recipientId: "c".repeat(64),
            weightSats: 250,
          },
        ]
      : []),
    {
      kind: "conduit" as const,
      recipientId: "conduit-tester@rizful.com",
      weightSats: 111,
    },
  ]
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "financial-checkout",
    orderId: "financial-order",
    merchantPubkey: MERCHANT,
    walletId: "financial-wallet",
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 120_000,
    commerceQuote: {
      commerceTotalSats: 1000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:item`,
          productEventId: "d".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "financial-receive",
      paymentRequest: invoice(1113, 1),
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: `02${"e".repeat(64)}`,
      grossFundingSats: 1113,
      createdAt: NOW,
      expiresAt: NOW + 3_600_000,
    },
    recipients: recipients.map((recipient) => ({
      ...recipient,
      destination: {
        type: "lightning_address" as const,
        value:
          recipient.kind === "conduit"
            ? recipient.recipientId
            : `${recipient.kind}-${recipient.recipientId[0]}@receiver.conduit.cash`,
        source:
          recipient.kind === "conduit"
            ? {
                type: "conduit_allowlist" as const,
                policy: "local_router_canary" as const,
              }
            : {
                type: "signed_profile" as const,
                profileEventId: "f".repeat(64),
                profileEventCreatedAt: NOW / 1000,
              },
      },
    })),
  })
  const proof = {
    mode: "ordinary_v3" as const,
    requestId: plan.funding.requestId,
    transferId: "exact-native-credit",
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    grossSats: 1113,
    creditedSats: 1111,
  }
  let state = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      ...proof,
      paymentHash: plan.funding.paymentHash,
      observedAt: NOW + 1,
    }
  )
  for (let index = 0; index < plan.recipients.length; index++) {
    const leg = state.legs[index]!
    const amount = leg.allocationSats! - 1
    state = prepareCheckoutSparkSettledLeg(state, {
      legId: leg.legId,
      transferId: deriveCheckoutSparkSettledTransferId(plan, leg.legId),
      paymentRequest: invoice(amount, index + 2),
      paymentHash: (index + 2).toString(16).padStart(2, "0").repeat(32),
      invoiceAmountSats: amount,
      maxFeeSats: 1,
      preparedAt: NOW + 2 + index,
    })
  }
  return { plan, proof, state }
}
function observation(
  target: CheckoutSparkSettledOutgoingTarget,
  status: "paid" | "not_found" | "pending"
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
        finalFeeSats: 1,
        finalDebitSats: target.intent.invoiceAmountSats + 1,
      }
    : { ...identity, status }
}
function harness(
  initial: CheckoutSparkSettledReconciliation,
  actor: "shopper" | "merchant"
) {
  let state = restoreCheckoutSparkSettledReconciliation(initial)
  let revision = 1
  let active = true
  let retired = false
  let failAfterSave = false
  let ambiguous = false
  let rejectRecipient = false
  let afterLookup: (() => Promise<void>) | null = null
  let afterPreflight: (() => Promise<void>) | null = null
  const sent: string[] = []
  const facts = new Map<string, "paid" | "pending">()
  const events: string[] = []
  const now = () => (actor === "shopper" ? NOW + 10 : NOW + 120_010)
  const assertCurrent = () => {
    if (!active) throw new Error("Actor session revoked")
  }
  const snapshot = (): CheckoutSparkSettledRepositorySnapshot =>
    retired
      ? {
          status: "retired",
          planDigest: state.plan.planDigest,
          retiredAt: now(),
        }
      : { status: "active", revision, state: structuredClone(state) }
  const ports: CheckoutSparkFinancialWorkflowPorts = {
    assertCurrent,
    now,
    store: {
      load: async () => snapshot(),
      save: async (next, expected) => {
        assertCurrent()
        if (revision !== expected)
          throw new CheckoutSparkSettledRepositoryConflictError()
        state = restoreCheckoutSparkSettledReconciliation(next)
        revision++
        events.push(`projection:${state.credit ? "credit" : "empty"}`)
        if (failAfterSave) {
          failAfterSave = false
          throw new Error("Interrupted after commit")
        }
        return snapshot()
      },
    },
    outgoing: {
      reconcile: async (target) => {
        requireCheckoutSparkSettledExactOutgoingRequest(state.plan, target)
        await afterLookup?.()
        return observation(
          target,
          facts.get(target.intent.transferId) ?? "not_found"
        )
      },
      preflight: async () => {
        await afterPreflight?.()
        return "ready"
      },
      send: async (target) => {
        assertCurrent()
        expect(
          state.legs.find((leg) => leg.legId === target.legId)?.status
        ).toBe("submitted")
        expect(events).toContain("recovery:submitted")
        sent.push(target.intent.transferId)
        facts.set(target.intent.transferId, ambiguous ? "pending" : "paid")
        if (ambiguous) throw new Error("Provider response lost")
        return observation(target, "paid")
      },
    },
    recordPaid: async (target) => {
      if (rejectRecipient) return false
      expect(facts.get(target.intent.transferId)).toBe("paid")
      events.push(`verified:${target.legId}`)
    },
    acknowledgeRecoverySnapshot: async (next) => {
      expect(next.plan.planDigest).toBe(state.plan.planDigest)
      events.push(
        `recovery:${next.legs.find((leg) => leg.status === "submitted")?.status ?? "prepared"}`
      )
    },
    cleanupTerminal: async () => {
      events.push("cleanup:terminal")
    },
  }
  const run = (
    mode: "credit" | "reconcile" | "advance" | "prepare" | "retire" = "advance",
    legId?: string
  ) =>
    runCheckoutSparkFinancialWorkflow(
      {
        checkoutId: state.plan.checkoutId,
        planDigest: state.plan.planDigest,
        actor,
        mode,
        ...(legId ? { legId } : {}),
      },
      ports
    )
  return {
    run,
    ports,
    sent,
    facts,
    events,
    state: () => state,
    revoke: () => {
      active = false
    },
    retire: () => {
      retired = true
    },
    failAfterSave: () => {
      failAfterSave = true
    },
    ambiguous: () => {
      ambiguous = true
    },
    rejectRecipient: () => {
      rejectRecipient = true
    },
    afterLookup: (hook: () => Promise<void>) => {
      afterLookup = hook
    },
    afterPreflight: (hook: () => Promise<void>) => {
      afterPreflight = hook
    },
  }
}

describe("shared checkout financial workflow", () => {
  for (const actor of ["shopper", "merchant"] as const) {
    it(`${actor} advances the same obligations, checkpoints and Conduit-last executor`, async () => {
      const source = fixture(true)
      const h = harness(source.state, actor)
      for (const recipient of source.plan.recipients) {
        const outcome = await h.run("advance", recipient.legId)
        expect(outcome.status).toBe("outgoing_step")
        if (outcome.status === "outgoing_step")
          expect(outcome.step.outcome).toBe("paid")
      }
      expect(h.sent).toEqual(
        source.state.legs.map((leg) => leg.intent!.transferId)
      )
      expect(h.state().legs.every((leg) => leg.status === "paid")).toBe(true)
      expect((await h.run()).status).toBe("outgoing_step")
      expect(h.sent.length).toBe(4)
    })
    it(`${actor} admits exact credit fact before its durable state and recovers a committed-write interruption`, async () => {
      const source = fixture()
      const h = harness(
        createCheckoutSparkSettledReconciliation(source.plan),
        actor
      )
      h.ports.credit = {
        proof: source.proof,
        record: async () => {
          h.events.push("native-credit:verified")
        },
      }
      h.failAfterSave()
      await expect(h.run("credit")).rejects.toThrow("Interrupted after commit")
      expect(h.events.slice(0, 2)).toEqual([
        "native-credit:verified",
        "projection:credit",
      ])
      const reloaded = await h.run("credit")
      expect(reloaded.status).toBe("credited")
      expect(h.state().credit?.transferId).toBe(source.proof.transferId)
      expect(h.sent).toHaveLength(0)
    })
    it(`${actor} retains a possible send across response loss and reload without replay`, async () => {
      const h = harness(fixture().state, actor)
      h.ambiguous()
      const first = await h.run()
      expect(first.status).toBe("outgoing_step")
      const again = await h.run()
      expect(again.status).toBe("outgoing_step")
      if (again.status === "outgoing_step")
        expect(again.step.reason).toBe("prior_possible_send")
      expect(h.sent).toHaveLength(1)
      expect(h.state().legs[1]!.status).toBe("prepared")
    })
    it(`${actor} prepares the Core-selected obligation with durable invoice origin and exact recovery ACK`, async () => {
      const source = fixture()
      const initial = recordCheckoutSparkSettledCredit(
        createCheckoutSparkSettledReconciliation(source.plan),
        {
          ...source.proof,
          paymentHash: source.plan.funding.paymentHash,
          observedAt: NOW + 1,
        }
      )
      const h = harness(initial, actor)
      h.ports.preparation = {
        repository: {
          load: h.ports.store.load,
          savePreparedWithInvoiceOrigin: async (
            state,
            revision,
            origin,
            assertCurrent
          ) => {
            assertCurrent?.()
            expect(origin.legId).toBe(source.plan.recipients[0]!.legId)
            h.events.push("invoice-origin:durable")
            return h.ports.store.save(state, revision)
          },
        },
        assertAuthority: h.ports.assertCurrent,
        nowMs: h.ports.now,
        estimateFee: async () => 1,
        resolveInvoice: (input) =>
          resolveCheckoutSparkFixtureInvoice(
            input,
            qualifiedReceiverInvoiceFixture({
              lud16: input.lud16,
              amountSats: input.amountSats,
              paymentHash: "2a".repeat(32),
              createdAt: NOW / 1000,
            })
          ),
        acknowledgeRecoverySnapshot: h.ports.acknowledgeRecoverySnapshot,
      }
      const result = await h.run("prepare")
      expect(result.status).toBe("payout_prepared")
      expect(h.state().legs[0]!.intent?.invoiceAmountSats).toBe(749)
      expect(h.events.indexOf("invoice-origin:durable")).toBeLessThan(
        h.events.indexOf("recovery:prepared")
      )
      expect(h.sent).toHaveLength(0)
      expect(h.state().legs[1]!.intent).toBeNull()
    })
    it(`${actor} performs exact full-wallet evidence, reader closure, replay marker readback and retryable cleanup`, async () => {
      const h = harness(fixture().state, actor)
      for (const leg of h.state().legs) await h.run("advance", leg.legId)
      const ids = [
        h.state().credit!.transferId,
        ...h.state().legs.map((leg) => leg.intent!.transferId),
      ]
      h.ports.now = () => NOW + 120_020
      h.ports.retirement = {
        proveSettlement: async () => ({
          expectedTransferIds: ids,
          closedReturnedProofs: [],
        }),
        openReader: async () => {
          h.events.push("reader:opened")
          return {
            sparkAddress: "exact-checkout-reader",
            reader: {
              getTransfers: async () => ({
                transfers: ids.map((id) => ({
                  id,
                  type: 0,
                  status: 5,
                  network: 1,
                  totalValue: 1,
                })),
                offset: -1,
              }),
              getPendingTransfers: async () => [],
              getAvailableBalance: async () => 0n,
              getOwnedBalance: async () => 0n,
            },
            cleanup: async () => {
              h.events.push("reader:closed")
            },
          }
        },
        commit: async ({ expectedRevision, evidence }) => {
          expect(expectedRevision).toBeGreaterThan(1)
          expect(
            retireCheckoutSparkSettledReconciliation(h.state(), evidence)
              .planDigest
          ).toBe(h.state().plan.planDigest)
          expect(h.events.at(-1)).toBe("reader:closed")
          h.events.push("terminal:durable")
          h.retire()
        },
      }
      expect(await h.run("retire")).toEqual({ status: "retired" })
      expect(h.events.slice(-3)).toEqual([
        "reader:closed",
        "terminal:durable",
        "cleanup:terminal",
      ])
      expect(await h.run("retire")).toEqual({ status: "retired" })
      expect(
        h.events.filter((event) => event === "reader:opened")
      ).toHaveLength(1)
      expect(h.sent).toHaveLength(3)
    })
  }
  it("historically imported short funding remains inspectable but cannot prepare or dispatch a haircut", async () => {
    const source = fixture()
    const divided = allocateCheckoutSparkSettledSats({
      settledSats: 1000,
      fundingInvoiceGrossSats: 1113,
      weights: { commerceWeightSats: 1000, conduitWeightSats: 111 },
    })
    const supplier = Math.floor(divided.commerceAllocationSats / 4)
    const allocations = [
      divided.commerceAllocationSats - supplier,
      supplier,
      divided.conduitAllocationSats,
    ]
    const historical = {
      ...source.state,
      credit: { ...source.state.credit!, creditedSats: 1000 },
      legs: source.state.legs.map((leg, index) => ({
        ...leg,
        allocationSats: allocations[index]!,
        intent: null,
        status: "unprepared" as const,
        observedAt: null,
      })),
    }
    const h = harness(historical, "merchant")
    expect((await h.run("reconcile")).status).toBe("reconciled")
    for (const mode of ["prepare", "advance"] as const) {
      const result = await h.run(mode)
      if (result.status !== "outgoing_step")
        throw new Error("Expected short-funding pause")
      expect(result.step).toMatchObject({
        reason: "funding_shortfall",
        sendAttempted: false,
      })
    }
    expect(h.sent).toHaveLength(0)
    expect(h.state().legs.every((leg) => leg.intent === null)).toBe(true)
  })
  it("cold partial Merchant recovery re-attests a Buyer payment and sends only remaining allocations", async () => {
    const source = fixture()
    const buyer = harness(source.state, "shopper")
    await buyer.run()
    const cold = harness(buyer.state(), "merchant")
    cold.facts.set(source.state.legs[0]!.intent!.transferId, "paid")
    await cold.run()
    await cold.run()
    expect(cold.sent).toEqual(
      source.state.legs.slice(1).map((leg) => leg.intent!.transferId)
    )
    expect(cold.state().legs.every((leg) => leg.status === "paid")).toBe(true)
  })
  it("a cold imported paid label and absent provider proof never unlock the next obligation", async () => {
    const source = fixture()
    const buyer = harness(source.state, "shopper")
    await buyer.run()
    const cold = harness(buyer.state(), "merchant")
    const result = await cold.run()
    expect(result.status).toBe("outgoing_step")
    if (result.status === "outgoing_step")
      expect(result.step.reason).toBe("prior_possible_send")
    expect(cold.sent).toHaveLength(0)
  })
  it("receiver proof is separate from exact native paid history", async () => {
    const source = fixture()
    const h = harness(source.state, "merchant")
    h.facts.set(source.state.legs[0]!.intent!.transferId, "paid")
    h.rejectRecipient()
    const result = await h.run()
    if (result.status !== "outgoing_step")
      throw new Error("Expected paused execution")
    expect(result.step.reason).toBe("provider_evidence_unavailable")
    expect(h.state().legs[0]!.status).toBe("prepared")
    expect(h.sent).toHaveLength(0)
  })
  for (const actor of ["shopper", "merchant"] as const) {
    it(`${actor} retains a reconciled paid obligation and pauses on its lost recovery ACK`, async () => {
      const source = fixture()
      const h = harness(source.state, actor)
      const first = source.state.legs[0]!
      h.facts.set(first.intent!.transferId, "paid")
      const acknowledge = h.ports.acknowledgeRecoverySnapshot
      h.ports.acknowledgeRecoverySnapshot = async (state) => {
        await acknowledge(state)
        throw new Error("Synthetic paid progress ACK lost")
      }
      const paused = await h.run("advance", first.legId)
      expect(paused).toMatchObject({
        status: "outgoing_step",
        step: {
          outcome: "wait",
          reason: "recovery_handoff_unavailable",
          sendAttempted: false,
        },
      })
      expect(h.state().legs[0]!.status).toBe("paid")
      expect(h.events).toContain(`verified:${first.legId}`)
      expect(h.sent).toHaveLength(0)
      h.ports.acknowledgeRecoverySnapshot = acknowledge
      expect(await h.run("advance", first.legId)).toMatchObject({
        status: "outgoing_step",
        step: { outcome: "already_paid", sendAttempted: false },
      })
      expect(h.sent).toHaveLength(0)
      await h.run()
      expect(h.sent).toEqual([source.state.legs[1]!.intent!.transferId])
    })
  }
  it.each(["session", "revision"] as const)(
    "does not hide %s revocation behind a failed reconciled-paid recovery ACK",
    async (interruption) => {
      const source = fixture()
      const h = harness(source.state, "merchant")
      const first = source.state.legs[0]!
      h.facts.set(first.intent!.transferId, "paid")
      h.ports.acknowledgeRecoverySnapshot = async () => {
        if (interruption === "session") h.revoke()
        else {
          const current = await h.ports.store.load(
            source.plan.checkoutId,
            source.plan.planDigest
          )
          if (current.status !== "active") throw new Error("Expected active")
          await h.ports.store.save(
            { ...current.state, updatedAt: current.state.updatedAt + 1 },
            current.revision
          )
        }
        throw new Error("Synthetic ACK lost after interruption")
      }
      await expect(h.run()).rejects.toThrow(
        interruption === "session" ? "Actor session revoked" : "changed"
      )
      expect(h.state().legs[0]!.status).toBe("paid")
      expect(h.sent).toHaveLength(0)
    }
  )
  it("revokes a changed session after an awaited provider lookup before facts or new sends", async () => {
    const h = harness(fixture().state, "merchant")
    h.afterLookup(async () => {
      h.revoke()
    })
    await expect(h.run()).rejects.toThrow("Actor session revoked")
    expect(h.sent).toHaveLength(0)
    expect(h.events).toHaveLength(0)
  })
  it("concurrent conforming callers compete on the same durable CAS, never a second intent", async () => {
    const source = fixture()
    const h = harness(source.state, "merchant")
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrivals = 0
    h.afterPreflight(async () => {
      arrivals++
      if (arrivals === 2) release()
      await barrier
    })
    const results = await Promise.allSettled([h.run(), h.run()])
    expect(results.some((result) => result.status === "fulfilled")).toBe(true)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toBe(source.state.legs[0]!.intent!.transferId)
  })
  it("a durable terminal marker retries cleanup without wallet or provider work", async () => {
    const h = harness(fixture().state, "shopper")
    h.retire()
    expect(await h.run()).toEqual({ status: "retired" })
    expect(h.events).toEqual(["cleanup:terminal"])
    expect(h.sent).toHaveLength(0)
  })
  it("a failed local terminal cleanup never reopens payment execution", async () => {
    const h = harness(fixture().state, "shopper")
    h.retire()
    h.ports.cleanupTerminal = async () => {
      throw new Error("Local storage temporarily unavailable")
    }
    expect(await h.run()).toEqual({ status: "retired" })
    h.ports.cleanupTerminal = async () => {
      h.events.push("cleanup:retried")
    }
    expect(await h.run()).toEqual({ status: "retired" })
    expect(h.events).toEqual(["cleanup:retried"])
    expect(h.sent).toHaveLength(0)
  })
  for (const fault of ["reader_revocation", "missing_tombstone"] as const) {
    it(`retirement preserves execution evidence for ${fault} without terminal cleanup`, async () => {
      const h = harness(fixture().state, "merchant")
      for (const leg of h.state().legs) await h.run("advance", leg.legId)
      const ids = [
        h.state().credit!.transferId,
        ...h.state().legs.map((leg) => leg.intent!.transferId),
      ]
      h.ports.now = () => NOW + 120_020
      let commits = 0
      let closes = 0
      h.ports.retirement = {
        proveSettlement: async () => ({
          expectedTransferIds: ids,
          closedReturnedProofs: [],
        }),
        openReader: async () => ({
          sparkAddress: "exact-checkout-reader",
          reader: {
            getTransfers: async () => {
              if (fault === "reader_revocation") h.revoke()
              return {
                transfers: ids.map((id) => ({
                  id,
                  type: 0,
                  status: 5,
                  network: 1,
                  totalValue: 1,
                })),
                offset: -1,
              }
            },
            getPendingTransfers: async () => [],
            getAvailableBalance: async () => 0n,
            getOwnedBalance: async () => 0n,
          },
          cleanup: async () => {
            closes++
          },
        }),
        commit: async () => {
          commits++
        },
      }
      await expect(h.run("retire")).rejects.toThrow(
        fault === "reader_revocation"
          ? "Actor session revoked"
          : "settled state changed"
      )
      expect(closes).toBe(1)
      expect(commits).toBe(fault === "reader_revocation" ? 0 : 1)
      expect(h.events).not.toContain("cleanup:terminal")
      expect(h.sent).toHaveLength(3)
      expect(h.state().credit?.transferId).toBe(ids[0])
    })
  }
})
