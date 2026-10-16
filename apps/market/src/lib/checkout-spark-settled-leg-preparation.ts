import {
  assertCheckoutSparkSettledBuyerPreparationWindow,
  DexieCheckoutSparkSettledRepository,
  prepareCheckoutSparkSettledOutgoingLegShared,
  resolveCheckoutSparkLnurlInvoice,
  type CheckoutSparkLnurlInvoice,
  type CheckoutSparkLnurlInvoiceInput,
  type CheckoutSparkSettledLegPreparationInput,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledRepositorySnapshot,
  type CheckoutSparkSettledLegPreparationDependencies as SharedPreparationDependencies,
} from "@conduit/core"

import { getSparkWalletManager } from "./spark-sdk"
import type { SparkWalletManager } from "./spark-wallet"
import { assertMarketCheckoutSparkDispatchPlan } from "./checkout-spark-dispatch-policy"

export type { CheckoutSparkSettledLegPreparationInput }

export interface CheckoutSparkSettledLegPreparationDependencies {
  repository?: Pick<
    DexieCheckoutSparkSettledRepository,
    "load" | "savePreparedWithInvoiceOrigin"
  >
  walletManager?: Pick<
    SparkWalletManager,
    "estimateCheckoutLightningFee"
  > | null
  resolveInvoice?: (
    input: CheckoutSparkLnurlInvoiceInput
  ) => Promise<CheckoutSparkLnurlInvoice>
  /** Persists and relay-ACKs the exact encrypted Merchant recovery snapshot. */
  acknowledgeRecoverySnapshot: (
    state: CheckoutSparkSettledReconciliation
  ) => Promise<void>
  nowMs?: () => number
}

/** Buyer-only adapter; Core does not grant Merchant execution authority. */
export async function prepareCheckoutSparkSettledOutgoingLeg(
  input: CheckoutSparkSettledLegPreparationInput,
  dependencies: CheckoutSparkSettledLegPreparationDependencies
): Promise<
  Extract<CheckoutSparkSettledRepositorySnapshot, { status: "active" }>
> {
  return prepareCheckoutSparkSettledOutgoingLegShared(
    input,
    createBuyerCheckoutSparkLegPreparationPorts(input, dependencies)
  )
}

/** Provider-specific ports; the shared financial workflow owns preparation. */
export function createBuyerCheckoutSparkLegPreparationPorts(
  input: CheckoutSparkSettledLegPreparationInput,
  dependencies: CheckoutSparkSettledLegPreparationDependencies
): SharedPreparationDependencies {
  let pinnedManager:
    Pick<SparkWalletManager, "estimateCheckoutLightningFee"> | null | undefined
  const requireManager = () => {
    if (pinnedManager === undefined) {
      pinnedManager =
        dependencies.walletManager === null
          ? null
          : (dependencies.walletManager ?? getSparkWalletManager())
    }
    if (!pinnedManager) {
      throw new Error("Checkout Spark wallet is unavailable.")
    }
    return pinnedManager
  }
  return {
    repository:
      dependencies.repository ?? new DexieCheckoutSparkSettledRepository(),
    estimateFee(request) {
      return requireManager().estimateCheckoutLightningFee(request)
    },
    async resolveInvoice(request, context) {
      // No LNURL side effect until the buyer's exact wallet is available.
      requireManager()
      if (
        context.state.plan.merchantPublicZapPolicy &&
        context.recipient.kind === "merchant"
      ) {
        // Existing exact intents may still be re-ACKed/reconciled by Core.
        // Never sign or replace a historical public attempt with a private one.
        throw new Error(
          "Historical public routed payments require exact-attempt recovery."
        )
      }
      return (dependencies.resolveInvoice ?? resolveCheckoutSparkLnurlInvoice)(
        request
      )
    },
    assertAuthority(state, nowMs) {
      assertMarketCheckoutSparkDispatchPlan(state.plan)
      const current = state.legs.find((leg) => leg.legId === input.legId)
      // Re-ACK an immutable existing intent after takeover, but never prepare
      // a new invoice after buyer authority has ended.
      if (!current?.intent) {
        assertCheckoutSparkSettledBuyerPreparationWindow(state, nowMs)
      }
    },
    acknowledgeRecoverySnapshot: dependencies.acknowledgeRecoverySnapshot,
    nowMs: dependencies.nowMs,
  }
}
