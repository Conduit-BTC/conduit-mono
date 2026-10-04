import { describe, expect, it } from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledTreasuryPlan,
  restoreCheckoutSparkSettledPlan,
  restoreCheckoutSparkSettledReconciliation,
  recordCheckoutSparkMerchantTreasury,
  projectCheckoutSparkMerchantSettlement,
  createCheckoutSparkRetiredSettlementSummary,
  validateCheckoutSparkRetiredSettlementRecord,
  DexieCheckoutSparkSettledRepository,
  assertCheckoutSparkSettledRecoveryProgression,
  deriveCheckoutSparkNativeTreasuryInvoiceId,
  deriveCheckoutSparkNativeTreasuryBudget,
  prepareCheckoutSparkNativeTreasury,
  recordCheckoutSparkNativeTreasuryStatus,
  runCheckoutSparkNativeTreasuryStep,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkNativeTreasuryProvider,
  type CheckoutSparkNativeTreasuryStepInput,
} from "@conduit/core/protocol"

import {
  AT,
  nativeTreasuryFixture as fixture,
} from "./support/checkout-spark-native-treasury-fixture"
function engine(
  f = fixture(),
  options: {
    state?: CheckoutSparkSettledReconciliation
    preflight?: "ready" | "fee_over_cap"
    missing?: boolean
    ackFail?: number
    failedProofAt?: number
  } = {}
) {
  let state = options.state ?? f.state
  let revision = 1
  let sends = 0
  let proofs = 0
  let acks = 0
  let time = AT + 10
  const events: string[] = []
  const provider: CheckoutSparkNativeTreasuryProvider = {
    reconcile: async (target) =>
      sends && !options.missing
        ? {
            invoiceId: target.intent.invoiceId,
            status: "paid",
            providerTransferId: "actual-native-transfer",
            finalFeeSats: 0,
            finalDebitSats: target.intent.amountSats,
          }
        : { invoiceId: target.intent.invoiceId, status: "not_found" },
    preflight: async () => options.preflight ?? "ready",
    send: async () => {
      sends++
      events.push("send")
      return { status: "submitted" }
    },
  }
  const input: CheckoutSparkNativeTreasuryStepInput = {
    checkoutId: f.plan.checkoutId,
    planDigest: f.plan.planDigest,
    legId: f.feeId,
    actor: "shopper",
    now: () => time++,
    provider,
    store: {
      load: async () => ({ status: "active", revision, state }),
      save: async (next, expected) => {
        expect(expected).toBe(revision)
        assertCheckoutSparkSettledRecoveryProgression(state, next)
        state = next
        revision++
        events.push(`save:${state.treasuryFinalization!.status}`)
        return { status: "active", revision, state }
      },
      savePrepared: async (next, expected, record) => {
        expect(expected).toBe(revision)
        deriveCheckoutSparkNativeTreasuryBudget(state, record)
        state = next
        revision++
        events.push("save:prepared")
        return { status: "active", revision, state }
      },
    },
    proveCommerce: async () => {
      proofs++
      if (proofs === options.failedProofAt) throw new Error("Unavailable")
      return f.record
    },
    acknowledgeRecoverySnapshot: async (snapshot) => {
      acks++
      events.push(`ack:${snapshot.treasuryFinalization!.status}`)
      if (acks === options.ackFail) throw new Error("Relay unavailable")
    },
  }
  return {
    input,
    events,
    sends: () => sends,
    state: () => state,
    proofs: () => proofs,
  }
}

