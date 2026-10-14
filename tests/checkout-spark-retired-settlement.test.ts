import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB, type OrderLifecycle } from "@conduit/core/db"
import {
  CheckoutSparkSettledRepositoryConflictError,
  DexieCheckoutSparkSettledRepository,
  createCheckoutSparkMerchantSettlementRecord,
  createCheckoutSparkRetiredSettlementSummary,
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  validateCheckoutSparkRetiredSettlementRecord,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkSettledReconciliation,
} from "@conduit/core/protocol"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW = 1_800_000_000_000
const BUYER = "a".repeat(64)
const MERCHANT = "b".repeat(64)
const ORGANIZER = "c".repeat(64)
const RECEIVER = `02${"d".repeat(64)}`

function invoice(amountSats: number, hashByte: number): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function plan(): CheckoutSparkSettledPlan {
  return freezeCheckoutSparkSettledPlan({
    checkoutId: "retained-checkout",
    orderId: "retained-order",
    merchantPubkey: MERCHANT,
    walletId: "retained-wallet",
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 120_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:item`,
          productEventId: "e".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "retained-receive",
      paymentRequest: invoice(1_113, 1),
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: RECEIVER,
      grossFundingSats: 1_113,
      createdAt: NOW,
      expiresAt: NOW + 3_600_000,
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
            profileEventId: "f".repeat(64),
            profileEventCreatedAt: NOW / 1_000,
          },
        },
        weightSats: 700,
      },
      {
        kind: "organizer",
        recipientId: ORGANIZER,
        destination: {
          type: "lightning_address",
          value: "organizer@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "9".repeat(64),
            profileEventCreatedAt: NOW / 1_000,
          },
        },
        weightSats: 300,
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
        weightSats: 111,
      },
    ],
  })
}

function terminalState(): CheckoutSparkSettledReconciliation {
  const frozen = plan()
  let state = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(frozen),
    {
      requestId: frozen.funding.requestId,
      paymentHash: frozen.funding.paymentHash,
      transferId: "retained-credit",
      receiverIdentityPublicKey: RECEIVER,
      grossSats: frozen.funding.grossFundingSats,
      creditedSats: 1_111,
      observedAt: NOW + 1,
    }
  )
  for (const [index, leg] of state.legs.entries()) {
    const allocationSats = leg.allocationSats!
    const intent = {
      legId: leg.legId,
      transferId: deriveCheckoutSparkSettledTransferId(frozen, leg.legId),
      paymentRequest: invoice(allocationSats - 1, index + 2),
      paymentHash: (index + 2).toString(16).padStart(2, "0").repeat(32),
      invoiceAmountSats: allocationSats - 1,
      maxFeeSats: 1,
      preparedAt: NOW + 2 + index * 2,
    }
    state = prepareCheckoutSparkSettledLeg(state, intent)
    state = recordCheckoutSparkSettledLegStatus(state, {
      legId: leg.legId,
      transferId: intent.transferId,
      paymentHash: intent.paymentHash,
      status: "paid",
      observedAt: intent.preparedAt + 1,
      finalFeeSats: 1,
      finalDebitSats: allocationSats,
    })
  }
  return state
}

function deliveredOrder(frozen: CheckoutSparkSettledPlan): OrderLifecycle {
  return {
    orderId: frozen.orderId,
    merchantPubkey: frozen.merchantPubkey,
    buyerPubkey: BUYER,
    buyerIdentityKind: "signed_in",
    checkoutMode: "private_checkout",
    orderDeliveryStatus: "sent",
    currency: "SATS",
    totalSats: frozen.commerceQuote.commerceTotalSats,
    checkoutSparkRouterBinding: {
      checkoutId: frozen.checkoutId,
      planDigest: frozen.planDigest,
      walletId: frozen.walletId,
    },
  } as OrderLifecycle
}

async function withDatabase(
  run: (
    database: ConduitDB,
    repository: DexieCheckoutSparkSettledRepository
  ) => Promise<void>
): Promise<void> {
  const database = new ConduitDB(`conduit-retained-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  try {
    await run(database, new DexieCheckoutSparkSettledRepository(database))
  } finally {
    database.close()
    await database.delete()
  }
}

async function stage(
  database: ConduitDB,
  repository: DexieCheckoutSparkSettledRepository,
  state: CheckoutSparkSettledReconciliation
): Promise<number> {
  await repository.create(state.plan)
  const saved = await repository.save(state, 1)
  if (saved.status !== "active") throw new Error("Expected active checkout")
  await database.orderLifecycles.put(deliveredOrder(state.plan))
  return saved.revision
}

function retirement(
  state: CheckoutSparkSettledReconciliation,
  expectedRevision: number
) {
  return {
    checkoutId: state.plan.checkoutId,
    planDigest: state.plan.planDigest,
    expectedRevision,
    evidence: {
      walletId: state.plan.walletId,
      network: state.plan.network,
      observedAt: state.updatedAt + 1,
      availableSats: 0,
      ownedSats: 0,
      incomingSats: 0,
      fundingReceiveTerminal: true,
      sendHistoryTerminal: true,
      claimsTerminal: true,
      refundsTerminal: true,
    },
  }
}

describe("retained buyer Spark settlement", () => {
  it("binds only the exact delivered signed-in order and account", async () => {
    await withDatabase(async (database, repository) => {
      const frozen = plan()
      await repository.create(frozen)
      await expect(
        repository.bindBuyerOrder(frozen, BUYER, () => {})
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      await database.orderLifecycles.put(deliveredOrder(frozen))
      await expect(
        repository.bindBuyerOrder(frozen, MERCHANT, () => {})
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      const bound = await repository.bindBuyerOrder(frozen, BUYER, () => {})
      expect(bound).toMatchObject({
        buyerPubkey: BUYER,
        orderId: frozen.orderId,
        walletId: frozen.walletId,
        commerceTotalSats: 1_000,
      })
      expect(await repository.bindBuyerOrder(frozen, BUYER, () => {})).toEqual(
        bound
      )
      expect(
        await repository.loadBuyerSettlement(
          frozen.checkoutId,
          frozen.planDigest,
          MERCHANT
        )
      ).toEqual({ status: "absent" })
    })
  })

  it("rejects mismatched delivered terms and rolls back a revoked binder", async () => {
    await withDatabase(async (database, repository) => {
      const frozen = plan()
      await repository.create(frozen)
      const order = deliveredOrder(frozen)
      for (const broken of [
        { ...order, totalSats: 999 },
        { ...order, orderDeliveryStatus: "failed" as const },
        {
          ...order,
          checkoutSparkRouterBinding: {
            ...order.checkoutSparkRouterBinding!,
            walletId: "other-wallet",
          },
        },
      ]) {
        await database.orderLifecycles.put(broken)
        await expect(
          repository.bindBuyerOrder(frozen, BUYER, () => {})
        ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      }
      await database.orderLifecycles.put(order)
      let checks = 0
      await expect(
        repository.bindBuyerOrder(frozen, BUYER, () => {
          checks += 1
          if (checks === 4) throw new Error("revoked")
        })
      ).rejects.toThrow("revoked")
      expect(
        (await database.checkoutSparkPlanBindings.get(frozen.checkoutId))
          ?.buyerOrderBinding
      ).toBeUndefined()
      await repository.bindBuyerOrder(frozen, BUYER, () => {})
    })
  })

  it("retains an exact organizer-inclusive summary but no inferred paid proof", async () => {
    await withDatabase(async (database, repository) => {
      const state = terminalState()
      const revision = await stage(database, repository, state)
      await repository.bindBuyerOrder(state.plan, BUYER, () => {})
      const active = await repository.loadBuyerSettlement(
        state.plan.checkoutId,
        state.plan.planDigest,
        BUYER
      )
      expect(active.status).toBe("active")
      await repository.retire(retirement(state, revision))
      const retired = await repository.loadBuyerSettlement(
        state.plan.checkoutId,
        state.plan.planDigest,
        BUYER
      )
      expect(retired.status).toBe("retired")
      if (retired.status !== "retired") return
      expect(retired.settlement).toBeNull()
      expect(retired.summary.legs.map((leg) => leg.kind)).toEqual([
        "merchant",
        "organizer",
        "conduit",
      ])
      expect(retired.summary.credit).toEqual({
        transferId: "retained-credit",
        creditedSats: 1_111,
      })
      const serialized = JSON.stringify(retired.summary)
      expect(serialized).not.toContain(state.plan.funding.paymentRequest)
      expect(serialized).not.toContain("merchant@example.test")
      expect(serialized).not.toContain("organizer@example.test")
      expect(serialized).not.toContain(state.plan.funding.paymentHash)
      expect(await database.checkoutSparkReconciliations.count()).toBe(0)
      expect(
        await repository.loadBuyerSettlement(
          state.plan.checkoutId,
          state.plan.planDigest,
          MERCHANT
        )
      ).toEqual({ status: "absent" })
    })
  })

  it("rejects substituted provider leg amounts, transfer IDs, and order IDs", () => {
    const state = terminalState()
    const summary = createCheckoutSparkRetiredSettlementSummary(state)
    const initial = createCheckoutSparkMerchantSettlementRecord(state.plan)
    const record = {
      ...initial,
      credit: {
        transferId: state.credit!.transferId,
        creditedSats: state.credit!.creditedSats,
        observedAt: NOW + 1,
      },
      paidLegs: summary.legs.map((leg) => ({
        legId: leg.legId,
        transferId: leg.transferId,
        allocationSats: leg.allocationSats,
        finalDebitSats: leg.allocationSats,
        finalFeeSats: 0,
        observedAt: NOW + 5,
      })),
    }
    expect(
      validateCheckoutSparkRetiredSettlementRecord(summary, record)
    ).toEqual(record)
    expect(() =>
      validateCheckoutSparkRetiredSettlementRecord(summary, {
        ...record,
        orderId: "another-order",
      })
    ).toThrow()
    expect(() =>
      validateCheckoutSparkRetiredSettlementRecord(summary, {
        ...record,
        paidLegs: [
          { ...record.paidLegs[0]!, allocationSats: 1 },
          ...record.paidLegs.slice(1),
        ],
      })
    ).toThrow()
    expect(() =>
      validateCheckoutSparkRetiredSettlementRecord(summary, {
        ...record,
        paidLegs: [
          { ...record.paidLegs[0]!, transferId: "another-transfer" },
          ...record.paidLegs.slice(1),
        ],
      })
    ).toThrow()
  })

  it("validates retained Merchant reads against exact provider facts", async () => {
    await withDatabase(async (database, repository) => {
      const state = terminalState()
      const revision = await stage(database, repository, state)
      await repository.bindBuyerOrder(state.plan, BUYER, () => {})
      const summary = createCheckoutSparkRetiredSettlementSummary(state)
      const initial = createCheckoutSparkMerchantSettlementRecord(state.plan)
      const record = {
        ...initial,
        credit: {
          transferId: state.credit!.transferId,
          creditedSats: state.credit!.creditedSats,
          observedAt: NOW + 1,
        },
        paidLegs: summary.legs.map((leg) => ({
          legId: leg.legId,
          transferId: leg.transferId,
          allocationSats: leg.allocationSats,
          finalDebitSats: leg.allocationSats,
          finalFeeSats: 0,
          observedAt: NOW + 5,
        })),
      }
      const binding = (await database.checkoutSparkPlanBindings.get(
        state.plan.checkoutId
      ))!
      await database.checkoutSparkPlanBindings.put({
        ...binding,
        merchantSettlement: record,
        orderWitness: {
          schemaVersion: 1,
          merchantPubkey: MERCHANT,
          buyerPubkey: BUYER,
          orderId: state.plan.orderId,
          rumorId: "f".repeat(64),
          contentHash: "e".repeat(64),
          checkoutId: state.plan.checkoutId,
          planDigest: state.plan.planDigest,
        },
      })
      await repository.retire(retirement(state, revision))
      const buyer = await repository.loadBuyerSettlement(
        state.plan.checkoutId,
        state.plan.planDigest,
        BUYER
      )
      expect(buyer.status).toBe("retired")
      if (buyer.status !== "retired") return
      expect(buyer.settlement).toEqual(record)
      expect(
        await repository.loadMerchantSettlement(
          MERCHANT,
          state.plan.checkoutId,
          state.plan.planDigest
        )
      ).toEqual(record)
      // Older rows without local signed-source validation remain unverified.
      expect(
        await repository.loadMerchantOrderSettlements(MERCHANT, [
          state.plan.orderId,
        ])
      ).toHaveLength(0)
      const retiredBinding = (await database.checkoutSparkPlanBindings.get(
        state.plan.checkoutId
      ))!
      for (const paidLegs of [
        [
          { ...record.paidLegs[0]!, transferId: "substituted" },
          ...record.paidLegs.slice(1),
        ],
        [
          { ...record.paidLegs[0]!, allocationSats: 1 },
          ...record.paidLegs.slice(1),
        ],
      ]) {
        await database.checkoutSparkPlanBindings.put({
          ...retiredBinding,
          merchantSettlement: { ...record, paidLegs },
        })
        await expect(
          repository.loadMerchantSettlement(
            MERCHANT,
            state.plan.checkoutId,
            state.plan.planDigest
          )
        ).rejects.toThrow()
        await expect(
          repository.loadBuyerSettlement(
            state.plan.checkoutId,
            state.plan.planDigest,
            BUYER
          )
        ).rejects.toThrow()
        expect(
          await repository.loadMerchantOrderSettlements(MERCHANT, [
            state.plan.orderId,
          ])
        ).toEqual([])
      }
    })
  })

  it("rolls back the summary and tombstone together on retirement failure", async () => {
    await withDatabase(async (database, repository) => {
      const state = terminalState()
      const revision = await stage(database, repository, state)
      await repository.bindBuyerOrder(state.plan, BUYER, () => {})
      database.checkoutSparkRetirements.hook("creating", () => {
        throw new Error("simulated tombstone failure")
      })
      await expect(
        repository.retire(retirement(state, revision))
      ).rejects.toThrow("simulated tombstone failure")
      const binding = await database.checkoutSparkPlanBindings.get(
        state.plan.checkoutId
      )
      expect(binding?.retiredSettlementSummary).toBeUndefined()
      expect(
        (
          await repository.loadBuyerSettlement(
            state.plan.checkoutId,
            state.plan.planDigest,
            BUYER
          )
        ).status
      ).toBe("active")
    })
  })
})
