import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"

import { ConduitDB } from "@conduit/core/db"
import {
  CheckoutSparkSettledRepositoryConflictError,
  DexieCheckoutSparkSettledRepository,
  assessCheckoutSparkSettledRetirement,
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  retireCheckoutSparkSettledReconciliation,
  type CheckoutSparkRetirementEvidence,
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
import { createRuntimeInvalidMnemonic } from "./support/runtime-wallet-fixtures"

const POISON_MNEMONIC = createRuntimeInvalidMnemonic()

const CREATED_SECONDS = 1_800_000_000
const CREATED_AT = CREATED_SECONDS * 1_000
const MERCHANT = "a".repeat(64)

function invoice(amountSats: number, hashByte: number): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: CREATED_SECONDS,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function plan(): CheckoutSparkSettledPlan {
  return freezeCheckoutSparkSettledPlan({
    checkoutId: "checkout-settled-retirement",
    orderId: "order-settled-retirement",
    merchantPubkey: MERCHANT,
    walletId: "wallet-settled-retirement",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:retirement`,
          productEventId: "c".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "receive-settled-retirement",
      paymentRequest: invoice(1_113, 1),
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: `02${"f".repeat(64)}`,
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
            profileEventCreatedAt: CREATED_SECONDS - 1,
          },
        },
        weightSats: 1_000,
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

function credited(): CheckoutSparkSettledReconciliation {
  const frozen = plan()
  return recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(frozen),
    {
      requestId: frozen.funding.requestId,
      paymentHash: frozen.funding.paymentHash,
      transferId: "spark-receive-retirement",
      receiverIdentityPublicKey: frozen.funding.receiverIdentityPublicKey,
      grossSats: frozen.funding.grossFundingSats,
      creditedSats: 1_111,
      observedAt: CREATED_AT + 1,
    }
  )
}

function completeState(
  creditedState: CheckoutSparkSettledReconciliation,
  conduitFailed = false
): CheckoutSparkSettledReconciliation {
  let state = creditedState
  for (const [index, leg] of state.legs.entries()) {
    const allocationSats = leg.allocationSats!
    const preparedAt = CREATED_AT + 2 + index * 2
    const intent = {
      legId: leg.legId,
      transferId: deriveCheckoutSparkSettledTransferId(state.plan, leg.legId),
      paymentRequest: invoice(allocationSats - 1, index + 2),
      paymentHash: (index + 2).toString(16).padStart(2, "0").repeat(32),
      invoiceAmountSats: allocationSats - 1,
      maxFeeSats: 1,
      preparedAt,
    }
    state = prepareCheckoutSparkSettledLeg(state, intent)
    state = recordCheckoutSparkSettledLegStatus(state, {
      legId: leg.legId,
      transferId: intent.transferId,
      paymentHash: intent.paymentHash,
      status: conduitFailed && index === 1 ? "terminal_failure" : "paid",
      observedAt: preparedAt + 1,
      ...(conduitFailed && index === 1
        ? {}
        : { finalFeeSats: 1, finalDebitSats: allocationSats }),
    })
  }
  return state
}

function terminalState(
  conduitFailed = false
): CheckoutSparkSettledReconciliation {
  return completeState(credited(), conduitFailed)
}

function zeroFundsEvidence(
  state: CheckoutSparkSettledReconciliation
): CheckoutSparkRetirementEvidence {
  return {
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
  }
}

async function withDatabase(
  run: (
    database: ConduitDB,
    repository: DexieCheckoutSparkSettledRepository
  ) => Promise<void>
): Promise<void> {
  const database = new ConduitDB(
    `conduit-settled-retirement-${crypto.randomUUID()}`,
    { indexedDB, IDBKeyRange }
  )
  try {
    await run(database, new DexieCheckoutSparkSettledRepository(database))
  } finally {
    database.close()
    await database.delete()
  }
}

describe("checkout Spark v3 terminal retirement", () => {
  it("retires paid or terminal-failed legs only with fresh terminal zero-funds evidence", () => {
    for (const state of [terminalState(), terminalState(true)]) {
      const evidence = zeroFundsEvidence(state)
      expect(assessCheckoutSparkSettledRetirement(state, evidence)).toEqual({
        state: "ready",
      })
      const tombstone = retireCheckoutSparkSettledReconciliation(
        state,
        evidence
      )
      expect(tombstone).toEqual({
        schemaVersion: 1,
        planDigest: state.plan.planDigest,
        retiredAt: evidence.observedAt,
      })
      expect(JSON.stringify(tombstone)).not.toContain(state.plan.walletId)
      expect(JSON.stringify(tombstone)).not.toContain(state.plan.merchantPubkey)
      expect(JSON.stringify(tombstone)).not.toContain(
        state.plan.funding.paymentRequest
      )
    }
  })

  it("keeps open and ambiguous legs, stale evidence, balances, and nonterminal paths pending", () => {
    const state = credited()
    const evidence = zeroFundsEvidence(state)
    expect(assessCheckoutSparkSettledRetirement(state, evidence)).toEqual({
      state: "retirement_pending",
      reasons: ["obligation_open"],
    })
    const leg = state.legs[0]!
    const intent = {
      legId: leg.legId,
      transferId: deriveCheckoutSparkSettledTransferId(state.plan, leg.legId),
      paymentRequest: invoice(999, 4),
      paymentHash: "04".repeat(32),
      invoiceAmountSats: 999,
      maxFeeSats: 1,
      preparedAt: CREATED_AT + 2,
    }
    const prepared = prepareCheckoutSparkSettledLeg(state, intent)
    const ambiguous = recordCheckoutSparkSettledLegStatus(prepared, {
      legId: leg.legId,
      transferId: intent.transferId,
      paymentHash: intent.paymentHash,
      status: "ambiguous",
      observedAt: CREATED_AT + 3,
    })
    expect(
      assessCheckoutSparkSettledRetirement(
        ambiguous,
        zeroFundsEvidence(ambiguous)
      )
    ).toMatchObject({ reasons: ["obligation_open"] })

    const completed = terminalState()
    const blocked = {
      ...zeroFundsEvidence(completed),
      observedAt: completed.updatedAt - 1,
      availableSats: 1,
      ownedSats: 1,
      incomingSats: 1,
      fundingReceiveTerminal: false,
      sendHistoryTerminal: false,
      claimsTerminal: false,
      refundsTerminal: false,
    }
    expect(assessCheckoutSparkSettledRetirement(completed, blocked)).toEqual({
      state: "retirement_pending",
      reasons: [
        "stale_funds_evidence",
        "funds_remaining",
        "transfer_in_flight",
        "funding_receive_open",
        "send_history_open",
        "claim_path_open",
        "refund_path_open",
      ],
    })
    expect(() =>
      retireCheckoutSparkSettledReconciliation(completed, blocked)
    ).toThrow("not ready to retire")
    expect(
      assessCheckoutSparkSettledRetirement(completed, {
        ...zeroFundsEvidence(completed),
        observedAt: completed.updatedAt,
      })
    ).toEqual({
      state: "retirement_pending",
      reasons: ["stale_funds_evidence"],
    })
  })

  it("rejects cross-wallet/network and malformed funds or terminal evidence", () => {
    const state = terminalState()
    const evidence = zeroFundsEvidence(state)
    expect(() =>
      assessCheckoutSparkSettledRetirement(state, {
        ...evidence,
        walletId: "another-wallet",
      })
    ).toThrow("out of scope")
    expect(() =>
      assessCheckoutSparkSettledRetirement(state, {
        ...evidence,
        network: "regtest",
      })
    ).toThrow("out of scope")
    for (const availableSats of [-1, 0.5, Number.NaN]) {
      expect(() =>
        assessCheckoutSparkSettledRetirement(state, {
          ...evidence,
          availableSats,
        })
      ).toThrow()
    }
    expect(() =>
      assessCheckoutSparkSettledRetirement(state, {
        ...evidence,
        availableSats: 2,
        ownedSats: 1,
      })
    ).toThrow("inconsistent")
    expect(() =>
      assessCheckoutSparkSettledRetirement(state, {
        ...evidence,
        sendHistoryTerminal: "true" as unknown as boolean,
      })
    ).toThrow("terminal evidence is invalid")
  })

  it("atomically replaces the active v3 row with a tombstone and rejects replay", async () => {
    await withDatabase(async (database, repository) => {
      const state = terminalState()
      await repository.create(state.plan)
      const saved = await repository.save(state, 1)
      if (saved.status !== "active") throw new Error("Expected active checkout")
      const retirement = {
        checkoutId: state.plan.checkoutId,
        planDigest: state.plan.planDigest,
        expectedRevision: saved.revision,
        evidence: zeroFundsEvidence(state),
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
      const loaded = await repository.load(
        state.plan.checkoutId,
        state.plan.planDigest
      )
      expect(loaded).toEqual({
        status: "retired",
        planDigest: state.plan.planDigest,
        retiredAt: retirement.evidence.observedAt,
      })
      await expect(repository.create(state.plan)).rejects.toBeInstanceOf(
        CheckoutSparkSettledRepositoryConflictError
      )
      await expect(
        repository.save(state, saved.revision)
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      await expect(repository.retire(retirement)).rejects.toBeInstanceOf(
        CheckoutSparkSettledRepositoryConflictError
      )
      expect(await database.checkoutSparkReconciliations.count()).toBe(0)
      expect(await database.checkoutSparkRetirements.count()).toBe(1)
      expect(
        Object.keys(
          (await database.checkoutSparkRetirements.get(state.plan.checkoutId))!
        )
      ).toEqual(["checkoutId", "schemaVersion", "planDigest", "retiredAt"])
    })
  })

  it.each([
    "before retirement",
    "before the transaction begins",
    "during the binding read",
    "during the binding write",
    "during the tombstone write",
  ])(
    "preserves recovery when caller authority is revoked %s",
    async (phase) => {
      await withDatabase(async (database, repository) => {
        const state = terminalState()
        await repository.create(state.plan)
        const saved = await repository.save(state, 1)
        if (saved.status !== "active")
          throw new Error("Expected active checkout")
        let active = phase !== "before retirement"
        const revoke = () => {
          active = false
        }
        if (phase === "during the binding read") {
          database.checkoutSparkPlanBindings.hook("reading", (binding) => {
            revoke()
            return binding
          })
        } else if (phase === "during the binding write") {
          database.checkoutSparkPlanBindings.hook("updating", revoke)
        } else if (phase === "during the tombstone write") {
          database.checkoutSparkRetirements.hook("creating", revoke)
        }
        const pending = repository.retire({
          checkoutId: state.plan.checkoutId,
          planDigest: state.plan.planDigest,
          expectedRevision: saved.revision,
          evidence: zeroFundsEvidence(state),
          assertCurrent: () => {
            if (!active) throw new Error("merchant session changed")
          },
        })
        if (phase === "before the transaction begins") revoke()
        await expect(pending).rejects.toThrow("merchant session changed")
        expect(
          await repository.load(state.plan.checkoutId, state.plan.planDigest)
        ).toEqual(saved)
      })
    }
  )

  it("rolls back retirement when caller authority is revoked during its final write", async () => {
    await withDatabase(async (database, repository) => {
      const state = terminalState()
      await repository.create(state.plan)
      const saved = await repository.save(state, 1)
      if (saved.status !== "active") throw new Error("Expected active checkout")
      let active = true
      const revoke = () => {
        active = false
      }
      database.checkoutSparkReconciliations.hook("deleting", revoke)
      const retirement = {
        checkoutId: state.plan.checkoutId,
        planDigest: state.plan.planDigest,
        expectedRevision: saved.revision,
        evidence: zeroFundsEvidence(state),
        assertCurrent: () => {
          if (!active) throw new Error("merchant session changed")
        },
      }
      await expect(repository.retire(retirement)).rejects.toThrow(
        "merchant session changed"
      )
      expect(
        await repository.load(state.plan.checkoutId, state.plan.planDigest)
      ).toEqual(saved)

      database.checkoutSparkReconciliations.hook("deleting").unsubscribe(revoke)
      active = true
      await repository.retire(retirement)
      expect(
        await repository.load(state.plan.checkoutId, state.plan.planDigest)
      ).toEqual({
        status: "retired",
        planDigest: state.plan.planDigest,
        retiredAt: retirement.evidence.observedAt,
      })
    })
  })

  it("serializes a state writer racing retirement and retains the winning state", async () => {
    await withDatabase(async (database, repository) => {
      const state = terminalState()
      await repository.create(state.plan)
      const saved = await repository.save(state, 1)
      if (saved.status !== "active") throw new Error("Expected active checkout")
      const results = await Promise.allSettled([
        repository.save(saved.state, saved.revision),
        repository.retire({
          checkoutId: state.plan.checkoutId,
          planDigest: state.plan.planDigest,
          expectedRevision: saved.revision,
          evidence: zeroFundsEvidence(state),
        }),
      ])
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1)
      expect(
        results.filter((result) => result.status === "rejected")
      ).toHaveLength(1)
      const loaded = await repository.load(
        state.plan.checkoutId,
        state.plan.planDigest
      )
      if (loaded.status === "active") {
        expect(loaded.revision).toBe(saved.revision + 1)
        expect(await database.checkoutSparkRetirements.count()).toBe(0)
      } else {
        expect(loaded.status).toBe("retired")
        expect(await database.checkoutSparkReconciliations.count()).toBe(0)
      }
    })
  })

  it("rolls back retirement when writing the tombstone fails", async () => {
    await withDatabase(async (database, repository) => {
      const state = terminalState()
      await repository.create(state.plan)
      const saved = await repository.save(state, 1)
      if (saved.status !== "active") throw new Error("Expected active checkout")
      database.checkoutSparkRetirements.hook("creating", () => {
        throw new Error("simulated tombstone failure")
      })
      await expect(
        repository.retire({
          checkoutId: state.plan.checkoutId,
          planDigest: state.plan.planDigest,
          expectedRevision: saved.revision,
          evidence: zeroFundsEvidence(state),
        })
      ).rejects.toThrow(/simulated tombstone failure/)
      expect(
        await repository.load(state.plan.checkoutId, state.plan.planDigest)
      ).toEqual(saved)
      expect(await database.checkoutSparkRetirements.count()).toBe(0)
    })
  })
})

describe("checkout Spark v3 Merchant recovery import", () => {
  it("atomically imports one validated snapshot and makes repeated import a no-op", async () => {
    await withDatabase(async (database, repository) => {
      const state = credited()
      const first = await repository.importRecoveryState(state, () => {})
      expect(first).toEqual({ status: "active", revision: 1, state })
      expect(await repository.importRecoveryState(state, () => {})).toEqual(
        first
      )
      expect(await database.checkoutSparkPlanBindings.count()).toBe(1)
      expect(await database.checkoutSparkReconciliations.count()).toBe(1)
      expect(
        await repository.load(state.plan.checkoutId, state.plan.planDigest)
      ).toEqual(first)
    })
  })

  it("advances a local snapshot but refuses an older or conflicting checkout", async () => {
    await withDatabase(async (_, repository) => {
      const earlier = credited()
      const latest = completeState(earlier)
      await repository.importRecoveryState(earlier, () => {})
      const imported = await repository.importRecoveryState(latest, () => {})
      expect(imported.status).toBe("active")
      if (imported.status !== "active") return
      expect(imported.revision).toBe(2)
      expect(imported.state.legs.every((leg) => leg.status === "paid")).toBe(
        true
      )
      await expect(
        repository.importRecoveryState(earlier, () => {})
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      await expect(
        repository.importRecoveryState(
          {
            ...latest,
            plan: { ...latest.plan, walletId: "different-wallet" },
          },
          () => {}
        )
      ).rejects.toThrow()
      expect(
        await repository.load(latest.plan.checkoutId, latest.plan.planDigest)
      ).toEqual(imported)
    })
  })

  it("does not regress an uncertain leg to submitted on imported state", async () => {
    await withDatabase(async (_, repository) => {
      const funded = credited()
      const leg = funded.legs[0]!
      const prepared = prepareCheckoutSparkSettledLeg(funded, {
        legId: leg.legId,
        transferId: deriveCheckoutSparkSettledTransferId(
          funded.plan,
          leg.legId
        ),
        paymentRequest: invoice(leg.allocationSats! - 1, 4),
        paymentHash: "04".repeat(32),
        invoiceAmountSats: leg.allocationSats! - 1,
        maxFeeSats: 1,
        preparedAt: CREATED_AT + 2,
      })
      const intent = prepared.legs[0]!.intent!
      const uncertain = recordCheckoutSparkSettledLegStatus(prepared, {
        legId: leg.legId,
        transferId: intent.transferId,
        paymentHash: intent.paymentHash,
        status: "ambiguous",
        observedAt: CREATED_AT + 3,
      })
      await repository.importRecoveryState(uncertain, () => {})
      const regression = {
        ...uncertain,
        legs: uncertain.legs.map((candidate, index) =>
          index === 0
            ? {
                ...candidate,
                status: "submitted" as const,
                observedAt: CREATED_AT + 4,
              }
            : candidate
        ),
        updatedAt: CREATED_AT + 4,
      }
      await expect(
        repository.importRecoveryState(regression, () => {})
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
    })
  })

  it("rolls back an import when merchant authority changes mid-transaction", async () => {
    await withDatabase(async (database, repository) => {
      const state = credited()
      let checks = 0
      await expect(
        repository.importRecoveryState(state, () => {
          checks += 1
          if (checks === 4) throw new Error("merchant changed")
        })
      ).rejects.toThrow("merchant changed")
      expect(await database.checkoutSparkPlanBindings.count()).toBe(0)
      expect(await database.checkoutSparkReconciliations.count()).toBe(0)
    })
  })

  it("rolls back an import when storage fails", async () => {
    await withDatabase(async (database, repository) => {
      const state = credited()
      database.checkoutSparkReconciliations.hook("creating", () => {
        throw new Error("storage unavailable")
      })
      await expect(
        repository.importRecoveryState(state, () => {})
      ).rejects.toThrow("storage unavailable")
      expect(await database.checkoutSparkPlanBindings.count()).toBe(0)
      expect(await database.checkoutSparkReconciliations.count()).toBe(0)
    })
  })

  it("never persists unexpected wallet credentials in the reconciliation row", async () => {
    await withDatabase(async (database, repository) => {
      const state = credited()
      const poisoned = {
        ...state,
        mnemonic: POISON_MNEMONIC,
      } as CheckoutSparkSettledReconciliation
      await repository.importRecoveryState(poisoned, () => {})
      const stored = await database.checkoutSparkReconciliations.get(
        state.plan.checkoutId
      )
      expect(JSON.stringify(stored)).not.toContain(POISON_MNEMONIC)
    })
  })

  it("does not resurrect a retired checkout", async () => {
    await withDatabase(async (_, repository) => {
      const state = terminalState()
      const saved = await repository.importRecoveryState(state, () => {})
      if (saved.status !== "active") throw new Error("Expected active checkout")
      await repository.retire({
        checkoutId: state.plan.checkoutId,
        planDigest: state.plan.planDigest,
        expectedRevision: saved.revision,
        evidence: zeroFundsEvidence(state),
      })
      await expect(
        repository.importRecoveryState(state, () => {})
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
    })
  })
})
