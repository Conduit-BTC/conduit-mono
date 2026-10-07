import { describe, expect, it } from "bun:test"
import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  deriveCheckoutSparkSettledRenewalTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  renewCheckoutSparkSettledLeg,
  restoreCheckoutSparkSettledReconciliation,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import {
  assertCheckoutSparkSettledReturnedProof,
  proveCheckoutSparkSettledReturnedTransfer,
  proveCheckoutSparkSettledClosedReturnedTransfer,
  type CheckoutSparkSettledReturnedProof,
} from "../packages/core/src/protocol/checkout-spark-settled-returned"
import { collectCheckoutSparkNativeRetirementEvidence } from "../packages/core/src/protocol/checkout-spark-native-retirement"
import { CONDUIT_CHECKOUT_FEE_RECIPIENT } from "../packages/core/src/protocol/checkout-spark-router-obligations"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"
import { DexieCheckoutSparkSettledRepository } from "../packages/core/src/protocol/checkout-spark-settled-router-repository"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"
import { qualifiedReceiverInvoiceFixture } from "./support/checkout-spark-qualified-receiver-fixture"
import {
  createCheckoutSparkMerchantProgress,
  parseCheckoutSparkMerchantProgress,
} from "../packages/core/src/protocol/checkout-spark-merchant-progress"
import {
  runCheckoutSparkSettledOutgoingStep,
  type CheckoutSparkSettledOutgoingTarget,
} from "../packages/core/src/protocol/checkout-spark-settled-outgoing"
import {
  createCheckoutSparkRetiredSettlementSummary,
  restoreCheckoutSparkRetiredSettlementSummary,
} from "../packages/core/src/protocol/checkout-spark-retired-settlement"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { deriveCheckoutSparkSettledRecoverySnapshotKey } from "../packages/core/src/protocol/checkout-spark-recovery"
import {
  prepareCheckoutSparkSettledOutgoingLegShared,
  assertCheckoutSparkSettledMerchantPreparationWindow,
} from "../packages/core/src/protocol/checkout-spark-settled-leg-preparation"
import { getCheckoutSparkSupplierNotifications } from "../packages/core/src/protocol/checkout-spark-supplier-notification"
import {
  createCheckoutSparkMerchantSettlementRecord,
  recordCheckoutSparkMerchantCredit,
  recordCheckoutSparkMerchantPayout,
} from "../packages/core/src/protocol/checkout-spark-merchant-settlement"
import { createCheckoutSparkInvoiceOriginRecord } from "../packages/core/src/protocol/checkout-spark-invoice-origin"

const CREATED_AT = 1_800_000_000_000
const NOW = CREATED_AT + 3_600_001
const MERCHANT = "a".repeat(64)
const IDENTITY = `02${"c".repeat(64)}`

