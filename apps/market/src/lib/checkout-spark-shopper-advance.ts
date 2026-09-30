import {
  applyCheckoutSparkEvidence,
  DexieCheckoutSparkRepository,
  getOrderLifecycle,
  runCheckoutSparkOutgoingStep,
  type CheckoutSparkOutgoingProvider,
  type CheckoutSparkOutgoingStepResult,
  type CheckoutSparkRepositorySnapshot,
  type OrderLifecycle,
} from "@conduit/core"

import {
  createCheckoutSparkRouterFundingBridge,
  type CheckoutSparkRouterFundingPaymentInput,
  type CheckoutSparkRouterFundingResult,
} from "./checkout-spark-router-funding"
import {
  getCheckoutSparkRouterPreparation,
  type StoredCheckoutSparkRouterPreparation,
} from "./checkout-spark-router-preparation"
import { createCheckoutSparkOutgoingProvider } from "./checkout-spark-outgoing-provider"
import { getSparkConfiguration, getSparkWalletManager } from "./spark-sdk"

type RouterRepository = Pick<
  DexieCheckoutSparkRepository,
  "create" | "load" | "save"
>

export interface AdvanceCheckoutSparkShopperInput {
  checkoutId: string
  orderId: string
  merchantPubkey: string
  network: "mainnet" | "regtest"
  /** The signer identity that authorized this exact checkout. */
  buyerPubkey: string
  /** Must read the current signer, not a captured React render value. */
  currentBuyerPubkey: () => string | null
  /** Invalidates a call after account or checkout navigation. */
  shouldContinue: () => boolean
  fundingPayment: CheckoutSparkRouterFundingPaymentInput
}

export type AdvanceCheckoutSparkShopperResult =
  | {
      status: "funding_wait"
      funding: CheckoutSparkRouterFundingResult
    }
  | {
      status: "outgoing_step"
      step: CheckoutSparkOutgoingStepResult
    }

export interface AdvanceCheckoutSparkShopperDependencies {
  readOrder?: (orderId: string) => Promise<OrderLifecycle | undefined>
  readPreparation?: (
    checkoutId: string
  ) => StoredCheckoutSparkRouterPreparation | null
  repository?: RouterRepository
  sparkConfiguration?: typeof getSparkConfiguration
  sparkManager?: typeof getSparkWalletManager
  fundingBridge?: typeof createCheckoutSparkRouterFundingBridge
  outgoingProvider?: typeof createCheckoutSparkOutgoingProvider
  now?: () => number
}

function activeSnapshot(
  snapshot: CheckoutSparkRepositorySnapshot
): Extract<CheckoutSparkRepositorySnapshot, { status: "active" }> {
  if (snapshot.status !== "active") {
    throw new Error("Checkout Spark reconciliation is not active.")
  }
  return snapshot
}

/**
 * Explicit shopper action only. It may reconcile funding and advance one
 * outgoing leg, but never marks an order paid from funding receipt alone.
 * A later invocation is required for each further leg or uncertain outcome.
 */
