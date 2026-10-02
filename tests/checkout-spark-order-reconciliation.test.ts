import { describe, expect, it } from "bun:test"
import type {
  CheckoutSparkMerchantOrderWitness,
  CheckoutSparkMerchantSettlementRecord,
  MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import {
  advanceMerchantCheckoutSparkOrder,
  reconcileMerchantCheckoutSparkOrder,
} from "../apps/merchant/src/lib/checkout-spark-order-reconciliation"

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
              credit: { transferId: "buyer-claimed-credit" },
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

describe("automatic checkout Spark order reconciliation adapter", () => {
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
      witnessReads: 0,
      stateReads: 0,
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
