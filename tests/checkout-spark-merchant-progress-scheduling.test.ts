import { describe, expect, it } from "bun:test"
import {
  startMerchantCheckoutSparkReconciliation,
  type CheckoutSparkMerchantSettlementRecord,
  type MerchantCheckoutSparkRecoveryCandidate,
  type MerchantCheckoutSparkReconciliationStatus,
} from "@conduit/core"
import { advanceMerchantCheckoutSparkOrder } from "../apps/merchant/src/lib/checkout-spark-order-reconciliation"
import { startMerchantCheckoutSparkDiscovery } from "../apps/merchant/src/lib/checkout-spark-discovery-controller"

// Offline provider/receipt/discovery fixtures; no signer, relay or payment calls.
const merchant = "a".repeat(64)
const merchantLeg = "1".repeat(64)
const feeLeg = "2".repeat(64)
const selected: MerchantCheckoutSparkRecoveryCandidate = {
  wrapId: "3".repeat(64),
  schemaVersion: 3,
  checkoutId: "offline-scheduler-probe",
  orderId: "offline-order-probe",
  planDigest: "4".repeat(64),
  takeoverAt: 0,
  preparedAt: 0,
  merchantProgress: {
    wrapId: "5".repeat(64),
    snapshotId: "6".repeat(64),
    recordedAt: 1,
  },
}
const fresh = {
  ...selected,
  merchantProgress: {
    wrapId: "7".repeat(64),
    snapshotId: "8".repeat(64),
    recordedAt: 2,
  },
}
type Dependencies = Parameters<typeof advanceMerchantCheckoutSparkOrder>[3]
type Repository = NonNullable<Dependencies["repository"]>

function record(
  paid: readonly string[]
): CheckoutSparkMerchantSettlementRecord {
  return {
    schemaVersion: 1,
    merchantPubkey: merchant,
    orderId: selected.orderId,
    checkoutId: selected.checkoutId,
    planDigest: selected.planDigest,
    merchantLegId: merchantLeg,
    requiredCommerceLegIds: [merchantLeg],
    feeLegId: feeLeg,
    credit: {
      transferId: "offline-funding",
      creditedSats: 1000,
      observedAt: 0,
    },
    paidLegs: paid.map((legId) => ({
      legId,
      transferId: `offline-${legId}`,
      allocationSats: 500,
      finalDebitSats: 500,
      finalFeeSats: 0,
      recipientVerified: true,
      observedAt: 1,
    })),
  }
}

