import { describe, expect, it } from "bun:test"
import {
  prepareCheckoutSparkNativeTreasury,
  recordCheckoutSparkMerchantTreasury,
  recordCheckoutSparkNativeTreasuryStatus,
  runCheckoutSparkNativeTreasuryStep,
  type CheckoutSparkNativeTreasuryObservation,
  type CheckoutSparkMerchantOrderWitness,
  type CheckoutSparkMerchantSettlementRecord,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import {
  advanceMerchantCheckoutSparkOrder,
  reconcileMerchantCheckoutSparkOrder,
} from "../apps/merchant/src/lib/checkout-spark-order-reconciliation"
import { nativeTreasuryFixture } from "./support/checkout-spark-native-treasury-fixture"

const merchant = "a".repeat(64)
const buyer = "b".repeat(64)
const digest = "c".repeat(64)
const merchantLeg = "1".repeat(64)
const supplierLeg = "2".repeat(64)
const feeLeg = "3".repeat(64)

const candidate: MerchantCheckoutSparkRecoveryCandidate = {
  wrapId: "d".repeat(64),
  schemaVersion: 2,
  checkoutId: "checkout-order-reconciliation",
  orderId: "order-reconciliation",
  planDigest: digest,
  takeoverAt: 1_000,
  preparedAt: 500,
}

const witness: CheckoutSparkMerchantOrderWitness = {
  schemaVersion: 1,
  merchantPubkey: merchant,
  buyerPubkey: buyer,
  orderId: candidate.orderId,
  rumorId: "e".repeat(64),
  contentHash: "f".repeat(64),
  checkoutId: candidate.checkoutId,
  planDigest: digest,
}

function paidLeg(legId: string) {
  return {
    legId,
    transferId: `transfer-${legId}`,
    allocationSats: 500,
    finalDebitSats: 500,
    finalFeeSats: 0,
    recipientVerified: true as const,
    observedAt: 2_000,
  }
}

function providerRecord(
  funded: boolean,
  paid: readonly string[] = []
): CheckoutSparkMerchantSettlementRecord {
  return {
    schemaVersion: 1,
    merchantPubkey: merchant,
    orderId: candidate.orderId,
    checkoutId: candidate.checkoutId,
    planDigest: digest,
    merchantLegId: merchantLeg,
    requiredCommerceLegIds: [merchantLeg, supplierLeg],
    feeLegId: feeLeg,
    credit: funded
      ? {
          transferId: "funding-transfer",
          creditedSats: 1_500,
          observedAt: 1_500,
        }
      : null,
    paidLegs: paid.map(paidLeg),
  }
}

type ReconciliationOptions = NonNullable<
  Parameters<typeof reconcileMerchantCheckoutSparkOrder>[3]
>
type Repository = NonNullable<ReconciliationOptions["repository"]>
type CreditCheck = NonNullable<ReconciliationOptions["checkCredit"]>
type PayoutInspection = NonNullable<ReconciliationOptions["inspectPayouts"]>

function fixture() {
  let currentWitness: CheckoutSparkMerchantOrderWitness | null = witness
  let currentRecord: CheckoutSparkMerchantSettlementRecord | null = null
  let savedCredit: { transferId: string } | null = {
    transferId: "buyer-claimed-credit",
  }
  let snapshot: "active" | "retired" = "active"
  let witnessReads = 0
  let stateReads = 0
  let recordReads = 0
  const repository = {
    async loadMerchantOrderWitness() {
      witnessReads += 1
      return currentWitness
    },
    async load() {
      stateReads += 1
      return snapshot === "retired"
        ? { status: "retired", planDigest: digest, retiredAt: 2_000 }
        : {
            status: "active",
            revision: 1,
            // Buyer-signed state is intentionally not a provider payment record.
            state: {
              credit: savedCredit,
              legs: [{ status: "paid", legId: merchantLeg }],
              plan: {
                merchantPubkey: merchant,
                orderId: candidate.orderId,
                checkoutId: candidate.checkoutId,
                planDigest: digest,
                takeoverAt: candidate.takeoverAt,
              },
            },
          }
    },
    async loadMerchantSettlement() {
      recordReads += 1
      return currentRecord
    },
  } as unknown as Repository
  return {
    repository,
    setWitness(next: CheckoutSparkMerchantOrderWitness | null) {
      currentWitness = next
    },
    setRecord(next: CheckoutSparkMerchantSettlementRecord | null) {
      currentRecord = next
    },
    setSavedCredit(next: { transferId: string } | null) {
      savedCredit = next
    },
    setRetired() {
      snapshot = "retired"
    },
    reads() {
      return { witnessReads, stateReads, recordReads }
    },
  }
}

const consumed = {
  status: "consumed" as const,
  coverage: "complete" as const,
  discoveryCoverage: "complete" as const,
  declarationState: "declared" as const,
  candidate,
}

const inspected = {
  ...consumed,
  payoutHistory: {
    status: "inspected" as const,
    checkedLegs: 2,
    newlyConfirmedLegs: 2,
    unresolvedLegs: 0,
    withoutIntentLegs: 0,
    alreadyPaidLegs: 0,
  },
}

function interruptedNativeFixture(
  status: "prepared" | "submitted" | "ambiguous",
  observation: "paid" | "not_found" = "paid"
) {
  const native = nativeTreasuryFixture()
  const clock = native.plan.takeoverAt + 1
  let state = prepareCheckoutSparkNativeTreasury(native.state, {
    settlement: native.record,
    preparedAt: native.plan.createdAt + 4,
  })
  if (status !== "prepared") {
    state = recordCheckoutSparkNativeTreasuryStatus(state, {
      invoiceId: native.plan.nativeTreasury!.invoiceId,
      status,
      observedAt: native.plan.createdAt + 5,
    })
  }
  const intent = structuredClone(state.treasuryFinalization!.intent!)
  const evidence = {
    invoiceId: intent.invoiceId,
    providerTransferId: "native-completed-transfer",
    status: "paid" as const,
    observedAt: clock,
    finalFeeSats: 0,
    finalDebitSats: intent.amountSats,
  }
  // The provider receipt was saved, but the subsequent terminal state write
  // was interrupted. Payment truth does not itself repair this router state.
  const record = recordCheckoutSparkMerchantTreasury(
    native.record,
    state,
    evidence
  )
  const selected: MerchantCheckoutSparkRecoveryCandidate = {
    ...candidate,
    checkoutId: native.plan.checkoutId,
    orderId: native.plan.orderId,
    planDigest: native.plan.planDigest,
    takeoverAt: native.plan.takeoverAt,
  }
  let revision = 1
  let retired = false
  let inspections = 0
  let sends = 0
  let preparations = 0
  let retirementChecks = 0
  let rescans = 0
  const repository = {
    async loadMerchantOrderWitness() {
      return {
        ...witness,
        checkoutId: selected.checkoutId,
        orderId: selected.orderId,
        planDigest: selected.planDigest,
      }
    },
    async load() {
      return retired
        ? {
            status: "retired" as const,
            planDigest: selected.planDigest,
            retiredAt: clock,
          }
        : { status: "active" as const, revision, state: structuredClone(state) }
    },
    async loadMerchantSettlement() {
      return record
    },
    async save(next: typeof state, expected: number) {
      expect(expected).toBe(revision)
      state = structuredClone(next)
      revision += 1
      return {
        status: "active" as const,
        revision,
        state: structuredClone(state),
      }
    },
    async saveTreasuryPrepared() {
      preparations += 1
      throw new Error("A paid receipt cannot authorize a new native intent")
    },
    async recordMerchantTreasury() {},
    async retire() {},
  } as unknown as NonNullable<
    Parameters<typeof advanceMerchantCheckoutSparkOrder>[3]["repository"]
  >
  const options: Parameters<typeof advanceMerchantCheckoutSparkOrder>[3] = {
    repository,
    now: () => clock,
    notifySuppliers: () => {},
    inspectPayouts: async () => ({ ...inspected, candidate: selected }),
    selectPayout: async () => ({ status: "native_treasury" }),
    continueNativeTreasury: async (_principal, recovered, input) => {
      expect(recovered).toEqual(selected)
      expect(input?.inspectionOnly).toBe(true)
      const payout = await runCheckoutSparkNativeTreasuryStep({
        checkoutId: selected.checkoutId,
        planDigest: selected.planDigest,
        legId: native.feeId,
        actor: "merchant",
        now: () => clock,
        inspectionOnly: input?.inspectionOnly,
        store: {
          load: () => repository.load(selected.checkoutId, selected.planDigest),
          save: (next, expected) => repository.save(next, expected),
          savePrepared: async () => {
            preparations += 1
            throw new Error("Do not prepare another native request")
          },
        },
        provider: {
          reconcile: async (
            target
          ): Promise<CheckoutSparkNativeTreasuryObservation> => {
            inspections += 1
            expect(target.intent).toEqual(intent)
            expect(target.nativeTreasury).toEqual(native.plan.nativeTreasury)
            return observation === "paid"
              ? evidence
              : { status: "not_found", invoiceId: intent.invoiceId }
          },
          preflight: async () => {
            throw new Error("Receipt repair is query-only")
          },
          send: async () => {
            sends += 1
            throw new Error("Never resend the completed native payment")
          },
        },
        proveCommerce: async () => {
          throw new Error("Existing native intent must reconcile first")
        },
        acknowledgeRecoverySnapshot: async () => {
          throw new Error("Inspection does not authorize a new send snapshot")
        },
      })
      return { ...consumed, candidate: recovered, payout }
    },
    retireWallet: async () => {
      retirementChecks += 1
      expect(state.treasuryFinalization!.status).toBe("paid")
      expect(state.legs.every((leg) => leg.status === "paid")).toBe(true)
      retired = true
      return { ...consumed, candidate: selected, retirementStatus: "retired" }
    },
    requestRescan: () => {
      rescans += 1
    },
  }
  return {
    selected,
    options,
    state: () => structuredClone(state),
    counts: () => ({
      inspections,
      sends,
      preparations,
      retirementChecks,
      rescans,
    }),
    run: () =>
      advanceMerchantCheckoutSparkOrder(merchant, selected, () => {}, options),
  }
}

describe("automatic checkout Spark order reconciliation adapter", () => {
  it("rechecks exact funding after query-only credit when the saved router state has no credit", async () => {
    const context = fixture()
    context.setSavedCredit(null)
    context.setRecord(providerRecord(true))
    const calls: string[] = []
    const guard = () => {}
    const status = await reconcileMerchantCheckoutSparkOrder(
      merchant,
      candidate,
      guard,
      {
        repository: context.repository,
        now: () => 2_000,
        checkCredit: async (principal, selected, options) => {
          calls.push("exact-funding")
          expect(principal).toBe(merchant)
          expect(selected).toEqual(candidate)
          expect(options?.expectedOrderWitness).toEqual(witness)
          expect(options?.assertActive).toBe(guard)
          // Model the existing funding adapter's independent receive proof and
          // guarded state save, not a copy of ledger or buyer-claimed credit.
          context.setSavedCredit({ transferId: "funding-transfer" })
          return { ...consumed, creditStatus: "recorded" }
        },
        inspectPayouts: async () => {
          const saved = await context.repository.load(
            candidate.checkoutId,
            candidate.planDigest
          )
          if (saved.status !== "active" || !saved.state.credit) {
            return {
              ...consumed,
              payoutHistory: {
                ...inspected.payoutHistory,
                status: "credit_needed",
              },
            }
          }
          calls.push("exact-payouts")
          context.setRecord(providerRecord(true, [merchantLeg, supplierLeg]))
          return inspected
        },
      }
    )
    expect(status).toBe("verified")
    expect(calls).toEqual(["exact-funding", "exact-payouts"])
  })

  it("keeps independently observed credit informational when exact saved-state funding proof is still pending", async () => {
    const context = fixture()
    context.setSavedCredit(null)
    context.setRecord(providerRecord(true))
    let fundingChecks = 0
    let historyChecks = 0
    const status = await reconcileMerchantCheckoutSparkOrder(
      merchant,
      candidate,
      () => {},
      {
        repository: context.repository,
        now: () => 2_000,
        checkCredit: async () => {
          fundingChecks += 1
          return { ...consumed, creditStatus: "pending" }
        },
        inspectPayouts: async () => {
          historyChecks += 1
          return {
            ...consumed,
            payoutHistory: {
              ...inspected.payoutHistory,
              status: "credit_needed",
            },
          }
        },
      }
    )
    expect(status).toBe("pending")
    expect(fundingChecks).toBe(1)
    expect(historyChecks).toBe(0)
    const saved = await context.repository.load(
      candidate.checkoutId,
      candidate.planDigest
    )
    expect(saved.status === "active" && saved.state.credit).toBeNull()
    expect(
      await context.repository.loadMerchantSettlement(
        merchant,
        candidate.checkoutId,
        candidate.planDigest
      )
    ).toEqual(providerRecord(true))
  })

  it("restores missing saved credit before automatic fee continuation even when commerce is already verified", async () => {
    const context = fixture()
    context.setSavedCredit(null)
    context.setRecord(providerRecord(true, [merchantLeg, supplierLeg]))
    const calls: string[] = []
    const noSend = async () => {
      throw new Error("This funding check cannot prepare or send a payout")
    }
    const status = await advanceMerchantCheckoutSparkOrder(
      merchant,
      candidate,
      () => {},
      {
        repository: Object.assign(context.repository, { retire: noSend }),
        now: () => 2_000,
        checkCredit: async () => {
          calls.push("exact-funding")
          context.setSavedCredit({ transferId: "funding-transfer" })
          return { ...consumed, creditStatus: "recorded" }
        },
        inspectPayouts: async () => {
          const saved = await context.repository.load(
            candidate.checkoutId,
            candidate.planDigest
          )
          if (saved.status !== "active" || !saved.state.credit) {
            return {
              ...consumed,
              payoutHistory: {
                ...inspected.payoutHistory,
                status: "credit_needed",
              },
            }
          }
          calls.push("exact-payouts")
          return inspected
        },
        selectPayout: async () => {
          calls.push("selection")
          return { status: "recovery_unavailable" }
        },
        preparePayout: noSend,
        continuePayout: noSend,
        continueNativeTreasury: noSend,
        retireWallet: noSend,
        requestRescan: () => {
          throw new Error("No send or preparation was attempted")
        },
      }
    )
    expect(status).toBe("unavailable")
    expect(calls).toEqual(["exact-funding", "exact-payouts", "selection"])
  })

  it.each(["submitted", "ambiguous"] as const)(
    "repairs an interrupted %s native terminal save against the same request before retirement",
    async (status) => {
      const context = interruptedNativeFixture(status)
      expect(await context.run()).toBe("progress_pending")
      expect(context.state().treasuryFinalization!.status).toBe("paid")
      expect(context.counts()).toEqual({
        inspections: 1,
        sends: 0,
        preparations: 0,
        retirementChecks: 0,
        rescans: 1,
      })
      expect(await context.run()).toBe("retired")
      expect(context.counts().retirementChecks).toBe(1)
      expect(context.counts().sends).toBe(0)
    }
  )

  it("does not resend a stale prepared native request when its paid ledger lacks fresh provider readback", async () => {
    const context = interruptedNativeFixture("prepared", "not_found")
    expect(await context.run()).toBe("progress_pending")
    expect(context.state().treasuryFinalization!.status).toBe("prepared")
    expect(context.counts()).toEqual({
      inspections: 1,
      sends: 0,
      preparations: 0,
      retirementChecks: 0,
      rescans: 1,
    })
  })

  it("observes recipient evidence immediately without opening claim-capable Spark or advancing", async () => {
    const context = fixture()
    Object.assign(context.repository, {
      hasInvoiceRecipient: async () => false,
      recordInvoiceRecipientVerification: async () => {},
      loadMerchantPlanSourceEvents: async () => [],
      recordMerchantCredit: async () => {
        throw new Error("Mock observation owns its financial proof")
      },
      recordMerchantPayout: async () => {
        throw new Error("Mock observation owns its financial proof")
      },
    })
    let observations = 0
    let nativeObservations = 0
    const noSpark = async () => {
      throw new Error("No Spark inspection or advancement before takeover")
    }
    const dependencies = {
      repository: context.repository,
      now: () => 999,
      verifyRecipients: async () => {
        observations += 1
        return "complete" as const
      },
      observeNative: async () => {
        nativeObservations += 1
        // Already verified commerce still cannot trigger pre-takeover fee,
        // preparation, claim-capable inspection, dispatch or retirement.
        return "verified" as const
      },
      checkCredit: noSpark,
      inspectPayouts: noSpark,
      selectPayout: noSpark,
      preparePayout: noSpark,
      continuePayout: noSpark,
      continueNativeTreasury: noSpark,
      retireWallet: noSpark,
      requestRescan: () => {
        throw new Error("No dispatch rescan is needed before takeover")
      },
    }
    expect(
      await reconcileMerchantCheckoutSparkOrder(
        merchant,
        candidate,
        () => {},
        dependencies
      )
    ).toBe("pending")
    expect(
      await advanceMerchantCheckoutSparkOrder(
        merchant,
        candidate,
        () => {},
        dependencies
      )
    ).toBe("pending")
    expect(observations).toBe(2)
    expect(nativeObservations).toBe(2)
    expect(context.reads().recordReads).toBe(0)
    context.setWitness(null)
    expect(
      await reconcileMerchantCheckoutSparkOrder(
        merchant,
        candidate,
        () => {},
        dependencies
      )
    ).toBe("unbound")
    expect(observations).toBe(2)
  })

  it("attributes already provider-paid facts before projecting the order as verified", async () => {
    const context = fixture()
    const verified = providerRecord(true, [merchantLeg, supplierLeg])
    const unattributed: CheckoutSparkMerchantSettlementRecord = {
      ...verified,
      paidLegs: verified.paidLegs.map((leg) => {
        const providerOnly = { ...leg }
        delete providerOnly.recipientVerified
        return providerOnly
      }),
    }
    context.setRecord(unattributed)
    // Enable the adapter's optional recipient-evidence repository capability.
    Object.assign(context.repository, {
      hasInvoiceRecipient: async () => false,
      recordInvoiceRecipientVerification: async () => {
        throw new Error("The verification boundary stub owns this persistence")
      },
    })
    let verifications = 0
    let notifications = 0
    const guard = () => {}
    const status = await reconcileMerchantCheckoutSparkOrder(
      merchant,
      candidate,
      guard,
      {
        repository: context.repository,
        now: () => 2_000,
        verifyRecipients: async ({ state, assertCurrent, now }) => {
          verifications += 1
          expect(assertCurrent).toBe(guard)
          assertCurrent()
          expect(now()).toBe(2_000)
          expect(state.plan.planDigest === candidate.planDigest).toBe(true)
          expect(context.reads().recordReads).toBe(0)
          // Attribution adds no transfer or amount: it upgrades only the
          // independently recorded paid facts before the first projection.
          context.setRecord(verified)
          return "complete"
        },
        notifySuppliers: ({ settlement }) => {
          notifications += 1
          expect(
            settlement?.paidLegs.every((leg) => leg.recipientVerified)
          ).toBe(true)
        },
        checkCredit: async () => {
          throw new Error("Already funded; must not open funding again")
        },
        inspectPayouts: async () => {
          throw new Error("Already paid; must not reopen provider history")
        },
      }
    )
    expect(status).toBe("verified")
    expect(verifications).toBe(1)
    expect(notifications).toBe(1)
    expect(context.reads().recordReads).toBe(1)
    expect(
      verified.paidLegs.map((leg) => {
        const paid = { ...leg }
        delete paid.recipientVerified
        return paid
      })
    ).toEqual(unattributed.paidLegs)
  })

  it("records exact Spark facts during a recipient lookup outage without dispatching", async () => {
    const context = fixture()
    const paidFacts: CheckoutSparkMerchantSettlementRecord = {
      ...providerRecord(true, [merchantLeg, supplierLeg]),
      paidLegs: [merchantLeg, supplierLeg].map((legId) => {
        const paid = { ...paidLeg(legId) }
        delete paid.recipientVerified
        return paid
      }),
    }
    const repository = Object.assign(context.repository, {
      hasInvoiceRecipient: async () => false,
      recordInvoiceRecipientVerification: async () => {
        throw new Error("No proof is available during a provider outage")
      },
      retire: async () => {
        throw new Error("Unattributed payments must not retire the wallet")
      },
    })
    let creditReads = 0
    let historyReads = 0
    let dispatchSelections = 0
    let preparations = 0
    let sends = 0
    let sawPaidProjection = false
    const status = await advanceMerchantCheckoutSparkOrder(
      merchant,
      candidate,
      () => {},
      {
        repository,
        now: () => 2_000,
        verifyRecipients: async () => "unavailable",
        notifySuppliers: ({ settlement }) => {
          if (settlement?.paidLegs.length === paidFacts.paidLegs.length) {
            sawPaidProjection = true
            expect(
              settlement.paidLegs.every((leg) => !leg.recipientVerified)
            ).toBe(true)
          }
        },
        checkCredit: async () => {
          creditReads += 1
          context.setRecord(providerRecord(true))
          return { ...consumed, creditStatus: "recorded" }
        },
        inspectPayouts: async () => {
          historyReads += 1
          context.setRecord(paidFacts)
          return inspected
        },
        selectPayout: async () => {
          dispatchSelections += 1
          throw new Error("Missing attribution must not select a dispatch")
        },
        preparePayout: async () => {
          preparations += 1
          throw new Error("Missing attribution must not replace an invoice")
        },
        continuePayout: async () => {
          sends += 1
          throw new Error("Missing attribution must not send a payment")
        },
        requestRescan: () => {},
      }
    )
    expect(status).toBe("unavailable")
    expect(creditReads).toBe(1)
    expect(historyReads).toBe(1)
    expect(context.reads().recordReads).toBeGreaterThanOrEqual(3)
    expect(sawPaidProjection).toBe(true)
    expect(dispatchSelections).toBe(0)
    expect(preparations).toBe(0)
    expect(sends).toBe(0)
    const savedFacts = await repository.loadMerchantSettlement(
      merchant,
      candidate.checkoutId,
      candidate.planDigest
    )
    expect(savedFacts).toEqual(paidFacts)
  })

  it("keeps paid and retired order truth when supplier notification delivery fails", async () => {
    const context = fixture()
    context.setRecord(providerRecord(true, [merchantLeg, supplierLeg]))
    let notificationCalls = 0
    const options: ReconciliationOptions = {
      repository: context.repository,
      now: () => 2_000,
      notifySuppliers: () => {
        notificationCalls += 1
        throw new Error("Private inbox unavailable")
      },
      inspectPayouts: async () => {
        throw new Error("Already verified; must not retry payment")
      },
      checkCredit: async () => {
        throw new Error("Already funded; must not fund again")
      },
    }
    expect(
      await reconcileMerchantCheckoutSparkOrder(
        merchant,
        candidate,
        () => {},
        options
      )
    ).toBe("verified")
    context.setRetired()
    expect(
      await reconcileMerchantCheckoutSparkOrder(
        merchant,
        candidate,
        () => {},
        options
      )
    ).toBe("retired")
    expect(notificationCalls).toBe(2)
  })
  it("does not open a provider for legacy, pre-handoff, unbound, or retired recovery", async () => {
    const context = fixture()
    let providerCalls = 0
    const checkCredit: CreditCheck = async () => {
      providerCalls += 1
      return { ...consumed, creditStatus: "recorded" }
    }
    const inspectPayouts: PayoutInspection = async () => {
      providerCalls += 1
      return inspected
    }
    const options = {
      repository: context.repository,
      checkCredit,
      inspectPayouts,
      now: () => 999,
    }
    const active = () => {}
    expect(
      await reconcileMerchantCheckoutSparkOrder(
        merchant,
        { ...candidate, schemaVersion: 1 },
        active,
        options
      )
    ).toBe("unbound")
    expect(
      await reconcileMerchantCheckoutSparkOrder(
        merchant,
        candidate,
        active,
        options
      )
    ).toBe("pending")
    expect(context.reads()).toEqual({
      witnessReads: 1,
      stateReads: 1,
      recordReads: 0,
    })

    options.now = () => 2_000
    context.setWitness(null)
    expect(
      await reconcileMerchantCheckoutSparkOrder(
        merchant,
        candidate,
        active,
        options
      )
    ).toBe("unbound")
    context.setWitness(witness)
    context.setRetired()
    expect(
      await reconcileMerchantCheckoutSparkOrder(
        merchant,
        candidate,
        active,
        options
      )
    ).toBe("retired")
    expect(providerCalls).toBe(0)
  })

  it("skips provider work once exact commerce is verified, even with an optional fee pending", async () => {
    const context = fixture()
    context.setRecord(providerRecord(true, [merchantLeg, supplierLeg, feeLeg]))
    let providerCalls = 0
    const status = await reconcileMerchantCheckoutSparkOrder(
      merchant,
      candidate,
      () => {},
      {
        repository: context.repository,
        now: () => 2_000,
        checkCredit: (async () => {
          providerCalls += 1
          throw new Error("Unneeded provider read")
        }) as CreditCheck,
        inspectPayouts: (async () => {
          providerCalls += 1
          throw new Error("Unneeded provider read")
        }) as PayoutInspection,
      }
    )
    expect(status).toBe("verified")
    expect(providerCalls).toBe(0)
    context.setRecord(providerRecord(true, [merchantLeg, supplierLeg]))
    expect(
      await reconcileMerchantCheckoutSparkOrder(merchant, candidate, () => {}, {
        repository: context.repository,
        now: () => 2_000,
        checkCredit: (async () => {
          providerCalls += 1
          throw new Error("Optional fee cannot reopen commerce")
        }) as CreditCheck,
        inspectPayouts: (async () => {
          providerCalls += 1
          throw new Error("Optional fee cannot reopen commerce")
        }) as PayoutInspection,
      })
    ).toBe("verified")
    expect(providerCalls).toBe(0)
  })

  it("does not inspect payouts while funding is pending", async () => {
    const context = fixture()
    let payoutCalls = 0
    const status = await reconcileMerchantCheckoutSparkOrder(
      merchant,
      candidate,
      () => {},
      {
        repository: context.repository,
        now: () => 2_000,
        checkCredit: (async () => ({
          ...consumed,
          creditStatus: "pending",
        })) as CreditCheck,
        inspectPayouts: (async () => {
          payoutCalls += 1
          return inspected
        }) as PayoutInspection,
      }
    )
    expect(status).toBe("pending")
    expect(payoutCalls).toBe(0)
  })

  it("keeps verified commerce terminal when only the paid optional fee lacks local origin", async () => {
    const context = fixture()
    const verified = providerRecord(true, [merchantLeg, supplierLeg, feeLeg])
    context.setRecord({
      ...verified,
      paidLegs: verified.paidLegs.map((leg) => {
        if (leg.legId !== feeLeg) return leg
        const providerOnly = { ...leg }
        delete providerOnly.recipientVerified
        return providerOnly
      }),
    })
    let providerCalls = 0
    const status = await reconcileMerchantCheckoutSparkOrder(
      merchant,
      candidate,
      () => {},
      {
        repository: context.repository,
        now: () => 2_000,
        inspectPayouts: async () => {
          providerCalls += 1
          return inspected
        },
      }
    )
    expect(status).toBe("verified")
    expect(providerCalls).toBe(0)
  })

  it("pauses old provider-paid commerce missing local origin without rechecking the provider", async () => {
    const context = fixture()
    const verified = providerRecord(true, [merchantLeg, supplierLeg])
    context.setRecord({
      ...verified,
      paidLegs: verified.paidLegs.map((leg) => {
        const providerOnly = { ...leg }
        delete providerOnly.recipientVerified
        return providerOnly
      }),
    })
    let providerCalls = 0
    const status = await reconcileMerchantCheckoutSparkOrder(
      merchant,
      candidate,
      () => {},
      {
        repository: context.repository,
        now: () => 2_000,
        inspectPayouts: async () => {
          providerCalls += 1
          return inspected
        },
      }
    )
    expect(status).toBe("recipient_unverified")
    expect(providerCalls).toBe(0)
  })

  it("requires separate provider records before history or payment verification", async () => {
    const context = fixture()
    let payoutCalls = 0
    const status = await reconcileMerchantCheckoutSparkOrder(
      merchant,
      candidate,
      () => {},
      {
        repository: context.repository,
        now: () => 2_000,
        checkCredit: (async () => ({
          ...consumed,
          creditStatus: "recorded",
        })) as CreditCheck,
        inspectPayouts: (async () => {
          payoutCalls += 1
          return inspected
        }) as PayoutInspection,
      }
    )
    expect(status).toBe("unavailable")
    expect(payoutCalls).toBe(0)
    expect(context.reads().recordReads).toBe(2)
  })

  it("passes the exact witness and active guard through both phases, preserving paid commerce with fee pending", async () => {
    const context = fixture()
    const guard = () => {}
    const seen: string[] = []
    const status = await reconcileMerchantCheckoutSparkOrder(
      merchant,
      candidate,
      guard,
      {
        repository: context.repository,
        now: () => 2_000,
        checkCredit: (async (_principal, _candidate, options) => {
          expect(options?.expectedOrderWitness).toEqual(witness)
          expect(options?.assertActive).toBe(guard)
          seen.push("credit")
          context.setRecord(providerRecord(true))
          return { ...consumed, creditStatus: "recorded" }
        }) as CreditCheck,
        inspectPayouts: (async (_principal, _candidate, options) => {
          expect(options?.expectedOrderWitness).toEqual(witness)
          expect(options?.assertActive).toBe(guard)
          seen.push("history")
          context.setRecord(providerRecord(true, [merchantLeg, supplierLeg]))
          return inspected
        }) as PayoutInspection,
      }
    )
    expect(seen).toEqual(["credit", "history"])
    expect(status).toBe("verified")
  })

  it("does not start payout history after a failed or cancelled credit phase", async () => {
    const context = fixture()
    let payoutCalls = 0
    let active = true
    const guard = () => {
      if (!active) throw new Error("Page became inactive")
    }
    const options: ReconciliationOptions = {
      repository: context.repository,
      now: () => 2_000,
      checkCredit: (async () => {
        active = false
        context.setRecord(providerRecord(true))
        return { ...consumed, creditStatus: "recorded" }
      }) as CreditCheck,
      inspectPayouts: (async () => {
        payoutCalls += 1
        return inspected
      }) as PayoutInspection,
    }
    await expect(
      reconcileMerchantCheckoutSparkOrder(merchant, candidate, guard, options)
    ).rejects.toThrow("Page became inactive")
    expect(payoutCalls).toBe(0)

    active = true
    context.setRecord(null)
    options.checkCredit = (async () => {
      throw new Error("Provider unavailable")
    }) as CreditCheck
    await expect(
      reconcileMerchantCheckoutSparkOrder(merchant, candidate, guard, options)
    ).rejects.toThrow("Provider unavailable")
    expect(payoutCalls).toBe(0)
  })
})
