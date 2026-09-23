import { describe, expect, it } from "bun:test"
import Dexie from "dexie"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"

import { ConduitDB } from "@conduit/core/db"
import {
  applyCheckoutSparkEvidence,
  CheckoutSparkRepositoryConflictError,
  createCheckoutSparkReconciliation,
  DexieCheckoutSparkRepository,
  freezeCheckoutSparkPlan,
  type CheckoutSparkPlan,
  type CheckoutSparkReconciliation,
} from "@conduit/core/protocol"

const CREATED_AT = 1_800_000_000_000
const MERCHANT_PUBKEY = "a".repeat(64)
const fakeIndexedDBOptions = { indexedDB, IDBKeyRange }

function makePlan(checkoutId = "checkout-1", suffix = "a"): CheckoutSparkPlan {
  return freezeCheckoutSparkPlan({
    checkoutId,
    orderId: `order-${checkoutId}`,
    merchantPubkey: MERCHANT_PUBKEY,
    walletId: `wallet-${checkoutId}`,
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    funding: {
      requestId: `funding-${suffix}`,
      paymentRequest: `lnbc-funding-${suffix}`,
      paymentHash: "b".repeat(64),
      requiredNetSats: 171,
      grossFundingSats: 180,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 60_000,
    },
    obligations: [
      {
        kind: "merchant",
        recipientId: MERCHANT_PUBKEY,
        paymentRequest: `lnbc-merchant-${suffix}`,
        amountSats: 50,
        maxFeeSats: 5,
      },
      {
        kind: "conduit",
        recipientId: "example@pay.test",
        paymentRequest: `lnbc-conduit-${suffix}`,
        amountSats: 111,
        maxFeeSats: 5,
      },
    ],
  })
}

