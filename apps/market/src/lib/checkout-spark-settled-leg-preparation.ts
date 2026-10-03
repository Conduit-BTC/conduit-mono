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
  return prepareCheckoutSparkSettledOutgoingLegShared(input, {
    repository:
      dependencies.repository ?? new DexieCheckoutSparkSettledRepository(),
    estimateFee(request) {
      return requireManager().estimateCheckoutLightningFee(request)
    },
    resolveInvoice(request) {
      // No LNURL side effect until the buyer's exact wallet is available.
      requireManager()
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
  })
}