function invoice(amountSats: number, hashByte: number, createdAt = CREATED_AT) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: Math.floor(createdAt / 1000),
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function fixture(kind: "merchant" | "supplier" = "merchant") {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "renewal-checkout",
    orderId: "renewal-order",
    merchantPubkey: MERCHANT,
    walletId: "renewal-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 60_000,
    commerceQuote: {
      commerceTotalSats: 1000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:renewal`,
          productEventId: "b".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "renewal-credit",
      paymentRequest: invoice(1113, 3),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: IDENTITY,
      grossFundingSats: 1113,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@receiver.conduit.cash",
          source: {
            type: "signed_profile",
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: CREATED_AT / 1000,
          },
        },
        weightSats: kind === "supplier" ? 750 : 1000,
      },
      ...(kind === "supplier"
        ? [
            {
              kind: "supplier" as const,
              recipientId: "e".repeat(64),
              destination: {
                type: "lightning_address" as const,
                value: "supplier@receiver.conduit.cash",
                source: {
                  type: "signed_profile" as const,
                  profileEventId: "f".repeat(64),
                  profileEventCreatedAt: CREATED_AT / 1000,
                },
              },
              weightSats: 250,
            },
          ]
        : []),
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
  let state = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "renewal-credit-transfer",
      receiverIdentityPublicKey: IDENTITY,
      grossSats: 1113,
      creditedSats: 1111,
      observedAt: CREATED_AT + 1,
    }
  )
  const position = kind === "supplier" ? 1 : 0
  const legId = plan.recipients[position]!.legId
  const allocation = state.legs[position]!.allocationSats!
  state = prepareCheckoutSparkSettledLeg(state, {
    legId,
    transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
    paymentRequest: invoice(allocation - 5, 4),
    paymentHash: "04".repeat(32),
    invoiceAmountSats: allocation - 5,
    maxFeeSats: 5,
    preparedAt: CREATED_AT + 2,
  })
  state = recordCheckoutSparkSettledLegStatus(state, {
    legId,
    transferId: state.legs[position]!.intent!.transferId,
    paymentHash: "04".repeat(32),
    status: "ambiguous",
    observedAt: CREATED_AT + 3,
  })
  const target = {
    walletId: plan.walletId,
    network: plan.network,
    legId,
    recipientId: plan.recipients[position]!.recipientId,
    allocationSats: allocation,
    unpaidAllocationSats: 1111,
    intent: state.legs[position]!.intent!,
  }
  const evidence = {
    network: plan.network,
    walletIdentityPublicKey: IDENTITY,
    transferId: target.intent.transferId,
    requestId: "returned-request",
    paymentRequest: target.intent.paymentRequest,
    paymentHash: target.intent.paymentHash,
    invoiceAmountSats: allocation - 5,
    maxFeeSats: 5,
    debitedSats: allocation,
    returnedSats: allocation,
    availableSats: 1111,
    sspStatus: "USER_SWAP_RETURNED",
    operatorStatus: "RETURNED" as const,
    htlcStatus: "RETURNED" as const,
    preimage: null,
    returnedLeaves: [{ id: "returned-leaf", valueSats: allocation }],
    availableLeaves: [
      { id: "returned-leaf", valueSats: allocation },
      { id: "remaining-allocations", valueSats: 1111 - allocation },
    ],
    observedAt: NOW,
  }
  const intent = {
    legId,
    transferId: deriveCheckoutSparkSettledRenewalTransferId(plan, legId),
    paymentRequest: invoice(allocation - 10, 5, NOW),
    paymentHash: "05".repeat(32),
    invoiceAmountSats: allocation - 10,
    maxFeeSats: 10,
    preparedAt: NOW,
  }
  return { plan, state, target, evidence, intent }
}

describe("bounded settled payout renewal", () => {
  it("retains an ambiguous old intent after exact full return and prepares only generation one", () => {
    const { plan, state, target, evidence, intent } = fixture()
    const before = JSON.stringify(state)
    const proof = proveCheckoutSparkSettledReturnedTransfer({
      plan,
      target,
      evidence,
    })
    const renewed = renewCheckoutSparkSettledLeg(state, {
      legId: target.legId,
      intent,
      proof,
      nowMs: NOW,
    })
    expect(renewed.schemaVersion).toBe(4)
    expect(JSON.stringify(renewed.plan) === JSON.stringify(plan)).toBe(true)
    expect(renewed.legs[0]!.generation).toBe(1)
    expect(
      JSON.stringify(renewed.legs[0]!.intent) === JSON.stringify(intent)
    ).toBe(true)
    expect(
      JSON.stringify(renewed.legs[0]!.closedGenerations![0]!.intent) ===
        JSON.stringify(target.intent)
    ).toBe(true)
    expect(renewed.legs[0]!.closedGenerations![0]!.status).toBe("ambiguous")
    expect(renewed.legs[0]!.closedGenerations![0]!.closure.netDebitSats).toBe(0)
    expect(
      JSON.stringify(restoreCheckoutSparkSettledReconciliation(renewed)) ===
        JSON.stringify(renewed)
    ).toBe(true)
    expect(JSON.stringify(state) === before).toBe(true)
    expect(Object.isFrozen(renewed.legs[0]!.closedGenerations)).toBe(true)
    expect(
      Object.isFrozen(renewed.legs[0]!.closedGenerations![0]!.intent)
    ).toBe(true)
    expect(
      Object.isFrozen(renewed.legs[0]!.closedGenerations![0]!.closure)
    ).toBe(true)
  })

  it("does not promote original state or buyer snapshot wire to a phantom renewal", () => {
    const { plan, state, target, evidence, intent } = fixture()
    expect(() =>
      restoreCheckoutSparkSettledReconciliation({
        ...state,
        schemaVersion: 4,
        legs: state.legs.map((leg) => ({
          ...leg,
          generation: 0,
          closedGenerations: [],
        })),
      })
    ).toThrow()
    const renewed = renewCheckoutSparkSettledLeg(state, {
      legId: target.legId,
      intent,
      proof: proveCheckoutSparkSettledReturnedTransfer({
        plan,
        target,
        evidence,
      }),
      nowMs: NOW,
    })
    expect(() =>
      deriveCheckoutSparkSettledRecoverySnapshotKey({
        initialHandoffId: "1".repeat(64),
        state: renewed,
      })
    ).toThrow()
  })

  it("does not renew a still-live invoice even with exact returned evidence", () => {
    const { plan, state, target, evidence, intent } = fixture()
    const nowMs = CREATED_AT + 60_001
    const proof = proveCheckoutSparkSettledReturnedTransfer({
      plan,
      target,
      evidence: { ...evidence, observedAt: nowMs },
    })
    expect(() =>
      renewCheckoutSparkSettledLeg(state, {
        legId: target.legId,
        intent: {
          ...intent,
          paymentRequest: invoice(990, 5, nowMs),
          preparedAt: nowMs,
        },
        proof,
        nowMs,
      })
    ).toThrow()
  })

  it("rejects absent, partial, contradictory, stale, or copied return authority", () => {
    const { plan, state, target, evidence, intent } = fixture()
    for (const changed of [
      { ...evidence, sspStatus: "USER_SWAP_PENDING" },
      { ...evidence, operatorStatus: "COMPLETED" as "RETURNED" },
      { ...evidence, preimage: "contradictory-preimage" },
      { ...evidence, returnedSats: 999 },
      { ...evidence, returnedLeaves: [] },
      { ...evidence, availableLeaves: [{ id: "other-leaf", valueSats: 1111 }] },
      {
        ...evidence,
        availableLeaves: [
          ...evidence.availableLeaves,
          evidence.availableLeaves[0]!,
        ],
      },
      {
        ...evidence,
        availableSats: 1000,
        availableLeaves: evidence.returnedLeaves,
      },
    ])
      expect(() =>
        proveCheckoutSparkSettledReturnedTransfer({
          plan,
          target,
          evidence: changed,
        })
      ).toThrow()
    const proof = proveCheckoutSparkSettledReturnedTransfer({
      plan,
      target,
      evidence,
    })
    expect(() =>
      assertCheckoutSparkSettledReturnedProof(proof, {
        plan,
        target: { ...target, walletId: "different-wallet" },
        nowMs: NOW,
      })
    ).toThrow()
    expect(() =>
      assertCheckoutSparkSettledReturnedProof(proof, {
        plan,
        target,
        nowMs: NOW + 5_001,
      })
    ).toThrow()
    expect(() =>
      assertCheckoutSparkSettledReturnedProof(
        { ...proof },
        { plan, target, nowMs: NOW }
      )
    ).toThrow()
    const renewed = renewCheckoutSparkSettledLeg(state, {
      legId: target.legId,
      intent,
      proof,
      nowMs: NOW,
    })
    expect(() =>
      renewCheckoutSparkSettledLeg(renewed, {
        legId: target.legId,
        intent,
        proof,
        nowMs: NOW,
      })
    ).toThrow()
    expect(() =>
      renewCheckoutSparkSettledLeg(state, {
        legId: target.legId,
        intent: {
          ...intent,
          paymentRequest: target.intent.paymentRequest,
          paymentHash: target.intent.paymentHash,
        },
        proof,
        nowMs: NOW,
      })
    ).toThrow()
    const forked = {
      ...renewed,
      legs: renewed.legs.map((leg) =>
        leg.legId !== target.legId
          ? leg
          : {
              ...leg,
              closedGenerations: leg.closedGenerations!.map((entry) => ({
                ...entry,
                intent: {
                  ...entry.intent,
                  transferId: "different-old-transfer",
                },
              })),
            }
      ),
    }
    expect(() => restoreCheckoutSparkSettledReconciliation(forked)).toThrow()
    const nonzero = {
      ...renewed,
      legs: renewed.legs.map((leg) =>
        leg.legId !== target.legId
          ? leg
          : {
              ...leg,
              closedGenerations: leg.closedGenerations!.map((entry) => ({
                ...entry,
                closure: { ...entry.closure, netDebitSats: 1 as 0 },
              })),
            }
      ),
    }
    expect(() => restoreCheckoutSparkSettledReconciliation(nonzero)).toThrow()
  })

  it("atomically retains the returned attempt and the fresh invoice origin across reload", async () => {
    const { plan, state, target, evidence, intent } = fixture()
    const database = new ConduitDB(`renewal-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    const repository = new DexieCheckoutSparkSettledRepository(database)
    try {
      await repository.create(plan)
      const saved = await repository.save(state, 1)
      if (saved.status !== "active") throw new Error("Expected saved state")
      const proof = proveCheckoutSparkSettledReturnedTransfer({
        plan,
        target,
        evidence,
      })
      const next = renewCheckoutSparkSettledLeg(saved.state, {
        legId: target.legId,
        intent,
        proof,
        nowMs: NOW,
      })
      await expect(repository.save(next, saved.revision)).rejects.toThrow()
      const fresh = await resolveCheckoutSparkFixtureInvoice(
        {
          lud16: plan.recipients[0]!.destination.value,
          amountSats: intent.invoiceAmountSats,
          network: plan.network,
          nowSeconds: Math.floor(NOW / 1000),
          shouldContinue: () => true,
        },
        intent.paymentRequest
      )
      let admissionClock = NOW
      let admissionChecks = 0
      await expect(
        repository.saveRenewedWithInvoiceOrigin(
          next,
          saved.revision,
          {
            legId: target.legId,
            proof,
            origin: fresh.origin!,
            nowMs: NOW,
            now: () => admissionClock,
          },
          () => {
            if (++admissionChecks > 1) admissionClock = NOW + 5_001
          }
        )
      ).rejects.toThrow()
      const held = await repository.load(plan.checkoutId, plan.planDigest)
      expect(
        held.status === "active" && (held.state.legs[0]!.generation ?? 0) === 0
      ).toBe(true)
      expect(
        await repository.hasInvoiceOrigin(plan, {
          ...target,
          intent,
          generation: 1,
        })
      ).toBe(false)
      expect(
        await repository.hasInvoiceRecipient(plan, {
          ...target,
          intent,
          generation: 1,
        })
      ).toBe(false)
      const persisted = await repository.saveRenewedWithInvoiceOrigin(
        next,
        saved.revision,
        {
          legId: target.legId,
          proof,
          origin: fresh.origin!,
          nowMs: NOW,
          now: () => NOW,
        }
      )
      expect(persisted.status).toBe("active")
      const reloaded = await new DexieCheckoutSparkSettledRepository(
        database
      ).load(plan.checkoutId, plan.planDigest)
      expect(reloaded.status).toBe("active")
      if (reloaded.status !== "active")
        throw new Error("Expected reloaded state")
      expect(reloaded.state.legs[0]!.closedGenerations!.length).toBe(1)
      expect(
        await repository.hasInvoiceOrigin(plan, {
          ...target,
          intent,
          generation: 1,
        })
      ).toBe(true)
      expect(
        await repository.hasInvoiceRecipient(plan, {
          ...target,
          intent,
          generation: 1,
        })
      ).toBe(true)
      expect(await repository.hasInvoiceOrigin(plan, target)).toBe(false)
      expect(await repository.hasInvoiceRecipient(plan, target)).toBe(false)
      const changedTarget = {
        ...target,
        intent: { ...intent, paymentHash: "06".repeat(32) },
        generation: 1 as const,
      }
      expect(await repository.hasInvoiceOrigin(plan, changedTarget)).toBe(false)
      expect(await repository.hasInvoiceRecipient(plan, changedTarget)).toBe(
        false
      )
      await expect(
        repository.saveRenewedWithInvoiceOrigin(next, saved.revision, {
          legId: target.legId,
          proof,
          origin: fresh.origin!,
          nowMs: NOW,
          now: () => NOW,
        })
      ).rejects.toThrow()
    } finally {
      await database.delete()
    }
  })

  it.each([2, 3])(
    "keeps the original attempt when authority is revoked during shared renewal proof %s",
    async (heldProofNumber) => {
      const { plan, state, target, evidence } = fixture()
      const database = new ConduitDB(
        `renewal-proof-revocation-${crypto.randomUUID()}`,
        { indexedDB, IDBKeyRange }
      )
      const repository = new DexieCheckoutSparkSettledRepository(database)
      let current = true
      let proofReads = 0
      let acknowledgements = 0
      let notifyHeld!: () => void
      let releaseHeld!: () => void
      const heldStarted = new Promise<void>((resolve) => {
        notifyHeld = resolve
      })
      const held = new Promise<void>((resolve) => {
        releaseHeld = resolve
      })
      try {
        await repository.create(plan)
        const original = await repository.save(state, 1)
        const pending = prepareCheckoutSparkSettledOutgoingLegShared(
          {
            checkoutId: plan.checkoutId,
            planDigest: plan.planDigest,
            legId: target.legId,
            allowRenewal: true,
            shouldContinue: () => current,
          },
          {
            repository,
            nowMs: () => NOW,
            assertAuthority:
              assertCheckoutSparkSettledMerchantPreparationWindow,
            proveRenewalReturn: async () => {
              proofReads++
              if (proofReads === heldProofNumber) {
                notifyHeld()
                await held
              }
              return proveCheckoutSparkSettledReturnedTransfer({
                plan,
                target,
                evidence,
              })
            },
            resolveInvoice: (request) =>
              resolveCheckoutSparkFixtureInvoice(
                request,
                qualifiedReceiverInvoiceFixture({
                  lud16: request.lud16,
                  amountSats: request.amountSats,
                  paymentHash: "05".repeat(32),
                  createdAt: Math.floor(NOW / 1_000),
                })
              ),
            estimateFee: async () => 1,
            acknowledgeRecoverySnapshot: async () => {
              acknowledgements++
            },
          }
        )
        await heldStarted
        current = false
        releaseHeld()
        await expect(pending).rejects.toThrow("authority changed")
        const saved = await repository.load(plan.checkoutId, plan.planDigest)
        expect(saved.status).toBe("active")
        if (saved.status !== "active") throw new Error("Expected saved attempt")
        expect(saved.revision).toBe(original.revision)
        expect(JSON.stringify(saved.state) === JSON.stringify(state)).toBe(true)
        expect(saved.state.schemaVersion).toBe(3)
        expect(acknowledgements).toBe(0)
      } finally {
        releaseHeld()
        await database.delete()
      }
    }
  )

  it("refreshes return proof after slow invoice and fee work, then again after dispatch ACK", async () => {
    const { plan, state, target, evidence } = fixture()
    const database = new ConduitDB(`renewal-freshness-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    const repository = new DexieCheckoutSparkSettledRepository(database)
    let clock = NOW
    const preparationProofTimes: number[] = []
    const dispatchProofStages: string[] = []
    let sends = 0
    let acknowledgements = 0
    const proofAt = () =>
      proveCheckoutSparkSettledReturnedTransfer({
        plan,
        target,
        evidence: { ...evidence, observedAt: clock },
      })
    try {
      await repository.create(plan)
      await repository.save(state, 1)
      const prepared = await prepareCheckoutSparkSettledOutgoingLegShared(
        {
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          legId: target.legId,
          allowRenewal: true,
          shouldContinue: () => true,
        },
        {
          repository,
          nowMs: () => clock,
          assertAuthority: assertCheckoutSparkSettledMerchantPreparationWindow,
          proveRenewalReturn: async () => {
            preparationProofTimes.push(clock)
            return proofAt()
          },
          resolveInvoice: async (request) => {
            clock += 6_001
            return resolveCheckoutSparkFixtureInvoice(
              { ...request, nowSeconds: Math.floor(clock / 1000) },
              qualifiedReceiverInvoiceFixture({
                lud16: request.lud16,
                amountSats: request.amountSats,
                paymentHash: "05".repeat(32),
                createdAt: Math.floor(clock / 1_000),
              })
            )
          },
          estimateFee: async () => {
            clock += 6_001
            return 1
          },
          acknowledgeRecoverySnapshot: async () => {
            clock += 6_001
            acknowledgements++
          },
        }
      )
      expect(prepared.state.legs[0]!.generation).toBe(1)
      expect(preparationProofTimes.length).toBe(3)
      expect(
        preparationProofTimes[1]! - preparationProofTimes[0]!
      ).toBeGreaterThan(5_000)
      expect(
        preparationProofTimes[2]! - preparationProofTimes[1]!
      ).toBeGreaterThan(5_000)
      expect(prepared.state.legs[0]!.intent!.preparedAt).toBe(
        preparationProofTimes[2]!
      )
      const result = await runCheckoutSparkSettledOutgoingStep({
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        legId: target.legId,
        actor: "merchant",
        now: () => clock,
        store: repository,
        acknowledgeRecoverySnapshot: async () => {
          clock += 6_001
          acknowledgements++
        },
        proveRenewalReturn: async (current) => {
          dispatchProofStages.push(current.legs[0]!.status)
          return proofAt()
        },
        provider: {
          reconcile: async (active) => ({
            ...active.intent,
            status: "not_found",
          }),
          preflight: async () => {
            clock += 6_001
            return "ready"
          },
          send: async (active) => {
            sends++
            expect(acknowledgements).toBe(3)
            return {
              ...active.intent,
              status: "paid",
              finalFeeSats: 1,
              finalDebitSats: 1000,
            }
          },
        },
      })
      expect(result.outcome).toBe("paid")
      expect(sends).toBe(1)
      expect(dispatchProofStages).toEqual(["prepared", "submitted"])
      expect(
        (await repository.load(plan.checkoutId, plan.planDigest)).status
      ).toBe("active")
    } finally {
      await database.delete()
    }
  })

  it("reconciles a paid successor without requiring its already-consumed old returned leaves", async () => {
    const { plan, state, target, evidence, intent } = fixture()
    let current = renewCheckoutSparkSettledLeg(state, {
      legId: target.legId,
      intent,
      proof: proveCheckoutSparkSettledReturnedTransfer({
        plan,
        target,
        evidence,
      }),
      nowMs: NOW,
    })
    let revision = 1
    let returnReads = 0
    let sends = 0
    const result = await runCheckoutSparkSettledOutgoingStep({
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      legId: target.legId,
      actor: "merchant",
      now: () => NOW + 10_000,
      store: {
        load: async () => ({ status: "active", revision, state: current }),
        save: async (next) => ({
          status: "active",
          revision: ++revision,
          state: (current = next),
        }),
      },
      acknowledgeRecoverySnapshot: async () => {},
      proveRenewalReturn: async () => {
        returnReads++
        throw new Error("Old leaves are no longer available")
      },
      provider: {
        reconcile: async (active) => ({
          ...active.intent,
          status: "paid",
          finalFeeSats: 5,
          finalDebitSats: 995,
        }),
        preflight: async () => "ready",
        send: async () => {
          sends++
          return { status: "not_sent" }
        },
      },
    })
    expect(result.outcome).toBe("paid")
    expect(current.legs[0]!.status).toBe("paid")
    expect(returnReads).toBe(0)
    expect(sends).toBe(0)
  })

  it("round-trips renewed history only in version-two Merchant progress", () => {
    const { plan, state, target, evidence, intent } = fixture()
    const proof = proveCheckoutSparkSettledReturnedTransfer({
      plan,
      target,
      evidence,
    })
    const renewed = renewCheckoutSparkSettledLeg(state, {
      legId: target.legId,
      intent,
      proof,
      nowMs: NOW,
    })
    const payload = createCheckoutSparkMerchantProgress({
      initialHandoffId: "1".repeat(64),
      state: renewed,
    })
    expect(payload.schemaVersion).toBe(2)
    expect(
      parseCheckoutSparkMerchantProgress(JSON.parse(JSON.stringify(payload)))
        .state.legs[0]!.closedGenerations!.length
    ).toBe(1)
    expect(() =>
      parseCheckoutSparkMerchantProgress({ ...payload, schemaVersion: 1 })
    ).toThrow()
  })

  it("never dispatches a successor from signed closure metadata without a fresh runtime proof", async () => {
    const { plan, state, target, evidence, intent } = fixture()
    const proof = proveCheckoutSparkSettledReturnedTransfer({
      plan,
      target,
      evidence,
    })
    let current = renewCheckoutSparkSettledLeg(state, {
      legId: target.legId,
      intent,
      proof,
      nowMs: NOW,
    })
    let revision = 1
    let sends = 0
    const result = await runCheckoutSparkSettledOutgoingStep({
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      legId: target.legId,
      actor: "merchant",
      now: () => NOW,
      store: {
        load: async () => ({ status: "active", revision, state: current }),
        save: async (next) => ({
          status: "active",
          revision: ++revision,
          state: (current = next),
        }),
      },
      acknowledgeRecoverySnapshot: async () => {},
      provider: {
        reconcile: async (active: CheckoutSparkSettledOutgoingTarget) => ({
          ...active.intent,
          status: "not_found",
        }),
        preflight: async () => "ready",
        send: async () => {
          sends++
          return { status: "not_sent" }
        },
      },
    })
    expect(result.reason).toBe("renewal_return_unavailable")
    expect(sends).toBe(0)
    expect(current.legs[0]!.status).toBe("prepared")
  })

  it("retains the actual winning generation identity in the non-secret retirement summary", () => {
    const { plan, state, target, evidence, intent } = fixture()
    const proof = proveCheckoutSparkSettledReturnedTransfer({
      plan,
      target,
      evidence,
    })
    const renewed = renewCheckoutSparkSettledLeg(state, {
      legId: target.legId,
      intent,
      proof,
      nowMs: NOW,
    })
    const paid = recordCheckoutSparkSettledLegStatus(renewed, {
      legId: target.legId,
      transferId: intent.transferId,
      paymentHash: intent.paymentHash,
      status: "paid",
      finalFeeSats: 5,
      finalDebitSats: 995,
      observedAt: NOW + 1,
    })
    const summary = createCheckoutSparkRetiredSettlementSummary(paid)
    expect(summary.schemaVersion).toBe(2)
    expect(summary.legs[0]!.transferId === intent.transferId).toBe(true)
    expect(
      summary.legs[0]!.closedTransferIds![0] === target.intent.transferId
    ).toBe(true)
    expect(summary.legs[0]!.historicalNetDebitSats).toBe(0)
    expect(
      restoreCheckoutSparkRetiredSettlementSummary(summary).legs[0]!.generation
    ).toBe(1)
  })

  it("retires only exact freshly proved closed returns and never turns retirement proof into send authority", async () => {
    const { plan, target, evidence, intent } = fixture()
    const {
      availableSats: _available,
      availableLeaves: _leaves,
      ...terminalEvidence
    } = evidence
    void _available
    void _leaves
    const closed = proveCheckoutSparkSettledClosedReturnedTransfer({
      plan,
      target,
      evidence: terminalEvidence,
    })
    expect(() =>
      assertCheckoutSparkSettledReturnedProof(
        closed as unknown as CheckoutSparkSettledReturnedProof,
        { plan, target, nowMs: NOW }
      )
    ).toThrow()
    const history = [
      {
        id: "renewal-credit-transfer",
        type: 1,
        status: 5,
        network: 1,
        totalValue: 1111,
      },
      {
        id: intent.transferId,
        type: 0,
        status: 5,
        network: 1,
        totalValue: 1000,
      },
      {
        id: target.intent.transferId,
        type: 0,
        status: 7,
        network: 1,
        totalValue: 1000,
      },
    ]
    const input = {
      walletId: plan.walletId,
      network: plan.network,
      sparkAddress: "exact-fixture-wallet-address",
      stateUpdatedAt: NOW,
      expectedTransferIds: ["renewal-credit-transfer", intent.transferId],
      closedReturnedProofs: [closed],
      now: () => NOW + 1,
      authenticatedReader: {
        getTransfers: async () => ({ transfers: history, offset: -1 }),
        getPendingTransfers: async () => [],
        getAvailableBalance: async () => 0n,
        getOwnedBalance: async () => 0n,
      },
    }
    expect(
      (await collectCheckoutSparkNativeRetirementEvidence(input)) !== null
    ).toBe(true)
    expect(
      await collectCheckoutSparkNativeRetirementEvidence({
        ...input,
        closedReturnedProofs: [],
      })
    ).toBeNull()
    expect(
      await collectCheckoutSparkNativeRetirementEvidence({
        ...input,
        now: () => NOW + 5_001,
      })
    ).toBeNull()
    for (const changed of [
      { ...history[2]!, id: "unknown-returned-transfer" },
      { ...history[2]!, status: 5 },
      { ...history[2]!, totalValue: 999 },
      { ...history[2]!, status: 4 },
    ])
      expect(
        await collectCheckoutSparkNativeRetirementEvidence({
          ...input,
          authenticatedReader: {
            ...input.authenticatedReader,
            getTransfers: async () => ({
              transfers: [...history.slice(0, 2), changed],
              offset: -1,
            }),
          },
        })
      ).toBeNull()
  })

  it("binds a renewed supplier notice to its actual winning generation and retains it on retirement", async () => {
    const { plan, state, target, evidence, intent } = fixture("supplier")
    const proof = proveCheckoutSparkSettledReturnedTransfer({
      plan,
      target,
      evidence,
    })
    const renewed = renewCheckoutSparkSettledLeg(state, {
      legId: target.legId,
      intent,
      proof,
      nowMs: NOW,
    })
    const currentTarget = { ...target, intent, generation: 1 as const }
    const fresh = await resolveCheckoutSparkFixtureInvoice(
      {
        lud16: plan.recipients[1]!.destination.value,
        network: plan.network,
        amountSats: intent.invoiceAmountSats,
        nowSeconds: Math.floor(NOW / 1000),
        shouldContinue: () => true,
      },
      intent.paymentRequest
    )
    let settlement = recordCheckoutSparkMerchantCredit(
      createCheckoutSparkMerchantSettlementRecord(plan),
      plan,
      {
        mode: "ordinary_v3",
        requestId: plan.funding.requestId,
        transferId: state.credit!.transferId,
        receiverIdentityPublicKey: IDENTITY,
        grossSats: 1113,
        creditedSats: 1111,
      },
      CREATED_AT + 1
    )
    const paid = {
      ...intent,
      status: "paid" as const,
      finalFeeSats: 10,
      finalDebitSats: target.allocationSats,
    }
    settlement = recordCheckoutSparkMerchantPayout(
      settlement,
      plan,
      currentTarget,
      paid,
      NOW + 1,
      createCheckoutSparkInvoiceOriginRecord(plan, currentTarget, fresh.origin!)
    )
    const notifications = getCheckoutSparkSupplierNotifications(
      plan,
      settlement,
      renewed
    )
    expect(notifications.length).toBe(1)
    expect(notifications[0]!.amountSats).toBe(intent.invoiceAmountSats)
    expect(() =>
      getCheckoutSparkSupplierNotifications(plan, settlement)
    ).toThrow()
    expect(() =>
      getCheckoutSparkSupplierNotifications(plan, settlement, state)
    ).toThrow()
    const database = new ConduitDB(`renewal-supplier-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    const repository = new DexieCheckoutSparkSettledRepository(database)
    try {
      await repository.create(plan)
      const saved = await repository.save(state, 1)
      if (saved.status !== "active") throw new Error("Expected saved state")
      let current = await repository.saveRenewedWithInvoiceOrigin(
        renewed,
        saved.revision,
        {
          legId: target.legId,
          proof,
          origin: fresh.origin!,
          nowMs: NOW,
          now: () => NOW,
        }
      )
      if (current.status !== "active") throw new Error("Expected renewed state")
      await repository.recordMerchantCredit(
        plan,
        {
          mode: "ordinary_v3",
          requestId: plan.funding.requestId,
          transferId: state.credit!.transferId,
          receiverIdentityPublicKey: IDENTITY,
          grossSats: 1113,
          creditedSats: 1111,
        },
        NOW + 1
      )
      await repository.recordMerchantPayout(plan, currentTarget, paid, NOW + 1)
      let complete = recordCheckoutSparkSettledLegStatus(current.state, {
        legId: target.legId,
        transferId: intent.transferId,
        paymentHash: intent.paymentHash,
        status: "paid",
        finalFeeSats: 10,
        finalDebitSats: target.allocationSats,
        observedAt: NOW + 1,
      })
      let byte = 6
      for (const leg of complete.legs.filter((leg) => leg.intent === null)) {
        const amount = leg.allocationSats! - 1
        const hash = byte.toString(16).padStart(2, "0").repeat(32)
        complete = prepareCheckoutSparkSettledLeg(complete, {
          legId: leg.legId,
          transferId: deriveCheckoutSparkSettledTransferId(plan, leg.legId),
          paymentRequest: invoice(amount, byte++, NOW),
          paymentHash: hash,
          invoiceAmountSats: amount,
          maxFeeSats: 1,
          preparedAt: NOW + 2,
        })
        complete = recordCheckoutSparkSettledLegStatus(complete, {
          legId: leg.legId,
          transferId: complete.legs.find((item) => item.legId === leg.legId)!
            .intent!.transferId,
          paymentHash: hash,
          status: "paid",
          finalFeeSats: 1,
          finalDebitSats: leg.allocationSats!,
          observedAt: NOW + 3,
        })
      }
      current = await repository.save(complete, current.revision)
      if (current.status !== "active")
        throw new Error("Expected complete state")
      await repository.retire({
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        expectedRevision: current.revision,
        evidence: {
          walletId: plan.walletId,
          network: plan.network,
          observedAt: NOW + 4,
          availableSats: 0,
          ownedSats: 0,
          incomingSats: 0,
          fundingReceiveTerminal: true,
          sendHistoryTerminal: true,
          claimsTerminal: true,
          refundsTerminal: true,
        },
      })
      const binding = await database.checkoutSparkPlanBindings.get(
        plan.checkoutId
      )
      expect(binding?.retiredSettlementSummary?.schemaVersion).toBe(2)
      expect(binding?.supplierNotificationIntents?.length).toBe(1)
      expect(
        binding?.supplierNotificationIntents?.[0]?.notificationId ===
          notifications[0]!.notificationId
      ).toBe(true)
      expect(
        getCheckoutSparkSupplierNotifications(
          plan,
          settlement,
          binding!.retiredSettlementSummary!
        ).length
      ).toBe(1)
    } finally {
      await database.delete()
    }
  })
})