describe("Checkout Spark native treasury accounting", () => {
  it("freezes v4 without changing v3 canonical restoration", () => {
    const f = fixture()
    expect(restoreCheckoutSparkSettledPlan(f.legacy)).toEqual(f.legacy)
    expect(f.plan.schemaVersion).toBe(4)
    expect(f.plan.planDigest).not.toBe(f.legacy.planDigest)
    expect(restoreCheckoutSparkSettledPlan(f.plan)).toEqual(f.plan)
    expect(f.state.schemaVersion).toBe(5)
  })
  it("binds the deterministic invoice before the digest and rejects rebinding", () => {
    const f = fixture()
    expect(deriveCheckoutSparkNativeTreasuryInvoiceId(f.identity)).toBe(
      f.plan.nativeTreasury!.invoiceId
    )
    expect(
      deriveCheckoutSparkNativeTreasuryInvoiceId({
        ...f.identity,
        orderId: "other",
      })
    ).not.toBe(f.plan.nativeTreasury!.invoiceId)
    expect(() =>
      freezeCheckoutSparkSettledTreasuryPlan({
        ...f.plan,
        nativeTreasury: { ...f.plan.nativeTreasury!, invoiceId: "wrong" },
      })
    ).toThrow()
    expect(() =>
      restoreCheckoutSparkSettledPlan({ ...f.plan, schemaVersion: 7 } as never)
    ).toThrow()
    expect(() =>
      restoreCheckoutSparkSettledReconciliation({
        ...f.state,
        schemaVersion: 6,
      } as never)
    ).toThrow()
  })
  it("combines original allocation and exactly one unused reserve sat", () => {
    const f = fixture()
    const budget = deriveCheckoutSparkNativeTreasuryBudget(f.state, f.record)
    expect(budget).toMatchObject({
      baseConduitAllocationSats: 111,
      unusedCommerceReserveSats: 1,
      authorizedDebitSats: 112,
    })
    expect(budget.authorizedDebitSats).toBe(
      f.state.credit!.creditedSats - f.state.legs[0]!.finalDebitSats!
    )
    const ready = prepareCheckoutSparkNativeTreasury(f.state, {
      settlement: f.record,
      preparedAt: AT + 4,
    })
    expect(ready.legs[1]!.intent).toBeNull()
    expect(ready.treasuryFinalization!.intent!.amountSats).toBe(112)
    expect(() =>
      deriveCheckoutSparkSettledTransferId(f.plan, f.feeId)
    ).toThrow()
  })
  it.each(["credit", "recipient", "missing", "debit"])(
    "rejects independent ledger mismatch: %s",
    (change) => {
      const f = fixture()
      const record = structuredClone(f.record)
      if (change === "credit")
        record.credit = { ...record.credit!, transferId: "other-deposit" }
      if (change === "recipient")
        record.paidLegs = record.paidLegs.map(
          ({ recipientVerified: _, ...leg }) => leg
        )
      if (change === "missing") record.paidLegs = []
      if (change === "debit")
        record.paidLegs = record.paidLegs.map((leg) => ({
          ...leg,
          finalDebitSats: leg.finalDebitSats - 1,
        }))
      expect(() =>
        deriveCheckoutSparkNativeTreasuryBudget(f.state, record)
      ).toThrow()
    }
  )
  it("rejects unconfirmed commerce, extra native keys and fee-bearing native evidence", () => {
    const f = fixture()
    const unpaid = {
      ...f.state,
      legs: f.state.legs.map((leg, index) =>
        index
          ? leg
          : {
              ...leg,
              status: "submitted" as const,
              finalFeeSats: null,
              finalDebitSats: null,
            }
      ),
    }
    expect(() =>
      deriveCheckoutSparkNativeTreasuryBudget(unpaid, f.record)
    ).toThrow()
    expect(() =>
      restoreCheckoutSparkSettledReconciliation({
        ...f.state,
        treasuryFinalization: {
          ...f.state.treasuryFinalization!,
          privateData: undefined,
        },
      } as never)
    ).toThrow()
    const state = prepareCheckoutSparkNativeTreasury(f.state, {
      settlement: f.record,
      preparedAt: AT + 4,
    })
    expect(() =>
      recordCheckoutSparkNativeTreasuryStatus(state, {
        invoiceId: f.plan.nativeTreasury!.invoiceId,
        providerTransferId: "actual",
        status: "paid",
        observedAt: AT + 5,
        finalFeeSats: 1,
        finalDebitSats: 112,
      })
    ).toThrow()
  })
  it("retains actual native principal/debit and residual breakdown, never an invented ID", () => {
    const f = fixture()
    let state = prepareCheckoutSparkNativeTreasury(f.state, {
      settlement: f.record,
      preparedAt: AT + 4,
    })
    const before = createCheckoutSparkRetiredSettlementSummary(state)
    expect(before.schemaVersion).toBe(3)
    expect(before.legs[1]!.transferId).toBeNull()
    const evidence = {
      invoiceId: f.plan.nativeTreasury!.invoiceId,
      providerTransferId: "actual-native",
      status: "paid" as const,
      observedAt: AT + 5,
      finalFeeSats: 0,
      finalDebitSats: 112,
    }
    const record = recordCheckoutSparkMerchantTreasury(
      f.record,
      state,
      evidence
    )
    state = recordCheckoutSparkNativeTreasuryStatus(state, evidence)
    expect(record.schemaVersion).toBe(2)
    expect(record.nativeTreasury).toMatchObject({
      providerTransferId: "actual-native",
      principalSats: 112,
      finalDebitSats: 112,
      unusedCommerceReserveSats: 1,
    })
    expect(projectCheckoutSparkMerchantSettlement(record).feePending).toBe(
      false
    )
    const summary = createCheckoutSparkRetiredSettlementSummary(state)
    expect(summary.legs[1]!.transferId).toBe("actual-native")
    expect(
      validateCheckoutSparkRetiredSettlementRecord(summary, record)
    ).toEqual(record)
    expect(() =>
      assertCheckoutSparkSettledRecoveryProgression(state, {
        ...state,
        treasuryFinalization: {
          ...state.treasuryFinalization!,
          providerTransferId: "other",
        },
      })
    ).toThrow()
  })
})

