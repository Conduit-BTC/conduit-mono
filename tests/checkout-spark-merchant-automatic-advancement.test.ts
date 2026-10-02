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
const freshSnapshotId = "4".repeat(64)
const candidate: MerchantCheckoutSparkRecoveryCandidate = {
  wrapId: "d".repeat(64),
  schemaVersion: 3,
  checkoutId: "checkout-automatic-advancement",
  orderId: "order-automatic-advancement",
  planDigest: digest,
  takeoverAt: 1_000,
  preparedAt: 500,
}
const freshCandidate: MerchantCheckoutSparkRecoveryCandidate = {
  ...candidate,
  merchantProgress: {
    wrapId: "5".repeat(64),
    snapshotId: freshSnapshotId,
    recordedAt: 2_000,
  },
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

type Dependencies = Parameters<typeof advanceMerchantCheckoutSparkOrder>[3]
type Repository = NonNullable<Dependencies["repository"]>
type Selection = Awaited<ReturnType<NonNullable<Dependencies["selectPayout"]>>>
type PreparationResult = Awaited<
  ReturnType<NonNullable<Dependencies["preparePayout"]>>
>
type Prepared = NonNullable<
  Extract<PreparationResult, { status: "attempted" }>["recovery"]["preparation"]
>

const review: Extract<Selection, { status: "ready" }>["review"] = {
  checkoutId: candidate.checkoutId,
  planDigest: digest,
  legId: feeLeg,
  recipientId: "offline-fee-recipient",
  destination: "fee@example.invalid",
  allocationSats: 500,
  intent: {
    legId: feeLeg,
    transferId: "offline-frozen-transfer",
    paymentRequest: "offline-reviewed-invoice",
    paymentHash: "6".repeat(64),
    invoiceAmountSats: 498,
    maxFeeSats: 2,
    preparedAt: 2_000,
  },
}

function providerRecord(
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
    credit: {
      transferId: "offline-funding-transfer",
      creditedSats: 1_500,
      observedAt: 1_500,
    },
    paidLegs: paid.map((legId) => ({
      legId,
      transferId: `offline-transfer-${legId}`,
      allocationSats: 500,
      finalDebitSats: 500,
      finalFeeSats: 0,
      recipientVerified: true,
      observedAt: 2_000,
    })),
  }
}

