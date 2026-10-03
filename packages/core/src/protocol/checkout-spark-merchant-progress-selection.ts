import {
  parseCheckoutSparkMerchantProgress,
  type CheckoutSparkMerchantProgressPayload,
} from "./checkout-spark-merchant-progress"
import type { CheckoutSparkSettledRecoveryPayload } from "./checkout-spark-recovery"
import { assertCheckoutSparkSettledRecoveryProgression } from "./checkout-spark-settled-router-repository"
import {
  restoreCheckoutSparkSettledPlan,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"

const HEX_64 = /^[0-9a-f]{64}$/

export interface CheckoutSparkMerchantProgressSelectionEntry {
  wrapId: string
  payload: CheckoutSparkMerchantProgressPayload
}

export type CheckoutSparkMerchantProgressSelection =
  | { status: "none" }
  | { status: "selected"; entry: CheckoutSparkMerchantProgressSelectionEntry }
  | { status: "conflict" }

/**
 * Select only a monotonic Merchant-authored update to an authenticated buyer
 * recovery. The caller must authenticate each gift wrap and the initial buyer
 * recovery before passing data here. This is neither settlement nor authority
 * to send a payment.
 */
export function selectCheckoutSparkMerchantProgress(input: {
  initial: CheckoutSparkSettledRecoveryPayload
  latestBuyerState: CheckoutSparkSettledReconciliation
  entries: readonly CheckoutSparkMerchantProgressSelectionEntry[]
}): CheckoutSparkMerchantProgressSelection {
  try {
    const { initial } = input
    if (
      initial.schemaVersion !== 2 ||
      initial.type !== "checkout_spark_recovery" ||
      !HEX_64.test(initial.handoffId) ||
      !HEX_64.test(initial.merchantPubkey) ||
      !HEX_64.test(initial.senderPubkey) ||
      initial.wallet.providerId !== "spark"
    ) {
      return { status: "conflict" }
    }
    const plan = restoreCheckoutSparkSettledPlan(initial.plan)
    const initialState = restoreCheckoutSparkSettledReconciliation(
      initial.state
    )
    const buyerState = restoreCheckoutSparkSettledReconciliation(
      input.latestBuyerState
    )
    const frozenPlan = JSON.stringify(plan)
    if (
      initial.merchantPubkey !== plan.merchantPubkey ||
      initial.wallet.walletId !== plan.walletId ||
      initial.wallet.network !== plan.network ||
      initial.preparedAt >= plan.takeoverAt ||
      initialState.updatedAt > initial.preparedAt ||
      JSON.stringify(initialState.plan) !== frozenPlan ||
      JSON.stringify(buyerState.plan) !== frozenPlan
    ) {
      return { status: "conflict" }
    }
    assertCheckoutSparkSettledRecoveryProgression(initialState, buyerState)

    const bySnapshot = new Map<
      string,
      CheckoutSparkMerchantProgressSelectionEntry
    >()
    const snapshotByWrap = new Map<string, string>()
    for (const entry of input.entries) {
      if (!HEX_64.test(entry.wrapId)) return { status: "conflict" }
      const payload = parseCheckoutSparkMerchantProgress(entry.payload)
      if (
        payload.initialHandoffId !== initial.handoffId ||
        payload.merchantPubkey !== plan.merchantPubkey ||
        JSON.stringify(payload.state.plan) !== frozenPlan
      ) {
        return { status: "conflict" }
      }
      const previousSnapshot = snapshotByWrap.get(entry.wrapId)
      if (previousSnapshot && previousSnapshot !== payload.snapshotId) {
        return { status: "conflict" }
      }
      snapshotByWrap.set(entry.wrapId, payload.snapshotId)
      const previous = bySnapshot.get(payload.snapshotId)
      if (
        previous &&
        JSON.stringify(previous.payload) !== JSON.stringify(payload)
      ) {
        return { status: "conflict" }
      }
      if (!previous || entry.wrapId < previous.wrapId) {
        bySnapshot.set(payload.snapshotId, { wrapId: entry.wrapId, payload })
      }
    }

    const ordered = [...bySnapshot.values()].sort(
      (left, right) =>
        left.payload.recordedAt - right.payload.recordedAt ||
        left.payload.snapshotId.localeCompare(right.payload.snapshotId)
    )
    let current = buyerState
    let selected: CheckoutSparkMerchantProgressSelectionEntry | null = null
    for (const entry of ordered) {
      const next = entry.payload.state
      if (next.updatedAt === current.updatedAt) {
        if (JSON.stringify(next) !== JSON.stringify(current)) {
          return { status: "conflict" }
        }
        continue
      }
      if (next.updatedAt < current.updatedAt) {
        // A delayed exact wrap may be strictly subsumed by newer buyer/local
        // evidence. It must not roll that evidence backward.
        assertCheckoutSparkSettledRecoveryProgression(next, current)
        continue
      }
      assertCheckoutSparkSettledRecoveryProgression(current, next)
      current = next
      selected = entry
    }
    return selected
      ? { status: "selected", entry: selected }
      : { status: "none" }
  } catch {
    return { status: "conflict" }
  }
}
