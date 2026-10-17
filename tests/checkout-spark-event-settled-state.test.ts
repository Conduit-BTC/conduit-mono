import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  CheckoutSparkSettledRepositoryConflictError,
  DexieCheckoutSparkSettledRepository,
  createCheckoutSparkSettledReconciliation,
  recordCheckoutSparkSettledCredit,
  restoreCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledLegStatus,
  createCheckoutSparkMerchantSettlementRecord,
  createCheckoutSparkRetiredSettlementSummary,
  restoreCheckoutSparkRetiredSettlementSummary,
  restoreCheckoutSparkBuyerOrderBinding,
  validateCheckoutSparkRetiredSettlementRecord,
  prepareCheckoutSparkNativeTreasury,
  deriveCheckoutSparkNativeTreasuryBudget,
} from "@conduit/core"
import {
  checkoutSparkEventMarketFixture,
  EVENT_MARKET_FIXTURE_AT as AT,
  eventMarketFixtureInvoice,
} from "./support/checkout-spark-event-market-fixture"

function funded(f = checkoutSparkEventMarketFixture({ commerceTotalSats: 0 })) {
  const state = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(f.plan),
    {
      requestId: f.plan.funding.requestId,
      paymentHash: f.plan.funding.paymentHash,
      transferId: crypto.randomUUID(),
      receiverIdentityPublicKey: f.plan.funding.receiverIdentityPublicKey,
      grossSats: f.plan.funding.grossFundingSats,
      creditedSats: f.plan.funding.grossFundingSats,
      observedAt: AT + 1,
    }
  )
  return { f, state }
}

describe("event reconciliation persistence and retained settlement versions", () => {
  it("reopens state six with the exact organizer allocation and native final intent, rejecting stale CAS", async () => {
    const { f, state: initial } = funded()
    const dbName = `event-state-${crypto.randomUUID()}`
    let database = new ConduitDB(dbName, { indexedDB, IDBKeyRange })
    try {
      let repository = new DexieCheckoutSparkSettledRepository(database)
      await repository.create(f.plan)
      await repository.save(initial, 1)
      const organizer = initial.legs[0]!
      const invoice = eventMarketFixtureInvoice(organizer.allocationSats! - 1)
      let state = prepareCheckoutSparkSettledLeg(initial, {
        legId: organizer.legId,
        transferId: deriveCheckoutSparkSettledTransferId(
          f.plan,
          organizer.legId
        ),
        ...invoice,
        invoiceAmountSats: organizer.allocationSats! - 1,
        maxFeeSats: 1,
        preparedAt: AT + 2,
      })
      state = recordCheckoutSparkSettledLegStatus(state, {
        legId: organizer.legId,
        transferId: state.legs[0]!.intent!.transferId,
        paymentHash: invoice.paymentHash,
        status: "paid",
        observedAt: AT + 3,
        finalFeeSats: 0,
        finalDebitSats: organizer.allocationSats! - 1,
      })
      const record = {
        ...createCheckoutSparkMerchantSettlementRecord(f.plan),
        credit: {
          transferId: state.credit!.transferId,
          creditedSats: state.credit!.creditedSats,
          observedAt: AT + 1,
        },
        paidLegs: [
          {
            legId: organizer.legId,
            transferId: state.legs[0]!.intent!.transferId,
            allocationSats: organizer.allocationSats!,
            finalDebitSats: organizer.allocationSats! - 1,
            finalFeeSats: 0,
            observedAt: AT + 3,
            recipientVerified: true as const,
          },
        ],
      }
      await repository.save(state, 2)
      const binding = await database.checkoutSparkPlanBindings.get(
        f.plan.checkoutId
      )
      await database.checkoutSparkPlanBindings.put({
        ...binding!,
        merchantSettlement: record,
      })
      expect(
        deriveCheckoutSparkNativeTreasuryBudget(state, record)
          .authorizedDebitSats
      ).toBe(113)
      state = prepareCheckoutSparkNativeTreasury(state, {
        settlement: record,
        preparedAt: AT + 4,
      })
      await repository.saveTreasuryPrepared(state, 3, record)
      database.close()
      database = new ConduitDB(dbName, { indexedDB, IDBKeyRange })
      repository = new DexieCheckoutSparkSettledRepository(database)
      const reopened = await repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(reopened.status).toBe("active")
      if (reopened.status !== "active") throw new Error("Expected state")
      expect(reopened.state).toEqual(state)
      expect(reopened.state.schemaVersion).toBe(6)
      expect(reopened.state.treasuryFinalization?.intent?.amountSats).toBe(113)
      await expect(repository.save(state, 3)).rejects.toBeInstanceOf(
        CheckoutSparkSettledRepositoryConflictError
      )
      expect(() =>
        restoreCheckoutSparkSettledReconciliation({
          ...state,
          schemaVersion: 5,
        })
      ).toThrow()
    } finally {
      database.close()
      await database.delete()
    }
  })

  it("retains fee-only evidence under explicit new versions without changing old positive-total guards", () => {
    const { f, state } = funded()
    const summary = createCheckoutSparkRetiredSettlementSummary(state)
    expect(summary.schemaVersion).toBe(4)
    expect(summary.commerceTotalSats).toBe(0)
    expect(summary.legs.map((leg) => leg.kind)).toEqual([
      "organizer",
      "conduit",
    ])
    const record = createCheckoutSparkMerchantSettlementRecord(f.plan)
    expect(record).toMatchObject({
      schemaVersion: 3,
      merchantLegId: null,
      requiredCommerceLegIds: [],
      organizerLegId: state.legs[0]!.legId,
    })
    expect(
      validateCheckoutSparkRetiredSettlementRecord(summary, record)
    ).toEqual(record)
    const buyer = {
      schemaVersion: 2 as const,
      checkoutId: f.plan.checkoutId,
      planDigest: f.plan.planDigest,
      orderId: f.plan.orderId,
      merchantPubkey: f.merchantPubkey,
      buyerPubkey: f.organizerPubkey,
      walletId: f.plan.walletId,
      commerceTotalSats: 0,
    }
    expect(restoreCheckoutSparkBuyerOrderBinding(buyer)).toEqual(buyer)
    expect(() =>
      restoreCheckoutSparkBuyerOrderBinding({ ...buyer, schemaVersion: 1 })
    ).toThrow()
    expect(() =>
      restoreCheckoutSparkRetiredSettlementSummary({
        ...summary,
        schemaVersion: 3,
      })
    ).toThrow()
    expect(() =>
      validateCheckoutSparkRetiredSettlementRecord(summary, {
        ...record,
        organizerLegId: f.events.grant.id,
      })
    ).toThrow()
  })
})
