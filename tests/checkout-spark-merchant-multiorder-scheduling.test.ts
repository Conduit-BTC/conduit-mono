import { describe, expect, it } from "bun:test"
import {
  startMerchantCheckoutSparkReconciliation,
  type CheckoutSparkMerchantSettlementRecord,
  type MerchantCheckoutSparkReconciliationStatus,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import { startMerchantCheckoutSparkDiscovery } from "../apps/merchant/src/lib/checkout-spark-discovery-controller"
import { advanceMerchantCheckoutSparkOrder } from "../apps/merchant/src/lib/checkout-spark-order-reconciliation"

// Offline scheduling only: the production discovery controller, worker and
// one-phase advancement execute, while provider and signed-discovery reads are
// controlled dependencies. This does not measure SDK or public relay latency.
const merchant = "a".repeat(64)
const merchantLeg = "1".repeat(64)
const feeLeg = "2".repeat(64)
type Dependencies = Parameters<typeof advanceMerchantCheckoutSparkOrder>[3]
type Repository = NonNullable<Dependencies["repository"]>

function virtualClock() {
  let now = 0
  const timers: Array<{
    at: number
    callback: () => void
    cancelled: boolean
  }> = []
  return {
    now: () => now,
    schedule(callback: () => void, delayMs: number) {
      const timer = { at: now + delayMs, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const next = timers
          .filter((timer) => !timer.cancelled && timer.at <= end)
          .sort((left, right) => left.at - right.at)[0]
        if (!next) break
        now = next.at
        next.cancelled = true
        next.callback()
        for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
      }
      now = end
      for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
    },
  }
}

function candidate(name: string): MerchantCheckoutSparkRecoveryCandidate {
  return {
    schemaVersion: 3,
    checkoutId: `offline-${name}`,
    orderId: `offline-order-${name}`,
    planDigest: "3".repeat(64),
    wrapId: "4".repeat(64),
    takeoverAt: 0,
    preparedAt: 0,
  }
}

function settlement(
  selected: MerchantCheckoutSparkRecoveryCandidate,
  feePaid: boolean
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
      creditedSats: 1_000,
      observedAt: 0,
    },
    paidLegs: [merchantLeg, ...(feePaid ? [feeLeg] : [])].map((legId) => ({
      legId,
      transferId: `offline-transfer-${legId}`,
      allocationSats: 500,
      finalDebitSats: 500,
      finalFeeSats: 0,
      recipientVerified: true,
      observedAt: 0,
    })),
  }
}

