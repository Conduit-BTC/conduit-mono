import {
  DexieCheckoutSparkSettledRepository,
  getOrderLifecycle,
  runCheckoutSparkSettledOutgoingStep,
  type CheckoutSparkSettledOutgoingObservation,
  type CheckoutSparkSettledOutgoingProvider,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledOutgoingStepResult,
  type CheckoutSparkSettledReconciliation,
  type OrderLifecycle,
} from "@conduit/core"

import {
  createCheckoutSparkSettledFundingBridge,
  type CheckoutSparkSettledFundingPaymentInput,
  type CheckoutSparkSettledFundingResult,
} from "./checkout-spark-settled-funding"
import { prepareCheckoutSparkSettledOutgoingLeg } from "./checkout-spark-settled-leg-preparation"
import { createCheckoutSparkSettledOutgoingProvider } from "./checkout-spark-settled-outgoing-provider"
import { getCheckoutSparkRecoveryDelivery } from "./checkout-spark-recovery-handoff"
import {
  getCheckoutSparkSettledPreparation,
  loadAuthorizedCheckoutSparkSettledFunding,
} from "./checkout-spark-settled-preparation"
import { getSparkConfiguration, getSparkWalletManager } from "./spark-sdk"
import { assertMarketCheckoutSparkDispatchPlan } from "./checkout-spark-dispatch-policy"
import {
  isCurrentGuestOrderSigningIdentity,
  type GuestOrderSigningIdentity,
} from "./guest-order-identity"

export interface AdvanceCheckoutSparkSettledShopperInput {
  checkoutId: string
  planDigest: string
  orderId: string
  merchantPubkey: string
  network: "mainnet" | "regtest"
  buyerPubkey: string
  currentBuyerPubkey: () => string | null
  guestIdentity?: GuestOrderSigningIdentity | null
  currentGuestIdentity?: () => GuestOrderSigningIdentity | null
  shouldContinue: () => boolean
  /** Null for a funding step; one exact plan leg otherwise. */
  legId: string | null
  /** Inspect a frozen payout without preparing, preflighting, or sending it. */
  inspectionOnly?: boolean
  fundingPayment: CheckoutSparkSettledFundingPaymentInput
  /** Must resolve only after the exact state update is relay-ACKed to Merchant. */
  acknowledgeRecoverySnapshot: (
    state: CheckoutSparkSettledReconciliation
  ) => Promise<void>
}

export type AdvanceCheckoutSparkSettledShopperResult =
  | { status: "funding"; funding: CheckoutSparkSettledFundingResult }
  | { status: "payout_prepared"; state: CheckoutSparkSettledReconciliation }
  | { status: "outgoing_step"; step: CheckoutSparkSettledOutgoingStepResult }

export interface AdvanceCheckoutSparkSettledShopperDependencies {
  readOrder?: (orderId: string) => Promise<OrderLifecycle | undefined>
  readPreparation?: typeof getCheckoutSparkSettledPreparation
  readInitialRecovery?: typeof getCheckoutSparkRecoveryDelivery
  loadAuthorized?: typeof loadAuthorizedCheckoutSparkSettledFunding
  repository?: Pick<
    DexieCheckoutSparkSettledRepository,
    | "create"
    | "load"
    | "save"
    | "savePreparedWithInvoiceOrigin"
    | "assertLocalInvoiceOrigin"
    | "recordMerchantPayout"
  >
  sparkConfiguration?: typeof getSparkConfiguration
  sparkManager?: typeof getSparkWalletManager
  fundingBridge?: typeof createCheckoutSparkSettledFundingBridge
  prepareLeg?: typeof prepareCheckoutSparkSettledOutgoingLeg
  outgoingStep?: typeof runCheckoutSparkSettledOutgoingStep
  outgoingProvider?: typeof createCheckoutSparkSettledOutgoingProvider
  now?: () => number
}

