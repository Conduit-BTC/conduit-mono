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
  assertCheckoutSparkNativePreProviderRetry,
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
    notSent?: boolean
    throwSend?: boolean
    cancelSaveFail?: "before" | "after"
    retrySaveFail?: "before" | "after"
  } = {}
) {
  let state = options.state ?? f.state
  let revision = 1
  let sends = 0
  let submittedSends = 0
  let proofs = 0
  let acks = 0
  let time = AT + 10
  const events: string[] = []
  const nativeAdmissionScope = Object.freeze({})
  const provider: CheckoutSparkNativeTreasuryProvider = {
    reconcile: async (target) =>
      submittedSends && !options.missing
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
      if (options.throwSend) throw new Error("Provider result lost")
      if (options.notSent && sends === 1) return { status: "not_sent" }
      submittedSends++
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
      nativeAdmissionScope,
      load: async () => ({ status: "active", revision, state }),
      save: async (next, expected) => {
        expect(expected).toBe(revision)
        if (
          next.treasuryFinalization!.status === "terminal_failure" &&
          options.cancelSaveFail === "before"
        )
          throw new Error("Write interrupted")
        assertCheckoutSparkSettledRecoveryProgression(state, next)
        state = next
        revision++
        events.push(`save:${state.treasuryFinalization!.status}`)
        if (
          next.treasuryFinalization!.status === "terminal_failure" &&
          options.cancelSaveFail === "after"
        )
          throw new Error("Callback interrupted")
        return { status: "active", revision, state }
      },
      savePreProviderRetry: async (next, expected, capability) => {
        expect(expected).toBe(revision)
        assertCheckoutSparkNativePreProviderRetry(
          nativeAdmissionScope,
          state,
          next,
          expected,
          capability
        )
        if (options.retrySaveFail === "before")
          throw new Error("Write interrupted")
        assertCheckoutSparkSettledRecoveryProgression(
          recordCheckoutSparkNativeTreasuryStatus(state, {
            invoiceId: state.plan.nativeTreasury!.invoiceId,
            status: "submitted",
            observedAt: state.treasuryFinalization!.observedAt!,
          }),
          next
        )
        state = next
        revision++
        events.push("save:submitted")
        if (options.retrySaveFail === "after")
          throw new Error("Callback interrupted")
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
        record.paidLegs = record.paidLegs.map((leg) => ({
          ...leg,
          recipientVerified: false,
        }))
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
  it("rejects short funding before preparing or sending a native payment", () => {
    const e = engine()
    expect(() => fixture(2, 1)).toThrow("funding shortfall")
    expect(e.state().treasuryFinalization!.intent).toBeNull()
    expect(e.sends()).toBe(0)
  })
  it("durably cancels a proven pre-provider failure and retries only the exact intent", async () => {
    const e = engine(fixture(), { failedProofAt: 3 })
    expect((await runCheckoutSparkNativeTreasuryStep(e.input)).reason).toBe(
      "provider_evidence_unavailable"
    )
    expect(e.state().treasuryFinalization!.status).toBe("terminal_failure")
    expect(e.sends()).toBe(0)
    const originalIntent = e.state().treasuryFinalization!.intent
    expect((await runCheckoutSparkNativeTreasuryStep(e.input)).outcome).toBe(
      "paid"
    )
    expect(e.state().treasuryFinalization!.intent).toEqual(originalIntent)
    expect(e.sends()).toBe(1)
  })
  it("retries after a submitted-snapshot ACK failure without changing the invoice", async () => {
    const e = engine(fixture(), { ackFail: 2 })
    expect((await runCheckoutSparkNativeTreasuryStep(e.input)).reason).toBe(
      "recovery_handoff_unavailable"
    )
    expect(e.state().treasuryFinalization!.status).toBe("terminal_failure")
    const intent = e.state().treasuryFinalization!.intent
    expect(e.sends()).toBe(0)
    expect((await runCheckoutSparkNativeTreasuryStep(e.input)).outcome).toBe(
      "paid"
    )
    expect(e.state().treasuryFinalization!.intent).toEqual(intent)
    expect(e.sends()).toBe(1)
  })
  it("rejects authority loss after the final ACK without calling the provider", async () => {
    const e = engine()
    let expired = false
    const input = {
      ...e.input,
      now: () => (expired ? e.state().plan.takeoverAt : e.input.now()),
      acknowledgeRecoverySnapshot: async (
        state: CheckoutSparkSettledReconciliation
      ) => {
        await e.input.acknowledgeRecoverySnapshot(state)
        if (state.treasuryFinalization?.status === "submitted") expired = true
      },
    }
    expect((await runCheckoutSparkNativeTreasuryStep(input)).reason).toBe(
      "authority_transferred"
    )
    expect(e.state().treasuryFinalization!.status).toBe("terminal_failure")
    expect(e.sends()).toBe(0)
    expect((await runCheckoutSparkNativeTreasuryStep(input)).reason).toBe(
      "authority_transferred"
    )
    expect(e.sends()).toBe(0)
  })
  it("binds positive retry authority to the exact scope, revision, and snapshot", async () => {
    const e = engine(fixture(), { failedProofAt: 3 })
    await runCheckoutSparkNativeTreasuryStep(e.input)
    const input = {
      ...e.input,
      store: {
        ...e.input.store,
        savePreProviderRetry: async (
          ...args: Parameters<
            NonNullable<
              CheckoutSparkNativeTreasuryStepInput["store"]["savePreProviderRetry"]
            >
          >
        ) => {
          const [next, revision, capability] = args
          const previous = e.state()
          const scope = e.input.store.nativeAdmissionScope!
          for (const [alteredScope, alteredState, alteredRevision] of [
            [{}, previous, revision],
            [scope, previous, revision + 1],
            [
              scope,
              { ...previous, updatedAt: previous.updatedAt + 1 },
              revision,
            ],
          ] as const) {
            expect(() =>
              assertCheckoutSparkNativePreProviderRetry(
                alteredScope,
                alteredState,
                next,
                alteredRevision,
                capability
              )
            ).toThrow()
          }
          expect(() =>
            assertCheckoutSparkNativePreProviderRetry(
              scope,
              previous,
              {
                ...next,
                treasuryFinalization: {
                  ...next.treasuryFinalization!,
                  intent: {
                    ...next.treasuryFinalization!.intent!,
                    amountSats:
                      next.treasuryFinalization!.intent!.amountSats + 1,
                  },
                },
              },
              revision,
              capability
            )
          ).toThrow()
          return e.input.store.savePreProviderRetry!(...args)
        },
      },
    }
    expect((await runCheckoutSparkNativeTreasuryStep(input)).outcome).toBe(
      "paid"
    )
    expect(e.sends()).toBe(1)
  })
  it("accepts only the pinned adapter's positive not-sent result, not a thrown result", async () => {
    const cancelled = engine(fixture(), { notSent: true })
    expect(
      (await runCheckoutSparkNativeTreasuryStep(cancelled.input)).reason
    ).toBe("provider_evidence_unavailable")
    expect(
      (await runCheckoutSparkNativeTreasuryStep(cancelled.input)).outcome
    ).toBe("paid")
    expect(cancelled.sends()).toBe(2)
    const uncertain = engine(fixture(), { throwSend: true })
    expect(
      (await runCheckoutSparkNativeTreasuryStep(uncertain.input)).outcome
    ).toBe("send_ambiguous")
    expect(
      (await runCheckoutSparkNativeTreasuryStep(uncertain.input)).reason
    ).toBe("prior_possible_send")
    expect(uncertain.sends()).toBe(1)
  })
  it("never trusts an imported or reloaded cancellation label", async () => {
    const f = fixture()
    const local = engine(f, { failedProofAt: 3 })
    await runCheckoutSparkNativeTreasuryStep(local.input)
    const reloaded = engine(f, { state: structuredClone(local.state()) })
    expect(
      (await runCheckoutSparkNativeTreasuryStep(reloaded.input)).reason
    ).toBe("prior_possible_send")
    expect(reloaded.sends()).toBe(0)
    const prepared = prepareCheckoutSparkNativeTreasury(f.state, {
      settlement: f.record,
      preparedAt: AT + 4,
    })
    const forged = recordCheckoutSparkNativeTreasuryStatus(prepared, {
      invoiceId: f.plan.nativeTreasury!.invoiceId,
      status: "terminal_failure",
      observedAt: AT + 5,
    })
    const imported = engine(f, { state: forged })
    expect(
      (await runCheckoutSparkNativeTreasuryStep(imported.input)).reason
    ).toBe("prior_possible_send")
    expect(imported.sends()).toBe(0)
    expect(() =>
      assertCheckoutSparkNativePreProviderRetry(
        {},
        forged,
        recordCheckoutSparkNativeTreasuryStatus(forged, {
          invoiceId: f.plan.nativeTreasury!.invoiceId,
          status: "submitted",
          observedAt: AT + 6,
        }),
        1,
        {} as never
      )
    ).toThrow()
  })
  it.each(["before", "after"] as const)(
    "never retries after interrupted cancellation persistence: %s",
    async (cancelSaveFail) => {
      const e = engine(fixture(), { failedProofAt: 3, cancelSaveFail })
      await expect(
        runCheckoutSparkNativeTreasuryStep(e.input)
      ).rejects.toThrow()
      expect((await runCheckoutSparkNativeTreasuryStep(e.input)).reason).toBe(
        "prior_possible_send"
      )
      expect(e.sends()).toBe(0)
    }
  )
  it.each(["before", "after"] as const)(
    "no provider call follows interrupted retry admission persistence: %s",
    async (retrySaveFail) => {
      const e = engine(fixture(), { failedProofAt: 3, retrySaveFail })
      await runCheckoutSparkNativeTreasuryStep(e.input)
      await expect(
        runCheckoutSparkNativeTreasuryStep(e.input)
      ).rejects.toThrow()
      expect(e.sends()).toBe(0)
      if (retrySaveFail === "after") {
        expect((await runCheckoutSparkNativeTreasuryStep(e.input)).reason).toBe(
          "prior_possible_send"
        )
        expect(e.sends()).toBe(0)
      }
    }
  )
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
  it("CAS-retries a locally cancelled exact intent across repository instances, not storage domains", async () => {
    const f = fixture()
    const database = new ConduitDB(`native-retry-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    await database.checkoutSparkPlanBindings.add({
      checkoutId: f.plan.checkoutId,
      planDigest: f.plan.planDigest,
      merchantSettlement: f.record,
    })
    await database.checkoutSparkReconciliations.add({
      checkoutId: f.plan.checkoutId,
      revision: 1,
      state: f.state,
    })
    const first = new DexieCheckoutSparkSettledRepository(database)
    const e = engine(f, { failedProofAt: 3 })
    const ports = (
      repository: DexieCheckoutSparkSettledRepository
    ): CheckoutSparkNativeTreasuryStepInput["store"] => ({
      nativeAdmissionScope: repository.nativeTreasuryAdmissionScope,
      load: repository.load.bind(repository),
      save: repository.save.bind(repository),
      savePrepared: repository.saveTreasuryPrepared.bind(repository),
      savePreProviderRetry:
        repository.saveTreasuryPreProviderRetry.bind(repository),
    })
    const input = { ...e.input, store: ports(first) }
    expect((await runCheckoutSparkNativeTreasuryStep(input)).reason).toBe(
      "provider_evidence_unavailable"
    )
    const cancelled = await first.load(f.plan.checkoutId, f.plan.planDigest)
    expect(cancelled.status).toBe("active")
    if (cancelled.status !== "active")
      throw new Error("Missing cancelled admission")
    const next = recordCheckoutSparkNativeTreasuryStatus(cancelled.state, {
      invoiceId: f.plan.nativeTreasury!.invoiceId,
      status: "submitted",
      observedAt: cancelled.state.updatedAt + 1,
    })
    await expect(first.save(next, cancelled.revision)).rejects.toThrow()
    await expect(
      first.saveTreasuryPreProviderRetry(next, cancelled.revision, {} as never)
    ).rejects.toThrow()
    const freshRepository = new DexieCheckoutSparkSettledRepository(database)
    expect(freshRepository.nativeTreasuryAdmissionScope).toBe(
      first.nativeTreasuryAdmissionScope
    )
    expect(
      (
        await runCheckoutSparkNativeTreasuryStep({
          ...input,
          store: ports(freshRepository),
        })
      ).outcome
    ).toBe("paid")
    expect(e.sends()).toBe(1)
    const paid = await first.load(f.plan.checkoutId, f.plan.planDigest)
    expect(
      paid.status === "active" && paid.state.treasuryFinalization!.intent
    ).toEqual(cancelled.state.treasuryFinalization!.intent)
    database.close()
    await database.delete()
  })
})