function fundingState(plan: CheckoutSparkPlan): CheckoutSparkReconciliation {
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

function completedState(plan: CheckoutSparkPlan): CheckoutSparkReconciliation {
  return plan.obligations.reduce<CheckoutSparkReconciliation>(
    (state, obligation, index) =>
      applyCheckoutSparkEvidence(state, {
        type: "obligation",
        obligationId: obligation.obligationId,
        outgoingId: obligation.outgoingId,
        paymentRequest: obligation.paymentRequest,
        amountSats: obligation.amountSats,
        maxFeeSats: obligation.maxFeeSats,
        state: "paid",
        observedAt: CREATED_AT + index + 2,
      }),
    fundingState(plan)
  )
}

function zeroFundsEvidence(plan: CheckoutSparkPlan) {
  return {
    walletId: plan.walletId,
    network: plan.network,
    observedAt: CREATED_AT + 10,
    availableSats: 0,
    ownedSats: 0,
    incomingSats: 0,
    fundingReceiveTerminal: true,
    sendHistoryTerminal: true,
    claimsTerminal: true,
    refundsTerminal: true,
  }
}

async function withDatabase(
  run: (
    database: ConduitDB,
    repository: DexieCheckoutSparkRepository
  ) => Promise<void>
): Promise<void> {
  const database = new ConduitDB(
    `conduit-checkout-test-${crypto.randomUUID()}`,
    fakeIndexedDBOptions
  )
  try {
    await run(database, new DexieCheckoutSparkRepository(database))
  } finally {
    database.close()
    await database.delete()
  }
}

describe("checkout Spark durable repository", () => {
  it("creates an idempotent immutable binding and reloads saved progress", async () => {
    await withDatabase(async (database, repository) => {
      const plan = makePlan()
      expect(await repository.create(plan)).toMatchObject({
        status: "active",
        revision: 1,
      })
      expect(await repository.create(plan)).toMatchObject({
        status: "active",
        revision: 1,
      })

      const saved = await repository.save(fundingState(plan), 1)
      expect(saved).toMatchObject({ status: "active", revision: 2 })
      const reopened = new DexieCheckoutSparkRepository(database)
      expect(await reopened.load(plan.checkoutId, plan.planDigest)).toEqual(
        saved
      )
      expect(await database.checkoutSparkPlanBindings.count()).toBe(1)
    })
  })

  it("rejects a stale writer without discarding the newer observation", async () => {
    await withDatabase(async (_database, repository) => {
      const plan = makePlan()
      await repository.create(plan)
      const first = await repository.load(plan.checkoutId, plan.planDigest)
      const second = await repository.load(plan.checkoutId, plan.planDigest)
      expect(first.status).toBe("active")
      expect(second.status).toBe("active")
      if (first.status !== "active" || second.status !== "active") return

      const saved = await repository.save(fundingState(plan), first.revision)
      await expect(
        repository.save(second.state, second.revision)
      ).rejects.toBeInstanceOf(CheckoutSparkRepositoryConflictError)
      expect(await repository.load(plan.checkoutId, plan.planDigest)).toEqual(
        saved
      )
    })
  })

  it("allows only one plan when two tabs create different plans for the same checkout", async () => {
    await withDatabase(async (_database, repository) => {
      const first = makePlan("shared-checkout", "first")
      const second = makePlan("shared-checkout", "second")
      const results = await Promise.allSettled([
        repository.create(first),
        repository.create(second),
      ])
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1)
      expect(
        results.filter((result) => result.status === "rejected")
      ).toHaveLength(1)
      const accepted = results.find((result) => result.status === "fulfilled")
      expect(accepted?.status).toBe("fulfilled")
      if (accepted?.status !== "fulfilled") return
      const acceptedDigest =
        accepted.value.status === "active"
          ? accepted.value.state.plan.planDigest
          : ""
      const loaded = await repository.load("shared-checkout", acceptedDigest)
      expect(loaded).toEqual(accepted.value)
    })
  })

  it("rolls back the immutable binding when initial state creation fails", async () => {
    await withDatabase(async (database, repository) => {
      const plan = makePlan()
      database.checkoutSparkReconciliations.hook("creating", () => {
        throw new Error("simulated initial-state write failure")
      })
      await expect(repository.create(plan)).rejects.toThrow(
        /simulated initial-state write failure/
      )
      expect(await database.checkoutSparkPlanBindings.count()).toBe(0)
      expect(await repository.load(plan.checkoutId, plan.planDigest)).toEqual({
        status: "absent",
      })
    })
  })

  it("keeps the checkout bound to its first digest while active and after retirement", async () => {
    await withDatabase(async (database, repository) => {
      const original = makePlan("checkout-one", "a")
      const replacement = makePlan("checkout-one", "b")
      expect(original.planDigest).not.toBe(replacement.planDigest)
      await repository.create(original)
      await expect(repository.create(replacement)).rejects.toBeInstanceOf(
        CheckoutSparkRepositoryConflictError
      )

      const completed = await repository.save(completedState(original), 1)
      expect(completed.status).toBe("active")
      if (completed.status !== "active") return
      await repository.retire({
        checkoutId: original.checkoutId,
        planDigest: original.planDigest,
        expectedRevision: completed.revision,
        evidence: zeroFundsEvidence(original),
      })
      await expect(repository.create(original)).rejects.toBeInstanceOf(
        CheckoutSparkRepositoryConflictError
      )
      await expect(repository.create(replacement)).rejects.toBeInstanceOf(
        CheckoutSparkRepositoryConflictError
      )
      await expect(
        repository.load(original.checkoutId, replacement.planDigest)
      ).rejects.toBeInstanceOf(CheckoutSparkRepositoryConflictError)
      expect(
        await database.checkoutSparkPlanBindings.get(original.checkoutId)
      ).toEqual({
        checkoutId: original.checkoutId,
        planDigest: original.planDigest,
      })
    })
  })

  it("never demotes paid progress even with a fresh revision", async () => {
    await withDatabase(async (_database, repository) => {
      const plan = makePlan()
      await repository.create(plan)
      const completed = await repository.save(completedState(plan), 1)
      expect(completed.status).toBe("active")
      if (completed.status !== "active") return
      const demoted: CheckoutSparkReconciliation = {
        ...completed.state,
        obligations: completed.state.obligations.map((progress, index) =>
          index === 0
            ? { ...progress, state: "not_found", observedAt: CREATED_AT + 20 }
            : progress
        ),
        updatedAt: CREATED_AT + 20,
      }
      await expect(
        repository.save(demoted, completed.revision)
      ).rejects.toBeInstanceOf(CheckoutSparkRepositoryConflictError)
    })
  })

  it("rolls back a failed save and never reports an advanced revision", async () => {
    await withDatabase(async (database, repository) => {
      const plan = makePlan()
      await repository.create(plan)
      database.checkoutSparkReconciliations.hook("updating", () => {
        throw new Error("simulated IndexedDB write failure")
      })
      await expect(repository.save(fundingState(plan), 1)).rejects.toThrow(
        /simulated IndexedDB write failure/
      )
      expect(
        await repository.load(plan.checkoutId, plan.planDigest)
      ).toMatchObject({
        status: "active",
        revision: 1,
        state: { funding: { state: "unreconciled" } },
      })
    })
  })

  it("retires atomically and rejects a racing writer or second retirement", async () => {
    await withDatabase(async (database, repository) => {
      const plan = makePlan()
      await repository.create(plan)
      const completed = await repository.save(completedState(plan), 1)
      expect(completed.status).toBe("active")
      if (completed.status !== "active") return
      const retirement = {
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        expectedRevision: completed.revision,
        evidence: zeroFundsEvidence(plan),
      }
      const results = await Promise.allSettled([
        repository.retire(retirement),
        repository.retire(retirement),
      ])
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1)
      expect(
        results.filter((result) => result.status === "rejected")
      ).toHaveLength(1)
      await expect(
        repository.save(completed.state, completed.revision)
      ).rejects.toBeInstanceOf(CheckoutSparkRepositoryConflictError)
      expect(
        await repository.load(plan.checkoutId, plan.planDigest)
      ).toMatchObject({
        status: "retired",
        tombstone: { planDigest: plan.planDigest },
      })
      expect(
        await database.checkoutSparkReconciliations.get(plan.checkoutId)
      ).toBeUndefined()
      expect(await database.checkoutSparkRetirements.count()).toBe(1)
    })
  })

  it("serializes a current-revision save racing retirement", async () => {
    await withDatabase(async (database, repository) => {
      const plan = makePlan()
      await repository.create(plan)
      const completed = await repository.save(completedState(plan), 1)
      expect(completed.status).toBe("active")
      if (completed.status !== "active") return
      const results = await Promise.allSettled([
        repository.save(completed.state, completed.revision),
        repository.retire({
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          expectedRevision: completed.revision,
          evidence: zeroFundsEvidence(plan),
        }),
      ])
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1)
      expect(
        results.filter((result) => result.status === "rejected")
      ).toHaveLength(1)
      const loaded = await repository.load(plan.checkoutId, plan.planDigest)
      if (loaded.status === "active") {
        expect(loaded.revision).toBe(completed.revision + 1)
        expect(await database.checkoutSparkRetirements.count()).toBe(0)
      } else {
        expect(loaded.status).toBe("retired")
        expect(await database.checkoutSparkReconciliations.count()).toBe(0)
      }
    })
  })

  it("rolls back retirement if the tombstone cannot be written", async () => {
    await withDatabase(async (database, repository) => {
      const plan = makePlan()
      await repository.create(plan)
      const completed = await repository.save(completedState(plan), 1)
      expect(completed.status).toBe("active")
      if (completed.status !== "active") return
      database.checkoutSparkRetirements.hook("creating", () => {
        throw new Error("simulated tombstone failure")
      })
      await expect(
        repository.retire({
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          expectedRevision: completed.revision,
          evidence: zeroFundsEvidence(plan),
        })
      ).rejects.toThrow(/simulated tombstone failure/)
      expect(await repository.load(plan.checkoutId, plan.planDigest)).toEqual(
        completed
      )
      expect(await database.checkoutSparkRetirements.count()).toBe(0)
    })
  })

  it("projects away unexpected fields rather than persisting credential-like input", async () => {
    await withDatabase(async (database, repository) => {
      const plan = makePlan()
      await repository.create(plan)
      const observed = fundingState(plan)
      const next = {
        ...observed,
        unexpectedCredential: "must-not-persist",
        plan: {
          ...observed.plan,
          unexpectedCredential: "must-not-persist",
        },
        funding: {
          ...observed.funding,
          unexpectedCredential: "must-not-persist",
        },
        obligations: observed.obligations.map((progress) => ({
          ...progress,
          unexpectedCredential: "must-not-persist",
        })),
      }
      await repository.save(next, 1)
      const row = await database.checkoutSparkReconciliations.get(
        plan.checkoutId
      )
      expect(row?.state).not.toHaveProperty("unexpectedCredential")
      expect(row?.state.plan).not.toHaveProperty("unexpectedCredential")
      expect(row?.state.funding).not.toHaveProperty("unexpectedCredential")
      expect(row?.state.obligations[0]).not.toHaveProperty(
        "unexpectedCredential"
      )
    })
  })

  it("upgrades an existing version-19 IndexedDB without losing wallet rows", async () => {
    const name = `conduit-checkout-migration-${crypto.randomUUID()}`
    const legacy = new Dexie(name, fakeIndexedDBOptions)
    legacy.version(19).stores({
      wallets: "id",
      shoppingCarts: "id, updatedAt",
    })
    await legacy.open()
    await legacy
      .table("wallets")
      .put({ id: "existing-wallet", label: "existing" })
    legacy.close()

    const upgraded = new ConduitDB(name, fakeIndexedDBOptions)
    try {
      await upgraded.open()
      expect(upgraded.verno).toBe(20)
      expect(await upgraded.wallets.get("existing-wallet")).toMatchObject({
        label: "existing",
      })
      expect(await upgraded.checkoutSparkPlanBindings.count()).toBe(0)
      expect(await upgraded.checkoutSparkReconciliations.count()).toBe(0)
      expect(await upgraded.checkoutSparkRetirements.count()).toBe(0)
      const plan = makePlan()
      const repository = new DexieCheckoutSparkRepository(upgraded)
      expect(await repository.create(plan)).toMatchObject({
        status: "active",
        revision: 1,
      })
    } finally {
      upgraded.close()
      await upgraded.delete()
    }
  })
})