async function runMultipleOrders(discoverPrepared: boolean) {
  const clock = virtualClock()
  const uncertain = candidate("a-uncertain")
  const ready = candidate("b-ready")
  const unprepared = candidate("c-unprepared")
  const candidates = [uncertain, ready, unprepared]
  const completed = new Set<string>()
  const sends = new Map<string, number>()
  const outcomes: Array<{
    checkoutId: string
    status: MerchantCheckoutSparkReconciliationStatus
    at: number
  }> = []
  let prepared = false
  let active = 0
  let maximumConcurrent = 0
  let retirementCalls = 0
  let preparations = 0

  const select = (checkoutId: string) => {
    const selected = candidates.find((entry) => entry.checkoutId === checkoutId)
    if (!selected) throw new Error("Unknown offline checkout")
    return selected
  }
  const repository = {
    async loadMerchantOrderWitness(_principal: string, checkoutId: string) {
      return {
        schemaVersion: 1,
        merchantPubkey: merchant,
        buyerPubkey: "b".repeat(64),
        ...select(checkoutId),
      }
    },
    async load(checkoutId: string) {
      return {
        status: "active",
        revision: 1,
        state: {
          credit: { transferId: "offline-funding" },
          plan: { merchantPubkey: merchant, ...select(checkoutId) },
          legs: [],
        },
      }
    },
    async loadMerchantSettlement(_principal: string, checkoutId: string) {
      return settlement(select(checkoutId), completed.has(checkoutId))
    },
    async retire() {
      retirementCalls += 1
      throw new Error("Payment completion does not authorize retirement")
    },
  } as unknown as Repository

  const consumed = (selected: MerchantCheckoutSparkRecoveryCandidate) => ({
    status: "consumed" as const,
    coverage: "complete" as const,
    discoveryCoverage: "complete" as const,
    declarationState: "declared" as const,
    candidate: selected,
  })

  const worker = startMerchantCheckoutSparkReconciliation({
    now: clock.now,
    schedule: clock.schedule,
    reconcile: async (selected, assertCurrent, reportProgress) => {
      active += 1
      maximumConcurrent = Math.max(maximumConcurrent, active)
      try {
        const status = await advanceMerchantCheckoutSparkOrder(
          merchant,
          selected,
          assertCurrent,
          {
            repository,
            now: clock.now,
            onProgress: reportProgress,
            notifySuppliers() {},
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
            selectPayout: async (_principal, current) => {
              if (
                current.checkoutId === unprepared.checkoutId &&
                !current.merchantProgress
              ) {
                return { status: "preparation_needed" }
              }
              return {
                status: "ready",
                review: {
                  checkoutId: current.checkoutId,
                  planDigest: current.planDigest,
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
                },
              }
            },
            preparePayout: async (_principal, current, options) => {
              expect(options.shouldContinue()).toBe(true)
              preparations += 1
              prepared = true
              return {
                status: "attempted",
                recovery: {
                  ...consumed(current),
                  preparation: {
                    status: "prepared",
                    recoveryDelivery: "relay_accepted",
                  },
                },
              }
            },
            continuePayout: async (_principal, current, _review, options) => {
              expect(options?.shouldContinue?.()).toBe(true)
              if (current.checkoutId === uncertain.checkoutId) {
                return {
                  ...consumed(current),
                  payout: {
                    outcome: "wait",
                    reason: "prior_possible_send",
                    sendAttempted: false,
                  },
                }
              }
              expect(completed.has(current.checkoutId)).toBe(false)
              sends.set(
                current.checkoutId,
                (sends.get(current.checkoutId) ?? 0) + 1
              )
              completed.add(current.checkoutId)
              return {
                ...consumed(current),
                payout: { outcome: "paid", sendAttempted: true },
              }
            },
            requestRescan: () => discovery.requestRescan(),
          }
        )
        outcomes.push({
          checkoutId: selected.checkoutId,
          status,
          at: clock.now(),
        })
        return status
      } finally {
        active -= 1
      }
    },
    onUpdate() {},
  })
  const discovery = startMerchantCheckoutSparkDiscovery({
    principalPubkey: merchant,
    schedule: clock.schedule,
    onStatus() {},
    createSession: async () =>
      ({
        async nextPage() {
          return {
            candidates: candidates.map((selected) =>
              selected.checkoutId === unprepared.checkoutId &&
              prepared &&
              discoverPrepared
                ? {
                    ...selected,
                    merchantProgress: {
                      wrapId: "5".repeat(64),
                      snapshotId: "6".repeat(64),
                      recordedAt: 1,
                    },
                  }
                : selected
            ),
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
  try {
    await clock.advance(7_500)
    return {
      completed: [...completed].sort(),
      sends: [...sends].sort(),
      outcomes,
      preparations,
      maximumConcurrent,
      retirementCalls,
    }
  } finally {
    await discovery.stopAndDrain()
    await worker.stopAndDrain()
  }
}

describe("Merchant multiorder automatic progression", () => {
  it("completes ready orders without manual checks while another exact possible send stays held", async () => {
    const result = await runMultipleOrders(true)
    expect(result.completed).toEqual([
      "offline-b-ready",
      "offline-c-unprepared",
    ])
    expect(result.sends).toEqual([
      ["offline-b-ready", 1],
      ["offline-c-unprepared", 1],
    ])
    expect(
      result.outcomes
        .filter(({ status }) => status === "verified")
        .map(({ checkoutId }) => checkoutId)
        .sort()
    ).toEqual(result.completed)
    expect(
      result.outcomes
        .filter(({ checkoutId }) => checkoutId === "offline-a-uncertain")
        .map(({ status }) => status)
    ).toEqual(["progress_pending"])
    expect(result.preparations).toBe(1)
    expect(result.maximumConcurrent).toBe(1)
    expect(result.retirementCalls).toBe(0)
  })

  it("does not continue prepared work until its fresh signed progress is discovered", async () => {
    const result = await runMultipleOrders(false)
    expect(result.completed).toEqual(["offline-b-ready"])
    expect(result.sends).toEqual([["offline-b-ready", 1]])
    expect(result.preparations).toBe(1)
    expect(result.maximumConcurrent).toBe(1)
    expect(result.retirementCalls).toBe(0)
  })
})