function clock() {
  let time = 0
  const timers: Array<{
    at: number
    callback: () => void
    cancelled: boolean
  }> = []
  const flush = async () => {
    for (let index = 0; index < 100; index += 1) await Promise.resolve()
  }
  return {
    now: () => time,
    schedule(callback: () => void, delayMs: number) {
      const timer = { at: time + delayMs, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    async advance(ms: number) {
      const end = time + ms
      for (;;) {
        const next = timers
          .filter((timer) => !timer.cancelled && timer.at <= end)
          .sort((left, right) => left.at - right.at)[0]
        if (!next) break
        time = next.at
        next.cancelled = true
        next.callback()
        await flush()
      }
      time = end
      await flush()
    },
  }
}

async function runScenario(progressPaid: boolean, discoverFresh: boolean) {
  const timer = clock()
  let settlement = record([merchantLeg])
  const starts: number[] = []
  const outcomes: MerchantCheckoutSparkReconciliationStatus[] = []
  let retirementCalls = 0
  let continuations = 0
  let rescans = 0
  let pages = 0
  let maximumConcurrent = 0
  let concurrent = 0
  const repository = {
    async loadMerchantOrderWitness() {
      return {
        merchantPubkey: merchant,
        buyerPubkey: "b".repeat(64),
        ...selected,
      }
    },
    async load() {
      return {
        status: "active",
        revision: 1,
        state: {
          credit: { transferId: "offline-funding" },
          plan: { merchantPubkey: merchant, ...selected },
          legs: [],
        },
      }
    },
    async loadMerchantSettlement() {
      return settlement
    },
    async retire() {
      retirementCalls += 1
      throw new Error("Completed payment recovery must remain retained.")
    },
  } as unknown as Repository
  const consumed = (candidate: MerchantCheckoutSparkRecoveryCandidate) => ({
    status: "consumed" as const,
    coverage: "complete" as const,
    discoveryCoverage: "complete" as const,
    declarationState: "declared" as const,
    candidate,
  })
  const review = {
    checkoutId: selected.checkoutId,
    planDigest: selected.planDigest,
    legId: feeLeg,
    recipientId: "offline-fee",
    destination: "offline@example.invalid",
    allocationSats: 500,
    intent: {
      legId: feeLeg,
      transferId: "offline-saved-transfer",
      paymentRequest: "offline-saved-invoice",
      paymentHash: "9".repeat(64),
      invoiceAmountSats: 500,
      maxFeeSats: 0,
      preparedAt: 0,
    },
  }
  const worker = startMerchantCheckoutSparkReconciliation({
    now: timer.now,
    schedule: timer.schedule,
    reconcile: async (candidate, assertCurrent, reportProgress) => {
      starts.push(timer.now())
      concurrent += 1
      maximumConcurrent = Math.max(maximumConcurrent, concurrent)
      try {
        const outcome = await advanceMerchantCheckoutSparkOrder(
          merchant,
          candidate,
          assertCurrent,
          {
            repository,
            onProgress: reportProgress,
            now: timer.now,
            notifySuppliers: () => {},
            inspectPayouts: async (_principal, current) => ({
              ...consumed(current),
              payoutHistory: {
                status: "inspected",
                checkedLegs: 2,
                newlyConfirmedLegs: 0,
                unresolvedLegs: 1,
                withoutIntentLegs: 0,
                alreadyPaidLegs: 1,
              },
            }),
            selectPayout: async () => ({ status: "ready", review }),
            continuePayout: async (_principal, current, _review, options) => {
              options?.shouldContinue?.()
              continuations += 1
              if (progressPaid) settlement = record([merchantLeg, feeLeg])
              return {
                ...consumed(current),
                payout: progressPaid
                  ? { outcome: "paid", sendAttempted: true }
                  : {
                      outcome: "wait",
                      reason: "prior_possible_send",
                      sendAttempted: false,
                    },
              }
            },
            requestRescan: () => {
              rescans += 1
              discovery.requestRescan()
            },
          }
        )
        outcomes.push(outcome)
        return outcome
      } finally {
        concurrent -= 1
      }
    },
    onUpdate() {},
  })
  const discovery = startMerchantCheckoutSparkDiscovery({
    principalPubkey: merchant,
    schedule: timer.schedule,
    onStatus() {},
    createSession: async () =>
      ({
        async nextPage() {
          pages += 1
          return {
            candidates: [pages > 1 && discoverFresh ? fresh : selected],
            history: {
              hasMore: false,
              pageStatus: "complete",
              retentionLimitReached: false,
            },
          }
        },
        restartScan() {},
        dispose() {},
      }) as never,
    onPage: (page) => worker.replaceCandidates(page.candidates),
  })
  await timer.advance(0)
  await timer.advance(750)
  const early = { starts: [...starts], outcomes: [...outcomes], pages }
  await timer.advance(29_250)
  const measured = {
    early,
    starts,
    outcomes,
    retirementCalls,
    continuations,
    rescans,
    maximumConcurrent,
  }
  await discovery.stopAndDrain()
  await worker.stopAndDrain()
  return measured
}

describe("Merchant successful payment scheduling", () => {
  it("retains the 30s backoff for unchanged uncertain progress", async () => {
    const result = await runScenario(false, false)
    expect(result.early.starts).toEqual([0])
    expect(result.starts).toEqual([0, 30_000])
    expect(result.outcomes).toEqual(["progress_pending", "progress_pending"])
    expect(result.retirementCalls).toBe(0)
    expect(result.maximumConcurrent).toBe(1)
  })
  it("already wakes at 750ms when rescan selects fresh signed progress", async () => {
    const result = await runScenario(true, true)
    expect(result.starts).toEqual([0, 750])
    expect(result.outcomes).toEqual(["progress_pending", "verified"])
    expect(result.retirementCalls).toBe(0)
    expect(result.continuations).toBe(1)
    expect(result.maximumConcurrent).toBe(1)
  })
  it("confirms completion promptly after paid progress while retaining the wallet and unchanged signed discovery candidate", async () => {
    const result = await runScenario(true, false)
    expect(result.starts).toEqual([0, 750])
    expect(result.outcomes).toEqual(["progress_pending", "verified"])
    expect(result.continuations).toBe(1)
    expect(result.maximumConcurrent).toBe(1)
    expect(result.retirementCalls).toBe(0)
  })
})
