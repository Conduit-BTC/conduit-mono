import type { CheckoutSparkMerchantProgressPayload } from "./checkout-spark-merchant-progress"
import {
  deriveCheckoutSparkOrganizerRecoveryHandoffId,
  type CheckoutSparkOrganizerOrderBinding,
} from "./checkout-spark-organizer-recovery"
import {
  parseCheckoutSparkOrganizerExecutionProgress,
  type CheckoutSparkOrganizerExecutionProgress,
} from "./checkout-spark-organizer-progress"
import type { CheckoutSparkSettledRecoveryPayload } from "./checkout-spark-recovery"
import { assertCheckoutSparkSettledRecoveryProgression } from "./checkout-spark-settled-router-repository"
import {
  isCheckoutSparkEventMarketPlan,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"

/** The original author/type is preserved; Organizer evidence is never a Merchant receipt. */
export type CheckoutSparkRecoveryActorProgress =
  CheckoutSparkMerchantProgressPayload | CheckoutSparkOrganizerExecutionProgress

/**
 * Input envelopes must already be authenticated to the receiving Merchant.
 * Select monotonic machine state only; neither a snapshot nor its paid flags
 * replaces exact provider/recipient verification or grants stock/handout power.
 */
export function selectCheckoutSparkOrganizerProgressForMerchant(input: {
  initial: CheckoutSparkSettledRecoveryPayload
  latestState: CheckoutSparkSettledReconciliation
  /** Independently derived from the actual Buyer-to-Merchant order witness. */
  orderBinding: CheckoutSparkOrganizerOrderBinding
  entries: readonly CheckoutSparkOrganizerExecutionProgress[]
}):
  | { status: "none" }
  | { status: "selected"; progress: CheckoutSparkOrganizerExecutionProgress }
  | { status: "conflict" } {
  try {
    const state = restoreCheckoutSparkSettledReconciliation(input.latestState)
    const { plan } = state
    const binding = plan.eventMarket
    if (
      !isCheckoutSparkEventMarketPlan(plan) ||
      binding?.mode !== "organizer_handoff" ||
      input.initial.merchantPubkey !== plan.merchantPubkey ||
      JSON.stringify(input.initial.plan) !== JSON.stringify(plan) ||
      input.entries.length > 512
    )
      return { status: "conflict" }
    assertCheckoutSparkSettledRecoveryProgression(input.initial.state, state)
    const initialHandoffId = deriveCheckoutSparkOrganizerRecoveryHandoffId({
      merchantHandoffId: input.initial.handoffId,
      organizerPubkey: binding.organizerPubkey,
      orderBinding: input.orderBinding,
    })
    const entries = input.entries.map((entry) =>
      parseCheckoutSparkOrganizerExecutionProgress(entry)
    )
    const writerManifests = new Set<string>()
    for (const entry of entries) {
      if (
        entry.initialHandoffId !== initialHandoffId ||
        entry.initialMerchantHandoffId !== input.initial.handoffId ||
        entry.organizerPubkey !== binding.organizerPubkey ||
        entry.merchantPubkey !== plan.merchantPubkey ||
        JSON.stringify(entry.orderBinding) !==
          JSON.stringify(input.orderBinding) ||
        JSON.stringify(entry.state.plan) !== JSON.stringify(plan) ||
        (plan.schemaVersion === 6 &&
          JSON.stringify(entry.state.buyerActivation) !==
            JSON.stringify(state.buyerActivation))
      )
        return { status: "conflict" }
      writerManifests.add(JSON.stringify(entry.writerBindings))
    }
    if (writerManifests.size > 1) return { status: "conflict" }
    let current = state
    let selected: CheckoutSparkOrganizerExecutionProgress | undefined
    for (const entry of entries.sort(
      (a, b) =>
        a.recordedAt - b.recordedAt || a.snapshotId.localeCompare(b.snapshotId)
    )) {
      if (JSON.stringify(entry.state) === JSON.stringify(current)) continue
      try {
        assertCheckoutSparkSettledRecoveryProgression(current, entry.state)
        current = entry.state
        selected = entry
      } catch {
        // A retained older checkpoint must be completely subsumed, not dropped
        // merely because another actor wrote a later local timestamp.
        assertCheckoutSparkSettledRecoveryProgression(entry.state, current)
      }
    }
    return selected
      ? { status: "selected", progress: selected }
      : { status: "none" }
  } catch {
    return { status: "conflict" }
  }
}