function consumed(selected: MerchantCheckoutSparkRecoveryCandidate) {
  return {
    status: "consumed" as const,
    coverage: "complete" as const,
    discoveryCoverage: "complete" as const,
    declarationState: "declared" as const,
    candidate: selected,
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture() {
  let active = true
  let now = 2_000
  let currentWitness: CheckoutSparkMerchantOrderWitness | null = witness
  let record: CheckoutSparkMerchantSettlementRecord | null = providerRecord()
  let retired = false
  let localAllPaid = false
  let recordReads = 0
  let prepared: Prepared = {
    status: "prepared",
    recoveryDelivery: "relay_accepted",
  }
  let selectionOverride: Selection | null = null
  let retirementStatus: "retired" | "pending" | null = "pending"
  let intercept: ((stage: string) => void | Promise<void>) | undefined
  const calls: string[] = []
  const repositoryArguments: unknown[][] = []
  const observedCandidates: MerchantCheckoutSparkRecoveryCandidate[] = []
  const phaseGuards: Array<() => boolean> = []
  const assertActive = () => {
    if (!active) throw new Error("Active Merchant session changed")
  }
  const stage = async (name: string) => {
    calls.push(name)
    await intercept?.(name)
  }
  const observeCandidate = (
    selected: MerchantCheckoutSparkRecoveryCandidate
  ) => {
    observedCandidates.push({
      ...selected,
      ...(selected.merchantProgress
        ? { merchantProgress: { ...selected.merchantProgress } }
        : {}),
    })
  }
  const repository = {
    async loadMerchantOrderWitness(...args: unknown[]) {
      repositoryArguments.push(args)
      await stage("witness")
      return currentWitness
    },
    async load(...args: unknown[]) {
      repositoryArguments.push(args)
      await stage("state")
      return retired
        ? { status: "retired", planDigest: digest, retiredAt: now }
        : {
            status: "active",
            revision: 1,
            state: {
              credit: { transferId: "unattested-local-credit" },
              legs: [merchantLeg, supplierLeg, feeLeg].map((legId) => ({
                legId,
                status: localAllPaid ? "paid" : "unprepared",
              })),
              plan: {
                merchantPubkey: merchant,
                checkoutId: candidate.checkoutId,
                orderId: candidate.orderId,
                planDigest: digest,
                takeoverAt: candidate.takeoverAt,
              },
            },
          }
    },
    async loadMerchantSettlement(...args: unknown[]) {
      repositoryArguments.push(args)
      await stage(`settlement:${++recordReads}`)
      return record
    },
  } as unknown as Repository
  const options: Dependencies = {
    repository,
    now: () => now,
    checkCredit: async (principal, selected, input) => {
      expect(principal).toBe(merchant)
      expect(input?.assertActive).toBe(assertActive)
      expect(input?.expectedOrderWitness).toEqual(witness)
      observeCandidate(selected)
      await stage("credit")
      record = providerRecord()
      return { ...consumed(selected), creditStatus: "recorded" }
    },
    inspectPayouts: async (principal, selected, input) => {
      expect(principal).toBe(merchant)
      expect(input?.assertActive).toBe(assertActive)
      expect(input?.expectedOrderWitness).toEqual(witness)
      observeCandidate(selected)
      await stage("history")
      return {
        ...consumed(selected),
        payoutHistory: {
          status: "inspected",
          checkedLegs: 3,
          newlyConfirmedLegs: 0,
          unresolvedLegs: 1,
          withoutIntentLegs: 0,
          alreadyPaidLegs: 0,
        },
      }
    },
    selectPayout: async (principal, selected, guard, input) => {
      expect(principal).toBe(merchant)
      expect(guard).toBe(assertActive)
      expect(input?.repository).toBe(repository)
      observeCandidate(selected)
      await stage("selection")
      return (
        selectionOverride ??
        (selected.merchantProgress?.snapshotId === freshSnapshotId
          ? { status: "ready", review }
          : { status: "preparation_needed" })
      )
    },
    preparePayout: async (principal, selected, input, dependencies) => {
      expect(principal).toBe(merchant)
      expect(dependencies?.repository).toBe(repository)
      expect(input).not.toHaveProperty("stopAndDrain")
      expect(Object.keys(input)).toEqual(["shouldContinue"])
      expect(input.shouldContinue()).toBe(true)
      phaseGuards.push(input.shouldContinue)
      observeCandidate(selected)
      await stage("preparation")
      return {
        status: "attempted",
        recovery: { ...consumed(selected), preparation: prepared },
      }
    },
    continuePayout: async (
      principal,
      selected,
      selectedReview,
      dependencies
    ) => {
      expect(principal).toBe(merchant)
      expect(selectedReview).toBe(review)
      expect(dependencies?.repository).toBe(repository)
      expect(dependencies).not.toHaveProperty("stopAndDrain")
      expect(dependencies?.shouldContinue?.()).toBe(true)
      phaseGuards.push(dependencies!.shouldContinue!)
      observeCandidate(selected)
      await stage("continuation")
      return {
        ...consumed(selected),
        payout: { outcome: "paid", sendAttempted: true },
      }
    },
    retireWallet: async (principal, selected, dependencies) => {
      expect(principal).toBe(merchant)
      expect(dependencies?.repository).toBe(repository)
      expect(dependencies?.assertActive).toBe(assertActive)
      dependencies?.assertActive?.()
      observeCandidate(selected)
      await stage("retirement")
      return { ...consumed(selected), retirementStatus }
    },
    requestRescan: () => {
      calls.push("rescan")
    },
  }
  return {
    options,
    calls,
    repositoryArguments,
    observedCandidates,
    phaseGuards,
    assertActive,
    run(selected = candidate) {
      return advanceMerchantCheckoutSparkOrder(
        ` ${merchant.toUpperCase()} `,
        selected,
        assertActive,
        options
      )
    },
    setActive(value: boolean) {
      active = value
    },
    setNow(value: number) {
      now = value
    },
    setRecord(value: CheckoutSparkMerchantSettlementRecord | null) {
      record = value
    },
    setWitness(value: CheckoutSparkMerchantOrderWitness | null) {
      currentWitness = value
    },
    setRetired() {
      retired = true
    },
    setLocalAllPaid() {
      localAllPaid = true
    },
    setPreparation(value: Prepared) {
      prepared = value
    },
    setSelection(value: Selection) {
      selectionOverride = value
    },
    setRetirementStatus(value: typeof retirementStatus) {
      retirementStatus = value
    },
    intercept(value: typeof intercept) {
      intercept = value
    },
  }
}

describe("automatic Merchant checkout one-phase advancement", () => {
  it("retires provider-verified commerce and fee without selecting or sending another payout", async () => {
    const context = fixture()
    context.setRecord(providerRecord([merchantLeg, supplierLeg, feeLeg]))
    context.setRetirementStatus("retired")
    expect(await context.run(freshCandidate)).toBe("retired")
    expect(context.calls).toEqual([
      "witness",
      "state",
      "settlement:1",
      "retirement",
    ])
    expect(context.observedCandidates).toEqual([freshCandidate])
  })

  it.each(["pending", null] as const)(
    "does not claim terminal retirement from a consumed %s observation",
    async (status) => {
      const context = fixture()
      context.setRecord(providerRecord([merchantLeg, supplierLeg, feeLeg]))
      context.setRetirementStatus(status)
      expect(await context.run(freshCandidate)).toBe(
        status === "pending" ? "retirement_pending" : "unavailable"
      )
      expect(context.calls).toEqual([
        "witness",
        "state",
        "settlement:1",
        "retirement",
      ])
    }
  )

  it.each(["missing", "incomplete"] as const)(
    "reports %s retirement authority as unavailable without another payout",
    async (status) => {
      const context = fixture()
      context.setRecord(providerRecord([merchantLeg, supplierLeg, feeLeg]))
      context.options.retireWallet = async () => ({
        status,
        coverage: "partial",
        discoveryCoverage: "partial",
        declarationState: "unavailable",
        candidate: null,
        retirementStatus: null,
      })
      expect(await context.run(freshCandidate)).toBe("unavailable")
      expect(context.calls).toEqual(["witness", "state", "settlement:1"])
    }
  )

  it("keeps read-only reconciliation separate from retirement", async () => {
    const context = fixture()
    context.setRecord(providerRecord([merchantLeg, supplierLeg, feeLeg]))
    context.setRetirementStatus("retired")
    expect(
      await reconcileMerchantCheckoutSparkOrder(
        merchant,
        freshCandidate,
        context.assertActive,
        context.options
      )
    ).toBe("verified")
    expect(context.calls).toEqual(["witness", "state", "settlement:1"])
  })

  it("invalidates a held retirement observation when the Merchant session changes", async () => {
    const context = fixture()
    context.setRecord(providerRecord([merchantLeg, supplierLeg, feeLeg]))
    context.setRetirementStatus("retired")
    const entered = deferred()
    const release = deferred()
    context.intercept(async (stage) => {
      if (stage !== "retirement") return
      entered.resolve()
      await release.promise
    })
    const advancing = context.run(freshCandidate)
    await entered.promise
    context.setActive(false)
    release.resolve()
    await expect(advancing).rejects.toThrow("Active Merchant session changed")
    expect(context.calls).toEqual([
      "witness",
      "state",
      "settlement:1",
      "retirement",
    ])
  })

  it("prepares and continues only in separate calls with fresh signed selection", async () => {
    const context = fixture()
    expect(await context.run()).toBe("progress_pending")
    expect(
      context.calls.filter((call) =>
        ["selection", "preparation", "continuation", "rescan"].includes(call)
      )
    ).toEqual(["selection", "preparation", "rescan"])

    expect(await context.run(freshCandidate)).toBe("progress_pending")
    expect(
      context.calls.filter((call) =>
        ["selection", "preparation", "continuation", "rescan"].includes(call)
      )
    ).toEqual([
      "selection",
      "preparation",
      "rescan",
      "selection",
      "continuation",
      "rescan",
    ])
    expect(context.observedCandidates.slice(-3)).toEqual([
      freshCandidate,
      freshCandidate,
      freshCandidate,
    ])
    context.setActive(false)
    for (const guard of context.phaseGuards) {
      expect(guard).toThrow("Active Merchant session changed")
    }
  })

  it.each(["prepared", "existing_intent", "recovery_pending"] as const)(
    "never continues from an old selection after %s preparation or self-delivery",
    async (status) => {
      const context = fixture()
      const oldCandidate = {
        ...freshCandidate,
        merchantProgress: {
          ...freshCandidate.merchantProgress!,
          snapshotId: "7".repeat(64),
        },
      }
      context.setPreparation({
        status,
        recoveryDelivery:
          status === "recovery_pending" ? "pending" : "relay_accepted",
      })
      expect(await context.run(oldCandidate)).toBe("progress_pending")
      expect(await context.run(oldCandidate)).toBe("progress_pending")
      expect(context.calls.filter((call) => call === "selection")).toHaveLength(
        2
      )
      expect(
        context.calls.filter((call) => call === "preparation")
      ).toHaveLength(2)
      expect(context.calls.filter((call) => call === "rescan")).toHaveLength(2)
      expect(context.calls).not.toContain("continuation")
      expect(
        context.observedCandidates.every(
          (selected) =>
            selected.merchantProgress?.snapshotId ===
            oldCandidate.merchantProgress.snapshotId
        )
      ).toBe(true)
    }
  )

  it.each(["already recorded", "after exact history"] as const)(
    "checks wallet retirement for provider-attested all-paid %s",
    async (when) => {
      const context = fixture()
      if (when === "already recorded") {
        context.setRecord(providerRecord([merchantLeg, supplierLeg, feeLeg]))
      } else {
        context.intercept((stage) => {
          if (stage === "history") {
            context.setRecord(
              providerRecord([merchantLeg, supplierLeg, feeLeg])
            )
          }
        })
      }
      expect(await context.run(freshCandidate)).toBe("retirement_pending")
      expect(
        context.calls.filter((call) => call === "retirement")
      ).toHaveLength(1)
      expect(context.calls).not.toContain("selection")
      expect(context.calls).not.toContain("preparation")
      expect(context.calls).not.toContain("continuation")
      expect(context.calls).not.toContain("rescan")
      if (when === "already recorded") {
        expect(context.calls).not.toContain("credit")
        expect(context.calls).not.toContain("history")
      }
    }
  )

  it("advances an unpaid fee after commerce is provider verified", async () => {
    const context = fixture()
    context.setRecord(providerRecord([merchantLeg, supplierLeg]))
    expect(await context.run(freshCandidate)).toBe("progress_pending")
    expect(context.calls).not.toContain("credit")
    expect(context.calls).toContain("history")
    expect(context.calls).toContain("selection")
    expect(context.calls).toContain("continuation")
    expect(context.calls).not.toContain("preparation")
    expect(context.calls).not.toContain("retirement")
  })

  it("does not treat local all-paid rows or no_unpaid_leg as provider or retirement proof", async () => {
    const context = fixture()
    context.setLocalAllPaid()
    context.setSelection({ status: "no_unpaid_leg" })
    expect(await context.run(freshCandidate)).toBe("pending")
    expect(context.calls).toContain("history")
    expect(context.calls).toContain("selection")
    expect(context.calls).not.toContain("preparation")
    expect(context.calls).not.toContain("continuation")
    expect(context.calls).not.toContain("rescan")
    expect(context.calls).not.toContain("retirement")
  })

  it("reports missing local invoice origin without preparing a replacement", async () => {
    const context = fixture()
    context.options.continuePayout = async (_principal, selected) => ({
      ...consumed(selected),
      payout: {
        outcome: "wait",
        reason: "recipient_unverified",
        sendAttempted: false,
      },
    })
    expect(await context.run(freshCandidate)).toBe("recipient_unverified")
    expect(context.calls).not.toContain("preparation")
    expect(context.calls).not.toContain("rescan")
  })

  it("pauses provider-complete recovery with missing origin without reopening provider history", async () => {
    const context = fixture()
    const complete = providerRecord([merchantLeg, supplierLeg, feeLeg])
    context.setRecord({
      ...complete,
      paidLegs: complete.paidLegs.map((leg) => {
        const providerOnly = { ...leg }
        delete providerOnly.recipientVerified
        return providerOnly
      }),
    })
    expect(await context.run(freshCandidate)).toBe("recipient_unverified")
    expect(context.calls).not.toContain("history")
    expect(context.calls).not.toContain("retirement")
    expect(context.calls).not.toContain("selection")
    expect(context.calls).not.toContain("preparation")
    expect(context.calls).not.toContain("rescan")
  })

  it("can still advance an unprepared next leg when prior provider-paid origin is missing", async () => {
    const context = fixture()
    const partial = providerRecord([merchantLeg])
    context.setRecord({
      ...partial,
      paidLegs: partial.paidLegs.map((leg) => {
        const providerOnly = { ...leg }
        delete providerOnly.recipientVerified
        return providerOnly
      }),
    })
    expect(await context.run(candidate)).toBe("progress_pending")
    expect(context.calls).toContain("preparation")
  })

  it.each(["legacy", "pre-handoff", "unbound", "retired"] as const)(
    "does not start an advancement phase for %s recovery",
    async (state) => {
      const context = fixture()
      if (state === "pre-handoff") context.setNow(999)
      if (state === "unbound") context.setWitness(null)
      if (state === "retired") context.setRetired()
      const selected =
        state === "legacy"
          ? { ...candidate, schemaVersion: 1 as const }
          : candidate
      const expected =
        state === "pre-handoff"
          ? "pending"
          : state === "retired"
            ? "retired"
            : "unbound"
      expect(await context.run(selected)).toBe(expected)
      expect(
        context.calls.every((call) => ["witness", "state"].includes(call))
      ).toBe(true)
    }
  )

  it.each([
    "witness",
    "state",
    "settlement:1",
    "credit",
    "settlement:2",
    "history",
    "settlement:3",
    "selection",
    "preparation",
    "continuation",
  ])(
    "rechecks the active guard after the %s await before further effects",
    async (heldStage) => {
      const context = fixture()
      context.setRecord(null)
      const entered = deferred()
      const release = deferred()
      context.intercept(async (stage) => {
        if (stage !== heldStage) return
        entered.resolve()
        await release.promise
      })
      const selected = heldStage === "continuation" ? freshCandidate : candidate
      const advancing = context.run(selected)
      expect(
        await Promise.race([
          entered.promise.then(() => true),
          advancing.then(() => false),
        ])
      ).toBe(true)
      context.setActive(false)
      release.resolve()
      await expect(advancing).rejects.toThrow("Active Merchant session changed")
      const expectedStages = [
        "witness",
        "state",
        "settlement:1",
        "credit",
        "settlement:2",
        "history",
        "settlement:3",
        "selection",
        heldStage === "continuation" ? "continuation" : "preparation",
      ]
      expect(context.calls).toEqual(
        expectedStages.slice(0, expectedStages.indexOf(heldStage) + 1)
      )
      expect(context.calls).not.toContain("rescan")
      for (const guard of context.phaseGuards) {
        expect(guard).toThrow("Active Merchant session changed")
      }
    }
  )

  it("pins the original candidate and nested signed progress across awaits", async () => {
    const context = fixture()
    const original = {
      ...freshCandidate,
      merchantProgress: { ...freshCandidate.merchantProgress! },
    }
    const selected = {
      ...original,
      merchantProgress: { ...original.merchantProgress },
    }
    const entered = deferred()
    const release = deferred()
    context.intercept(async (stage) => {
      if (stage !== "witness") return
      entered.resolve()
      await release.promise
    })
    const advancing = context.run(selected)
    await entered.promise
    selected.checkoutId = "changed-checkout"
    selected.orderId = "changed-order"
    selected.planDigest = "8".repeat(64)
    selected.wrapId = "9".repeat(64)
    selected.takeoverAt = 9_000
    selected.merchantProgress.snapshotId = "0".repeat(64)
    selected.merchantProgress.wrapId = "0".repeat(64)
    selected.merchantProgress.recordedAt = 9_000
    release.resolve()

    expect(await advancing).toBe("progress_pending")
    expect(context.observedCandidates).toEqual([original, original, original])
    expect(context.repositoryArguments).toEqual([
      [merchant, original.checkoutId, original.planDigest],
      [original.checkoutId, original.planDigest],
      [merchant, original.checkoutId, original.planDigest],
      [merchant, original.checkoutId, original.planDigest],
    ])
    expect(context.calls).toContain("continuation")
    expect(context.calls).not.toContain("preparation")
  })
})