export async function advanceCheckoutSparkShopper(
  input: AdvanceCheckoutSparkShopperInput,
  dependencies: AdvanceCheckoutSparkShopperDependencies = {}
): Promise<AdvanceCheckoutSparkShopperResult> {
  const readOrder = dependencies.readOrder ?? getOrderLifecycle
  const readPreparation =
    dependencies.readPreparation ?? getCheckoutSparkRouterPreparation
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkRepository()
  const sparkConfiguration =
    dependencies.sparkConfiguration ?? getSparkConfiguration
  const sparkManager = dependencies.sparkManager ?? getSparkWalletManager
  const fundingBridge =
    dependencies.fundingBridge ?? createCheckoutSparkRouterFundingBridge
  const outgoingProvider =
    dependencies.outgoingProvider ?? createCheckoutSparkOutgoingProvider
  const now = dependencies.now ?? Date.now
  const hexPubkey = /^[0-9a-f]{64}$/

  if (
    !hexPubkey.test(input.buyerPubkey) ||
    !hexPubkey.test(input.merchantPubkey) ||
    !input.shouldContinue()
  ) {
    throw new Error("Checkout Spark shopper identity is unavailable.")
  }

  const storedPreparation = readPreparation(input.checkoutId)
  const storedPlan = storedPreparation?.reconciliation.plan
  const storedReceive = storedPreparation?.fundingReceive
  const storedHandoffId = storedPreparation?.recoveryHandoffId
  if (
    !storedPreparation ||
    !storedPlan ||
    storedPlan.schemaVersion !== 2 ||
    storedPlan.checkoutId !== input.checkoutId ||
    storedPlan.orderId !== input.orderId ||
    storedPlan.merchantPubkey !== input.merchantPubkey ||
    storedPlan.network !== input.network ||
    !storedReceive ||
    !storedHandoffId ||
    storedPreparation.fundingInvoiceExposedAt === null ||
    storedReceive.walletId !== storedPlan.walletId ||
    storedReceive.network !== storedPlan.network ||
    storedReceive.id !== storedPlan.funding.requestId ||
    storedReceive.paymentRequest !== storedPlan.funding.paymentRequest ||
    storedReceive.paymentHash !== storedPlan.funding.paymentHash ||
    storedReceive.requiredNetSats !== storedPlan.funding.requiredNetSats ||
    storedReceive.grossFundingSats !== storedPlan.funding.grossFundingSats ||
    storedReceive.createdAt !== storedPlan.funding.createdAt ||
    storedReceive.expiresAt !== storedPlan.funding.expiresAt ||
    input.fundingPayment.grossFundingSats !==
      storedPlan.funding.grossFundingSats
  ) {
    throw new Error("Checkout Spark shopper plan is not durably prepared.")
  }
  const preparation = storedPreparation
  const plan = storedPlan

  async function assertAuthority(): Promise<void> {
    if (
      !input.shouldContinue() ||
      input.currentBuyerPubkey() !== input.buyerPubkey
    ) {
      throw new Error("Checkout Spark shopper session changed.")
    }
    const lifecycle = await readOrder(input.orderId)
    const binding = lifecycle?.checkoutSparkRouterBinding
    if (
      !input.shouldContinue() ||
      input.currentBuyerPubkey() !== input.buyerPubkey ||
      !lifecycle ||
      lifecycle.buyerIdentityKind !== "signed_in" ||
      lifecycle.buyerPubkey !== input.buyerPubkey ||
      lifecycle.merchantPubkey !== plan.merchantPubkey ||
      lifecycle.orderDeliveryStatus !== "sent" ||
      lifecycle.phase === "cancelled" ||
      lifecycle.phase === "completed" ||
      lifecycle.paymentStatus === "paid" ||
      binding?.checkoutId !== plan.checkoutId ||
      binding.planDigest !== plan.planDigest ||
      binding.walletId !== plan.walletId
    ) {
      throw new Error("Checkout Spark shopper order binding changed.")
    }
    const currentPreparation = readPreparation(input.checkoutId)
    if (
      currentPreparation?.reconciliation.plan.planDigest !== plan.planDigest ||
      currentPreparation.recoveryHandoffId !== preparation.recoveryHandoffId ||
      currentPreparation.fundingInvoiceExposedAt === null
    ) {
      throw new Error("Checkout Spark shopper preparation changed.")
    }
    const configuration = sparkConfiguration()
    if (
      configuration.status !== "ready" ||
      configuration.network !== plan.network
    ) {
      throw new Error("Checkout Spark shopper wallet network changed.")
    }
  }

  await assertAuthority()
  const manager = sparkManager()
  if (!manager) {
    throw new Error("Checkout Spark shopper wallet is unavailable.")
  }

  // Establish an exact IndexedDB plan binding before payer or outgoing work.
  let snapshot = activeSnapshot(await repository.create(plan))
  if (
    snapshot.state.plan.planDigest !== plan.planDigest ||
    snapshot.state.plan.walletId !== plan.walletId
  ) {
    throw new Error("Checkout Spark shopper reconciliation changed.")
  }

  if (snapshot.state.funding.state !== "spendable") {
    // A full-balance receive read after an outgoing payment is not a valid
    // funding recheck. Such a partial durable state needs manual recovery.
    if (
      snapshot.state.obligations.some(
        (progress) => progress.state !== "unreconciled"
      )
    ) {
      throw new Error("Checkout Spark funding needs manual reconciliation.")
    }
    if (
      preparation.fundingSubmissionState === "not_started" &&
      (now() >= plan.funding.expiresAt || now() >= plan.takeoverAt)
    ) {
      throw new Error("Checkout Spark funding window has closed.")
    }
    await assertAuthority()
    const bridge = fundingBridge({
      plan,
      reconciliation: preparation.reconciliation,
      recoveryHandoffId: storedHandoffId,
      fundingInvoice: plan.funding.paymentRequest,
      fundingReceive: Object.freeze({ ...storedReceive }),
      fundingSubmissionState: preparation.fundingSubmissionState,
    })
    const originalBeforeSend = input.fundingPayment.beforeSend
    const funding = await bridge.fund({
      ...input.fundingPayment,
      beforeSend: async () => {
        if (originalBeforeSend) await originalBeforeSend()
        await assertAuthority()
      },
    })
    await assertAuthority()
    const observed = funding.reconciliation
    if (observed.plan.planDigest !== plan.planDigest) {
      throw new Error("Checkout Spark funding observation changed plans.")
    }
    if (observed.funding.state !== "unreconciled") {
      if (observed.funding.observedAt === null) {
        throw new Error("Checkout Spark funding observation is incomplete.")
      }
      const next = applyCheckoutSparkEvidence(snapshot.state, {
        type: "funding",
        requestId: plan.funding.requestId,
        paymentRequest: plan.funding.paymentRequest,
        paymentHash: plan.funding.paymentHash,
        walletId: plan.walletId,
        network: plan.network,
        requiredNetSats: plan.funding.requiredNetSats,
        grossFundingSats: plan.funding.grossFundingSats,
        state: observed.funding.state,
        observedAt: observed.funding.observedAt,
      })
      snapshot = activeSnapshot(await repository.save(next, snapshot.revision))
    }
    if (
      funding.status !== "funded" ||
      snapshot.state.funding.state !== "spendable"
    ) {
      return { status: "funding_wait", funding }
    }
  }

  await assertAuthority()
  const provider = outgoingProvider({ plan, manager })
  const guardedProvider: CheckoutSparkOutgoingProvider = {
    reconcile: async (target) => {
      await assertAuthority()
      return provider.reconcile(target)
    },
    preflight: async (target) => {
      await assertAuthority()
      return provider.preflight(target)
    },
    send: async (target) => {
      await assertAuthority()
      return provider.send(target)
    },
  }
  const step = await runCheckoutSparkOutgoingStep({
    checkoutId: plan.checkoutId,
    planDigest: plan.planDigest,
    actor: "shopper",
    now,
    store: repository,
    provider: guardedProvider,
  })
  // A completed provider call may outlive the render that invoked it. Keep
  // its durable result, but never return another buyer's checkout to the UI.
  await assertAuthority()
  return { status: "outgoing_step", step }
}