/** One guarded step. The authorized foreground runner composes these serially. */
export async function advanceCheckoutSparkSettledShopper(
  input: AdvanceCheckoutSparkSettledShopperInput,
  dependencies: AdvanceCheckoutSparkSettledShopperDependencies = {}
): Promise<AdvanceCheckoutSparkSettledShopperResult> {
  const readOrder = dependencies.readOrder ?? getOrderLifecycle
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const readPreparation =
    dependencies.readPreparation ?? getCheckoutSparkSettledPreparation
  const readInitialRecovery =
    dependencies.readInitialRecovery ?? getCheckoutSparkRecoveryDelivery
  const now = dependencies.now ?? Date.now
  const guestIdentity = input.guestIdentity ? { ...input.guestIdentity } : null
  const guestScope = {
    orderId: input.orderId,
    merchantPubkey: input.merchantPubkey,
    pubkey: input.buyerPubkey,
  }
  const currentGuestIdentity = input.currentGuestIdentity
  function currentSessionMatches(): boolean {
    if (!input.shouldContinue()) return false
    if (!guestIdentity) return input.currentBuyerPubkey() === input.buyerPubkey
    const current = currentGuestIdentity?.() ?? null
    const time = now()
    return (
      isCurrentGuestOrderSigningIdentity(guestIdentity, guestScope, time) &&
      isCurrentGuestOrderSigningIdentity(current, guestScope, time) &&
      current?.createdAt === guestIdentity.createdAt &&
      current.expiresAt === guestIdentity.expiresAt
    )
  }
  function assertSession(): void {
    if (!currentSessionMatches()) {
      throw new Error("Checkout Spark shopper session changed.")
    }
  }
  assertSession()
  const availableManager = (
    dependencies.sparkManager ?? getSparkWalletManager
  )()
  if (
    !/^[0-9a-f]{64}$/.test(input.buyerPubkey) ||
    !/^[0-9a-f]{64}$/.test(input.merchantPubkey) ||
    !input.shouldContinue() ||
    !availableManager
  ) {
    throw new Error("Checkout Spark shopper identity or wallet is unavailable.")
  }
  const manager = availableManager
  const prepared = await (
    dependencies.loadAuthorized ?? loadAuthorizedCheckoutSparkSettledFunding
  )(input.checkoutId, { repository, now })
  assertSession()
  const { plan } = prepared
  assertMarketCheckoutSparkDispatchPlan(plan)
  if (
    plan.schemaVersion !== 3 ||
    plan.checkoutId !== input.checkoutId ||
    plan.planDigest !== input.planDigest ||
    plan.orderId !== input.orderId ||
    plan.merchantPubkey !== input.merchantPubkey ||
    plan.network !== input.network
  ) {
    throw new Error("Checkout Spark shopper plan changed.")
  }

  async function assertAuthority(): Promise<void> {
    assertSession()
    const lifecycle = await readOrder(input.orderId)
    assertSession()
    const binding = lifecycle?.checkoutSparkRouterBinding
    const preparation = readPreparation(input.checkoutId)
    const initialRecovery = preparation?.recoveryHandoffId
      ? readInitialRecovery(preparation.recoveryHandoffId)
      : null
    const configuration = (
      dependencies.sparkConfiguration ?? getSparkConfiguration
    )()
    if (
      !lifecycle ||
      lifecycle.buyerIdentityKind !==
        (guestIdentity ? "guest_ephemeral" : "signed_in") ||
      (guestIdentity !== null &&
        lifecycle.guestSessionExpiresAt !== guestIdentity.expiresAt) ||
      lifecycle.buyerPubkey !== input.buyerPubkey ||
      lifecycle.merchantPubkey !== plan.merchantPubkey ||
      lifecycle.orderDeliveryStatus !== "sent" ||
      lifecycle.phase === "cancelled" ||
      lifecycle.phase === "completed" ||
      lifecycle.paymentStatus === "paid" ||
      binding?.checkoutId !== plan.checkoutId ||
      binding.planDigest !== plan.planDigest ||
      binding.walletId !== plan.walletId ||
      preparation?.planDigest !== plan.planDigest ||
      preparation.recoveryHandoffId !== prepared.recoveryHandoffId ||
      preparation.fundingInvoiceExposedAt === null ||
      initialRecovery?.record.senderPubkey !== input.buyerPubkey ||
      initialRecovery.deliveryProgress.acknowledgedRelayRefs.length === 0 ||
      configuration.status !== "ready" ||
      configuration.network !== plan.network ||
      !manager.isOpen(plan.walletId) ||
      !Number.isSafeInteger(now()) ||
      now() < plan.createdAt ||
      now() >= plan.takeoverAt
    ) {
      throw new Error("Checkout Spark shopper order authority changed.")
    }
  }

  await assertAuthority()
  const snapshot = await repository.load(input.checkoutId, input.planDigest)
  await assertAuthority()
  if (
    snapshot.status !== "active" ||
    snapshot.state.plan.planDigest !== plan.planDigest
  ) {
    throw new Error("Checkout Spark settled state is unavailable.")
  }
  if (input.inspectionOnly && input.legId === null) {
    throw new Error("Checkout Spark inspection requires a payout leg.")
  }
  if (!snapshot.state.credit) {
    if (input.legId !== null) {
      throw new Error("Checkout Spark payout is not yet funded.")
    }
    if (input.fundingPayment.buyerPubkey !== input.buyerPubkey) {
      throw new Error("Checkout Spark funding buyer changed.")
    }
    const bridge = (
      dependencies.fundingBridge ?? createCheckoutSparkSettledFundingBridge
    )(input.checkoutId)
    const originalBeforeSend = input.fundingPayment.beforeSend
    const originalShouldContinue = input.fundingPayment.shouldContinue
    const funding = await bridge.fund({
      ...input.fundingPayment,
      shouldContinue: () => currentSessionMatches() && originalShouldContinue(),
      beforeSend: async () => {
        await assertAuthority()
        await originalBeforeSend?.()
        await assertAuthority()
      },
    })
    await assertAuthority()
    if (funding.reconciliation.plan.planDigest !== plan.planDigest) {
      throw new Error("Checkout Spark funding observation changed plans.")
    }
    return { status: "funding", funding }
  }
  const nextLeg = snapshot.state.legs.find((leg) => leg.status !== "paid")
  if (!nextLeg || input.legId !== nextLeg.legId) {
    throw new Error("Checkout Spark next payout changed.")
  }
  if (
    nextLeg.status === "terminal_failure" ||
    nextLeg.status === "conflicting_evidence"
  ) {
    throw new Error("Checkout Spark payout needs manual recovery.")
  }
  const acknowledgeRecoverySnapshot = async (
    state: CheckoutSparkSettledReconciliation
  ) => {
    await assertAuthority()
    await input.acknowledgeRecoverySnapshot(state)
    await assertAuthority()
  }
  if (!nextLeg.intent) {
    if (input.inspectionOnly) {
      throw new Error("Checkout Spark inspection requires a saved invoice.")
    }
    const preparedLeg = await (
      dependencies.prepareLeg ?? prepareCheckoutSparkSettledOutgoingLeg
    )(
      {
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        legId: nextLeg.legId,
        shouldContinue: () =>
          currentSessionMatches() && now() < plan.takeoverAt,
      },
      {
        repository,
        walletManager: manager,
        acknowledgeRecoverySnapshot,
        nowMs: now,
      }
    )
    await assertAuthority()
    return { status: "payout_prepared", state: preparedLeg.state }
  }
  const provider = (
    dependencies.outgoingProvider ?? createCheckoutSparkSettledOutgoingProvider
  )({
    plan,
    manager,
    assertBeforeSend: async (target) => {
      await assertAuthority()
      await repository.assertLocalInvoiceOrigin(plan, target, assertSession)
      await assertAuthority()
    },
  })
  const recordPaid = async (
    target: CheckoutSparkSettledOutgoingTarget,
    observation: CheckoutSparkSettledOutgoingObservation
  ) => {
    if (observation.status !== "paid") return
    await assertAuthority()
    await repository.recordMerchantPayout(
      plan,
      target,
      observation,
      now(),
      () => {
        if (!currentSessionMatches() || now() >= plan.takeoverAt) {
          throw new Error("Checkout Spark shopper session changed.")
        }
      }
    )
    await assertAuthority()
  }
  const guardedProvider: CheckoutSparkSettledOutgoingProvider = {
    reconcile: async (target) => {
      await assertAuthority()
      const observation = await provider.reconcile(target)
      await assertAuthority()
      await recordPaid(target, observation)
      return observation
    },
    preflight: async (target) => {
      await assertAuthority()
      const result = await provider.preflight(target)
      await assertAuthority()
      return result
    },
    send: async (target) => {
      await assertAuthority()
      const observation = await provider.send(target)
      await assertAuthority()
      if (observation.status === "paid") {
        await recordPaid(target, observation)
      }
      return observation
    },
  }
  const step = await (
    dependencies.outgoingStep ?? runCheckoutSparkSettledOutgoingStep
  )({
    checkoutId: plan.checkoutId,
    planDigest: plan.planDigest,
    legId: nextLeg.legId,
    actor: "shopper",
    ...(input.inspectionOnly ? { inspectionOnly: true } : {}),
    now,
    store: repository,
    provider: guardedProvider,
    acknowledgeRecoverySnapshot,
  })
  await assertAuthority()
  return { status: "outgoing_step", step }
}