describe("Checkout Spark native treasury durable step", () => {
  it("saves and ACKs exact prepared/submitted snapshots before one provider send", async () => {
    const e = engine()
    const result = await runCheckoutSparkNativeTreasuryStep(e.input)
    expect(result.outcome).toBe("paid")
    expect(e.events.slice(0, 5)).toEqual([
      "save:prepared",
      "ack:prepared",
      "save:submitted",
      "ack:submitted",
      "send",
    ])
    expect(e.proofs()).toBe(3)
    expect(e.sends()).toBe(1)
    expect(e.state().treasuryFinalization!.providerTransferId).toBe(
      "actual-native-transfer"
    )
  })
  it.each([1, 2])("stops for recovery ACK failure %s", async (ackFail) => {
    const e = engine(fixture(), { ackFail })
    expect((await runCheckoutSparkNativeTreasuryStep(e.input)).reason).toBe(
      "recovery_handoff_unavailable"
    )
    expect(e.sends()).toBe(0)
  })
  it("never resends a saved possible-send after NOT_FOUND", async () => {
    const f = fixture()
    const prepared = prepareCheckoutSparkNativeTreasury(f.state, {
      settlement: f.record,
      preparedAt: AT + 4,
    })
    const submitted = recordCheckoutSparkNativeTreasuryStatus(prepared, {
      invoiceId: f.plan.nativeTreasury!.invoiceId,
      status: "submitted",
      observedAt: AT + 5,
    })
    const e = engine(f, { state: submitted })
    expect((await runCheckoutSparkNativeTreasuryStep(e.input)).reason).toBe(
      "prior_possible_send"
    )
    expect(e.sends()).toBe(0)
  })
  it("pauses when a future native provider fee is nonzero", async () => {
    const e = engine(fixture(), { preflight: "fee_over_cap" })
    expect((await runCheckoutSparkNativeTreasuryStep(e.input)).reason).toBe(
      "fee_over_cap"
    )
    expect(e.sends()).toBe(0)
    expect(e.state().treasuryFinalization!.status).toBe("prepared")
  })
  it("keeps recovery and performs no native send for a zero attributed remainder", async () => {
    const f = fixture(2, 1)
    const budget = deriveCheckoutSparkNativeTreasuryBudget(f.state, f.record)
    expect(budget.authorizedDebitSats).toBe(0)
    expect(() =>
      restoreCheckoutSparkSettledReconciliation({
        ...f.state,
        updatedAt: AT + 4,
        legs: f.state.legs.map((leg, index) =>
          index ? { ...leg, status: "prepared", observedAt: AT + 4 } : leg
        ),
        treasuryFinalization: {
          intent: {
            ...budget,
            invoiceId: f.plan.nativeTreasury!.invoiceId,
            invoiceRequest: f.plan.nativeTreasury!.invoiceRequest,
            amountSats: 0,
            preparedAt: AT + 4,
          },
          status: "prepared",
          providerTransferId: null,
          observedAt: AT + 4,
          finalFeeSats: null,
          finalDebitSats: null,
        },
      })
    ).toThrow()
    const e = engine(f)
    expect((await runCheckoutSparkNativeTreasuryStep(e.input)).reason).toBe(
      "zero_remainder"
    )
    expect(e.state().treasuryFinalization!.intent).toBeNull()
    expect(e.sends()).toBe(0)
  })
  it("does not send after fresh commerce proof disappears at the last boundary", async () => {
    const e = engine(fixture(), { failedProofAt: 3 })
    expect((await runCheckoutSparkNativeTreasuryStep(e.input)).reason).toBe(
      "provider_evidence_unavailable"
    )
    expect(e.state().treasuryFinalization!.status).toBe("submitted")
    expect(e.sends()).toBe(0)
  })
  it("requires a stored independent local ledger to CAS-save a native intent", async () => {
    const f = fixture()
    const database = new ConduitDB(`native-treasury-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    await database.checkoutSparkPlanBindings.add({
      checkoutId: f.plan.checkoutId,
      planDigest: f.plan.planDigest,
    })
    await database.checkoutSparkReconciliations.add({
      checkoutId: f.plan.checkoutId,
      revision: 1,
      state: f.state,
    })
    const repository = new DexieCheckoutSparkSettledRepository(database)
    const next = prepareCheckoutSparkNativeTreasury(f.state, {
      settlement: f.record,
      preparedAt: AT + 4,
    })
    await expect(repository.save(next, 1)).rejects.toThrow()
    await expect(
      repository.saveTreasuryPrepared(next, 1, f.record)
    ).rejects.toThrow()
    await database.checkoutSparkPlanBindings.put({
      checkoutId: f.plan.checkoutId,
      planDigest: f.plan.planDigest,
      merchantSettlement: f.record,
    })
    const saved = await repository.saveTreasuryPrepared(next, 1, f.record)
    expect(saved.status).toBe("active")
    expect(
      saved.status === "active" &&
        saved.state.treasuryFinalization!.intent!.amountSats
    ).toBe(112)
    await expect(
      repository.saveTreasuryPrepared(next, 1, f.record)
    ).rejects.toThrow()
    database.close()
    await database.delete()
  })
})
