import { expect, it } from "bun:test"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import {
  startMerchantCheckoutSparkReconciliation,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import {
  startMerchantCheckoutSparkDiscovery,
  type MerchantCheckoutDiscoveryPage,
} from "../apps/merchant/src/lib/checkout-spark-discovery-controller"
import {
  createMerchantCheckoutSparkAutomaticSession,
  merchantCheckoutSparkAutomaticScopeIncludes,
} from "../apps/merchant/src/lib/checkout-spark-automatic-session"
import {
  getMerchantCheckoutSparkCandidateSelectionKey,
  getMerchantCheckoutSparkOrderSelectionKey,
  resolveMerchantCheckoutSparkDiscoverySelection,
} from "../apps/merchant/src/lib/checkout-spark-order-selection"
import { createMerchantCheckoutSparkPayoutReviewSelection } from "../apps/merchant/src/lib/checkout-spark-payout-review-selection"

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

it("continues one selected order after an ordinary empty first discovery page without another Continue", async () => {
  // Composed controller/selection/session seam, not mounted React or funded QA.
  // Selection uses the panel's real resolver; the callback and revocation below
  // compose its onPage/render boundary. There is only one ordinary order/account.
  const selectedOrder = {
    orderId: "ordinary-discovery-resume",
    merchantPubkey: getPublicKey(generateSecretKey()),
    buyerPubkey: getPublicKey(generateSecretKey()),
  }
  const candidate: MerchantCheckoutSparkRecoveryCandidate = {
    orderId: selectedOrder.orderId,
    initialBuyerPubkey: selectedOrder.buyerPubkey,
    checkoutId: "ordinary-discovery-checkout",
    planDigest: "c".repeat(64),
    wrapId: "d".repeat(64),
    schemaVersion: 3,
    takeoverAt: 0,
    preparedAt: 0,
  }
  const timer = clock()
  const reviewSelection = createMerchantCheckoutSparkPayoutReviewSelection()
  let discovery: ReturnType<typeof startMerchantCheckoutSparkDiscovery> | null =
    null
  let worker: ReturnType<
    typeof startMerchantCheckoutSparkReconciliation
  > | null = null
  let pages = 0
  let advancements = 0
  let automaticRevocations = 0
  const stopAndDrain = async () => {
    await Promise.all([discovery?.stopAndDrain(), worker?.stopAndDrain()])
  }
  const automatic = createMerchantCheckoutSparkAutomaticSession({
    isCurrent: () => true,
    stopAndDrain,
    captureOrder: (orderId, selectionKey) =>
      reviewSelection.capture(orderId, selectionKey),
  })
  const initialKey = getMerchantCheckoutSparkCandidateSelectionKey(
    selectedOrder,
    candidate
  )!
  let selection: ReturnType<
    typeof resolveMerchantCheckoutSparkDiscoverySelection
  > = {
    orderKey: getMerchantCheckoutSparkOrderSelectionKey(selectedOrder),
    selectionKey: initialKey,
  }
  reviewSelection.select(selectedOrder.orderId, initialKey)
  expect(
    await automatic.change(true, {
      kind: "order",
      orderId: selectedOrder.orderId,
      selectionKey: initialKey,
    })
  ).toBe(true)
  const scope = automatic.getScope()!
  const assertAutomatic = automatic.capture()
  worker = startMerchantCheckoutSparkReconciliation({
    now: timer.now,
    schedule: timer.schedule,
    async reconcile(current, assertWorkerCurrent) {
      assertWorkerCurrent()
      assertAutomatic(
        current.orderId,
        getMerchantCheckoutSparkCandidateSelectionKey(selectedOrder, current)
      )
      advancements += 1
      // This scheduler-only fixture has no wallet/provider or payment port.
      return "verified"
    },
    onUpdate() {},
  })
  discovery = startMerchantCheckoutSparkDiscovery({
    principalPubkey: selectedOrder.merchantPubkey,
    schedule: timer.schedule,
    onStatus() {},
    createSession: async () => ({
      async nextPage(): Promise<MerchantCheckoutDiscoveryPage> {
        pages += 1
        return {
          candidates: pages === 1 ? [] : [candidate],
          coverage: "partial",
          declarationState: "declared",
          malformedCount: 0,
          decryptFailureCount: 0,
          conflictCount: 0,
          history: {
            hasMore: pages === 1,
            pageStatus: pages === 1 ? "advanced" : "source_eose",
            retentionLimitReached: false,
          },
        }
      },
      restartScan() {},
      dispose() {},
    }),
    onPage(page) {
      worker?.replaceCandidates(
        page.candidates.filter((current) =>
          merchantCheckoutSparkAutomaticScopeIncludes(
            scope,
            current.orderId,
            getMerchantCheckoutSparkCandidateSelectionKey(
              selectedOrder,
              current
            )
          )
        )
      )
      selection = resolveMerchantCheckoutSparkDiscoverySelection({
        selected: selectedOrder,
        page,
        previous: selection,
      })
      reviewSelection.select(selectedOrder.orderId, selection.selectionKey)
      if (automatic.getScope() === null) {
        automaticRevocations += 1
        automatic.revoke()
        void stopAndDrain()
      }
    },
  })
  try {
    await timer.advance(0)
    expect({ pages, automaticRevocations, advancements }).toEqual({
      pages: 1,
      automaticRevocations: 0,
      advancements: 0,
    })
    await timer.advance(750)
    expect({ pages, automaticRevocations, advancements }).toEqual({
      pages: 2,
      automaticRevocations: 0,
      advancements: 1,
    })
    expect(automatic.getScope()).toBe(scope)
    selection = resolveMerchantCheckoutSparkDiscoverySelection({
      selected: selectedOrder,
      previous: selection,
      page: {
        candidates: [],
        coverage: "complete",
        declarationState: "declared",
        malformedCount: 0,
        decryptFailureCount: 0,
        conflictCount: 0,
        history: {
          hasMore: false,
          pageStatus: "source_eose",
          retentionLimitReached: false,
        },
      },
    })
    reviewSelection.select(selectedOrder.orderId, selection.selectionKey)
    expect(automatic.getScope()).toBeNull()
  } finally {
    await stopAndDrain()
  }
})
